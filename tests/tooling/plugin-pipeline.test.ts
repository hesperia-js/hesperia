import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { originalPositionFor, TraceMap } from "@jridgewell/trace-mapping";
import { PluginPipeline } from "../../packages/tooling/src/plugin-pipeline.ts";
import type { Plugin, PluginSourceMap } from "../../packages/tooling/src/plugins.ts";
import { checkSources } from "../../packages/tooling/src/project.ts";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("custom import handlers share captured Blob bytes but retain each importer's context", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-plugin-"));

  roots.push(root);

  const asset = join(root, "palette.dat");
  const first = join(root, "first.ts");
  const second = join(root, "second.ts");

  await writeFile(asset, "red,blue");

  const inputs: { importer: string; blob: Blob }[] = [];
  const plugin: Plugin = {
    name: "palette",

    transformSource(input) {
      return {
        code: `// transformed\n${input.current}`,
        map: {
          version: 3,
          sources: [input.filename],
          names: [],
          mappings: ";AAAA;AACA",
          sourcesContent: [input.current],
        },
      };
    },

    importTypes: {
      palette: async (input) => {
        inputs.push({ importer: input.importer, blob: input.file.blob });

        const value = `${await input.file.blob.text()}:${input.importer === first ? "first" : "second"}`;
        return {
          declaration: {
            code: "declare const value: string; export default value;",
            origin: input.importSpan,
          },
          browser: { code: `export default ${JSON.stringify(value)};`, origin: input.importSpan },
        };
      },
    },
  };
  const pipeline = new PluginPipeline([plugin]);
  const authored = `import palette from "./palette.dat" with { type: "palette" };\nexport const value = palette;`;
  const result = await pipeline.prepareImports(
    new Map([
      [first, authored],
      [second, authored],
    ]),
    root,
  );

  await writeFile(asset, "changed");

  expect(inputs.map((item) => item.importer)).toStrictEqual([first, second]);

  expect(inputs[0]!.blob).toBe(inputs[1]!.blob);

  expect(await inputs[0]!.blob.text()).toBe("red,blue");

  expect(result.projections.map((item) => item.result.browser.code)).toStrictEqual([
    'export default "red,blue:first";',
    'export default "red,blue:second";',
  ]);

  const rewritten = result.sources.get(first)!;

  expect(rewritten.current).not.toContain("with { type:");

  const position = positionAt(rewritten.current, rewritten.current.indexOf("value = palette"));
  const mapped = originalPositionFor(new TraceMap(rewritten.map!), position);

  expect({ line: mapped.line, column: mapped.column }).toStrictEqual(
    positionAt(authored, authored.indexOf("value = palette")),
  );

  const transformed = await pipeline.transformSources(result.sources, root);
  const finalSource = transformed.get(first)!;
  const finalPosition = originalPositionFor(new TraceMap(finalSource.map!), {
    line: 3,
    column: 0,
  });

  expect(finalPosition.source?.replaceAll("\\", "/")).toBe(first.replaceAll("\\", "/"));

  expect({ line: finalPosition.line, column: finalPosition.column }).toStrictEqual(
    positionAt(authored, authored.indexOf("export const value")),
  );
});

test("source and CSS stages retain plugin-specific data and ordered maps", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-plugin-"));

  roots.push(root);

  const filename = join(root, "component.tsx");
  const authored = "// function Card is mentioned here\nexport function Card() {}";
  const calls: string[] = [];
  let discoveredOrigin: { start: number; end: number } | undefined;
  const first: Plugin<{ color: string }> = {
    name: "first",

    transformSource(input) {
      calls.push("source:first");

      return { code: input.current, data: { color: "red" } };
    },

    generateStyles(sources) {
      calls.push(`styles:first:${sources[0]?.data?.color}`);

      return {
        styles: [
          {
            id: "first-style",
            owner: { kind: "application" },
            css: ".first{color:red}",
            origin: { filename, start: 0, end: 1 },
          },
        ],
      };
    },

    transformCss(input) {
      calls.push(`css:first:${input.id}`);

      return { css: input.css };
    },
  };
  const second: Plugin<{ padding: number }> = {
    name: "second",

    transformSource(input) {
      calls.push("source:second");

      return { code: input.current, data: { padding: 4 } };
    },

    generateStyles(sources) {
      calls.push(`styles:second:${sources[0]?.data?.padding}`);

      discoveredOrigin = sources[0]?.components[0]?.origin;
      return {
        styles: [
          {
            id: "second-style",
            owner: { kind: "component", id: `${filename}#Card` },
            css: ".second{padding:4px}",
            origin: { filename, start: 0, end: 1 },
          },
        ],
      };
    },

    transformCss(input) {
      calls.push(`css:second:${input.id}`);

      return { css: input.css };
    },
  };
  const pipeline = new PluginPipeline([first, second]);
  const sources = await pipeline.transformSources(
    new Map([
      [
        filename,
        {
          filename,
          authored,
          current: authored,
        },
      ],
    ]),
    root,
  );
  const compilation = {
    modules: new Map([[filename, { semantics: { components: new Set(["Card"]) } }]]),
  } as unknown as Parameters<typeof pipeline.generateStyles>[1];
  const styles = await pipeline.generateStyles(sources, compilation);

  expect(styles.map((item) => item.id)).toStrictEqual(["first-style", "second-style"]);

  expect(discoveredOrigin).toMatchObject({
    start: authored.lastIndexOf("Card"),
    end: authored.lastIndexOf("Card") + "Card".length,
  });

  expect(calls).toStrictEqual([
    "source:first",
    "source:second",
    "styles:first:red",
    "styles:second:4",
    "css:first:first-style",
    "css:second:first-style",
    "css:first:second-style",
    "css:second:second-style",
  ]);
});

