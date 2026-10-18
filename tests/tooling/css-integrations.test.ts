import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { originalPositionFor, TraceMap } from "@jridgewell/trace-mapping";
import { postcss } from "../../packages/postcss/src/index.ts";
import { tailwind } from "../../packages/tailwind/src/index.ts";
import { bundleCssRoots } from "../../packages/tooling/src/css-bundling.ts";
import { PluginPipeline } from "../../packages/tooling/src/plugin-pipeline.ts";
import type {
  Plugin,
  PluginCssInput,
  PluginDiagnosticOrigin,
} from "../../packages/tooling/src/plugins.ts";

const roots: string[] = [];

interface ProbePostcssNode {
  readonly type: string;
}

interface ProbePostcssRoot {
  readonly source?: { readonly input: { readonly file?: string } };
  readonly nodes?: readonly ProbePostcssNode[];

  warn(result: ProbePostcssResult, message: string, options?: { node: unknown }): void;

  walkDecls(property: string, visit: (declaration: { value: string; prop: string }) => void): void;

  prepend(node: unknown): void;
}

interface ProbePostcssResult {
  readonly messages: unknown[];
}

interface ProbePostcssContext {
  readonly result: ProbePostcssResult;
}

type ProbePostcssPlugin = Parameters<typeof postcss>[0]["plugins"][number];

function requireOriginSpan(origin: PluginDiagnosticOrigin): { start: number; end: number } {
  if (typeof origin.start !== "number" || typeof origin.end !== "number")
    throw new Error("Expected the plugin diagnostic to have an exact source span");

  return { start: origin.start, end: origin.end };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("PostCSS transforms imported roots and nested imports once with located warnings and watches", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-postcss-integration-"));

  roots.push(root);

  const app = join(root, "app.tsx");
  const first = join(root, "first.style");
  const second = join(root, "second.style");
  const shared = join(root, "nested", "shared");
  const sharedAsset = join(root, "nested", "images", "shared.png");
  const helper = join(root, "tokens.json");
  const scan = join(root, "scan");
  const firstCss = '@import "./nested/shared";\n.first { color: red; }\n';
  const secondCss = '@import "./nested/shared";\n.second { color: red; }\n';
  const sharedCss = '.shared { color: red; background-image: url("./images/shared.png"); }\n';

  await mkdir(scan);

  await mkdir(join(root, "nested", "images"), { recursive: true });

  await writeFile(first, firstCss);

  await writeFile(second, secondCss);

  await writeFile(shared, sharedCss);

  await writeFile(sharedAsset, new Uint8Array(8192).fill(5));

  await writeFile(helper, '{"accent":"blue"}');

  const postcssModule = await import(
    pathToFileURL(Bun.resolveSync("postcss", join(import.meta.dir, "../../packages/postcss/src")))
      .href
  );
  const postcssParser = postcssModule.default as {
    parse(css: string, options: { from: string }): ProbePostcssRoot & { readonly first?: unknown };
  };
  const transformedInputs: string[] = [];
  const plugin = {
    postcssPlugin: "hesperia-postcss-integration-probe",

    Once(css: ProbePostcssRoot, context: ProbePostcssContext) {
      const filename = css.source?.input.file;

      if (!filename) throw new Error("PostCSS did not retain the current stylesheet filename");

      transformedInputs.push(filename);

      css.walkDecls("color", (declaration) => {
        if (declaration.value === "red") declaration.value = "blue";
      });

      const rule = css.nodes?.find((node) => node.type === "rule");

      if (rule) css.warn(context.result, "stylesheet was processed", { node: rule });

      const messages = context.result.messages as unknown as Record<string, unknown>[];

      messages.push({ type: "dependency", plugin: "probe", file: helper, parent: filename });

      messages.push({
        type: "dir-dependency",
        plugin: "probe",
        dir: scan,
        glob: "**/*.tsx",
        parent: filename,
      });

      if (filename === first) {
        const helperRoot = postcssParser.parse(".helper { color: red; }\n", { from: helper });

        helperRoot.warn(context.result, "helper input warning", { node: helperRoot.first! });
      }
    },
  } as unknown as ProbePostcssPlugin;
  const inputs: PluginCssInput[] = [];
  const pipeline = new PluginPipeline([
    {
      name: "observe-imported-css",

      transformCss(input) {
        inputs.push(input);
      },
    },
    postcss({ plugins: [plugin] }),
  ]);
  const bundled = await bundleCssRoots(
    root,
    [
      { importer: app, filename: first, origin: { filename: app, start: 0, end: 1 } },
      { importer: app, filename: second, origin: { filename: app, start: 1, end: 2 } },
    ],
    [],
    pipeline,
  );

  expect(transformedInputs).toStrictEqual([first, shared, second]);

  expect(inputs.map((input) => input.filename)).toStrictEqual([first, shared, second]);

  expect(inputs.every((input) => input.kind === "import" && !("owner" in input))).toBe(true);

  expect(bundled.roots.map((item) => item.id)).toStrictEqual([
    "css:first.style",
    "css:second.style",
  ]);

  const firstOutput = await bundled.files.get(bundled.roots[0]!.path)?.text();

  expect(firstOutput).toContain(".shared{color:#00f;background-image:url(");

  expect(pipeline.capturedFiles.find((item) => item.filename === sharedAsset)?.blob.size).toBe(
    8192,
  );

  expect(await bundled.files.get(bundled.roots[0]!.path)?.text()).toContain(".first{color:#00f}");

  expect(await bundled.files.get(bundled.roots[1]!.path)?.text()).toContain(".second{color:#00f}");

  expect(pipeline.capturedFiles.map((item) => item.filename).sort()).toStrictEqual(
    [first, second, shared, sharedAsset].sort(),
  );

  expect(pipeline.watch).toContainEqual({ kind: "file", file: helper });

  expect(pipeline.watch).toContainEqual({ kind: "directory", dir: scan, glob: "**/*.tsx" });

  expect(
    pipeline.watch.filter((item) => item.kind === "file" && item.file === helper),
  ).toHaveLength(1);

  const warnings = pipeline.diagnostics;
  const firstWarning = warnings.find((item) => item.origin.filename === first)!;
  const helperWarning = warnings.find((item) => item.message === "helper input warning")!;

  expect(requireOriginSpan(firstWarning.origin).start).toBe(firstCss.indexOf(".first"));

  expect(helperWarning.origin.filename).toBe(helper);

  const helperSpan = requireOriginSpan(helperWarning.origin);

  expect(helperSpan.start).toBe(".helper { color: red; }\n".indexOf(".helper"));

  expect(helperSpan.end).toBeGreaterThanOrEqual(helperSpan.start);
});

