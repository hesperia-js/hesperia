import { afterEach, expect, spyOn, test } from "bun:test";
import * as filesystem from "node:fs";
import * as filesystemPromises from "node:fs/promises";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { prepareBuild, writeBuild } from "../../packages/tooling/src/project.ts";
import {
  devProject,
  previewProject,
  type ProjectServer,
} from "../../packages/tooling/src/server.ts";
import { linkFrameworkPackages, unlinkFrameworkPackages } from "./fixture-dependencies.ts";

const roots: string[] = [];

afterEach(async () => {
  const errors: unknown[] = [];

  for (const root of roots.splice(0)) {
    try {
      await unlinkFrameworkPackages(root);

      await rm(root, { recursive: true, force: true });
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length) throw new AggregateError(errors, "Fixture root cleanup failed");
});

async function withFixtureCleanup(
  body: () => Promise<void>,
  cleanup: readonly (() => void | Promise<void> | undefined)[],
): Promise<void> {
  let failed = false;
  let failure: unknown;

  try {
    await body();
  } catch (error) {
    failed = true;
    failure = error;
  }

  const errors: unknown[] = [];

  for (const action of cleanup) {
    try {
      await action();
    } catch (error) {
      errors.push(error);
    }
  }

  if (failed && errors.length)
    throw new AggregateError([failure, ...errors], "Fixture and cleanup failed");

  if (failed) throw failure;

  if (errors.length) throw new AggregateError(errors, "Fixture cleanup failed");
}

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

type ConfigurationFormat = "typescript" | "json";

async function createProjectRoot(
  prefix: string,
  format: ConfigurationFormat,
  mountURL = "/",
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));

  roots.push(root);

  await linkFrameworkPackages(root);

  await mkdir(join(root, "src", "routes"), { recursive: true });

  await writeFile(
    join(root, "app.tsx"),
    `export default function App(props: { children: () => unknown }) {
  return <html><head></head><body>{props.children()}</body></html>;
}
`,
  );

  await writeFile(
    join(root, "src", "routes", "+page.tsx"),
    "export default function Home() { return <main>Public file host</main>; }\n",
  );

  if (format === "typescript") {
    await writeFile(
      join(root, "hesperia.config.ts"),
      `import { defineConfig } from "@hesperia/tooling";\nexport default defineConfig(${JSON.stringify({ mountURL })});\n`,
    );
  } else {
    await writeFile(join(root, "hesperia.config.json"), JSON.stringify({ mountURL }));
  }

  return root;
}

interface PublicFileFixture {
  readonly relativePath: string;
  readonly urlPath: string;
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

const publicFiles: readonly PublicFileFixture[] = [
  {
    relativePath: "_underscored.bin",
    urlPath: "/_underscored.bin",
    bytes: new Uint8Array([0x5f, 0x75, 0x6e, 0xff]),
    contentType: "application/octet-stream",
  },
  {
    relativePath: "assets/data.bin",
    urlPath: "/assets/data.bin",
    bytes: new Uint8Array([0x00, 0x01, 0x80, 0xff]),
    contentType: "application/octet-stream",
  },
  {
    relativePath: "assets/empty.bin",
    urlPath: "/assets/empty.bin",
    bytes: new Uint8Array(),
    contentType: "application/octet-stream",
  },
  {
    relativePath: "café #%.txt",
    urlPath: "/caf%C3%A9%20%23%25.txt",
    bytes: new TextEncoder().encode("public café bytes"),
    contentType: "text/plain;charset=utf-8",
  },
  {
    relativePath: "literal%20name.bin",
    urlPath: "/literal%2520name.bin",
    bytes: new Uint8Array([0x25, 0x32, 0x30]),
    contentType: "application/octet-stream",
  },
  {
    relativePath: "objects/data.bin",
    urlPath: "/objects/data.bin",
    bytes: new Uint8Array([0x6f, 0x62, 0x6a, 0x65, 0x63, 0x74, 0x73]),
    contentType: "application/octet-stream",
  },
];

async function writePublicFiles(root: string): Promise<void> {
  for (const file of publicFiles) {
    const filename = join(root, "public", ...file.relativePath.split("/"));

    await mkdir(dirname(filename), { recursive: true });

    await writeFile(filename, file.bytes);
  }
}

function expectedPublicRecords(files: readonly PublicFileFixture[] = publicFiles) {
  return files.map((file) => ({
    relativePath: file.relativePath,
    urlPath: file.urlPath,
    sha256: sha256(file.bytes),
    contentType: file.contentType,
  }));
}

async function writeLinkedPublicFiles(root: string): Promise<readonly PublicFileFixture[]> {
  const publicRoot = join(root, "public");
  const sourceRoot = join(root, "source-public");
  const targets = join(root, "source-files");
  const directoryLinkType = process.platform === "win32" ? "junction" : "dir";

  await mkdir(sourceRoot);

  await mkdir(targets);

  await symlink(sourceRoot, publicRoot, directoryLinkType);

  await writePublicFiles(root);

  await rename(join(sourceRoot, "assets"), join(targets, "assets"));

  await symlink(join(targets, "assets"), join(sourceRoot, "assets"), directoryLinkType);

  await symlink(join(targets, "assets"), join(sourceRoot, "mirrored-assets"), directoryLinkType);

  const original = publicFiles.find((file) => file.urlPath === "/objects/data.bin")!;
  const target = join(targets, "shared.bin");
  const chain = join(targets, "chain.bin");

  await writeFile(target, original.bytes);

  await unlink(join(publicRoot, "objects", "data.bin"));

  await symlink(target, join(publicRoot, "objects", "data.bin"), "file");

  await symlink(target, chain, "file");

  await symlink(chain, join(publicRoot, "objects", "alias.bin"), "file");

  const relativeBytes = new Uint8Array([0x72, 0x65, 0x6c]);

  await mkdir(join(targets, "branch", "deep"), { recursive: true });

  await writeFile(join(targets, "branch", "shared.bin"), relativeBytes);

  await symlink(join(targets, "branch", "deep"), join(targets, "through"), directoryLinkType);

  await symlink(
    "../../source-files/through/../shared.bin",
    join(publicRoot, "objects", "native-relative.bin"),
    "file",
  );

  return [
    ...publicFiles,
    { ...original, relativePath: "objects/alias.bin", urlPath: "/objects/alias.bin" },
    {
      relativePath: "objects/native-relative.bin",
      urlPath: "/objects/native-relative.bin",
      bytes: process.platform === "win32" ? original.bytes : relativeBytes,
      contentType: "application/octet-stream",
    },
    ...publicFiles
      .filter((file) => file.relativePath.startsWith("assets/"))
      .map((file) => ({
        ...file,
        relativePath: file.relativePath.replace("assets/", "mirrored-assets/"),
        urlPath: file.urlPath.replace("/assets/", "/mirrored-assets/"),
      })),
  ].sort((left, right) =>
    left.urlPath < right.urlPath ? -1 : left.urlPath > right.urlPath ? 1 : 0,
  );
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function createDeadline(milliseconds: number) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("Development public-file journey timed out")),
    milliseconds,
  );

  return { signal: controller.signal, close: () => clearTimeout(timer) };
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason ?? new Error("Development public-file journey timed out"));

    signal.addEventListener("abort", onAbort, { once: true });
  });

  return Promise.race([promise, aborted]).finally(() => {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  });
}

function nextDevelopmentEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
) {
  const decoder = new TextDecoder();
  let pending = "";

  return async (): Promise<string> => {
    for (;;) {
      const boundary = pending.indexOf("\n\n");

      if (boundary >= 0) {
        const event = pending.slice(0, boundary);

        pending = pending.slice(boundary + 2);

        return event;
      }

      const chunk = await withAbort(reader.read(), signal);

      if (chunk.done) throw new Error("Development event stream closed before the expected event");

      pending += decoder.decode(chunk.value, { stream: true });
    }
  };
}