test("generated component styles must use a compiler-discovered identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-plugin-"));

  roots.push(root);

  const filename = join(root, "Card.tsx");
  const pipeline = new PluginPipeline([
    {
      name: "unknown-owner",

      generateStyles() {
        return {
          styles: [
            {
              id: "orphan",
              owner: { kind: "component", id: `${filename}#Missing` },
              css: ".orphan{}",
              origin: { filename, start: 0, end: 0 },
            },
          ],
        };
      },
    },
  ]);
  const source = {
    filename,
    authored: "export function Card() {}",
    current: "export function Card() {}",
  };
  const compilation = {
    modules: new Map([[filename, { semantics: { components: new Set(["Card"]) } }]]),
  } as unknown as Parameters<typeof pipeline.generateStyles>[1];

  await expect(pipeline.generateStyles(new Map([[filename, source]]), compilation)).rejects.toThrow(
    "Unknown generated stylesheet component",
  );
});

test("an authored TypeScript error survives a source transform that removes it", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-plugin-"));

  roots.push(root);

  const filename = join(root, "src", "invalid.ts");
  const authored = 'export const broken: number = "wrong";';
  const replacement = "export const broken: number = 1;";
  const plugin: Plugin = {
    name: "erase",

    transformSource(input) {
      return {
        code: replacement,
        map: {
          version: 3,
          sources: [input.filename],
          names: [],
          mappings: "AAAA",
          sourcesContent: [input.authored],
        },
      };
    },
  };
  const diagnostics = await checkSources(new Map([[filename, authored]]), root, {
    allowUnsafeHTML: false,
    mountURL: "/",
    resolutionOverrides: { browser: {} },
    plugins: [plugin],
  });

  expect(diagnostics.some((item) => item.code === "TS2322" && item.filename === filename)).toBe(
    true,
  );
});

test("multi-source JavaScript maps compose only the exact current input through three stages", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-plugin-"));

  roots.push(root);

  const filename = join(root, "src", "app.ts");
  const vendor = join(root, "vendor", "extra.ts");
  const authored = "export const authoredValue = 1;";
  const vendorSource = "export const vendorValue = 2;";
  const pipeline = new PluginPipeline(mappedSourceStages(filename, vendor, vendorSource));
  const transformed = await pipeline.transformSources(
    new Map([[filename, { filename, authored, current: authored }]]),
    root,
  );
  const source = transformed.get(filename)!;
  const trace = new TraceMap(source.map!);
  const authoredPosition = originalPositionFor(trace, { line: 4, column: 0 });
  const vendorPosition = originalPositionFor(trace, { line: 5, column: 0 });
  const placeholderPosition = originalPositionFor(trace, { line: 6, column: 0 });
  const remotePosition = originalPositionFor(trace, { line: 7, column: 0 });
  const unmappedPosition = originalPositionFor(trace, { line: 1, column: 0 });

  expect(authoredPosition.source?.replaceAll("\\", "/")).toBe(filename.replaceAll("\\", "/"));

  expect({ line: authoredPosition.line, column: authoredPosition.column }).toStrictEqual({
    line: 1,
    column: 0,
  });

  expect(vendorPosition.source?.replaceAll("\\", "/")).toBe(vendor.replaceAll("\\", "/"));

  expect({ line: vendorPosition.line, column: vendorPosition.column }).toStrictEqual({
    line: 1,
    column: 0,
  });

  expect(placeholderPosition.source).toBe("<no source>");

  expect(remotePosition.source).toBe("webpack://vendor/hidden.ts");

  expect(unmappedPosition.source).toBeNull();

  expect(trace.sources).toContain("<no source>");

  expect(trace.sources).toContain("webpack://vendor/hidden.ts");

  expect(trace.sourcesContent).toContain(authored);

  expect(trace.sourcesContent).toContain(vendorSource);

  expect(trace.sourcesContent).toContain("remote source");
});