test("PostCSS warning spans follow the current stage map back to authored CSS", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-postcss-map-"));

  roots.push(root);

  const filename = join(root, "theme.css");
  const authored = ".card { color: red; }\n";
  const postcssModule = await import(
    pathToFileURL(Bun.resolveSync("postcss", join(import.meta.dir, "../../packages/postcss/src")))
      .href
  );
  const postcssParser = postcssModule.default as { comment(options: { text: string }): unknown };
  const shift = postcss({
    plugins: [
      {
        postcssPlugin: "shift-current-css",

        Once(css: ProbePostcssRoot) {
          css.prepend(postcssParser.comment({ text: "generated" }));
        },
      } as unknown as ProbePostcssPlugin,
    ],
  });
  const warnAndChange = postcss({
    plugins: [
      {
        postcssPlugin: "warn-and-change-current-css",

        Once(css: ProbePostcssRoot, context: ProbePostcssContext) {
          const rule = css.nodes?.find((node) => node.type === "rule");

          if (rule) css.warn(context.result, "mapped CSS warning", { node: rule });

          css.walkDecls("color", (declaration) => {
            declaration.value = "blue";
          });
        },
      } as unknown as ProbePostcssPlugin,
    ],
  });
  const pipeline = new PluginPipeline([shift, warnAndChange]);
  const transformed = await pipeline.transformCss({
    kind: "import",
    id: "css:theme.css",
    filename,
    css: authored,
    origin: { filename, start: 0, end: authored.length },
  });
  const warning = pipeline.diagnostics[0]!;
  const cardOffset = transformed.css.indexOf(".card");
  const preceding = transformed.css.slice(0, cardOffset);
  const location = originalPositionFor(new TraceMap(transformed.map!), {
    line: preceding.split("\n").length,
    column: cardOffset - preceding.lastIndexOf("\n") - 1,
  });

  expect(transformed.css).toContain("color: blue");

  expect(warning.message).toBe("mapped CSS warning");

  expect(warning.origin.filename).toBe(filename);

  const warningSpan = requireOriginSpan(warning.origin);

  expect(warningSpan.start).toBe(authored.indexOf(".card"));

  expect(warningSpan.end).toBeGreaterThan(warningSpan.start);

  expect(location.source?.replaceAll("\\", "/")).toBe(filename.replaceAll("\\", "/"));
});