async function waitForPublicBytes(
  nextEvent: () => Promise<string>,
  url: URL,
  expected: Uint8Array,
  signal: AbortSignal,
): Promise<void> {
  for (;;) {
    const event = await nextEvent();

    if (!event.includes("data:")) continue;

    const response = await fetch(url, {
      headers: { accept: "application/octet-stream" },
      signal,
    });
    const actual = new Uint8Array(await response.arrayBuffer());

    if (response.status === 200 && sameBytes(actual, expected)) return;
  }
}

async function waitForPublicMiss(
  nextEvent: () => Promise<string>,
  url: URL,
  signal: AbortSignal,
): Promise<void> {
  for (;;) {
    const event = await nextEvent();

    if (!event.includes("data:")) continue;

    if (
      (
        await fetch(url, {
          headers: { accept: "application/octet-stream" },
          signal,
        })
      ).status === 404
    )
      return;
  }
}

async function buildFailure(root: string): Promise<string> {
  try {
    await prepareBuild(root);
  } catch (error) {
    const diagnostics =
      typeof error === "object" && error !== null && "diagnostics" in error
        ? JSON.stringify(error.diagnostics)
        : "";

    return `${String(error)} ${diagnostics}`.replaceAll("\\", "/");
  }

  throw new Error("Expected the invalid public-file build to fail");
}

function completion() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });

  return { promise, resolve };
}

interface ObservedWatch {
  readonly directory: string;
  closed: boolean;
  notify(filename: string | null): void;
  close(): void;
}

function observePublicWatches(root: string, context: () => unknown) {
  const originalWatch = filesystem.watch;
  const originalOpen = filesystemPromises.open;
  const canonicalRoot = String(filesystem.realpathSync(root));
  const records: ObservedWatch[] = [];
  const requests: { raw: string; canonical?: string; state: string }[] = [];
  const waiting: { directory: string; after: number; resolve(record: ObservedWatch): void }[] = [];
  const heldNotifications = new Set<string>();
  const handleSpies = new Set<{ mockRestore(): void }>();
  let failDirectory: string | undefined;
  let earlyNotificationDirectory: string | undefined;
  let beforeRegistration: { directory: string; run(): void } | undefined;
  let afterRead: { filename: string; run(): void } | undefined;
  let readIntercepted = false;
  let readRestored = false;
  let forwardedNativeCallbacks = 0;

  const isWithinFixture = (path: string): boolean => {
    const relativePath = relative(canonicalRoot, resolve(path));

    return (
      relativePath === "" ||
      (!isAbsolute(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${sep}`))
    );
  };

  const openSpy = spyOn(filesystemPromises, "open");

  try {
    openSpy.mockImplementation(((...args: Parameters<typeof filesystemPromises.open>) => {
      const filename = args[0];

      if (
        typeof filename !== "string" ||
        !isWithinFixture(filename) ||
        !afterRead ||
        filename !== afterRead.filename
      )
        return Reflect.apply(originalOpen, filesystemPromises, args);

      return (async () => {
        const handle = await Reflect.apply(originalOpen, filesystemPromises, args);

        try {
          const originalRead = handle.readFile;
          const readSpy = spyOn(handle, "readFile");

          handleSpies.add(readSpy);
          readSpy.mockImplementation((async (...readArguments: unknown[]) => {
            let bytes;
            let readFailed = false;
            let readFailure: unknown;

            try {
              bytes = await Reflect.apply(originalRead, handle, readArguments);
              const action = afterRead;

              if (action && filename === action.filename) {
                afterRead = undefined;
                readIntercepted = true;
                action.run();
              }
            } catch (error) {
              readFailed = true;
              readFailure = error;
            }

            try {
              readSpy.mockRestore();
              handleSpies.delete(readSpy);
              readRestored = handle.readFile === originalRead;
            } catch (cleanup) {
              if (readFailed)
                throw new AggregateError(
                  [readFailure, cleanup],
                  "Fixture read and spy restoration failed",
                );

              throw cleanup;
            }

            if (readFailed) throw readFailure;

            return bytes;
          }) as typeof handle.readFile);

          return handle;
        } catch (error) {
          try {
            await handle.close();
          } catch (cleanup) {
            throw new AggregateError(
              [error, cleanup],
              "Fixture read spy setup and handle close failed",
            );
          }

          throw error;
        }
      })();
    }) as typeof filesystemPromises.open);
  } catch (error) {
    try {
      openSpy.mockRestore();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "Fixture open spy setup rollback failed");
    }

    throw error;
  }

  let watchSpy: { mockRestore(): void } | undefined;

  try {
    const activeSpy = spyOn(filesystem, "watch");
    watchSpy = activeSpy;
    activeSpy.mockImplementation(((...args: Parameters<typeof filesystem.watch>) => {
      const raw = args[0];

      if (typeof raw !== "string") return Reflect.apply(originalWatch, filesystem, args);

      const request = { raw, canonical: undefined as string | undefined, state: "outside fixture" };
      requests.push(request);

      if (!isWithinFixture(raw)) return Reflect.apply(originalWatch, filesystem, args);

      let directory: string;

      try {
        directory = String(filesystem.realpathSync(raw));
      } catch {
        request.state = "unresolved";
        return Reflect.apply(originalWatch, filesystem, args);
      }

      request.canonical = directory;
      request.state = "outside canonical fixture";

      if (!isWithinFixture(directory)) return Reflect.apply(originalWatch, filesystem, args);

      const callbackIndex = typeof args[1] === "function" ? 1 : 2;
      const callback = (args as readonly unknown[])[callbackIndex];

      request.state = "no callback";

      if (typeof callback !== "function") return Reflect.apply(originalWatch, filesystem, args);

      if (directory === failDirectory) {
        request.state = "controlled failure";
        throw new Error(`Controlled Q10 watch registration failure: ${directory}`);
      }

      if (beforeRegistration && directory === beforeRegistration.directory) {
        const action = beforeRegistration;
        beforeRegistration = undefined;
        action.run();
      }

      request.state = "opening";
      const registration = Reflect.apply(originalWatch, filesystem, [
        ...args.slice(0, callbackIndex),
        function (this: filesystem.FSWatcher, event: string, filename: string | Buffer | null) {
          if (filename !== null) {
            const changed = resolve(directory, filename.toString());
            const controlled = [...heldNotifications].some((target) => {
              const fromTarget = relative(target, changed);
              const fromChange = relative(changed, target);

              return [fromTarget, fromChange].some(
                (path) => !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`),
              );
            });

            if (controlled) return;
          }

          forwardedNativeCallbacks++;
          Reflect.apply(callback, this, [event, filename]);
        },
      ]) as filesystem.FSWatcher;
      request.state = "native watch returned";
      const close = registration.close.bind(registration);
      const record: ObservedWatch = {
        directory,
        closed: false,
        notify(filename) {
          Reflect.apply(callback, registration, ["change", filename]);
        },
        close() {
          registration.close();
        },
      };

      registration.close = () => {
        close();
        record.closed = true;
      };
      records.push(record);

      if (directory === earlyNotificationDirectory) record.notify(null);

      for (const waiter of waiting)
        if (waiter.directory === directory && records.length > waiter.after) waiter.resolve(record);

      return registration;
    }) as typeof filesystem.watch);
  } catch (error) {
    const failures: unknown[] = [error];

    try {
      watchSpy?.mockRestore();
    } catch (cleanup) {
      failures.push(cleanup);
    }

    try {
      openSpy.mockRestore();
    } catch (cleanup) {
      failures.push(cleanup);
    }

    if (failures.length > 1)
      throw new AggregateError(failures, "Fixture spy setup rollback failed");

    throw error;
  }

  return {
    records,
    holdNotifications(...paths: string[]): void {
      for (const path of paths) heldNotifications.add(resolve(path));
    },
    registration(directory: string): ObservedWatch {
      const canonical = String(filesystem.realpathSync(directory));
      const record = records.find((item) => !item.closed && item.directory === canonical);

      if (!record)
        throw new Error(
          `No active native watch registration for ${directory}: ${JSON.stringify({
            root,
            canonicalRoot,
            canonical,
            requests,
            records: records.map(({ directory, closed }) => ({ directory, closed })),
            forwardedNativeCallbacks,
            context: context(),
          })}`,
        );

      return record;
    },
    waitFor(directory: string, after: number): Promise<ObservedWatch> {
      const canonical = String(filesystem.realpathSync(directory));
      const found = records
        .slice(after)
        .find((item) => !item.closed && item.directory === canonical);

      if (found) return Promise.resolve(found);

      return new Promise((resolve) => waiting.push({ directory: canonical, after, resolve }));
    },
    failAt(directory?: string): void {
      failDirectory =
        directory === undefined ? undefined : String(filesystem.realpathSync(directory));
    },
    notifyDuringRegistration(directory: string): void {
      earlyNotificationDirectory = String(filesystem.realpathSync(directory));
    },
    beforeRegistration(directory: string, run: () => void): void {
      beforeRegistration = { directory: String(filesystem.realpathSync(directory)), run };
    },
    afterRead(filename: string, run: () => void): void {
      afterRead = { filename: String(filesystem.realpathSync(filename)), run };
    },
    forwardedNativeCallbacks(): number {
      return forwardedNativeCallbacks;
    },
    readProbePassed(): boolean {
      return readIntercepted && readRestored;
    },
    restore(): void {
      const errors: unknown[] = [];

      for (const record of records) {
        try {
          if (!record.closed) record.close();
        } catch (error) {
          errors.push(error);
        }
      }

      for (const handleSpy of handleSpies) {
        try {
          handleSpy.mockRestore();
        } catch (error) {
          errors.push(error);
        }
      }

      try {
        watchSpy?.mockRestore();
      } catch (error) {
        errors.push(error);
      }

      try {
        openSpy.mockRestore();
      } catch (error) {
        errors.push(error);
      }

      if (filesystem.watch !== originalWatch || filesystemPromises.open !== originalOpen)
        errors.push(new Error("Fixture filesystem spies were not restored"));

      if (errors.length) throw new AggregateError(errors, "Fixture watcher cleanup failed");
    },
  };
}