test("a multi-source map without the current-input edge stays attached to its vendor source", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-plugin-"));

  roots.push(root);

  const filename = join(root, "src", "input.ts");
  const vendor = join(root, "vendor", "input.ts");
  const authored = "export const authoredValue = 1;";
  const vendorSource = "export const vendorValue = 2;";
  const pipeline = new PluginPipeline([
    {
      name: "prior",

      transformSource(input) {
        return {
          code: `// prior\n${input.current}`,
          map: {
            version: 3,
            sources: [input.filename],
            names: [],
            mappings: ";AAAA",
            sourcesContent: [input.current],
          },
        };
      },
    },
    {
      name: "vendor-only",

      transformSource(input) {
        return {
          code: `${input.current}\n${vendorSource}`,
          map: {
            version: 3,
            sources: [vendor],
            names: [],
            mappings: ";AAAA",
            sourcesContent: [vendorSource],
          },
        };
      },
    },
  ]);
  const transformed = await pipeline.transformSources(
    new Map([[filename, { filename, authored, current: authored }]]),
    root,
  );
  const result = transformed.get(filename)!;
  const position = originalPositionFor(new TraceMap(result.map!), { line: 2, column: 0 });

  expect(position.source?.replaceAll("\\", "/")).toBe(vendor.replaceAll("\\", "/"));

  expect({ line: position.line, column: position.column }).toStrictEqual({ line: 1, column: 0 });

  expect(position.source).not.toBe(filename);
});

test("same-basename map entries in another directory do not compose to the current input", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-plugin-"));

  roots.push(root);

  const filename = join(root, "src", "input.ts");
  const other = join(root, "other", "input.ts");
  const authored = "export const value = 1;";
  const pipeline = new PluginPipeline([
    {
      name: "prior",

      transformSource(input) {
        return {
          code: `// prior\n${input.current}`,
          map: {
            version: 3,
            sources: [input.filename],
            names: [],
            mappings: ";AAAA",
            sourcesContent: [input.current],
          },
        };
      },
    },
    {
      name: "other-directory",

      transformSource(input) {
        return {
          code: input.current,
          map: {
            version: 3,
            sources: ["../other/input.ts"],
            names: [],
            mappings: "AAAA",
            sourcesContent: ["export const other = 1;"],
          },
        };
      },
    },
  ]);
  const transformed = await pipeline.transformSources(
    new Map([[filename, { filename, authored, current: authored }]]),
    root,
  );
  const position = originalPositionFor(new TraceMap(transformed.get(filename)!.map!), {
    line: 1,
    column: 0,
  });

  expect(position.source?.replaceAll("\\", "/")).toBe(other.replaceAll("\\", "/"));

  expect(position.source).not.toBe(filename);
});

if (process.platform === "linux") {
  test("Linux path case remains significant when selecting a current-input edge", async () => {
    const root = await mkdtemp(join(tmpdir(), "hesperia-plugin-"));

    roots.push(root);

    const filename = join(root, "src", "input.ts");
    const caseVariant = join(root, "src", "Input.ts");
    const authored = "export const value = 1;";
    const pipeline = new PluginPipeline([
      {
        name: "prior",

        transformSource(input) {
          return {
            code: `// prior\n${input.current}`,
            map: {
              version: 3,
              sources: [input.filename],
              names: [],
              mappings: ";AAAA",
              sourcesContent: [input.current],
            },
          };
        },
      },
      {
        name: "case-variant",

        transformSource(input) {
          return {
            code: input.current,
            map: {
              version: 3,
              sources: [caseVariant],
              names: [],
              mappings: "AAAA",
              sourcesContent: ["export const other = 1;"],
            },
          };
        },
      },
    ]);
    const transformed = await pipeline.transformSources(
      new Map([[filename, { filename, authored, current: authored }]]),
      root,
    );
    const position = originalPositionFor(new TraceMap(transformed.get(filename)!.map!), {
      line: 1,
      column: 0,
    });

    expect(position.source).toBe(caseVariant);

    expect(position.source).not.toBe(filename);
  });
}

