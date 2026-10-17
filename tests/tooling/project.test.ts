import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  checkSources,
  initProject,
  prepareBuild,
  ProjectError,
  readProject,
  writeBuild,
} from "../../packages/tooling/src/project.ts";
import { devProject, previewProject } from "../../packages/tooling/src/server.ts";
import { createHost, readBuild } from "../../packages/hosting/src/index.ts";
import { captureRejection } from "./capture-rejection.ts";
import { linkFrameworkPackages, unlinkFrameworkPackages } from "./fixture-dependencies.ts";
import { identityMappings, pluginSourceMap } from "./plugin-source-map-fixture.ts";
import type { Plugin } from "../../packages/tooling/src/plugins.ts";

const roots: string[] = [];

async function temporaryProject(linkPackages = true): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hesperia-tooling-"));

  if (linkPackages) await linkFrameworkPackages(root);

  roots.push(root);

  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await unlinkFrameworkPackages(root);

    await rm(root, { recursive: true, force: true });
  }
});

describe("project commands", () => {
  test("checks imported modules outside src in the same source snapshot", async () => {
    const root = await temporaryProject();

    await mkdir(join(root, "src/routes"), { recursive: true });

    await writeFile(
      join(root, "src/routes/+page.tsx"),
      'import { api } from "../../api.ts"; export default function Page() { return <main>{api}</main>; }',
    );

    await writeFile(join(root, "api.ts"), 'export { api } from "./backend.ts";');

    await writeFile(join(root, "backend.ts"), "export const api: string = 42;");

    const sources = await readProject(root);

    expect(sources.get(join(root, "api.ts"))).toContain('"./backend.ts"');

    expect(sources.get(join(root, "backend.ts"))).toContain("42");

    const diagnostics = await checkSources(sources, root);

    expect(
      diagnostics.some(
        (item) => item.code === "TS2322" && item.filename === join(root, "backend.ts"),
      ),
    ).toBe(true);

    expect(await captureRejection(prepareBuild(root))).toMatchObject({
      message: expect.stringContaining("checking failed"),
    });
  });

  test("maps transformed diagnostics to the mapped source and its captured text", async () => {
    const root = await temporaryProject();
    const filename = join(root, "author.ts");
    const vendor = join(root, "vendor.ts");
    const authored = "export const authored: string = 1;\nexport const retained = true;";
    const injected = 'export const fromVendor: number = "wrong";';
    const authoredLines = authored.split("\n");
    const plugin: Plugin = {
      name: "mapped-diagnostic-fixture",

      transformSource(input) {
        if (input.filename !== filename) return undefined;

        return {
          code: `${injected}\n${input.current}`,
          map: pluginSourceMap(
            [
              { filename: vendor, content: injected },
              { filename, content: input.current },
            ],
            identityMappings([
              { generatedLine: 0, sourceIndex: 0, originalLine: 0, text: injected },
              ...authoredLines.map((text, originalLine) => ({
                generatedLine: originalLine + 1,
                sourceIndex: 1,
                originalLine,
                text,
              })),
            ]),
          ),
        };
      },
    };

    const diagnostics = await checkSources(new Map([[filename, authored]]), root, {
      allowUnsafeHTML: false,
      mountURL: "/",
      resolutionOverrides: { browser: {} },
      plugins: [plugin],
    });
    const authorDiagnostics = diagnostics.filter(
      (item) => item.code === "TS2322" && item.filename === filename,
    );
    const vendorDiagnostic = diagnostics.find(
      (item) => item.code === "TS2322" && item.filename === vendor,
    );

    const authoredSpan = {
      start: authored.indexOf("authored"),
      end: authored.indexOf("authored") + "authored".length,
    };

    expect(authorDiagnostics).toHaveLength(1);

    expect(authorDiagnostics.map((item) => item.span)).toStrictEqual([authoredSpan]);

    expect(vendorDiagnostic?.span).toStrictEqual({
      start: injected.indexOf("fromVendor"),
      end: injected.indexOf("fromVendor") + "fromVendor".length,
    });
  });

  test("the emitted init command requires a completed build and invalid commands or ports fail", async () => {
    const root = await temporaryProject();
    const executable = resolve(import.meta.dir, "../../packages/tooling/dist/cli.js");

    const invoke = async (...arguments_: string[]) => {
      const child = Bun.spawn([process.execPath, executable, ...arguments_], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { code, stdout, stderr };
    };

    const help = await invoke("--help");

    expect(help.code).toBe(0);

    expect(help.stdout).toContain("hesperia preview");

    const noBuild = await invoke("init");

    expect(noBuild.code).toBe(1);

    expect(noBuild.stderr).toContain("No completed browser build");

    const unknown = await invoke("invented-command");

    expect(unknown.code).toBe(1);

    expect(unknown.stderr).toContain("Unknown Hesperia command");

    for (const [command, port, diagnostic] of [
      ["preview", "65536", "Port must be between 0 and 65535"],
      ["dev", "12abc", "Usage: hesperia dev [--port <number>]"],
    ] as const) {
      const invalid = await invoke(command, "--port", port);

      expect(invalid.code).toBe(1);

      expect(invalid.stderr).toContain(diagnostic);

      expect(invalid.stdout).not.toContain(`Hesperia ${command}:`);
    }
  });

  test("creates the starter and refuses to overwrite a nonempty destination", async () => {
    const root = await temporaryProject(false);

    await initProject(root);

    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

    expect(manifest.scripts).toStrictEqual({
      dev: "hesperia dev",
      build: "hesperia build",
      preview: "hesperia preview",
      check: "hesperia check",
    });

    const sources = await readProject(root);

    expect(
      [...sources.keys()].map((path) => path.slice(root.length).replaceAll("\\", "/")),
    ).toStrictEqual(["/app.tsx", "/app.config.ts", "/src/routes/+page.tsx"]);

    await writeFile(join(root, "notes.txt"), "keep me");

    await expect(initProject(root)).rejects.toThrow("empty destination");

    expect(await readFile(join(root, "notes.txt"), "utf8")).toBe("keep me");
  });

  test("type failures prevent publishing any build, including unreachable author modules", async () => {
    const root = await temporaryProject();

    await mkdir(join(root, "src"));

    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ["src"] }),
    );

    await writeFile(
      join(root, "app.tsx"),
      'console.log("app"); export default function App() { return <html><head></head><body></body></html>; }',
    );

    await writeFile(join(root, "src/unreachable.ts"), "const value: string = 1;");

    const diagnostics = await checkSources(await readProject(root));

    expect(
      diagnostics.some(
        (item) => item.code === "TS2322" && item.filename.endsWith("unreachable.ts"),
      ),
    ).toBe(true);

    expect(await captureRejection(prepareBuild(root))).toMatchObject({
      message: expect.stringContaining("checking failed"),
    });

    expect(await readdir(root)).not.toContain(".hesperia");
  });

  test("project checking includes the root app shell and restricts document roots to that file", async () => {
    const root = await temporaryProject();

    await mkdir(join(root, "src"));

    const shell = join(root, "app.tsx");
    const source =
      "export default function App() { return <html><head><title>Hesperia</title></head><body><main>Ready</main></body></html>; }";

    await writeFile(shell, source);

    const snapshot = await readProject(root);

    expect(snapshot.get(shell)).toBe(source);

    expect(await checkSources(snapshot, root)).toEqual([]);

    await writeFile(shell, source.replace("<head><title>Hesperia</title></head>", ""));

    expect(
      (await checkSources(await readProject(root), root)).some(
        (item) => item.filename === shell && item.severity === "error",
      ),
    ).toBe(true);

    expect(await checkSources(snapshot, root)).toEqual([]);

    await writeFile(shell, source);

    await writeFile(join(root, "src/nested.tsx"), source);

    expect(
      (await checkSources(await readProject(root), root)).some(
        (item) => item.filename.endsWith("nested.tsx") && item.severity === "error",
      ),
    ).toBe(true);
  });

  test("the check command rejects compiler-invalid unreachable TSX before a build", async () => {
    const root = await temporaryProject();

    await mkdir(join(root, "src"));

    await writeFile(
      join(root, "app.tsx"),
      "export default function App() { return <html><head></head><body></body></html>; }",
    );

    await writeFile(
      join(root, "src/unreachable.tsx"),
      "export function Unreachable() { return <table><tr><td>invalid</td></tr></table>; }",
    );

    const child = Bun.spawn(
      [process.execPath, resolve(import.meta.dir, "../../packages/tooling/dist/cli.js"), "check"],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(code).toBe(1);

    expect(stderr).toContain("unreachable.tsx: HES-HTML-CONTEXT:");

    expect(stdout).not.toContain("Hesperia checking passed");

    expect(await readdir(root)).not.toContain(".hesperia");
  });

  test("a missing root shell reports the required-shell build error", async () => {
    const root = await temporaryProject();

    await mkdir(join(root, "src", "routes"), { recursive: true });

    await writeFile(
      join(root, "src", "routes", "+page.tsx"),
      "export default function Page() { return <h1>Page</h1>; }",
    );

    const error = await captureRejection(prepareBuild(root));

    expect(error).toBeInstanceOf(ProjectError);

    expect(error).toMatchObject({
      message: "The browser application requires a root app.tsx shell",
    });

    const child = Bun.spawn(
      [process.execPath, resolve(import.meta.dir, "../../packages/tooling/dist/cli.js"), "build"],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(code).toBe(1);

    expect(stdout).not.toContain("Built browser application");

    expect(stderr).toContain("The browser application requires a root app.tsx shell");

    expect(stderr).not.toContain("Missing stylesheet entry");

    expect(existsSync(join(root, ".hesperia", "build"))).toBe(false);
  });

  test("route collisions fail the emitted check command and prevent browser build preparation", async () => {
    const root = await temporaryProject();

    for (const group of ["(first)", "(second)"]) {
      const directory = join(root, "src/routes", group);

      await mkdir(directory, { recursive: true });

      await writeFile(
        join(directory, "+page.tsx"),
        "export default function Page() { return <main>page</main>; }",
      );
    }

    await writeFile(
      join(root, "app.tsx"),
      "export default function App() { return <html><head></head><body></body></html>; }",
    );

    const child = Bun.spawn(
      [process.execPath, resolve(import.meta.dir, "../../packages/tooling/dist/cli.js"), "check"],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(code).toBe(1);

    expect(stdout).not.toContain("Hesperia checking passed");

    expect(stderr.match(/HES-ROUTE-SCAN:/gu)).toHaveLength(2);

    expect(stderr).toContain("(first)");

    expect(stderr).toContain("(second)");

    expect(await captureRejection(prepareBuild(root))).toMatchObject({
      message: expect.stringContaining("checking failed"),
    });

    expect(await readdir(root)).not.toContain(".hesperia");
  });

  test("preview serves deep links as HTML while missing assets stay missing", async () => {
    const root = await temporaryProject();
    const startup = new Blob(["export async function start() {}"], {
      type: "text/javascript; charset=utf-8",
    });
    const hosting = {
      version: 1 as const,
      mode: "production" as const,
      standaloneMountURL: "/",
      startupAsset: "/assets/team%20docs/caf%C3%A9.js",
      assets: [
        {
          path: "/assets/team%20docs/caf%C3%A9.js",
          sha256: new Bun.CryptoHasher("sha256")
            .update(new Uint8Array(await startup.arrayBuffer()))
            .digest("hex"),
          contentType: startup.type,
        },
      ],
    };

    await writeBuild(root, {
      hosting,
      diagnostics: [],
      sources: [],
      files: new Map([
        ["/assets/team%20docs/caf%C3%A9.js", startup],
        ["/hesperia-build.json", new Blob([JSON.stringify({ hosting })])],
        ["/index.html", new Blob(["<!doctype html><title>Preview</title>"])],
      ]),
    });

    const server = await previewProject(root, 0);

    try {
      const page = await fetch(new URL("/people/42?tab=details", server.url), {
        headers: { accept: "text/html" },
      });

      expect(page.status).toBe(200);

      expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");

      expect(await page.text()).toContain('<script type="module" src="/_hesperia/startup.js">');

      const script = await fetch(new URL("/_hesperia/assets/team%20docs/caf%C3%A9.js", server.url));

      expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");

      expect(await script.text()).toContain("function start");

      expect((await fetch(new URL("/_hesperia/assets/missing.js", server.url))).status).toBe(404);

      expect(
        (
          await fetch(new URL("/_hesperia/assets/team%20docs/caf%C3%A9.js", server.url), {
            method: "HEAD",
          })
        ).headers.get("content-type"),
      ).toBe("text/javascript; charset=utf-8");

      expect(
        (
          await fetch(new URL("/_hesperia/assets/team%20docs/caf%C3%A9.js", server.url), {
            method: "POST",
          })
        ).status,
      ).toBe(405);
    } finally {
      await server.close();
    }

    await mkdir(join(root, "src"));

    await writeFile(join(root, "hesperia.config.json"), JSON.stringify({ allowUnsafeHTML: true }));

    await writeFile(
      join(root, "app.tsx"),
      'import Fragment from "./src/fragment.html" with { type: "html" }; export default function App() { return <html><head></head><body><Fragment /></body></html>; }',
    );

    await writeFile(
      join(root, "src", "fragment.html"),
      '<section><link rel="stylesheet" href="./native.css" referrerpolicy="no-referrer"><p>Native CSS filenames</p></section>',
    );

    await writeFile(
      join(root, "src", "native.css"),
      '.native { background-image: url("./native%20pic%20%23%25.png"); mask-image: url("./image%2520name.png"); }',
    );

    const image = new Uint8Array([1, 2, 3, 4]);

    await writeFile(join(root, "src", "native pic #%.png"), image);

    await writeFile(join(root, "src", "image%20name.png"), image);

    const built = await prepareBuild(root);
    const captured = {
      hosting: built.hosting,
      files: new Map(
        built.hosting.assets.map((asset) => [asset.path, built.files.get(asset.path)!]),
      ),
    };
    const imagePaths = ["native%20pic%20%23%25.png", "image%2520name.png"].map((name) => {
      const path = built.hosting.assets.find((asset) => asset.path.endsWith(`/${name}`))?.path;

      expect(path).toBeDefined();

      return path!;
    });
    const host = await createHost(captured);

    for (const path of imagePaths) {
      const response = host.handle(new Request(`https://fixture.invalid/_hesperia${path}`))!;

      expect(response.status).toBe(200);

      expect(new Uint8Array(await response.arrayBuffer())).toEqual(image);
    }

    await writeBuild(root, built);

    const loaded = await readBuild(join(root, ".hesperia", "build"));

    for (const path of imagePaths)
      expect(new Uint8Array(await loaded.files.get(path)!.arrayBuffer())).toEqual(image);

    const nativePreview = await previewProject(root, 0);

    try {
      for (const path of imagePaths) {
        const response = await fetch(new URL(`/_hesperia${path}`, nativePreview.url));

        expect(response.status).toBe(200);

        expect(new Uint8Array(await response.arrayBuffer())).toEqual(image);
      }
    } finally {
      await nativePreview.close();
    }
  });

  test("builds browser assets with maps and publishes the rewritten entry after checking", async () => {
    const root = await temporaryProject();

    await mkdir(join(root, "src"));

    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ["src"] }),
    );

    await writeFile(
      join(root, "app.tsx"),
      'document.body.setAttribute("data-application", "ready"); export default function App() { return <html><head></head><body></body></html>; }',
    );

    const built = await prepareBuild(root);

    expect(built.diagnostics).toStrictEqual([]);

    const scriptPath = built.hosting.startupAsset;

    expect(scriptPath).toMatch(/^\/assets\/main-.*\.js$/);

    expect([...built.files.keys()].some((path) => path.endsWith(".js.map"))).toBe(true);

    expect(built.files.has("/index.html")).toBe(false);

    const scripts = await Promise.all(
      [...built.files].filter(([path]) => path.endsWith(".js")).map(([, file]) => file.text()),
    );

    expect(
      scripts.some((script) => script.includes('setAttribute("data-application", "ready")')),
    ).toBe(true);

    expect(scripts.some((script) => script.includes("oxc-parser"))).toBe(false);

    const record = JSON.parse(await built.files.get("/hesperia-build.json")!.text());

    expect(record.hosting).toStrictEqual(built.hosting);

    expect(built.hosting.assets.map((asset) => asset.path)).toStrictEqual(
      [...built.files.keys()].filter((path) => path.startsWith("/assets/")).sort(),
    );

    expect(record.routeTable).toMatch(/^\/assets\/route-table-.*\.js$/u);

    expect(await built.files.get(record.routeTable)!.text()).toContain("routeTable");

    await writeBuild(root, built);

    expect(existsSync(join(root, ".hesperia/build/index.html"))).toBe(false);
  });

  test("keeps the previous record-listed asset capture valid when later publication fails", async () => {
    const root = await temporaryProject();

    await mkdir(join(root, "src"));

    const source =
      "export default function App() { return <html><head></head><body>Hello</body></html>; }";

    await writeFile(join(root, "app.tsx"), source);

    const first = await prepareBuild(root);

    await writeBuild(root, first);

    const recordPath = join(root, ".hesperia/build/hesperia-build.json");
    const previousRecord = await readFile(recordPath);

    await writeFile(join(root, "app.tsx"), `${source}\n// only source-map metadata changes`);

    const second = await prepareBuild(root);
    const firstDigests = new Map(first.hosting.assets.map((asset) => [asset.path, asset.sha256]));
    const changedSharedMaps = second.hosting.assets.filter(
      (asset) => asset.path.endsWith(".map") && firstDigests.get(asset.path) !== asset.sha256,
    );

    expect(changedSharedMaps.length).toBeGreaterThan(0);

    class UnreadableBlob extends Blob {
      override async arrayBuffer(): Promise<ArrayBuffer> {
        throw new Error("fixture artifact unavailable");
      }
    }

    const failed = { ...second, files: new Map(second.files) };

    failed.files.set(second.hosting.startupAsset, new UnreadableBlob());

    await expect(writeBuild(root, failed)).rejects.toThrow("fixture artifact unavailable");

    expect(await readFile(recordPath)).toEqual(previousRecord);

    const previousCapture = await readBuild(join(root, ".hesperia/build"));

    expect(previousCapture.hosting).toStrictEqual(first.hosting);

    for (const asset of previousCapture.hosting.assets) {
      const file = previousCapture.files.get(asset.path)!;
      const digest = new Bun.CryptoHasher("sha256")
        .update(new Uint8Array(await file.arrayBuffer()))
        .digest("hex");

      expect(digest).toBe(asset.sha256);
    }
  });

  test("production removes unpublished captures before checking and retires the old capture only after success", async () => {
    const root = await temporaryProject();

    await mkdir(join(root, "src"));

    const app = join(root, "app.tsx");

    await writeFile(
      app,
      "export default function App() { return <html><head></head><body>Old</body></html>; }",
    );

    const first = await prepareBuild(root);
    const output = await writeBuild(root, first);
    const recordPath = join(output, "hesperia-build.json");
    const oldRecord = await readFile(recordPath, "utf8");
    const old = JSON.parse(oldRecord) as { assetDirectory: string };
    const unpublished = join(output, ".captures", "33333333-3333-3333-3333-333333333333");

    await mkdir(join(unpublished, "assets"), { recursive: true });

    await writeFile(
      app,
      "export default function App() { const broken: string = 42; return <html><head></head><body>{broken}</body></html>; }",
    );

    expect(await captureRejection(prepareBuild(root))).toMatchObject({
      message: expect.stringContaining("checking failed"),
    });

    expect(existsSync(unpublished)).toBe(false);

    expect(await readFile(recordPath, "utf8")).toBe(oldRecord);

    expect((await readBuild(output)).hosting).toStrictEqual(first.hosting);

    await writeFile(
      app,
      "export default function App() { return <html><head></head><body>New</body></html>; }",
    );

    const second = await prepareBuild(root);

    await writeBuild(root, second);

    expect(existsSync(join(output, old.assetDirectory))).toBe(false);

    expect(await readdir(join(output, ".captures"))).toHaveLength(1);

    expect((await readBuild(output)).hosting).toStrictEqual(second.hosting);
  });

  test("disk hosting rejects a missing captured asset and preview rejects development builds", async () => {
    const root = await temporaryProject();

    await mkdir(join(root, "src"));

    await writeFile(
      join(root, "app.tsx"),
      "export default function App() { return <html><head></head><body>Hosted</body></html>; }",
    );

    const production = await prepareBuild(root);

    await writeBuild(root, production);

    const asset = production.hosting.assets[0]!;
    const record = JSON.parse(
      await readFile(join(root, ".hesperia", "build", "hesperia-build.json"), "utf8"),
    ) as { assetDirectory: string };
    const assetPath = join(
      root,
      ".hesperia",
      "build",
      ...record.assetDirectory.split("/"),
      asset.path.slice("/assets/".length),
    );
    const original = production.files.get(asset.path)!;

    await writeFile(
      assetPath,
      new Uint8Array(await original.arrayBuffer()).map((byte) => byte ^ 0xff),
    );

    expect(await captureRejection(previewProject(root, 0))).toMatchObject({
      message: expect.stringContaining("digest"),
    });

    await rm(assetPath);

    expect(await captureRejection(readBuild(join(root, ".hesperia/build")))).toMatchObject({
      message: expect.stringContaining("asset is missing"),
    });

    const development = await prepareBuild(root, true);

    await writeBuild(root, development);

    expect(await captureRejection(previewProject(root, 0))).toMatchObject({
      message: expect.stringContaining("Cannot serve a development build as production"),
    });
  });

  test("development reload follows a successful rebuild and warnings reach its console", async () => {
    const root = await temporaryProject();

    await mkdir(join(root, "src"));

    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ["src"] }),
    );

    await writeFile(
      join(root, "app.tsx"),
      'document.body.setAttribute("data-version", "first"); export default function App() { return <html><head></head><body></body></html>; }',
    );

    const reports: string[] = [];
    const server = await devProject(root, { port: 0, report: (message) => reports.push(message) });
    const abort = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

    try {
      const events = await fetch(new URL("/_hesperia/events", server.url), {
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]),
      });
      reader = events.body!.getReader();

      expect(new TextDecoder().decode((await reader.read()).value)).toContain(": connected");

      const waitForEvent = async (message: string) => {
        let received = "";

        while (!received.includes(message)) {
          const next = await reader!.read();

          if (next.done) throw new Error("Reload stream ended before rebuild");

          received += new TextDecoder().decode(next.value);
        }
      };

      await writeFile(
        join(root, "app.tsx"),
        'document.body.setAttribute("data-version", "second"); export default function App() { return <html><head></head><body></body></html>; }',
      );

      await waitForEvent('data: "reload"');

      const html = await (await fetch(server.url, { headers: { accept: "text/html" } })).text();

      expect(html.indexOf("/_hesperia/client.js")).toBeLessThan(
        html.indexOf("/_hesperia/startup.js"),
      );

      const path = html.match(/src="(\/_hesperia\/startup\.js)"/)![1]!;
      const urls = new Set([new URL(path, server.url).href]);
      const scripts = new Map<string, string>();
      const scanner = new Bun.Transpiler({ loader: "js" });

      for (const url of urls) {
        const response = await fetch(url);

        expect(response.status).toBe(200);

        const source = await response.text();

        scripts.set(url, source);

        for (const dependency of scanner.scanImports(source)) {
          const target = new URL(dependency.path, url);

          expect(target.origin).toBe(server.url.origin);

          urls.add(target.href);
        }
      }

      const shell = [...scripts].find(([, source]) =>
        source.includes('setAttribute("data-version", "second")'),
      );

      expect(shell).toBeDefined();

      if (!shell) throw new Error("The rebuilt shell was absent from the served module graph");

      expect(
        (
          await fetch(new URL("/_hesperia/warnings", server.url), {
            method: "POST",
            headers: { origin: server.url.origin },
            body: "unsafeBind was used",
          })
        ).status,
      ).toBe(204);

      expect(reports).toStrictEqual(["unsafeBind was used"]);

      await writeFile(
        join(root, "app.tsx"),
        "export default function App() { return <html><body>missing head</body></html>; }",
      );

      await waitForEvent("Hesperia checking failed");

      expect(await (await fetch(shell[0])).text()).toBe(shell[1]);

      await writeFile(
        join(root, "app.tsx"),
        "export default function App() { return <html><head><title>App</title></head><body>ready</body></html>; }",
      );

      await waitForEvent('data: "reload"');

      for (const path of ["/hesperia-build.json", "/src/app.tsx", "/package.json"]) {
        const response = await fetch(new URL(path, server.url), {
          headers: { accept: "application/json" },
        });

        expect(response.status).toBe(404);
      }
    } finally {
      await reader?.cancel();

      abort.abort();

      await server.close();
    }
  }, 20_000);

  test("development checks changes in imported backend modules outside src", async () => {
    const root = await temporaryProject();

    await mkdir(join(root, "src"));

    await mkdir(join(root, "backend"));

    await writeFile(
      join(root, "app.tsx"),
      'import { label } from "./api.ts"; export default function App() { return <html><head><title>{label}</title></head><body></body></html>; }',
    );

    await writeFile(join(root, "api.ts"), 'export { label } from "./backend/operation.ts";');

    const operation = join(root, "backend/operation.ts");

    await writeFile(operation, 'export const label: string = "Backend";');

    const server = await devProject(root, { port: 0, report: () => undefined });
    const abort = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

    try {
      const events = await fetch(new URL("/_hesperia/events", server.url), {
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]),
      });
      reader = events.body!.getReader();

      await reader.read();

      await writeFile(operation, "export const label: string = 42;");

      let received = "";

      while (!received.includes("Hesperia checking failed")) {
        const chunk = await reader.read();

        if (chunk.done)
          throw new Error("Development events ended before the dependency diagnostic");

        received += new TextDecoder().decode(chunk.value);
      }

      expect(received).toContain("Hesperia checking failed");
    } finally {
      abort.abort();

      await reader?.cancel().catch(() => undefined);

      await server.close();
    }
  }, 15000);
});
