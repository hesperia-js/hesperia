import { afterEach, expect, test } from "bun:test";
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
import { dirname, join } from "node:path";
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