test("Tailwind handles imported and generated CSS, maps its input branch, and records nested sources", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-tailwind-integration-"));

  roots.push(root);

  const sourceDir = join(root, "shared", "views");
  const cssDir = join(root, ".hesperia");

  await mkdir(sourceDir, { recursive: true });

  await mkdir(cssDir, { recursive: true });

  const source = join(sourceDir, "Card.tsx");

  await writeFile(
    source,
    'export const Card = () => <div class="bg-fuchsia-950 px-7 hover:underline" />;\n',
  );

  const importedCssPath = join(root, "app.css");
  const generatedCssPath = join(cssDir, "generated.css");
  const importedCss =
    '@import "tailwindcss" source(none);\n@source "./shared";\n.app-card { color: red; }\n';
  const generatedCss =
    '@import "tailwindcss" source(none);\n@source "../shared";\n.generated-card { color: red; }\n';

  await writeFile(importedCssPath, importedCss);

  await linkTailwindModule(root);

  const tailwindPlugin = tailwind({ base: root });
  const inputs: PluginCssInput[] = [];
  const observer: Plugin = {
    name: "observe-css-root-ownership",

    transformCss(input) {
      inputs.push(input);
    },
  };
  const generatedStylesPlugin: Plugin = {
    name: "generated-tailwind-fixture",

    generateStyles() {
      return {
        styles: [
          {
            id: "generated-tailwind",
            owner: { kind: "application" },
            css: generatedCss,
            inputFilename: generatedCssPath,
            origin: { filename: source, start: 0, end: 1 },
          },
        ],
      };
    },
  };
  const pipeline = new PluginPipeline([
    generatedStylesPlugin,
    observer,
    tailwindPlugin,
    postcss({
      plugins: [
        {
          postcssPlugin: "late-color-stage",

          Declaration(declaration: { prop: string; value: string }) {
            if (declaration.prop === "color" && declaration.value === "red")
              declaration.value = "blue";
          },
        } as unknown as ProbePostcssPlugin,
      ],
    }),
  ]);
  const importedInput = {
    kind: "import" as const,
    id: "css:app.css",
    filename: importedCssPath,
    css: importedCss,
    origin: { filename: importedCssPath, start: 0, end: importedCss.length },
  };
  const transformed = await pipeline.transformCss(importedInput);
  const trace = new TraceMap(transformed.map!);
  const generatedStyles = await pipeline.generateStyles(new Map(), {
    modules: new Map(),
  } as unknown as Parameters<typeof pipeline.generateStyles>[1]);
  const bundled = await bundleCssRoots(
    root,
    [{ importer: join(root, "app.tsx"), filename: importedCssPath, origin: importedInput.origin }],
    generatedStyles,
    pipeline,
  );

  expect(transformed.css).toContain(".bg-fuchsia-950");

  expect(transformed.css).toContain(".px-7");

  expect(transformed.css).toContain(".app-card");

  expect(transformed.css).toContain("color: blue");

  expect(
    trace.sources
      .filter((source): source is string => source !== null)
      .map((source) => source.replaceAll("\\", "/")),
  ).toContain(importedCssPath.replaceAll("\\", "/"));

  expect(trace.sources).toContain("<no source>");

  expect(
    trace.sources
      .filter((item): item is string => item !== null)
      .some((item) => item.toLowerCase().includes("tailwindcss")),
  ).toBe(true);

  expect(bundled.roots.map((item) => item.id)).toStrictEqual([
    "css:app.css",
    "generated:generated-tailwind",
  ]);

  for (const item of bundled.roots) {
    const output = await bundled.files.get(item.path)?.text();

    expect(output).toContain(".bg-fuchsia-950");

    expect(output).toContain(".px-7");
  }

  const resolvedWatchedFiles = await Promise.all(
    pipeline.watch
      .filter((item) => item.kind === "file")
      .map(async (item) => realpath(item.file).catch(() => undefined)),
  );

  expect(resolvedWatchedFiles).toContain(await realpath(source));

  const resolvedWatchedDirectories = await Promise.all(
    pipeline.watch
      .filter((item) => item.kind === "directory")
      .map(async (item) => ({
        item,
        dir: await realpath(item.dir).catch(() => undefined),
      })),
  );
  const sharedDirectory = await realpath(join(root, "shared"));
  const sharedWatch = resolvedWatchedDirectories.find((item) => item.dir === sharedDirectory);

  expect(sharedWatch?.item).toMatchObject({ kind: "directory", glob: expect.any(String) });

  expect(inputs.some((input) => input.kind === "import" && !("owner" in input))).toBe(true);

  expect(
    inputs.some(
      (input) =>
        input.kind === "generated" &&
        input.owner.kind === "application" &&
        input.filename === generatedCssPath,
    ),
  ).toBe(true);
});

test("Tailwind's default scan base is the configuration process cwd", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-tailwind-cwd-"));

  roots.push(root);

  await mkdir(join(root, "src"), { recursive: true });

  await writeFile(
    join(root, "src", "App.tsx"),
    'export const App = () => <main class="text-emerald-700" />;\n',
  );

  await linkTailwindModule(root);

  await writeFile(join(root, "app.css"), '@import "tailwindcss";\n');

  const adapter = pathToFileURL(join(import.meta.dir, "../../packages/tailwind/src/index.ts")).href;
  const script = join(root, "tailwind-cwd-probe.ts");

  await writeFile(
    script,
    `import { join } from "node:path";
import { tailwind } from ${JSON.stringify(adapter)};
const root = ${JSON.stringify(root)};
const filename = join(root, "app.css");
const input = { kind: "import", id: "css:app.css", filename, css: '@import "tailwindcss";\\n', origin: { filename, start: 0, end: 1 } };
const output = await tailwind().transformCss(input);
if (!output?.css.includes(".text-emerald-700")) throw new Error("default base did not scan the project cwd");
`,
  );

  const child = Bun.spawn([process.execPath, script], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  expect(status, stdout + stderr).toBe(0);
});

async function linkTailwindModule(root: string): Promise<void> {
  const modules = join(root, "node_modules");

  await mkdir(modules, { recursive: true });

  await symlink(
    join(import.meta.dir, "../../packages/tailwind/node_modules/tailwindcss"),
    join(modules, "tailwindcss"),
    process.platform === "win32" ? "junction" : "dir",
  );
}
