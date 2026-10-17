import { existsSync, realpathSync, watch, type FSWatcher } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  createHost,
  readBuild,
  type ApplicationHost,
  type HostingAssetRecord,
  type HostingRecordV1,
  type HostSelection,
} from "@hesperia/hosting";
import { prepareBuild, type BrowserBuild } from "./project.ts";
import { isMissingFile } from "./utils.ts";

/** A local server handle owns its file watchers and connected development clients. */
export interface ProjectServer {
  /** Loopback origin and selected port; valid while the server remains open. */
  readonly url: URL;

  /** Stop listening, close reload streams, and release every filesystem watcher. */
  close(): Promise<void>;
}

/** Start a loopback preview of the most recent successful build. Port zero selects a free port. */
export async function previewProject(
  root: string,
  port = 4173,
  selection?: HostSelection,
): Promise<ProjectServer> {
  const build = await readBuild(resolve(root, ".hesperia/build"));
  const host = await createHost(build, selection);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: (request) => host.handle(request) ?? new Response(null, { status: 404 }),
  });
  return {
    url: server.url,

    async close() {
      await server.stop(true);
    },
  };
}

/** Development reports compilation failures without replacing the last successful application. */
export interface DevelopmentOptions {
  /** Loopback port; defaults to 5173, while 0 asks the operating system for a free port. */
  readonly port?: number;
  /** Receives compile failures and forwarded browser development warnings. */
  readonly report?: (message: string) => void;
}

interface DevelopmentCapture {
  readonly hosting: HostingRecordV1;
  readonly files: ReadonlyMap<string, Blob>;
  readonly sourceFiles: readonly string[];
  readonly dependencies?: BrowserBuild["developmentDependencies"];
}

interface PublishedDevelopmentRevision extends DevelopmentCapture {
  readonly host: ApplicationHost;
  readonly fingerprint: string;
}

