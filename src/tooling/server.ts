import { watch, type FSWatcher } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { prepareBuild, type BrowserBuild } from "./project.ts";

/** A local server handle owns its file watchers and connected development clients. */
export interface ProjectServer {
  /** Loopback origin and selected port; valid while the server remains open. */
  readonly url: URL;
  /** Stop listening, close reload streams, and release every filesystem watcher. */
  close(): Promise<void>;
}

const mimeTypes: Readonly<Record<string, string>> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json",
  map: "application/json",
  svg: "image/svg+xml",
};

/** Serve only captured assets, using the HTML entry for browser navigation to deep links. */
export function assetResponse(files: ReadonlyMap<string, Blob>, request: Request): Response {
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  const url = new URL(request.url);
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return new Response("Invalid path", { status: 400 });
  }
  const direct = files.get(path);
  const navigation = request.headers.get("accept")?.includes("text/html") === true;
  const blob = direct ?? (navigation ? files.get("/index.html") : undefined);
  if (!blob) return new Response("Not found", { status: 404 });
  const extension = direct ? path.split(".").at(-1) : "html";
  const contentType = mimeTypes[extension ?? ""] ?? (blob.type || "application/octet-stream");
  return new Response(request.method === "HEAD" ? null : blob, {
    headers: {
      "content-type": contentType,
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
    },
  });
}

/** Read a completed build without following symlinks or exposing other project files. */
export async function readBuiltFiles(root: string): Promise<ReadonlyMap<string, Blob>> {
  const files = new Map<string, Blob>();
  async function visit(directory: string, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) await visit(join(directory, entry.name), `${prefix}/${entry.name}`);
      else if (entry.isFile())
        files.set(
          `${prefix}/${entry.name}`,
          new Blob([await readFile(join(directory, entry.name))]),
        );
    }
  }
  await visit(resolve(root, ".hesperia/build"), "");
  if (!files.has("/index.html")) throw new Error("No built index.html; run hesperia build first");
  return files;
}

/** Start a loopback preview of the most recent successful build. Port zero selects a free port. */
export async function previewProject(root: string, port = 4173): Promise<ProjectServer> {
  const files = await readBuiltFiles(root);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: (request) => assetResponse(files, request),
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

/** Build before listening, rebuild serially, and notify connected browsers only when served bytes change. Reload streams remain connected across rebuilds. */
export async function devProject(
  root: string,
  options: DevelopmentOptions = {},
): Promise<ProjectServer> {
  root = resolve(root);
  const report = options.report ?? console.warn;
  let build: BrowserBuild = await prepareBuild(root, true);
  let files = await developmentFiles(build);
  let closed = false;
  let pending = false;
  let building: Promise<void> | undefined;
  const dependencyWatchers = new Map<string, FSWatcher>();
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();
  let publishedFingerprint = await developmentFingerprint(files);
  function publish(message: string): void {
    for (const client of clients) {
      try {
        client.enqueue(encoder.encode(`data: ${JSON.stringify(message)}\n\n`));
      } catch {
        clients.delete(client);
      }
    }
  }
  function watchDependencies(): void {
    const sourceRoot = join(root, "src");
    const directories = new Set(
      build.sources
        .map(dirname)
        .filter(
          (directory) =>
            directory !== root &&
            directory !== sourceRoot &&
            !directory.startsWith(`${sourceRoot}${sep}`),
        ),
    );
    for (const [directory, watcher] of dependencyWatchers) {
      if (!directories.has(directory)) {
        watcher.close();
        dependencyWatchers.delete(directory);
      }
    }
    for (const directory of directories) {
      if (!dependencyWatchers.has(directory))
        dependencyWatchers.set(directory, watch(directory, rebuild));
    }
  }
  function rebuild(): void {
    if (closed) return;
    pending = true;
    if (building) return;
    building = (async () => {
      while (pending && !closed) {
        pending = false;
        try {
          build = await prepareBuild(root, true);
          const next = await developmentFiles(build);
          if (!closed) {
            watchDependencies();
            const fingerprint = await developmentFingerprint(next);
            if (fingerprint !== publishedFingerprint) {
              publishedFingerprint = fingerprint;
              files = next;
              publish("reload");
            }
          }
        } catch (error) {
          if (!closed) {
            report(String(error));
            publish(String(error));
          }
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
      if (url.pathname === "/__hesperia/events" && request.method === "GET") {
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
      if (url.pathname === "/__hesperia/warnings" && request.method === "POST") {
        if (request.headers.get("origin") !== url.origin)
          return new Response("Forbidden origin", { status: 403 });
        const message = await request.text();
        if (message.length > 16_384) return new Response("Warning too long", { status: 413 });
        report(message);
        return new Response(null, { status: 204 });
      }
      return assetResponse(files, request);
    },
  });
  const watchers: FSWatcher[] = [];
  try {
    watchDependencies();
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
        if (
          changed &&
          changed !== "hesperia.d.ts" &&
          (/\.(?:ts|tsx|mts)$/u.test(changed) ||
            ["tsconfig.json", "hesperia.config.json"].includes(changed) ||
            checkingInput)
        )
          rebuild();
      }),
    );
  } catch (error) {
    closed = true;
    for (const watcher of watchers) watcher.close();
    for (const watcher of dependencyWatchers.values()) watcher.close();
    await server.stop(true);
    throw error;
  }
  return {
    url: server.url,
    async close() {
      closed = true;
      for (const watcher of watchers) watcher.close();
      for (const watcher of dependencyWatchers.values()) watcher.close();
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

async function developmentFiles(build: BrowserBuild): Promise<ReadonlyMap<string, Blob>> {
  const files = new Map(build.files);
  const html = await files.get("/index.html")!.text();
  files.set(
    "/index.html",
    new Blob([
      html.replace(
        '<script type="module"',
        '<script type="module" src="/__hesperia/client.js"></script><script type="module"',
      ),
    ]),
  );
  files.set(
    "/__hesperia/client.js",
    new Blob([
      'addEventListener("hesperia:warning", event => { if (typeof event.detail === "string") void fetch("/__hesperia/warnings", { method: "POST", body: event.detail }).catch(() => {}); });\nconst events = new EventSource("/__hesperia/events");\nevents.onmessage = event => { const message = JSON.parse(event.data); if (message === "reload") location.reload(); else console.error(message); };\n',
    ]),
  );
  return files;
}

async function developmentFingerprint(files: ReadonlyMap<string, Blob>): Promise<string> {
  const entries = await Promise.all(
    [...files.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(async ([filename, file]) => {
        const hasher = new Bun.CryptoHasher("sha256");
        hasher.update(new Uint8Array(await file.arrayBuffer()));
        return [filename, file.type, hasher.digest("hex")] as const;
      }),
  );
  return JSON.stringify(entries);
}
