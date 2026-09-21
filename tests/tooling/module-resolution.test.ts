import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ModuleResolver } from "../../src/compiler/module-resolution.ts";
import { prepareBuild, writeBuild } from "../../src/tooling/project.ts";
import { buildRouteGuards } from "../../src/tooling/route-build.ts";
import { analyzeModule, emitAnalysis } from "../../src/compiler/compilation.ts";
import { browserStartupSource } from "../../src/tooling/startup.ts";

const roots: string[] = [];

async function temporaryProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hesperia-resolution-tooling-"));
  await mkdir(join(root, ".hesperia"), { recursive: true });
  await mkdir(join(root, "src/routes"), { recursive: true });
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function writeModePackage(root: string, hostile = false): Promise<void> {
  const packageRoot = join(root, "node_modules/mode-package");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "mode-package",
      types: "./index.d.ts",
      exports: {
        ".": {
          types: "./index.d.ts",
          browser: {
            development: "./development.js",
            production: "./production.js",
          },
          default: "./fallback.js",
        },
      },
    }),
  );
  await writeFile(join(packageRoot, "index.d.ts"), "export declare const marker: string;\n");
  await writeFile(
    join(packageRoot, "development.js"),
    hostile
      ? 'import "fs"; export const marker = "development";'
      : 'export const marker = "development";',
  );
  await writeFile(join(packageRoot, "production.js"), 'export const marker = "production";');
  await writeFile(join(packageRoot, "fallback.js"), 'export const marker = "fallback";');
}

async function writeApp(root: string): Promise<void> {
  await writeFile(
    join(root, "app.tsx"),
    [
      'import { marker } from "mode-package";',
      "document.body.dataset.mode = marker;",
      "export default function App() { return <html><head></head><body></body></html>; }",
    ].join("\n"),
  );
}