test("one production capture serves exact assets at root and a nested mount", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-hosting-http-"));

  roots.push(root);

  await linkFrameworkPackages(root);

  await mkdir(join(root, "src/routes/early"), { recursive: true });

  await writeFile(join(root, "hesperia.config.json"), JSON.stringify({ mountURL: "/dashboard" }));

  await writeFile(
    join(root, "app.tsx"),
    await readFile(join(import.meta.dir, "fixtures/applications/production-host/app.tsx"), "utf8"),
  );

  await writeFile(
    join(root, "app.css"),
    await readFile(join(import.meta.dir, "fixtures/applications/production-host/app.css"), "utf8"),
  );

  await writeFile(
    join(root, "src/routes/+route.ts"),
    await readFile(
      join(import.meta.dir, "fixtures/applications/production-host/src/routes/+route.ts"),
      "utf8",
    ),
  );

  await writeFile(
    join(root, "src/routes/+page.tsx"),
    await readFile(
      join(import.meta.dir, "fixtures/applications/production-host/src/routes/+page.tsx"),
      "utf8",
    ),
  );

  await writeFile(
    join(root, "src/routes/home.css"),
    await readFile(
      join(import.meta.dir, "fixtures/applications/production-host/src/routes/home.css"),
      "utf8",
    ),
  );

  await writeFile(
    join(root, "src/routes/early/+page.tsx"),
    await readFile(
      join(import.meta.dir, "fixtures/applications/production-host/src/routes/early/http-page.tsx"),
      "utf8",
    ),
  );

  await writeFile(
    join(root, "src/routes/early/early.css"),
    await readFile(
      join(
        import.meta.dir,
        "fixtures/applications/production-host/src/routes/early/http-early.css",
      ),
      "utf8",
    ),
  );

  const build = await prepareBuild(root);

  expect(build.diagnostics).toStrictEqual([]);

  expect(build.hosting.version).toBe(1);

  expect(
    JSON.parse(await build.files.get("/hesperia-build.json")!.text()).hosting,
  ).not.toHaveProperty("publicFiles");

  expect(build.hosting.standaloneMountURL).toBe("/dashboard");

  const record = JSON.parse(await build.files.get("/hesperia-build.json")!.text()) as {
    readonly routeGuards: Readonly<Record<string, string>>;
    readonly routeTable: string;
  };

  const guardPath = record.routeGuards["src/routes/+route.ts"]!;

  expect(guardPath).toMatch(/^\/assets\/routes\/guard-.*\.js$/u);

  const routeTable = await build.files.get(record.routeTable)!.text();

  expect(routeTable).toContain('import("./routes/guard-');

  expect(routeTable).not.toContain('import("/assets/routes/guard-');

  const emittedJavaScript = (
    await Promise.all(
      [...build.files].filter(([path]) => path.endsWith(".js")).map(([, file]) => file.text()),
    )
  ).join("\n");

  expect(emittedJavaScript).not.toContain("SERVER_ROUTE_MARKER");

  await writeBuild(root, build);

  let rootServer: ProjectServer | undefined;

  let dashboardServer: ProjectServer | undefined;

  try {
    rootServer = await previewProject(root, 0, { mountURL: "/" });

    dashboardServer = await previewProject(root, 0, { mountURL: "/dashboard" });

    const mounts = [
      { server: rootServer, mount: "", path: "/early" },
      { server: dashboardServer, mount: "/dashboard", path: "/dashboard/early" },
    ];

    for (const fixture of mounts) {
      const assetBase = fixture.mount + "/_hesperia";

      const document = await fetch(new URL(fixture.path, fixture.server.url), {
        headers: { accept: "text/html" },
      });

      expect(document.status).toBe(200);

      expect(await document.text()).toContain(
        `<script type="module" src="${assetBase}/startup.js">`,
      );

      const wrapper = await fetch(new URL(assetBase + "/startup.js", fixture.server.url));

      expect(wrapper.status).toBe(200);

      expect(await wrapper.text()).toContain(`await start("${fixture.mount || "/"}")`);

      for (const asset of build.hosting.assets) {
        expect(build.files.get(asset.path)).toBeInstanceOf(Blob);

        const response = await fetch(new URL(assetBase + asset.path, fixture.server.url));

        expect(response.status).toBe(200);

        expect(response.headers.get("content-type")).toBe(asset.contentType);

        expect(sha256(new Uint8Array(await response.arrayBuffer()))).toBe(asset.sha256);
      }

      for (const asset of build.hosting.assets.filter((item) =>
        item.contentType.startsWith("text/javascript"),
      )) {
        const source = await build.files.get(asset.path)!.text();

        const moduleUrl = new URL(assetBase + asset.path, fixture.server.url);

        const specifiers = [
          ...source.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["'](\.{1,2}\/[^"']+)["']/gu),
        ].map((match) => match[1]!);

        for (const specifier of specifiers) {
          const importedUrl = new URL(specifier, moduleUrl);

          expect(importedUrl.pathname.startsWith(assetBase + "/assets/")).toBe(true);

          expect(importedUrl.pathname).not.toContain("/assets/assets/");

          expect((await fetch(importedUrl)).status).toBe(200);
        }
      }

      const guard = await fetch(new URL(assetBase + guardPath, fixture.server.url));

      expect(guard.status).toBe(200);

      expect(await guard.text()).not.toContain("SERVER_ROUTE_MARKER");

      expect(
        (await fetch(new URL(assetBase + "/assets/missing.js", fixture.server.url))).status,
      ).toBe(404);

      for (const path of [
        "/hesperia-build.json",
        "/src/routes/+route.ts",
        "/package.json",
        "/.hesperia/build/hesperia-build.json",
      ]) {
        const response = await fetch(new URL(path, fixture.server.url));

        expect(response.status).toBe(404);
      }

      if (fixture.mount) {
        for (const path of [
          "/hesperia-build.json",
          "/src/routes/+route.ts",
          "/package.json",
          "/.hesperia/build/hesperia-build.json",
        ]) {
          const response = await fetch(new URL(fixture.mount + path, fixture.server.url), {
            headers: { accept: "application/json" },
          });

          expect(response.status).toBe(404);
        }
      }
    }
  } finally {
    await dashboardServer?.close();

    await rootServer?.close();
  }
}, 45_000);