if (process.platform === "win32") {
  test("Win32 case-equivalent paths compose while keeping authored source spelling", async () => {
    const root = await mkdtemp(join(tmpdir(), "hesperia-plugin-"));

    roots.push(root);

    const filename = join(root, "Author", "File.ts");
    const authored = "export const value = 1;";

    await mkdir(dirname(filename), { recursive: true });

    await writeFile(filename, authored);

    expect(await readFile(filename.toLowerCase(), "utf8")).toBe(authored);

    const pipeline = new PluginPipeline([
      {
        name: "prefix",

        transformSource(input) {
          return {
            code: `// prefix\n${input.current}`,
            map: {
              version: 3,
              sources: [input.filename],
              sourcesContent: [input.current],
              names: [],
              mappings: ";AAAA",
            },
          };
        },
      },
      {
        name: "case-equivalent",

        transformSource(input) {
          return {
            code: input.current,
            map: {
              version: 3,
              sources: [filename.toLowerCase()],
              sourcesContent: [input.current],
              names: [],
              mappings: ";AACA",
            },
          };
        },
      },
    ]);
    const transformed = await pipeline.transformSources(
      new Map([[filename, { filename, authored, current: authored }]]),
      root,
    );
    const position = originalPositionFor(new TraceMap(transformed.get(filename)!.map!), {
      line: 2,
      column: 0,
    });

    expect({ line: position.line, column: position.column }).toStrictEqual({ line: 1, column: 0 });

    expect(position.source).toBe(filename);
  });
}

test("multi-stage source-map diagnostics keep their authored spans", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-plugin-"));

  roots.push(root);

  const filename = join(root, "src", "invalid.ts");
  const vendor = join(root, "vendor", "extra.ts");
  const authored = 'export const broken: number = "wrong";';
  const badSpan = authored.indexOf("broken");
  const diagnostics = await checkSources(new Map([[filename, authored]]), root, {
    allowUnsafeHTML: false,
    mountURL: "/",
    resolutionOverrides: { browser: {} },
    plugins: mappedSourceStages(filename, vendor, "export const vendorValue = 2;"),
  });
  const typeError = diagnostics.find((item) => item.code === "TS2322");

  expect(typeError?.filename).toBe(filename);

  expect(typeError?.span).toStrictEqual({ start: badSpan, end: badSpan + "broken".length });
});

test("a cross-source diagnostic keeps its error without highlighting transformed offsets", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-plugin-"));

  roots.push(root);

  const filename = join(root, "src", "cross-source.ts");
  const vendor = join(root, "vendor", "other.ts");
  const authored = "export const broken: number = 1;";
  const generated = 'export const broken: number = "wrong";';
  const plugin: Plugin = {
    name: "cross-source",

    transformSource() {
      return {
        code: generated,
        map: {
          version: 3,
          sources: [filename, vendor],
          sourcesContent: [authored, generated],
          names: [],
          mappings: "AAAA,aAAa,MCAM",
        },
      };
    },
  };
  const diagnostics = await checkSources(new Map([[filename, authored]]), root, {
    allowUnsafeHTML: false,
    mountURL: "/",
    resolutionOverrides: { browser: {} },
    plugins: [plugin],
  });
  const error = diagnostics.find((item) => item.code === "TS2322");

  expect(error?.severity).toBe("error");

  expect(error?.filename).toBe(filename);

  expect(error?.message).toContain("location unavailable");

  expect(error?.span).toBeUndefined();
});

test("a foreign source without original text retains its diagnostic without a span", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-plugin-"));

  roots.push(root);

  const filename = join(root, "src", "missing-text.ts");
  const vendor = join(root, "vendor", "missing.ts");
  const authored = "export const broken: number = 1;";
  const generated = 'export const broken: number = "wrong";';
  const plugin: Plugin = {
    name: "missing-text",

    transformSource() {
      return {
        code: generated,
        map: {
          version: 3,
          sources: [vendor],
          sourcesContent: [null],
          names: [],
          mappings: "AAAA,aAAa,MAAM",
        },
      };
    },
  };
  const diagnostics = await checkSources(new Map([[filename, authored]]), root, {
    allowUnsafeHTML: false,
    mountURL: "/",
    resolutionOverrides: { browser: {} },
    plugins: [plugin],
  });
  const error = diagnostics.find((item) => item.code === "TS2322");

  expect(error?.severity).toBe("error");

  expect(error?.filename).toBe(filename);

  expect(error?.message).toContain("location unavailable");

  expect(error?.span).toBeUndefined();
});