/** Build before listening, rebuild serially, and notify connected browsers only when served bytes change. Reload streams remain connected across rebuilds. The optional preparation function is a test seam for revision races. */
export async function devProject(
  root: string,
  options: DevelopmentOptions = {},
  prepareRevision?: (root: string, signal?: AbortSignal) => Promise<BrowserBuild>,
): Promise<ProjectServer> {
  root = resolve(root);
  const report = options.report ?? console.warn;

  const prepare = async (signal?: AbortSignal): Promise<BrowserBuild> =>
    prepareRevision
      ? prepareRevision(root, signal)
      : existsSync(join(root, "hesperia.config.ts"))
        ? (await import("./project-worker-client.ts")).buildInProjectProcess(root, true, signal)
        : prepareBuild(root, true);

  let build: BrowserBuild = await prepare();
  const initialCapture = developmentCapture(build);
  let published: PublishedDevelopmentRevision = {
    ...initialCapture,
    host: await createHost({ hosting: initialCapture.hosting, files: initialCapture.files }),
    fingerprint: developmentFingerprint(build, initialCapture.hosting),
  };
  let closed = false;
  let pending = false;
  let building: Promise<void> | undefined;
  let buildAbort: AbortController | undefined;
  const dependencyWatchers = new Map<
    string,
    { watcher: FSWatcher; recursive: boolean; targets: Set<string> }
  >();
  const missingDirectories = new Set<string>();
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();
  const developmentRoots = new Map<string, Blob>();

  function rememberDevelopmentRoot(host: ApplicationHost): void {
    const root = host.mount.assetPath;

    developmentRoots.set(
      root,
      new Blob([developmentClientSource(root)], { type: "text/javascript; charset=utf-8" }),
    );
  }

  rememberDevelopmentRoot(published.host);

  function publish(message: unknown): void {
    for (const client of clients) {
      try {
        client.enqueue(encoder.encode(`data: ${JSON.stringify(message)}\n\n`));
      } catch {
        clients.delete(client);
      }
    }
  }

  function watchDependencies(candidate: BrowserBuild): void {
    const sourceRoot = join(root, "src");
    const directories = new Map<string, { recursive: boolean; targets: Set<string> }>();

    for (const directory of candidate.sources
      .map(dirname)
      .filter(
        (directory) =>
          directory !== root &&
          directory !== sourceRoot &&
          !directory.startsWith(`${sourceRoot}${sep}`),
      ))
      addDirectory(directory, false);

    for (const item of candidate.watch ?? []) {
      const directory = item.kind === "file" ? dirname(item.file) : item.dir;

      if (
        directory === root ||
        directory === sourceRoot ||
        directory.startsWith(`${sourceRoot}${sep}`)
      )
        continue;

      addDirectory(directory, item.kind === "directory");
    }

    function addDirectory(directory: string, recursive: boolean): void {
      let ancestor = resolve(directory);

      for (;;) {
        try {
          const canonical = realpathSync(ancestor);
          const targets = directories.get(canonical)?.targets ?? new Set<string>();

          targets.add(resolve(canonical, relative(ancestor, directory)));

          directories.set(canonical, {
            recursive: recursive || directories.get(canonical)?.recursive === true,
            targets,
          });

          if (ancestor === resolve(directory)) missingDirectories.delete(resolve(directory));
          else if (!missingDirectories.has(resolve(directory))) {
            missingDirectories.add(resolve(directory));

            report(
              `Development watch directory is missing: ${directory}; watching for its creation`,
            );
          }

          return;
        } catch (error) {
          if (!isMissingFile(error)) throw error;

          const parent = dirname(ancestor);

          if (parent === ancestor) throw error;

          ancestor = parent;
          recursive = true;
        }
      }
    }

    for (const [directory, current] of dependencyWatchers) {
      if (directories.get(directory)?.recursive !== current.recursive) {
        current.watcher.close();

        dependencyWatchers.delete(directory);
      }
    }

    for (const [directory, requested] of directories) {
      const existing = dependencyWatchers.get(directory);

      if (existing) existing.targets = requested.targets;
      else {
        const current = {
          ...requested,
          watcher: watch(directory, { recursive: requested.recursive }, (_event, filename) => {
            if (filename === null) return;

            const changed = resolve(directory, filename.toString());

            if (
              [...current.targets].some(
                (target) =>
                  changed === target ||
                  changed.startsWith(`${target}${sep}`) ||
                  target.startsWith(`${changed}${sep}`),
              )
            )
              rebuild();
          }),
        };

        dependencyWatchers.set(directory, current);
      }
    }
  }

  function rebuild(): void {
    if (closed) return;

    pending = true;

    if (building) {
      buildAbort?.abort();

      return;
    }

    building = (async () => {
      while (pending && !closed) {
        pending = false;
        const controller = new AbortController();
        buildAbort = controller;

        try {
          const candidate = await prepare(controller.signal);
          const removed = new Set(published.sourceFiles.filter((source) => !existsSync(source)));
          const ownership = published.dependencies;
          const reloadAll = ownership?.shared.some((source) => removed.has(source)) ?? false;
          const routeIds =
            ownership?.routes
              .filter((route) => route.sources.some((source) => removed.has(source)))
              .map((route) => route.routeId) ?? [];
          const retainedSources = new Set([
            ...(reloadAll ? [] : (ownership?.shared ?? [])),
            ...(ownership?.routes
              .filter((route) => !reloadAll && !routeIds.includes(route.routeId))
              .flatMap((route) => route.sources) ?? []),
          ]);
          const retire = new Set(
            Object.entries(ownership?.assets ?? {})
              .filter(
                ([, sources]) =>
                  sources.some((source) => removed.has(source)) &&
                  !sources.some((source) => retainedSources.has(source)),
              )
              .map(([path]) => path),
          );
          const styleOnly =
            build.styleRevision &&
            candidate.styleRevision &&
            build.styleRevision.semanticKey === candidate.styleRevision.semanticKey;
          const capture = developmentCapture(candidate, styleOnly ? published : undefined, retire);
          const fingerprint = developmentFingerprint(candidate, capture.hosting);

          if (!closed && !controller.signal.aborted && !pending) {
            if (fingerprint === published.fingerprint && !routeIds.length && !reloadAll) {
              watchDependencies(candidate);

              published = { ...published, ...capture };
              build = candidate;
              continue;
            }

            const host = await createHost({ hosting: capture.hosting, files: capture.files });

            if (!closed && !controller.signal.aborted && !pending) {
              watchDependencies(candidate);

              published = { ...capture, host, fingerprint };

              rememberDevelopmentRoot(host);

              build = candidate;

              if (routeIds.length || reloadAll)
                publish({ type: "source-removal", routeIds, reloadAll });

              publish(
                styleOnly
                  ? { type: "style-revision", plan: candidate.styleRevision!.plan }
                  : "reload",
              );
            }
          }
        } catch (error) {
          if (!closed && !controller.signal.aborted) {
            report(String(error));

            publish(String(error));
          }
        } finally {
          if (buildAbort === controller) buildAbort = undefined;
        }
      }
    })().finally(() => {
      building = undefined;
    });
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 5173,

    async fetch(request, connection) {
      const url = new URL(request.url);

      for (const [assetRoot, client] of developmentRoots) {
        if (url.pathname === `${assetRoot}/events` && request.method === "GET") {
          connection.timeout(request, 0);

          let controller: ReadableStreamDefaultController<Uint8Array>;
          const stream = new ReadableStream<Uint8Array>({
            start(value) {
              controller = value;

              clients.add(value);

              value.enqueue(encoder.encode(": connected\n\n"));
            },

            cancel() {
              clients.delete(controller);
            },
          });
          return new Response(stream, {
            headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
          });
        }

        if (url.pathname === `${assetRoot}/warnings` && request.method === "POST") {
          if (request.headers.get("origin") !== url.origin)
            return new Response("Forbidden origin", { status: 403 });

          const message = await request.text();

          if (message.length > 16_384) return new Response("Warning too long", { status: 413 });

          report(message);

          return new Response(null, { status: 204 });
        }

        if (url.pathname === `${assetRoot}/client.js` && request.method === "GET")
          return new Response(client, {
            headers: { "cache-control": "no-cache", "x-content-type-options": "nosniff" },
          });
      }

      const current = published;
      const response = current.host.handle(request);

      if (!response) return new Response(null, { status: 404 });

      if (
        request.method !== "GET" ||
        !response.headers.get("content-type")?.startsWith("text/html")
      )
        return response;

      const body = await response.text();
      const clientPath = `${current.host.mount.assetPath}/client.js`;
      const html = body.replace(
        '<script type="module" src=',
        `<script type="module" src="${clientPath.replaceAll("&", "&amp;")}"></script><script type="module" src=`,
      );
      const headers = new Headers(response.headers);

      headers.delete("content-length");

      return new Response(html, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    },
  });
  const watchers: FSWatcher[] = [];

  try {
    watchDependencies(build);

    watchers.push(watch(join(root, "src"), { recursive: true }, rebuild));

    watchers.push(
      watch(root, (_event, filename) => {
        const changed = filename?.toString();
        const checkingInput =
          changed !== undefined &&
          build.sources.some(
            (source) =>
              dirname(source).toLowerCase() === root.toLowerCase() &&
              resolve(source).toLowerCase() === resolve(root, changed).toLowerCase(),
          );
        const rootDirectoryWatch =
          changed !== undefined &&
          build.watch?.some((item) => item.kind === "directory" && resolve(item.dir) === root) ===
            true;

        if (
          changed &&
          changed !== "hesperia.d.ts" &&
          (/\.(?:ts|tsx|mts)$/u.test(changed) ||
            ["tsconfig.json", "hesperia.config.json"].includes(changed) ||
            checkingInput ||
            rootDirectoryWatch)
        )
          rebuild();
      }),
    );
  } catch (error) {
    closed = true;

    for (const watcher of watchers) watcher.close();

    for (const { watcher } of dependencyWatchers.values()) watcher.close();

    await server.stop(true);

    throw error;
  }

  return {
    url: server.url,

    async close() {
      closed = true;

      buildAbort?.abort();

      for (const watcher of watchers) watcher.close();

      for (const { watcher } of dependencyWatchers.values()) watcher.close();

      for (const client of clients) {
        try {
          client.close();
        } catch {
          /* The browser may already have disconnected. */
        }
      }

      clients.clear();

      await server.stop(true);

      await building;
    },
  };
}