test("production captures public bytes through worker and in-process builds", async () => {
  const projects = [
    { format: "typescript" as const, mountURL: "/shop", linked: false },
    { format: "json" as const, mountURL: "/shop", linked: false },
    { format: "typescript" as const, mountURL: "/shop", linked: true },
    { format: "json" as const, mountURL: "/shop", linked: true },
  ];

  for (const project of projects) {
    const label = `${project.format}${project.linked ? "-linked" : ""}`;
    const root = await createProjectRoot(
      `hesperia-public-${label}-`,
      project.format,
      project.mountURL,
    );
    const publicRoot = join(root, "public");

    const files = project.linked ? await writeLinkedPublicFiles(root) : publicFiles;

    if (!project.linked) await writePublicFiles(root);

    await mkdir(join(root, "src", "routes", "objects", "[name]"), { recursive: true });

    await writeFile(
      join(root, "src", "routes", "objects", "[name]", "+page.tsx"),
      "export default function ObjectPage() { return <main>Dynamic route</main>; }\n",
    );

    const build = await prepareBuild(root);

    expect(build.hosting.version).toBe(2);

    if (build.hosting.version !== 2 || !("publicFiles" in build))
      throw new Error("A nonempty public directory must produce a version 2 build");

    expect(build.hosting.publicFiles).toStrictEqual(expectedPublicRecords(files));

    expect([...build.publicFiles.keys()].sort()).toStrictEqual(
      files.map((file) => file.urlPath).sort(),
    );

    expect(build.files.has("/hesperia-build.json")).toBe(true);

    await writeFile(
      join(publicRoot, "assets", "data.bin"),
      new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
    );

    await rm(publicRoot, { recursive: true, force: true });

    if (project.linked) {
      await rm(join(root, "source-public"), { recursive: true, force: true });

      await rm(join(root, "source-files"), { recursive: true, force: true });
    }

    await writeBuild(root, build);

    await rm(join(root, "src"), { recursive: true, force: true });

    await rm(join(root, "app.tsx"), { force: true });

    await rm(join(root, "hesperia.config.ts"), { force: true });

    await rm(join(root, "hesperia.config.json"), { force: true });

    await rm(join(root, "hesperia.d.ts"), { force: true });

    let rootServer: ProjectServer | undefined;

    let dashboardServer: ProjectServer | undefined;

    await withFixtureCleanup(async () => {
      rootServer = await previewProject(root, 0, { mountURL: "/" });

      dashboardServer = await previewProject(root, 0, { mountURL: "/shop" });

      for (const mount of [
        { server: rootServer, prefix: "" },
        { server: dashboardServer, prefix: "/shop" },
      ]) {
        for (const file of files) {
          const url = new URL(mount.prefix + file.urlPath, mount.server.url);
          const response = await fetch(url, {
            headers: {
              accept: file.urlPath === "/objects/data.bin" ? "text/html" : "application/json",
            },
          });

          expect(response.status).toBe(200);

          expect(response.headers.get("content-type")).toBe(file.contentType);

          expect([...new Uint8Array(await response.arrayBuffer())]).toStrictEqual([...file.bytes]);

          const head = await fetch(url, {
            method: "HEAD",
            headers: { accept: "text/html" },
          });

          expect(head.status).toBe(200);

          expect(head.headers.get("content-type")).toBe(file.contentType);

          expect(new Uint8Array(await head.arrayBuffer())).toHaveLength(0);
        }

        expect(
          (await fetch(new URL(mount.prefix + "/_hesperia/assets/data.bin", mount.server.url)))
            .status,
        ).toBe(404);
      }
    }, [() => dashboardServer?.close(), () => rootServer?.close()]);
  }
}, 150_000);

test("public collisions reject before replacing the last published build", async () => {
  const root = await createProjectRoot("hesperia-public-collision-", "json");
  const publicRoot = join(root, "public");
  const retained = new Uint8Array([0x6c, 0x61, 0x73, 0x74]);

  await mkdir(publicRoot, { recursive: true });

  await writeFile(join(publicRoot, "retained.bin"), retained);

  await writeBuild(root, await prepareBuild(root));

  const recordPath = join(root, ".hesperia", "build", "hesperia-build.json");
  const publishedRecord = await readFile(recordPath);

  await mkdir(join(root, "src", "routes", "about"), { recursive: true });

  await writeFile(
    join(root, "src", "routes", "about", "+page.tsx"),
    "export default function About() { return <main>About route</main>; }\n",
  );

  await writeFile(join(publicRoot, "about"), "route collision");

  const exactCollision = await buildFailure(root);

  expect(exactCollision).toContain("public/about");

  expect(exactCollision).toContain("src/routes/about/+page.tsx");

  expect(await readFile(recordPath)).toEqual(publishedRecord);

  await rm(join(publicRoot, "about"), { force: true });

  await rm(join(root, "src", "routes", "about"), { recursive: true, force: true });

  await mkdir(join(publicRoot, "_hesperia"), { recursive: true });

  await writeFile(join(publicRoot, "_hesperia", "internal.bin"), "reserved");

  const reservedCollision = await buildFailure(root);

  expect(reservedCollision).toContain("public/_hesperia/internal.bin");

  expect(reservedCollision).toContain("/_hesperia");

  expect(await readFile(recordPath)).toEqual(publishedRecord);

  await rm(join(publicRoot, "_hesperia"), { recursive: true, force: true });

  const outside = await mkdtemp(`${root}-outside-`);

  roots.push(outside);

  const canonicalOutside = await realpath(outside);

  await writeFile(join(outside, "secret.bin"), "outside project");

  const link = join(publicRoot, "link.bin");
  const hop = join(root, "hop.bin");
  const directoryLinkType = process.platform === "win32" ? "junction" : "dir";

  for (const kind of [
    "broken",
    "escape",
    "escape-and-return",
    "file-cycle",
    "directory-cycle",
  ] as const) {
    let linkCreated = false;
    let hopCreated = false;
    let returnCreated = false;

    await withFixtureCleanup(async () => {
      if (kind === "broken") await symlink(join(root, "missing.bin"), link, "file");
      else if (kind === "escape") await symlink(join(outside, "secret.bin"), link, "file");
      else if (kind === "escape-and-return") {
        await symlink(join(publicRoot, "retained.bin"), join(outside, "return.bin"), "file");
        returnCreated = true;
        await symlink(join(outside, "return.bin"), link, "file");
      } else if (kind === "file-cycle") {
        await symlink(link, hop, "file");
        hopCreated = true;
        await symlink(hop, link, "file");
      } else await symlink(publicRoot, link, directoryLinkType);
      linkCreated = true;

      const failure = await buildFailure(root);

      expect(failure).toContain("public/link.bin");

      expect(failure).toContain(
        kind === "escape" || kind === "escape-and-return"
          ? "escapes the project root"
          : kind === "directory-cycle" || kind === "file-cycle"
            ? "cycle"
            : "could not be resolved",
      );

      if (kind === "escape" || kind === "escape-and-return")
        expect(failure).toContain(
          join(canonicalOutside, kind === "escape" ? "secret.bin" : "return.bin").replaceAll(
            "\\",
            "/",
          ),
        );

      expect(await readFile(recordPath)).toEqual(publishedRecord);
    }, [
      () => (linkCreated ? unlink(link) : undefined),
      () => (hopCreated ? unlink(hop) : undefined),
      () => (returnCreated ? unlink(join(outside, "return.bin")) : undefined),
    ]);
  }

  const savedPublic = join(root, "saved-public");
  let publicSaved = false;
  let brokenRootCreated = false;

  await withFixtureCleanup(async () => {
    await rename(publicRoot, savedPublic);
    publicSaved = true;
    await symlink(join(root, "missing-public"), publicRoot, directoryLinkType);
    brokenRootCreated = true;

    expect(await buildFailure(root)).toContain("public source could not be resolved");

    expect(await readFile(recordPath)).toEqual(publishedRecord);
  }, [
    () => (brokenRootCreated ? unlink(publicRoot) : undefined),
    () => (publicSaved ? rename(savedPublic, publicRoot) : undefined),
  ]);

  let server: ProjectServer | undefined;

  try {
    server = await previewProject(root, 0);

    const response = await fetch(new URL("/retained.bin", server.url), {
      headers: { accept: "text/html" },
    });

    expect(response.status).toBe(200);

    expect([...new Uint8Array(await response.arrayBuffer())]).toStrictEqual([...retained]);
  } finally {
    await server?.close();
  }
}, 45_000);