test("ordered source and CSS maps compose to the authored file", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-plugin-"));

  roots.push(root);

  const filename = join(root, "Card.tsx");
  const authored = "export function Card() { return <div />; }";

  const add = (label: string): Plugin => ({
    name: label,

    transformSource(input) {
      return {
        code: `//${label}\n${input.current}`,
        map: {
          version: 3,
          sources: [input.filename],
          names: [],
          mappings: `;${input.current
            .split("\n")
            .map((_, index) => (index === 0 ? "AAAA" : "AACA"))
            .join(";")}`,
          sourcesContent: [input.current],
        },
      };
    },

    transformCss(input) {
      return {
        css: `/*${label}*/\n${input.css}`,
        map: {
          version: 3,
          sources: [input.filename],
          names: [],
          mappings: `;${input.css
            .split("\n")
            .map((_, index) => (index === 0 ? "AAAA" : "AACA"))
            .join(";")}`,
          sourcesContent: [input.css],
        },
      };
    },
  });

  const generator: Plugin = {
    name: "generator",

    generateStyles() {
      return {
        styles: [
          {
            id: "card.css",
            owner: { kind: "application" },
            css: ".card{color:red}",
            origin: { filename, start: 0, end: 1 },
            map: {
              version: 3,
              sources: [filename],
              names: [],
              mappings: "AAAA",
              sourcesContent: [authored],
            },
          },
        ],
      };
    },
  };
  const pipeline = new PluginPipeline([add("one"), add("two"), generator]);
  const transformed = await pipeline.transformSources(
    new Map([[filename, { filename, authored, current: authored }]]),
    root,
  );
  const source = transformed.get(filename)!;

  expect(originalPositionFor(new TraceMap(source.map!), { line: 3, column: 0 }).line).toBe(1);

  const compilation = {
    modules: new Map([[filename, { semantics: { components: new Set(["Card"]) } }]]),
  } as unknown as Parameters<typeof pipeline.generateStyles>[1];
  const styles = await pipeline.generateStyles(transformed, compilation);

  expect(styles[0]!.css).toStartWith("/*two*/\n/*one*/\n");

  const position = originalPositionFor(new TraceMap(styles[0]!.map!), { line: 3, column: 0 });

  expect(position.source?.replaceAll("\\", "/")).toBe(filename.replaceAll("\\", "/"));

  expect(position.line).toBe(1);
});

function mappedSourceStages(filename: string, vendor: string, vendorSource: string): Plugin[] {
  const fileUrl = pathToFileURL(filename).href.replace(
    /^file:\/\/\/([A-Z]):/iu,
    (_match, drive: string) =>
      process.platform === "win32" ? `file:///${drive.toLowerCase()}:` : `file:///${drive}:`,
  );
  return [
    {
      name: "first-map",

      transformSource(input) {
        return {
          code: `// first\n${input.current}`,
          map: {
            version: 3,
            sources: [input.filename],
            names: [],
            mappings: ";AAAA",
            sourcesContent: [input.current],
          },
        };
      },
    },
    {
      name: "multi-source-map",

      transformSource(input) {
        return {
          code: `// second\n${input.current}\n${vendorSource}\n// placeholder\n// remote`,
          map: {
            version: 3,
            sourceRoot: "..",
            sources: [
              relative(dirname(dirname(filename)), filename),
              relative(dirname(dirname(filename)), vendor),
              "<no source>",
              "webpack://vendor/hidden.ts",
            ],
            names: [],
            mappings: ";;AACA;ACDA;ACAA;ACAA",
            sourcesContent: [input.current, vendorSource, null, "remote source"],
          } as PluginSourceMap & { readonly sourceRoot: ".." },
        };
      },
    },
    {
      name: "third-map",

      transformSource(input) {
        return {
          code: `// third\n${input.current}`,
          map: {
            version: 3,
            sources: [fileUrl],
            names: [],
            mappings: ";;;AAEA;AACA;AACA;AACA",
            sourcesContent: [input.current],
          },
        };
      },
    },
  ];
}

function positionAt(source: string, offset: number): { line: number; column: number } {
  const preceding = source.slice(0, offset);
  return { line: preceding.split("\n").length, column: offset - preceding.lastIndexOf("\n") - 1 };
}