function developmentCapture(
  build: BrowserBuild,
  previous?: DevelopmentCapture,
  retired: ReadonlySet<string> = new Set(),
): DevelopmentCapture {
  if (build.hosting.mode !== "development")
    throw new TypeError("The development server requires a development build");

  const assets = new Map<string, HostingAssetRecord>();
  const files = new Map<string, Blob>();

  for (const asset of build.hosting.assets) {
    assets.set(asset.path, asset);

    const blob = build.files.get(asset.path);

    if (!blob)
      throw new TypeError(
        `Development build omitted ${asset.path}; captured assets: ${[...build.files.keys()]
          .filter((path) => path.startsWith("/assets/"))
          .join(", ")}`,
      );

    files.set(asset.path, blob);
  }

  if (previous) {
    for (const asset of previous.hosting.assets) {
      if (assets.has(asset.path) || retired.has(asset.path)) continue;

      assets.set(asset.path, asset);

      const blob = previous.files.get(asset.path);

      if (blob) files.set(asset.path, blob);
    }
  }

  const hosting: HostingRecordV1 = {
    ...build.hosting,
    assets: [...assets.values()].sort((left, right) => left.path.localeCompare(right.path)),
  };
  return {
    hosting,
    files,
    sourceFiles: [
      ...new Set([
        ...build.sources.filter((source) => existsSync(source)).map(canonicalSource),
        ...(previous?.sourceFiles.filter((source) => existsSync(source)) ?? []),
      ]),
    ],
    ...(build.developmentDependencies
      ? {
          dependencies: {
            ...build.developmentDependencies,
            shared: [
              ...new Set([
                ...build.developmentDependencies.shared,
                ...(previous?.dependencies?.shared ?? []),
              ]),
            ],
            routes: build.developmentDependencies.routes.map((route) => ({
              routeId: route.routeId,
              sources: [
                ...new Set([
                  ...route.sources,
                  ...(previous?.dependencies?.routes.find(
                    (prior) => prior.routeId === route.routeId,
                  )?.sources ?? []),
                ]),
              ],
            })),
            assets: Object.fromEntries([
              ...Object.entries(previous?.dependencies?.assets ?? {}).filter(([path]) =>
                files.has(path),
              ),
              ...Object.entries(build.developmentDependencies.assets),
            ]),
          },
        }
      : {}),
  };
}