async function verifyDevelopmentPublicFiles(format: ConfigurationFormat): Promise<void> {
  const root = await createProjectRoot(`hesperia-public-dev-${format}-`, format);
  const publicRoot = join(root, "public");
  const first = new Uint8Array([0x66, 0x69, 0x72, 0x73, 0x74]);
  const changed = new Uint8Array([0x63, 0x68, 0x61, 0x6e, 0x67, 0x65, 0x64]);
  const second = new Uint8Array([0x73, 0x65, 0x63, 0x6f, 0x6e, 0x64]);
  const reports: string[] = [];
  let server: ProjectServer | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let deadline: ReturnType<typeof createDeadline> | undefined;

  try {
    server = await devProject(root, {
      port: 0,
      report: (message) => reports.push(message),
    });
    deadline = createDeadline(55_000);

    const signal = deadline.signal;
    const missingRootResponse = await fetch(new URL("/first.bin", server.url), { signal });

    expect(missingRootResponse.status).toBe(404);

    const events = await fetch(new URL("/_hesperia/events", server.url), { signal });

    expect(events.status).toBe(200);

    reader = events.body!.getReader();

    const nextEvent = nextDevelopmentEvent(reader, signal);

    await nextEvent();

    await mkdir(publicRoot, { recursive: true });

    await writeFile(join(publicRoot, "first.bin"), first);

    await waitForPublicBytes(nextEvent, new URL("/first.bin", server.url), first, signal);

    await writeFile(join(publicRoot, "first.bin"), changed);

    await waitForPublicBytes(nextEvent, new URL("/first.bin", server.url), changed, signal);

    const reportsBeforeFailure = reports.length;

    await writeFile(join(root, "app.tsx"), "export default function App( {\n");

    let failureReport: string | undefined;

    for (;;) {
      const event = await nextEvent();
      const newReport = reports
        .slice(reportsBeforeFailure)
        .find((report) => event.includes(JSON.stringify(report)));

      if (newReport !== undefined) {
        failureReport = newReport;

        break;
      }
    }

    expect(failureReport).toBeDefined();

    expect(failureReport!.trim()).not.toBe("");

    const retained = await fetch(new URL("/first.bin", server.url), { signal });

    expect(retained.status).toBe(200);

    expect([...new Uint8Array(await retained.arrayBuffer())]).toStrictEqual([...changed]);

    await writeFile(
      join(root, "app.tsx"),
      `export default function App(props: { children: () => unknown }) {\n  return <html><head></head><body>{props.children()}</body></html>;\n}\n`,
    );

    await writeFile(join(publicRoot, "second.bin"), second);

    await waitForPublicBytes(nextEvent, new URL("/second.bin", server.url), second, signal);

    await rm(join(publicRoot, "first.bin"), { force: true });

    await waitForPublicMiss(nextEvent, new URL("/first.bin", server.url), signal);

    const retainedSecond = await fetch(new URL("/second.bin", server.url), { signal });

    expect([...new Uint8Array(await retainedSecond.arrayBuffer())]).toStrictEqual([...second]);

    if (format === "typescript") {
      await mkdir(join(root, "src", "routes", "about"), { recursive: true });

      await writeFile(
        join(root, "src", "routes", "about", "+page.tsx"),
        "export default function About() { return <main>About route</main>; }\n",
      );

      const routeReady = new TextEncoder().encode("route-ready");

      await writeFile(join(publicRoot, "second.bin"), routeReady);

      await waitForPublicBytes(nextEvent, new URL("/second.bin", server.url), routeReady, signal);

      const reportsBeforeCollision = reports.length;

      await writeFile(join(publicRoot, "about"), "literal page collision");

      let collisionReport: string | undefined;

      for (;;) {
        const event = await nextEvent();

        collisionReport = reports
          .slice(reportsBeforeCollision)
          .find((report) => event.includes(JSON.stringify(report)));

        if (collisionReport !== undefined) break;
      }

      const normalizedCollision = collisionReport!.replaceAll("\\", "/");

      expect(normalizedCollision).toContain("public/about");

      expect(normalizedCollision).toContain("src/routes/about/+page.tsx");

      const retainedAfterCollision = await fetch(new URL("/second.bin", server.url), { signal });

      expect(retainedAfterCollision.status).toBe(200);

      expect([...new Uint8Array(await retainedAfterCollision.arrayBuffer())]).toStrictEqual([
        ...routeReady,
      ]);

      await rm(join(publicRoot, "about"), { force: true });

      const recovered = new TextEncoder().encode("collision-recovered");

      await writeFile(join(publicRoot, "second.bin"), recovered);

      await waitForPublicBytes(nextEvent, new URL("/second.bin", server.url), recovered, signal);
    }

    await rm(join(publicRoot, "second.bin"), { force: true });

    await waitForPublicMiss(nextEvent, new URL("/second.bin", server.url), signal);

    const empty = await prepareBuild(root);

    expect(empty.hosting.version).toBe(1);

    expect("publicFiles" in empty).toBe(false);
  } finally {
    deadline?.close();

    await reader?.cancel().catch(() => undefined);

    await server?.close();
  }
}

test("development updates public files through worker and in-process builds", async () => {
  for (const format of ["typescript", "json"] as const) await verifyDevelopmentPublicFiles(format);
}, 180_000);

async function verifyDevelopmentLinkedTarget(format: ConfigurationFormat): Promise<void> {
  const root = await createProjectRoot(`hesperia-q10-target-${format}-`, format);
  const publicRoot = join(root, "public");
  const firstTarget = join(root, "linked-source");
  const nextTarget = join(root, "linked-replacement");
  const removedTarget = join(root, "linked-replacement-away");
  const alias = join(publicRoot, "linked");
  const directoryLinkType = process.platform === "win32" ? "junction" : "dir";
  const first = new TextEncoder().encode("first-target");
  const updated = new TextEncoder().encode("updated-first-target");
  const replacement = new TextEncoder().encode("replacement-target");
  const restored = new TextEncoder().encode("restored-target");
  const reports: string[] = [];
  let linked = false;
  let server: ProjectServer | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let deadline: ReturnType<typeof createDeadline> | undefined;

  await withFixtureCleanup(async () => {
    await mkdir(publicRoot);
    await mkdir(firstTarget);
    await mkdir(nextTarget);
    await writeFile(join(firstTarget, "live.bin"), first);
    await writeFile(join(nextTarget, "live.bin"), replacement);
    await symlink(firstTarget, alias, directoryLinkType);
    linked = true;

    server = await devProject(root, { port: 0, report: (message) => reports.push(message) });
    deadline = createDeadline(150_000);
    const signal = deadline.signal;
    const linkedURL = new URL("/linked/live.bin", server.url);
    const initial = await fetch(linkedURL, { signal });

    expect(initial.status).toBe(200);
    expect([...new Uint8Array(await initial.arrayBuffer())]).toStrictEqual([...first]);

    const events = await fetch(new URL("/_hesperia/events", server.url), { signal });
    expect(events.status).toBe(200);
    reader = events.body!.getReader();
    const nextEvent = nextDevelopmentEvent(reader, signal);
    await nextEvent();

    await writeFile(join(firstTarget, "live.bin"), updated);
    await waitForPublicBytes(nextEvent, linkedURL, updated, signal);

    await unlink(alias);
    linked = false;
    await symlink(nextTarget, alias, directoryLinkType);
    linked = true;
    await waitForPublicBytes(nextEvent, linkedURL, replacement, signal);

    const reportsBeforeFailure = reports.length;
    await rename(nextTarget, removedTarget);

    for (;;) {
      const event = await nextEvent();
      const failure = reports.slice(reportsBeforeFailure).find((message) => {
        const normalized = message.replaceAll("\\", "/");

        return (
          normalized.includes("public source could not be resolved (broken or cyclic link)") &&
          normalized.includes(alias.replaceAll("\\", "/")) &&
          event.includes(JSON.stringify(message))
        );
      });

      if (failure !== undefined) break;
    }

    const lastGood = await fetch(linkedURL, { signal });
    expect(lastGood.status).toBe(200);
    expect([...new Uint8Array(await lastGood.arrayBuffer())]).toStrictEqual([...replacement]);

    await writeFile(join(removedTarget, "live.bin"), restored);
    await rename(removedTarget, nextTarget);
    await waitForPublicBytes(nextEvent, linkedURL, restored, signal);
  }, [
    () => deadline?.close(),
    () => reader?.cancel(),
    () => server?.close(),
    () => (linked ? unlink(alias) : undefined),
  ]);
}