describe("browser module resolution integration", () => {
  test("selects the mode branch and records the same captured package bytes", async () => {
    const root = await temporaryProject();
    await writeModePackage(root);
    await writeApp(root);

    const development = await prepareBuild(root, true);
    const developmentRecord = JSON.parse(
      await development.files.get("/hesperia-build.json")!.text(),
    );
    expect(developmentRecord.resolution.mode).toBe("development");
    expect(developmentRecord.resolution.activeConditions).toContain("development");
    const startupRecord = developmentRecord.resolution.generatedSources.find(
      (item: { semantic: string }) => item.semantic === "startup",
    );
    const runtimeEdge = developmentRecord.resolution.edges.find(
      (edge: { from: string; specifier: string }) =>
        edge.from === startupRecord.filename &&
        edge.specifier.startsWith("hesperia:compiler-runtime:project:"),
    );
    expect(runtimeEdge).toBeDefined();
    const startupSource = browserStartupSource(false, runtimeEdge.specifier);
    const startupOptions = {
      filename: join(root, startupRecord.filename),
      browserTarget: true,
      runtimeModule: runtimeEdge.specifier,
    };
    const startupEmission = emitAnalysis(
      analyzeModule(startupSource, startupOptions),
      startupOptions,
    );
    expect(startupEmission.diagnostics).toStrictEqual([]);
    expect(startupRecord.semanticHash).toBe(startupEmission.semanticHash);
    expect(startupRecord.semanticHash).not.toBe(
      `sha256-${new Bun.CryptoHasher("sha256").update(startupSource).digest("hex")}`,
    );
    expect(developmentRecord.resolution.runtimeKeyRegistry).toStrictEqual({
      source:
        "https://raw.githubusercontent.com/WinterTC55/runtime-keys/a55623cb670debc4abd8059de1cff2cc31d5a6f2/runtime-keys.json",
      revision: "a55623cb670debc4abd8059de1cff2cc31d5a6f2",
      digest: "sha256-05a0e8da7538015cd4aa185f43a99859b1954f045e0632bd727e57bfecc396c5",
    });
    expect(developmentRecord.resolution.generatedSources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          semantic: "startup",
          semanticHash: expect.stringMatching(/^sha256-[0-9a-f]{64}$/u),
          digest: expect.stringMatching(/^sha256-/u),
        }),
        expect.objectContaining({
          semantic: "route-table",
          semanticHash: expect.stringMatching(/^sha256-[0-9a-f]{64}$/u),
          digest: expect.stringMatching(/^sha256-/u),
        }),
        expect.objectContaining({
          semantic: "compiled-module",
          semanticHash: expect.stringMatching(/^sha256-[0-9a-f]{64}$/u),
          authoredFilename: "app.tsx",
          digest: expect.stringMatching(/^sha256-/u),
          sourceMapDigest: expect.stringMatching(/^sha256-/u),
        }),
      ]),
    );
    expect(
      developmentRecord.resolution.edges.find(
        (edge: { specifier: string }) => edge.specifier === "mode-package",
      ).conditionPath,
    ).toEqual([".", "browser", "development"]);
    expect(developmentRecord.resolution.capturedSources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ filename: "node_modules/mode-package/development.js" }),
      ]),
    );
    const developmentScripts = await Promise.all(
      [...development.files]
        .filter(([path]) => path.endsWith(".js"))
        .map(([, file]) => file.text()),
    );
    expect(developmentScripts).toEqual(
      expect.arrayContaining([expect.stringContaining("development")]),
    );

    const production = await prepareBuild(root, false);
    const productionRecord = JSON.parse(await production.files.get("/hesperia-build.json")!.text());
    expect(productionRecord.resolution.mode).toBe("production");
    expect(productionRecord.resolution.runtimeKeyRegistry).toStrictEqual(
      developmentRecord.resolution.runtimeKeyRegistry,
    );
    expect(productionRecord.resolution.generatedSources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          semantic: "startup",
          semanticHash: expect.stringMatching(/^sha256-[0-9a-f]{64}$/u),
          digest: expect.stringMatching(/^sha256-/u),
        }),
        expect.objectContaining({
          semantic: "route-table",
          semanticHash: expect.stringMatching(/^sha256-[0-9a-f]{64}$/u),
          digest: expect.stringMatching(/^sha256-/u),
        }),
        expect.objectContaining({
          semantic: "compiled-module",
          semanticHash: expect.stringMatching(/^sha256-[0-9a-f]{64}$/u),
          authoredFilename: "app.tsx",
          digest: expect.stringMatching(/^sha256-/u),
          sourceMapDigest: expect.stringMatching(/^sha256-/u),
        }),
      ]),
    );
    expect(
      productionRecord.resolution.edges.find(
        (edge: { specifier: string }) => edge.specifier === "mode-package",
      ).conditionPath,
    ).toEqual([".", "browser", "production"]);
    expect(productionRecord.resolution.capturedSources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ filename: "node_modules/mode-package/production.js" }),
      ]),
    );
    const productionScripts = await Promise.all(
      [...production.files].filter(([path]) => path.endsWith(".js")).map(([, file]) => file.text()),
    );
    expect(productionScripts).toEqual(
      expect.arrayContaining([expect.stringContaining("production")]),
    );
  });

  test("rejects a host import reached through the selected browser branch", async () => {
    const root = await temporaryProject();
    await writeModePackage(root, true);
    await writeApp(root);
    await expect(prepareBuild(root, true)).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: "HES-CAPABILITY" })]),
    });
  });

  test("builds the exact configured replacement and records its selected bytes", async () => {
    const root = await temporaryProject();
    const packageRoot = join(root, "node_modules/display-package");
    const replacement = join(root, "src/browser-replacement.ts");
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "display-package", exports: "./entry.js" }),
    );
    await writeFile(join(packageRoot, "entry.js"), 'export const label = "package";');
    await writeFile(replacement, 'export const label: string = "replacement";');
    await writeFile(
      join(root, "hesperia.config.json"),
      JSON.stringify({
        resolutionOverrides: { browser: { "display-package": "./src/browser-replacement.ts" } },
      }),
    );
    await writeFile(
      join(root, "app.tsx"),
      [
        'import { label } from "display-package";',
        "document.body.dataset.label = label;",
        "export default function App() { return <html><head></head><body></body></html>; }",
      ].join("\n"),
    );
    const build = await prepareBuild(root);
    const record = JSON.parse(await build.files.get("/hesperia-build.json")!.text());
    expect(record.configuration.resolutionOverrides.browser).toStrictEqual({
      "display-package": "./src/browser-replacement.ts",
    });
    expect(record.resolution.overrides).toStrictEqual({
      "display-package": "./src/browser-replacement.ts",
    });
    const edge = record.resolution.edges.find(
      (item: { specifier: string }) => item.specifier === "display-package",
    );
    expect(edge).toMatchObject({
      outcome: "resolved",
      resolvedFilename: "src/browser-replacement.ts",
      conditionPath: ["override", "display-package", "./src/browser-replacement.ts"],
    });
    const scripts = await Promise.all(
      [...build.files].filter(([path]) => path.endsWith(".js")).map(([, file]) => file.text()),
    );
    expect(scripts).toEqual(expect.arrayContaining([expect.stringContaining("replacement")]));
    expect(scripts).not.toEqual(expect.arrayContaining([expect.stringContaining('"package"')]));
  });

  test("still capability-checks a configured replacement before bundling", async () => {
    const root = await temporaryProject();
    const replacement = join(root, "src/browser-replacement.ts");
    await writeFile(replacement, 'import "node:fs"; export const label = "unsafe";');
    await writeFile(
      join(root, "hesperia.config.json"),
      JSON.stringify({
        resolutionOverrides: { browser: { "display-package": "./src/browser-replacement.ts" } },
      }),
    );
    await writeFile(
      join(root, "app.tsx"),
      [
        'import { label } from "display-package";',
        "document.body.dataset.label = label;",
        "export default function App() { return <html><head></head><body></body></html>; }",
      ].join("\n"),
    );
    await expect(prepareBuild(root)).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: "HES-CAPABILITY" })]),
    });
  });

  test("executes a configured replacement in the built app across browsers", async () => {
    const root = await temporaryProject();
    await writeFile(
      join(root, "src/routes/+page.tsx"),
      'import { label } from "display-package"; export default function Page() { return <main id="label">{label}</main>; }',
    );
    await writeFile(
      join(root, "src/browser-replacement.ts"),
      'export const label = "replacement";',
    );
    await writeFile(
      join(root, "hesperia.config.json"),
      JSON.stringify({
        resolutionOverrides: { browser: { "display-package": "./src/browser-replacement.ts" } },
      }),
    );
    await writeFile(
      join(root, "app.tsx"),
      "export default function App(props: { children: () => unknown }) { return <html><head></head><body>{props.children()}</body></html>; }",
    );
    const output = await writeBuild(root, await prepareBuild(root));
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const pathname = new URL(request.url).pathname;
        const requested = pathname === "/" ? "/index.html" : pathname;
        const filename = resolve(output, `.${decodeURIComponent(requested)}`);
        const file = Bun.file(filename);
        return (await file.exists())
          ? new Response(file)
          : new Response("Not found", { status: 404 });
      },
    });
    try {
      const script = `
        import assert from "node:assert/strict";
        import { chromium, firefox, webkit } from ${JSON.stringify(pathToFileURL(resolve(import.meta.dir, "../../node_modules/playwright/index.mjs")).href)};
        const opened = [];
        try {
          for (const engine of [chromium, firefox, webkit]) {
            const browser = await engine.launch();
            opened.push(browser);
            const page = await browser.newPage();
            const errors = [];
            page.on("pageerror", error => errors.push(error.message));
            await page.goto(${JSON.stringify(`http://localhost:${server.port}/`)});
            await page.waitForFunction(() => document.querySelector("#label")?.textContent === "replacement");
            assert.deepEqual(errors, []);
            console.log(engine.name() + " browser override executed");
          }
        } finally {
          await Promise.all(opened.map(browser => browser.close()));
        }
      `;
      const child = Bun.spawn(["node", "--input-type=module", "--eval", script], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [status, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (status !== 0) throw new Error(`Built browser override failed\n${stdout}\n${stderr}`);
      expect(stdout.trim().split(/\r?\n/u)).toStrictEqual([
        "chromium browser override executed",
        "firefox browser override executed",
        "webkit browser override executed",
      ]);
    } finally {
      server.stop();
    }
  }, 90_000);

  test("does not reread a captured dependency after the request resolves", async () => {
    const root = await temporaryProject();
    await writeModePackage(root);
    const entry = join(root, "entry.ts");
    await writeFile(entry, 'import { marker } from "mode-package"; export { marker };');
    const resolver = new ModuleResolver(
      root,
      new Map([[entry, await Bun.file(entry).text()]]),
      "development",
    );
    const first = resolver.resolve(entry, "mode-package");
    expect(first.kind).toBe("resolved");
    if (first.kind !== "resolved") return;
    await writeFile(
      join(root, "node_modules/mode-package/development.js"),
      'export const marker = "mutated";',
    );
    const second = resolver.resolve(entry, "mode-package");
    expect(second).toStrictEqual(first);
    expect(
      resolver.capturedSources.find((item) => item.filename === first.filename)?.source,
    ).toContain('"development"');
    const compilerEntryPath = join(root, "compiler-runtime.js");
    await writeFile(compilerEntryPath, "export const runtime = 1;");
    const compilerEntry = resolver.captureCompilerEntry(compilerEntryPath);
    await writeFile(compilerEntryPath, "export const runtime = 2;");
    expect(resolver.captureCompilerEntry(compilerEntryPath)).toStrictEqual(compilerEntry);
  });

  test("keeps a missing package export target missing for the whole resolver snapshot", async () => {
    const root = await temporaryProject();
    const packageRoot = join(root, "node_modules/missing-target-package");
    const entry = join(root, "entry.ts");
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({
        name: "missing-target-package",
        exports: { "./a": "./missing.js", "./b": "./missing.js" },
      }),
    );
    await writeFile(entry, "export {};\n");
    const resolver = new ModuleResolver(
      root,
      new Map([[entry, await Bun.file(entry).text()]]),
      "development",
    );

    expect(resolver.resolve(entry, "missing-target-package/a")).toMatchObject({
      kind: "failure",
      code: "MODULE_NOT_FOUND",
    });
    await writeFile(join(packageRoot, "missing.js"), "export const marker = true;\n");

    expect(resolver.resolve(entry, "missing-target-package/b")).toMatchObject({
      kind: "failure",
      code: "MODULE_NOT_FOUND",
    });
    const freshResolver = new ModuleResolver(
      root,
      new Map([[entry, await Bun.file(entry).text()]]),
      "development",
    );
    expect(freshResolver.resolve(entry, "missing-target-package/b")).toMatchObject({
      kind: "resolved",
      filename: join(packageRoot, "missing.js"),
    });
  });

  test("records compiler-selected edges and rejects a conflicting remap", async () => {
    const root = await temporaryProject();
    const importer = join(root, "entry.js");
    const selected = join(root, "runtime.js");
    const conflicting = join(root, "other-runtime.js");
    await writeFile(importer, "export {};");
    await writeFile(selected, "export const runtime = 1;");
    await writeFile(conflicting, "export const runtime = 2;");
    const resolver = new ModuleResolver(
      root,
      new Map([[importer, await Bun.file(importer).text()]]),
      "production",
    );
    const first = resolver.resolveCompilerEntry(importer, "hesperia/runtime", selected);
    expect(first.kind).toBe("resolved");
    expect(resolver.capturedEdges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: importer,
          specifier: "hesperia/runtime",
          outcome: "resolved",
          resolvedFilename: selected,
        }),
      ]),
    );
    const conflict = resolver.resolveCompilerEntry(importer, "hesperia/runtime", conflicting);
    expect(conflict).toMatchObject({ kind: "failure", code: "MODULE_NOT_FOUND" });
    expect(resolver.resolve(importer, "hesperia/runtime")).toStrictEqual(first);
  });

  test("bundles the selected package projection without pulling an unrelated host callback", async () => {
    const root = await temporaryProject();
    const packageRoot = join(root, "node_modules/route-package");
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({
        name: "route-package",
        exports: { ".": { browser: "./browser.js", default: "./server.js" } },
      }),
    );
    await writeFile(
      join(packageRoot, "browser.js"),
      "export const guard = () => true; export const serverOnly = () => process.cwd();",
    );
    await writeFile(join(packageRoot, "server.js"), "export const guard = () => false;");
    const routeFilename = join(root, "src/routes/+route.ts");
    const routeSource =
      'import { route } from "hesperia/routing"; import { guard } from "route-package"; export default route({ guard });';
    const result = await buildRouteGuards(
      { modules: [{ filename: routeFilename, source: routeSource }], routeFiles: [routeFilename] },
      { root },
    );
    expect(result.diagnostics).toStrictEqual([]);
    expect(result.guards).toHaveLength(1);
    expect(result.guards[0]!.code).toContain("return true");
    expect(result.guards[0]!.code).not.toContain("process.cwd");
    expect(result.guards[0]!.code).not.toContain("serverOnly");
  });

  test("refuses a standalone guard build when its selected runtime uses dynamic native execution", async () => {
    const root = await temporaryProject();
    const runtimeFilename = join(root, "unsafe-runtime.js");
    await writeFile(runtimeFilename, 'export const runtime = () => eval("globalThis.process");\n');
    const routeFilename = join(root, "src/routes/+route.ts");
    const routeSource =
      'import { route } from "hesperia/routing"; export default route({ guard: () => true });';
    const result = await buildRouteGuards(
      { modules: [{ filename: routeFilename, source: routeSource }], routeFiles: [routeFilename] },
      { root, runtimeModule: runtimeFilename },
    );
    expect(result.guards).toStrictEqual([]);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "HES-CAPABILITY-DYNAMIC" })]),
    );
  });

  test("rejects dynamic guard imports whose selected module uses a host capability", async () => {
    const root = await temporaryProject();
    const routeFilename = join(root, "src/routes/+route.ts");
    const secretFilename = join(root, "src/routes/secret.js");
    await writeFile(secretFilename, "export const allow = () => globalThis.process.env.SECRET;\n");
    const routeSource = [
      'import { route } from "hesperia/routing";',
      'const guard = async () => (await import("./secret.js")).allow();',
      "export default route({ guard });",
    ].join("\n");
    const result = await buildRouteGuards(
      {
        modules: [
          { filename: routeFilename, source: routeSource },
          { filename: secretFilename, source: await Bun.file(secretFilename).text() },
        ],
        routeFiles: [routeFilename],
      },
      { root },
    );
    expect(result.guards).toStrictEqual([]);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: expect.stringMatching(/^HES-(ROUTE|CAPABILITY)/u),
        }),
      ]),
    );
  });

  test("does not launder a helper's runtime import through the compiler runtime entry", async () => {
    const root = await temporaryProject();
    const shadowRoot = join(root, "node_modules/hesperia");
    await mkdir(shadowRoot, { recursive: true });
    await writeFile(
      join(shadowRoot, "package.json"),
      JSON.stringify({ name: "hesperia", exports: { "./runtime": "./runtime.js" } }),
    );
    await writeFile(
      join(shadowRoot, "runtime.js"),
      "export const unsafe = () => globalThis.process.env.SECRET;\n",
    );
    const helperFilename = join(root, "src/routes/helper.js");
    const routeFilename = join(root, "src/routes/+route.ts");
    await writeFile(
      helperFilename,
      'const target = "hesperia/" + "runtime";\nexport const guard = async () => (await import(target, {})).unsafe();\n',
    );
    const routeSource = [
      'import { route } from "hesperia/routing";',
      'import { guard } from "./helper.js";',
      "export default route({ guard });",
    ].join("\n");
    const result = await buildRouteGuards(
      {
        modules: [
          { filename: routeFilename, source: routeSource },
          { filename: helperFilename, source: await Bun.file(helperFilename).text() },
        ],
        routeFiles: [routeFilename],
      },
      { root },
    );
    expect(result.guards).toStrictEqual([]);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "HES-CAPABILITY" })]),
    );
  });

  test("keeps an authored runtime import separate from the generated runtime edge", async () => {
    const root = await temporaryProject();
    const shadowRoot = join(root, "node_modules/hesperia");
    await mkdir(shadowRoot, { recursive: true });
    await writeFile(
      join(shadowRoot, "package.json"),
      JSON.stringify({ name: "hesperia", exports: { "./runtime": "./runtime.js" } }),
    );
    await writeFile(join(shadowRoot, "runtime.js"), 'export const marker = "shadow-safe";\n');
    const helperFilename = join(root, "src/routes/helper.js");
    const routeFilename = join(root, "src/routes/+route.ts");
    const helperSource = [
      'import { marker } from "hesperia/runtime";',
      'export const guard = () => marker === "shadow-safe";',
    ].join("\n");
    await writeFile(helperFilename, helperSource);
    const routeSource = [
      'import { route } from "hesperia/routing";',
      'import { guard } from "./helper.js";',
      "export default route({ guard });",
    ].join("\n");
    const result = await buildRouteGuards(
      {
        modules: [
          { filename: routeFilename, source: routeSource },
          { filename: helperFilename, source: helperSource },
        ],
        routeFiles: [routeFilename],
      },
      { root },
    );
    expect(result.diagnostics).toStrictEqual([]);
    expect(result.guards).toHaveLength(1);
    expect(result.guards[0]!.code).toContain("shadow-safe");
  });

  test("does not treat an authored routing import as the compiler routing module", async () => {
    const root = await temporaryProject();
    const shadowRoot = join(root, "node_modules/hesperia");
    await mkdir(shadowRoot, { recursive: true });
    await writeFile(
      join(shadowRoot, "package.json"),
      JSON.stringify({ name: "hesperia", exports: { "./routing": "./routing.js" } }),
    );
    await writeFile(
      join(shadowRoot, "routing.js"),
      "export const redirect = () => globalThis.process.env.SECRET;\n",
    );
    const helperFilename = join(root, "src/routes/helper.js");
    const routeFilename = join(root, "src/routes/+route.ts");
    const helperSource = [
      'import { redirect } from "hesperia/routing";',
      'export const guard = () => redirect("/login");',
    ].join("\n");
    await writeFile(helperFilename, helperSource);
    const routeSource = [
      'import { route } from "hesperia/routing";',
      'import { guard } from "./helper.js";',
      "export default route({ guard });",
    ].join("\n");
    const result = await buildRouteGuards(
      {
        modules: [
          { filename: routeFilename, source: routeSource },
          { filename: helperFilename, source: helperSource },
        ],
        routeFiles: [routeFilename],
      },
      { root },
    );
    expect(result.guards).toStrictEqual([]);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "HES-CAPABILITY" })]),
    );
  });

  test("maps generated dynamic-import diagnostics back through a CRLF authored source", async () => {
    const root = await temporaryProject();
    const routeFilename = join(root, "src/routes/+route.ts");
    const routeSource = [
      'import { route } from "hesperia/routing";',
      "const guard = async (target) => {",
      '  const padding = "🐈";',
      "  return import(target);",
      "};",
      "export default route({ guard });",
    ].join("\r\n");
    const result = await buildRouteGuards(
      { modules: [{ filename: routeFilename, source: routeSource }], routeFiles: [routeFilename] },
      { root },
    );
    expect(result.guards).toStrictEqual([]);
    const diagnostic = result.diagnostics.find((item) => item.code === "HES-CAPABILITY-DYNAMIC");
    expect(diagnostic).toMatchObject({ filename: routeFilename });
    expect(diagnostic?.span?.start).toBe(routeSource.indexOf("import(target)"));
  });

  test("bundles a finite dynamic import of a safe TypeScript helper through its emitted artifact", async () => {
    const root = await temporaryProject();
    const routeFilename = join(root, "src/routes/+route.ts");
    const helperFilename = join(root, "src/routes/safe.ts");
    const helperSource = "export const allow = () => true;\n";
    await writeFile(helperFilename, helperSource);
    const routeSource = [
      'import { route } from "hesperia/routing";',
      'const guard = async () => (await import("./safe.ts")).allow();',
      "export default route({ guard });",
    ].join("\n");
    const result = await buildRouteGuards(
      {
        modules: [
          { filename: routeFilename, source: routeSource },
          { filename: helperFilename, source: helperSource },
        ],
        routeFiles: [routeFilename],
      },
      { root },
    );
    expect(result.diagnostics).toStrictEqual([]);
    expect(result.guards).toHaveLength(1);
    expect(result.guards[0]!.code).toContain("allow");
  });
});