function canonicalSource(filename: string): string {
  const path = resolve(filename).replaceAll("\\", "/");
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function developmentFingerprint(build: BrowserBuild, hosting: HostingRecordV1): string {
  return JSON.stringify({
    mount: hosting.standaloneMountURL,
    startup: hosting.startupAsset,
    assets: hosting.assets,
    styleRevision: build.styleRevision
      ? { semanticKey: build.styleRevision.semanticKey, plan: build.styleRevision.plan }
      : null,
  });
}

function developmentClientSource(assetRoot: string): string {
  const eventsURL = JSON.stringify(`${assetRoot}/events`);
  const warningsURL = JSON.stringify(`${assetRoot}/warnings`);
  return `const warningsURL = ${warningsURL};
addEventListener("hesperia:warning", event => { if (typeof event.detail === "string") void fetch(warningsURL, { method: "POST", body: event.detail }).catch(() => {}); });
const requestHardReload = () => { const request = new CustomEvent("hesperia:dev-hard-reload", { cancelable: true }); if (window.dispatchEvent(request)) location.reload(); };
const events = new EventSource(${eventsURL});
events.onmessage = async event => { const message = JSON.parse(event.data); if (message === "reload") { requestHardReload(); return; } if (message?.type === "source-removal") { window.dispatchEvent(new CustomEvent("hesperia:dev-source-removal", { detail: { routeIds: message.routeIds, reloadAll: message.reloadAll } })); return; } if (message?.type === "style-revision") { let resolve; let reject; const settled = new Promise((accept, fail) => { resolve = accept; reject = fail; }); const update = new CustomEvent("hesperia:style-revision", { cancelable: true, detail: { plan: message.plan, resolve, reject } }); if (window.dispatchEvent(update)) { requestHardReload(); return; } try { await settled; } catch (error) { console.error(error); dispatchEvent(new CustomEvent("hesperia:warning", { detail: String(error) })); } return; } console.error(message); };
`;
}