test("development follows a changed public link target and retains bytes on failure", async () => {
  for (const format of ["typescript", "json"] as const) await verifyDevelopmentLinkedTarget(format);
}, 330_000);

test("a missing-watch report can close a real changed development build", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-real-report-close-"));

  const phase = createDeadline(150_000);
  let cleanup: ReturnType<typeof createDeadline> | undefined;
  let server: ProjectServer | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let readerTerminal:
    | Promise<{ readonly kind: "closed" } | { readonly kind: "errored"; readonly error: unknown }>
    | undefined;
  let matchedReaderError = false;
  let startupSucceeded = false;
  let closeSettled = false;
  let closeSucceeded = false;
  let closeObserved = false;
  let closing = false;
  let readerRetired = false;
  let bodyCompleted = false;
  let operationRejected = false;
  let streamSettledBeforeClose = false;
  let revisionSignal: AbortSignal | undefined;
  let signalWasLive = false;
  let signalAbortedDuringClose = false;
  const builds: {
    initial?: Awaited<ReturnType<typeof prepareBuild>>;
    changed?: Awaited<ReturnType<typeof prepareBuild>>;
  } = {};
  let shutdown: Promise<{ ok: true } | { ok: false; error: unknown }> | undefined;
  const pendingOperations = new Set<Promise<unknown>>();

  function track<T>(operation: Promise<T>): Promise<T> {
    pendingOperations.add(operation);
    void operation.then(
      () => pendingOperations.delete(operation),
      () => {
        pendingOperations.delete(operation);
        operationRejected = true;
      },
    );

    return operation;
  }

  const beginClose = () => {
    if (!server || shutdown) return;

    shutdown = server.close().then(
      () => {
        closeSettled = true;
        closeSucceeded = true;
        return { ok: true as const };
      },
      (error: unknown) => {
        closeSettled = true;
        return { ok: false as const, error };
      },
    );
  };

  const observeClose = async (signal: AbortSignal) => {
    beginClose();

    if (!shutdown || closeObserved) return;

    closeObserved = true;
    const result = await withAbort(shutdown, signal);

    if (!result.ok) throw result.error;
  };

  await withFixtureCleanup(async () => {
    await withAbort(track(linkFrameworkPackages(root)), phase.signal);
    await withAbort(track(mkdir(join(root, "src", "routes"), { recursive: true })), phase.signal);
    await withAbort(
      track(
        writeFile(
          join(root, "src", "routes", "+page.tsx"),
          "export default function Home() { return <main>Public file host</main>; }\n",
        ),
      ),
      phase.signal,
    );

    const canonicalRoot = await withAbort(track(realpath(root)), phase.signal);
    const app = join(root, "app.tsx");
    const replacement = join(root, "app.next");
    const trigger = join(root, "enable-watch");
    const parent = join(canonicalRoot, "dependency");
    const missing = join(parent, "later");
    const missingReport = `Development watch directory is missing: ${missing}; watching for its creation`;
    let reportReached!: () => void;
    const reported = new Promise<void>((resolve) => {
      reportReached = resolve;
    });
    const appSource = (value: string) =>
      `export default function App(props: { children: () => unknown }) { return <html><head></head><body><p>${value}</p>{props.children()}</body></html>; }\n`;

    await withAbort(track(mkdir(parent)), phase.signal);
    await withAbort(track(writeFile(app, appSource("initial"))), phase.signal);
    await withAbort(
      track(
        writeFile(
          join(root, "hesperia.config.ts"),
          `import { existsSync } from "node:fs";
import { defineConfig } from "@hesperia/tooling";
const trigger = ${JSON.stringify(trigger)};
const missing = ${JSON.stringify(missing)};
export default defineConfig({ plugins: [{ name: "real-report-close", analyzeProject() { return { watch: existsSync(trigger) ? [{ kind: "directory", dir: missing }] : [] }; } }] });
`,
        ),
      ),
      phase.signal,
    );

    const starting = track(
      devProject(
        root,
        {
          port: 0,
          report: (message) => {
            if (message !== missingReport || !server || shutdown) return;

            signalWasLive = revisionSignal !== undefined && !revisionSignal.aborted;
            closing = true;
            beginClose();
            signalAbortedDuringClose = revisionSignal?.aborted === true;
            reportReached();
          },
        },
        async (project, signal) => {
          const build = await track(prepareBuild(project, true));

          if (!builds.initial) builds.initial = build;

          if (build.watch?.some((item) => item.kind === "directory" && item.dir === missing)) {
            builds.changed = build;
            revisionSignal = signal;
          }

          return build;
        },
      ).then((started) => {
        startupSucceeded = true;
        server = started;
        return started;
      }),
    );

    server = await withAbort(starting, phase.signal);
    const initial = await withAbort(
      track(fetch(server.url, { signal: phase.signal, headers: { accept: "text/html" } })),
      phase.signal,
    );

    expect(initial.status).toBe(200);
    await withAbort(track(initial.arrayBuffer()), phase.signal);

    const events = await withAbort(
      track(fetch(new URL("/_hesperia/events", server.url), { signal: phase.signal })),
      phase.signal,
    );

    expect(events.status).toBe(200);

    reader = events.body!.getReader();
    readerTerminal = reader.closed.then(
      () => ({ kind: "closed" as const }),
      (error: unknown) => ({ kind: "errored" as const, error }),
    );
    const nextEvent = nextDevelopmentEvent(reader, phase.signal);

    expect(await track(nextEvent())).toContain(": connected");

    const pendingStream = track(
      nextEvent().then(
        (event) => {
          if (!closing) streamSettledBeforeClose = true;

          return { event };
        },
        (error: unknown) => {
          if (!closing) streamSettledBeforeClose = true;

          return { error };
        },
      ),
    );

    await withAbort(track(writeFile(trigger, "enabled")), phase.signal);
    await withAbort(track(writeFile(replacement, appSource("changed"))), phase.signal);
    await withAbort(track(rename(replacement, app)), phase.signal);
    await withAbort(reported, phase.signal);

    const initialBuild = builds.initial;
    const changedBuild = builds.changed;

    expect(initialBuild).toBeDefined();
    expect(changedBuild).toBeDefined();

    if (!initialBuild || !changedBuild) throw new Error("Real build evidence was not retained");

    expect(JSON.stringify(changedBuild.hosting.assets)).not.toBe(
      JSON.stringify(initialBuild.hosting.assets),
    );
    expect(signalWasLive).toBe(true);
    expect(signalAbortedDuringClose).toBe(true);

    await observeClose(phase.signal);
    const finalEvent = await withAbort(pendingStream, phase.signal);

    expect(streamSettledBeforeClose).toBe(false);
    expect("error" in finalEvent).toBe(true);

    if (!readerTerminal || !("error" in finalEvent))
      throw new Error("Development event reader has no observed terminal error");

    const terminal = await withAbort(track(readerTerminal), phase.signal);

    if (terminal.kind === "errored") {
      if (!Object.is(terminal.error, finalEvent.error))
        throw new AggregateError(
          [finalEvent.error, terminal.error],
          "Development event and reader terminal errors differ",
        );

      matchedReaderError = true;
    }

    if (phase.signal.aborted) throw phase.signal.reason;

    const stopped = await withAbort(
      track(
        fetch(server.url, { signal: phase.signal }).then(
          () => false,
          () => true,
        ),
      ),
      phase.signal,
    );

    if (phase.signal.aborted) throw phase.signal.reason;

    expect(stopped).toBe(true);
    bodyCompleted = true;
  }, [
    () => {
      phase.close();
      cleanup = createDeadline(15_000);
    },
    () => observeClose(cleanup!.signal),
    async () => {
      if (!reader) return;

      if (!matchedReaderError) await withAbort(track(reader.cancel()), cleanup!.signal);

      reader.releaseLock();
      readerRetired = true;
    },
    async () => {
      if (
        !bodyCompleted ||
        !startupSucceeded ||
        !closeSettled ||
        !closeSucceeded ||
        !readerRetired ||
        phase.signal.aborted ||
        cleanup!.signal.aborted ||
        operationRejected ||
        pendingOperations.size > 0
      )
        throw new Error(`Report-close fixture retained after failure or unsettled work: ${root}`);

      await withAbort(track(unlinkFrameworkPackages(root)), cleanup!.signal);

      if (cleanup!.signal.aborted || operationRejected || pendingOperations.size > 0)
        throw new Error(`Report-close fixture retained after incomplete unlink: ${root}`);

      cleanup!.close();
      await rm(root, { recursive: true, force: true });
    },
    () => cleanup?.close(),
  ]);
}, 240_000);

test("public dependency replacement and rollback use the existing native watcher boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-public-watch-order-"));

  const publicRoot = join(root, "public");
  const directories = Object.fromEntries(
    ["a", "b", "aa-addition", "zz-addition", "failed-one", "failed-two", "held-failure"].map(
      (name) => [name, join(root, name)],
    ),
  );
  const bytes = (value: string) => new TextEncoder().encode(value);
  const initial = bytes("same bytes");
  const changed = bytes("B changed");
  const recovered = bytes("registration recovered");
  const repaired = bytes("missing target repaired");
  const final = bytes("current root-file target");
  const alias = join(publicRoot, "live.bin");
  const rootFile = join(root, "root-target.bin");

  let watches: ReturnType<typeof observePublicWatches> | undefined;
  let bodyCompleted = false;
  let serverClosed = false;
  let readerRetired = false;
  let spiesRestored = false;
  let startupSucceeded = false;
  let operationRejected = false;
  let cleanup: ReturnType<typeof createDeadline> | undefined;
  const pendingOperations = new Set<Promise<unknown>>();

  function track<T>(operation: Promise<T>): Promise<T> {
    pendingOperations.add(operation);
    void operation.then(
      () => pendingOperations.delete(operation),
      () => {
        pendingOperations.delete(operation);
        operationRejected = true;
      },
    );

    return operation;
  }
  const heldFailureStarted = completion();
  const releaseFailure = completion();
  const obsoleteAborted = completion();
  const reports: string[] = [];
  const reportWaiters: { after: number; match(message: string): boolean; resolve(): void }[] = [];
  let preparations = 0;
  let lastPreparedWatchTargets: Awaited<ReturnType<typeof prepareBuild>>["watch"];
  let holdFailure = false;
  let server: ProjectServer | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const deadline = createDeadline(210_000);
  const signal = deadline.signal;

  const nextReport = (after: number, match: (message: string) => boolean): Promise<void> =>
    withAbort(
      reports.slice(after).some(match)
        ? Promise.resolve()
        : new Promise<void>((resolve) => reportWaiters.push({ after, match, resolve })),
      signal,
    );

  await withFixtureCleanup(async () => {
    await withAbort(track(linkFrameworkPackages(root)), signal);
    await withAbort(track(mkdir(join(root, "src", "routes"), { recursive: true })), signal);
    await withAbort(
      track(
        writeFile(
          join(root, "app.tsx"),
          `export default function App(props: { children: () => unknown }) {
  return <html><head></head><body>{props.children()}</body></html>;
}
`,
        ),
      ),
      signal,
    );
    await withAbort(
      track(
        writeFile(
          join(root, "src", "routes", "+page.tsx"),
          "export default function Home() { return <main>Public file host</main>; }\n",
        ),
      ),
      signal,
    );
    await withAbort(
      track(writeFile(join(root, "hesperia.config.json"), JSON.stringify({ mountURL: "/" }))),
      signal,
    );
    await withAbort(track(mkdir(publicRoot)), signal);

    for (const directory of Object.values(directories))
      await withAbort(track(mkdir(directory)), signal);

    for (const name of ["a", "b", "aa-addition", "zz-addition"])
      await withAbort(track(writeFile(join(directories[name]!, "live.bin"), initial)), signal);

    await withAbort(track(writeFile(rootFile, final)), signal);
    await withAbort(track(symlink(join(directories.a!, "live.bin"), alias, "file")), signal);

    const observed = observePublicWatches(root, () => ({
      preparations,
      reports,
      lastPreparedWatchTargets,
    }));
    watches = observed;
    observed.holdNotifications(publicRoot, rootFile, ...Object.values(directories));

    const activeServer = await withAbort(
      track(
        devProject(
          root,
          {
            port: 0,
            report(message) {
              reports.push(message);

              for (const waiter of reportWaiters)
                if (reports.length > waiter.after && waiter.match(message)) waiter.resolve();
            },
          },
          async (project, attemptSignal) => {
            preparations++;
            const held = holdFailure;
            holdFailure = false;

            if (held)
              attemptSignal?.addEventListener("abort", obsoleteAborted.resolve, { once: true });

            try {
              const prepared = await prepareBuild(project, true);
              lastPreparedWatchTargets = prepared.watch;
              return prepared;
            } catch (error) {
              if (held) {
                heldFailureStarted.resolve();

                await releaseFailure.promise;
              }

              throw error;
            }
          },
        ).then((started) => {
          startupSucceeded = true;
          server = started;
          return started;
        }),
      ),
      signal,
    );
    server = activeServer;
    reader = (
      await fetch(new URL("/_hesperia/events?updateProtocol=2", activeServer.url), { signal })
    ).body!.getReader();
    const nextEvent = nextDevelopmentEvent(reader, signal);

    await nextEvent();

    const liveURL = new URL("/live.bin", activeServer.url);
    expect(observed.records.length).toBeGreaterThan(0);

    const oldWatch = observed.registration(directories.a!);
    const beforeRetarget = observed.records.length;

    await unlink(alias);

    await symlink(join(directories.b!, "live.bin"), alias, "file");

    observed.registration(publicRoot).notify("live.bin");

    const currentWatch = await withAbort(observed.waitFor(directories.b!, beforeRetarget), signal);

    expect(oldWatch.closed).toBe(true);

    expect([
      ...new Uint8Array(await (await fetch(liveURL, { signal })).arrayBuffer()),
    ]).toStrictEqual([...initial]);

    const beforeOldNotification = preparations;

    await writeFile(join(directories.a!, "live.bin"), bytes("obsolete A"));

    oldWatch.notify("live.bin");

    observed.registration(root).notify("a");

    expect(preparations).toBe(beforeOldNotification);

    await writeFile(join(directories.b!, "live.bin"), changed);

    currentWatch.notify(null);

    await waitForPublicBytes(nextEvent, liveURL, changed, signal);

    const beforeUnrelated = preparations;
    const afterUnrelated = bytes("B after unrelated notification");

    await writeFile(join(directories.b!, "live.bin"), afterUnrelated);

    observed.registration(directories.b!).notify("unrelated.bin");

    expect(preparations).toBe(beforeUnrelated);

    observed.registration(directories.b!).notify("live.bin");

    await waitForPublicBytes(nextEvent, liveURL, afterUnrelated, signal);

    const gapDirectory = join(root, "read-watch-gap");
    const gapTarget = join(gapDirectory, "live.bin");
    const gapCaptured = bytes("captured before registration");
    const gapLatest = bytes("changed before registration");
    const beforeGap = observed.records.length;
    let changedBeforeRegistration = false;

    await mkdir(gapDirectory);

    await writeFile(gapTarget, gapCaptured);

    observed.holdNotifications(gapDirectory);
    observed.beforeRegistration(gapDirectory, () => {
      filesystem.writeFileSync(gapTarget, gapLatest);

      changedBeforeRegistration = true;
    });

    await unlink(alias);

    await symlink(gapTarget, alias, "file");

    const beforeGapCallbacks = observed.forwardedNativeCallbacks();

    observed.registration(publicRoot).notify("live.bin");

    await withAbort(observed.waitFor(gapDirectory, beforeGap), signal);

    expect(changedBeforeRegistration).toBe(true);

    await waitForPublicBytes(nextEvent, liveURL, gapLatest, signal);

    expect(observed.forwardedNativeCallbacks()).toBe(beforeGapCallbacks);

    const sharedLatest = bytes("root target changed before binding");
    const sharedRootWatch = observed.registration(root);
    const beforeSharedTarget = observed.records.length;
    let changedBeforeBinding = false;

    observed.afterRead(rootFile, () => {
      filesystem.writeFileSync(rootFile, sharedLatest);

      changedBeforeBinding = true;
    });

    await unlink(alias);

    await symlink(rootFile, alias, "file");

    const beforeSharedCallbacks = observed.forwardedNativeCallbacks();

    observed.registration(publicRoot).notify("live.bin");

    await waitForPublicBytes(nextEvent, liveURL, sharedLatest, signal);

    expect(observed.forwardedNativeCallbacks()).toBe(beforeSharedCallbacks);

    expect(changedBeforeBinding).toBe(true);

    expect(observed.readProbePassed()).toBe(true);

    expect(observed.registration(root)).toBe(sharedRootWatch);

    expect(
      observed.records
        .slice(beforeSharedTarget)
        .some((record) => record.directory === sharedRootWatch.directory),
    ).toBe(false);

    await writeFile(rootFile, final);

    await unlink(alias);

    await symlink(join(directories.b!, "live.bin"), alias, "file");

    observed.registration(publicRoot).notify("live.bin");

    await waitForPublicBytes(nextEvent, liveURL, afterUnrelated, signal);

    const beforeAdditions = observed.records.length;
    const oldRegistrations = observed.records.filter((record) => !record.closed);
    const reportsBeforeRollback = reports.length;
    const directoryLinkType = process.platform === "win32" ? "junction" : "dir";

    await symlink(directories["aa-addition"]!, join(publicRoot, "0-left"), directoryLinkType);

    await symlink(directories["zz-addition"]!, join(publicRoot, "1-right"), directoryLinkType);

    observed.failAt(directories["zz-addition"]!);
    observed.notifyDuringRegistration(directories["aa-addition"]!);
    observed.registration(publicRoot).notify("0-left");

    await nextReport(reportsBeforeRollback, (message) =>
      message.includes("Controlled Q10 watch registration failure"),
    );

    const openedAdditions = observed.records.slice(beforeAdditions);

    expect(openedAdditions.length).toBeGreaterThan(0);

    expect(openedAdditions.every((record) => record.closed)).toBe(true);

    expect(oldRegistrations.every((record) => !record.closed)).toBe(true);

    const beforeRetiredAdditions = preparations;

    for (const record of openedAdditions) record.notify(null);

    expect(preparations).toBe(beforeRetiredAdditions);

    expect([
      ...new Uint8Array(await (await fetch(liveURL, { signal })).arrayBuffer()),
    ]).toStrictEqual([...afterUnrelated]);

    expect(
      (
        await fetch(new URL("/0-left/live.bin", activeServer.url), {
          headers: { accept: "application/octet-stream" },
          signal,
        })
      ).status,
    ).toBe(404);

    observed.failAt();

    await unlink(join(publicRoot, "0-left"));

    await unlink(join(publicRoot, "1-right"));

    await writeFile(join(directories.b!, "live.bin"), recovered);

    observed.registration(directories.b!).notify("live.bin");

    await waitForPublicBytes(nextEvent, liveURL, recovered, signal);

    const beforeFirstFailure = observed.records.length;
    const reportsBeforeFirstFailure = reports.length;
    const preparationsBeforeFirstFailure = preparations;

    await unlink(alias);

    await symlink(
      join(directories["failed-one"]!, "nested", "deeper", "missing.bin"),
      alias,
      "file",
    );

    observed.registration(publicRoot).notify("live.bin");

    const firstFailureWatch = await withAbort(
      observed.waitFor(directories["failed-one"]!, beforeFirstFailure),
      signal,
    );

    await nextReport(reportsBeforeFirstFailure + 1, (message) => message.includes("public source"));

    expect(preparations - preparationsBeforeFirstFailure).toBe(2);

    const beforeSecondFailure = observed.records.length;

    await unlink(alias);

    await symlink(join(directories["failed-two"]!, "missing.bin"), alias, "file");

    observed.registration(publicRoot).notify("live.bin");

    const secondFailureWatch = await withAbort(
      observed.waitFor(directories["failed-two"]!, beforeSecondFailure),
      signal,
    );

    expect(firstFailureWatch.closed).toBe(true);

    const beforeObsoleteFailure = preparations;

    firstFailureWatch.notify("missing.bin");

    observed.registration(root).notify("failed-one");

    expect(preparations).toBe(beforeObsoleteFailure);

    expect([
      ...new Uint8Array(await (await fetch(liveURL, { signal })).arrayBuffer()),
    ]).toStrictEqual([...recovered]);

    await writeFile(join(directories["failed-two"]!, "missing.bin"), repaired);

    secondFailureWatch.notify("missing.bin");

    await waitForPublicBytes(nextEvent, liveURL, repaired, signal);

    const beforeStaleFailure = observed.records.length;
    holdFailure = true;

    await unlink(alias);

    await symlink(join(directories["held-failure"]!, "missing.bin"), alias, "file");

    observed.registration(publicRoot).notify("live.bin");

    await withAbort(heldFailureStarted.promise, signal);

    await unlink(alias);

    await symlink(rootFile, alias, "file");

    observed.registration(publicRoot).notify("live.bin");

    await withAbort(obsoleteAborted.promise, signal);

    releaseFailure.resolve();

    await waitForPublicBytes(nextEvent, liveURL, final, signal);

    expect(
      observed.records
        .slice(beforeStaleFailure)
        .some(
          (record) =>
            record.directory === String(filesystem.realpathSync(directories["held-failure"]!)),
        ),
    ).toBe(false);

    const finalChanged = bytes("root-file changed");

    await writeFile(rootFile, finalChanged);

    observed.registration(root).notify("root-target.bin");

    await waitForPublicBytes(nextEvent, liveURL, finalChanged, signal);

    bodyCompleted = true;
  }, [
    () => releaseFailure.resolve(),
    () => {
      deadline.close();
      cleanup = createDeadline(15_000);
    },
    async () => {
      if (!reader) return;

      await withAbort(track(reader.cancel()), cleanup!.signal);
      readerRetired = true;
    },
    async () => {
      if (!startupSucceeded || !server) return;

      await withAbort(track(server.close()), cleanup!.signal);
      serverClosed = true;
    },
    () => {
      if (!watches) return;
      if (!startupSucceeded || !serverClosed)
        throw new Error(`Retained Q10 watcher spies after uncertain server retirement: ${root}`);

      watches.restore();
      spiesRestored = true;
    },
    async () => {
      if (
        !bodyCompleted ||
        !startupSucceeded ||
        !readerRetired ||
        !serverClosed ||
        !spiesRestored ||
        signal.aborted ||
        cleanup!.signal.aborted ||
        operationRejected ||
        pendingOperations.size > 0
      )
        throw new Error(`Retained Q10 watcher fixture after failure or unsettled work: ${root}`);

      await withAbort(track(unlinkFrameworkPackages(root)), cleanup!.signal);

      if (cleanup!.signal.aborted || operationRejected || pendingOperations.size > 0)
        throw new Error(`Retained Q10 watcher fixture after incomplete unlink: ${root}`);

      cleanup!.close();
      await rm(root, { recursive: true, force: true });
    },
    () => cleanup?.close(),
  ]);
}, 240_000);
