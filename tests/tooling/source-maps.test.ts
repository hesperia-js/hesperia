import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { originalPositionFor, TraceMap, type SourceMapInput } from "@jridgewell/trace-mapping";
import { prepareBuild } from "../../packages/tooling/src/project.ts";
import { identityMappings, pluginSourceMap } from "./plugin-source-map-fixture.ts";

test("browser bundle maps authored TSX and imported HTML after CRLF and Unicode", async () => {
  const parent = resolve(import.meta.dir, "../../.hesperia");

  await mkdir(parent, { recursive: true });

  const root = await mkdtemp(join(parent, "bundle-map-"));
  const source = [
    "type Removed = { value: number };",
    "export default function App() {",
    '  const marker: number = -7; const cat = "🐈";',
    "  return <span>{Math.abs(marker)}</span>;",
    "}",
  ].join("\r\n");
  const markup = '\r\n<!--🐈--><button data-r06-map="current">Mapped markup</button>\r\n';
  const files = new Map([
    ["src/App.tsx", source],
    ["src/Panel.html", markup],
    [
      "app.tsx",
      'import Content from "./src/App.tsx"; import Panel from "./src/Panel.html" with { type: "html" }; export default function App() { return <html><head></head><body><Content /><Panel /></body></html>; }',
    ],
    ["hesperia.config.json", '{"allowUnsafeHTML":true}'],
    [
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          target: "ESNext",
          module: "ESNext",
          moduleResolution: "bundler",
          jsx: "preserve",
          strict: true,
          noEmit: true,
          allowImportingTsExtensions: true,
          skipLibCheck: true,
        },
        include: ["src"],
      }),
    ],
  ]);

  await mkdir(join(root, "src"));

  try {
    for (const [name, contents] of files) await writeFile(join(root, name), contents);

    const built = await prepareBuild(root);

    expect(built.diagnostics).toStrictEqual([]);

    const scripts = await Promise.all(
      [...built.files]
        .filter(([name]) => name.endsWith(".js"))
        .map(async ([name, blob]) => ({
          name,
          contents: await blob.text(),
        })),
    );
    const scriptPath = scripts.find(({ contents }) => contents.includes("Math.abs"))!.name;
    const script = await built.files.get(scriptPath)!.text();
    const map = JSON.parse(await built.files.get(scriptPath + ".map")!.text()) as SourceMapInput;
    const token = script.indexOf("Math.abs");

    expect(token).toBeGreaterThanOrEqual(0);

    const generated = position(script, token + "Math.".length);
    const trace = new TraceMap(map);
    const original = originalPositionFor(trace, generated);

    expect(original.source?.replaceAll("\\", "/")).toEndWith("/src/App.tsx");

    expect({ line: original.line, column: original.column }).toStrictEqual(
      position(source, source.indexOf("abs")),
    );

    const sourceIndex = trace.sources.indexOf(original.source!);

    expect(trace.sourcesContent?.[sourceIndex]).toBe(source);

    const markupScript = scripts.find(({ contents }) => contents.includes("data-r06-map"));

    expect(markupScript).toBeDefined();

    const markupMap = JSON.parse(
      await built.files.get(markupScript!.name + ".map")!.text(),
    ) as SourceMapInput;
    const markupToken = markupScript!.contents.indexOf("data-r06-map");
    const mappedMarkup = originalPositionFor(
      new TraceMap(markupMap),
      position(markupScript!.contents, markupToken),
    );

    expect(mappedMarkup.source?.replaceAll("\\", "/")).toEndWith("/src/Panel.html");

    expect({ line: mappedMarkup.line, column: mappedMarkup.column }).toStrictEqual(
      position(markup, markup.indexOf("data-r06-map")),
    );

    const markupSourceIndex = new TraceMap(markupMap).sources.indexOf(mappedMarkup.source!);

    expect(new TraceMap(markupMap).sourcesContent?.[markupSourceIndex]).toBe(markup);
  } finally {
    for (const name of [...files.keys(), "hesperia.d.ts"])
      await unlink(join(root, name)).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });

    await rmdir(join(root, "src"));

    await rmdir(root);
  }
});

test("final browser maps preserve plugin source identities, source roots, and captured content", async () => {
  const parent = resolve(import.meta.dir, "../../.hesperia");

  await mkdir(parent, { recursive: true });

  const root = await mkdtemp(join(parent, "plugin-bundle-map-"));
  const imported = [
    { name: "webpack", marker: "WEBPACK_SOURCE_LITERAL", source: "webpack://vendor/original.ts" },
    {
      name: "remote",
      marker: "REMOTE_SOURCE_LITERAL",
      source: "https://example.invalid/vendor/original.ts?version=2#source",
    },
    { name: "placeholder", marker: "PLACEHOLDER_SOURCE_LITERAL", source: "<no source>" },
    {
      name: "file",
      marker: "FILE_URL_SOURCE_LITERAL",
      source: pathToFileURL(join(root, "originals/file.ts")).href,
    },
    {
      name: "absolute",
      marker: "ABSOLUTE_SOURCE_LITERAL",
      source: join(root, "originals/absolute.ts"),
    },
  ].map((item) => ({ ...item, content: `export const ${item.name} = "${item.marker}";` }));
  const browserCode = imported.map((item) => item.content).join("\n");
  const browserMap = pluginSourceMap(
    imported.map((item) => ({ filename: item.source, content: item.content })),
    identityMappings(
      imported.map((item, index) => ({
        generatedLine: index,
        sourceIndex: index,
        originalLine: 0,
        text: item.content,
      })),
    ),
  );
  const relativeFilename = join(root, "src/relative.ts");
  const exactFilename = join(root, "src/exact.ts");
  const relativeSource = 'export const relative = "RELATIVE_SOURCE_LITERAL";';
  const exactSource = 'export const exact = "EXACT_SOURCE_LITERAL";';
  const transforms = {
    [relativeFilename]: {
      ...pluginSourceMap(
        [{ filename: "relative-original.ts", content: relativeSource }],
        identityMappings([
          { generatedLine: 0, sourceIndex: 0, originalLine: 0, text: relativeSource },
        ]),
      ),
      sourceRoot: "../originals",
    },
    [exactFilename]: pluginSourceMap(
      [{ filename: exactFilename, content: exactSource }],
      identityMappings([{ generatedLine: 0, sourceIndex: 0, originalLine: 0, text: exactSource }]),
    ),
  };
  const pluginResult = {
    declaration: { code: imported.map((item) => `export const ${item.name}: string;`).join("\n") },
    browser: { code: browserCode, map: browserMap },
  };

  try {
    await mkdir(join(root, "src"));

    await writeFile(join(root, "src/input.dat"), "mapped input");

    await writeFile(relativeFilename, relativeSource);

    await writeFile(exactFilename, exactSource);

    await writeFile(
      join(root, "app.tsx"),
      `import { ${imported.map((item) => item.name).join(",")} } from "./src/input.dat" with {type:"mapped"}; import {relative} from "./src/relative.ts"; import {exact} from "./src/exact.ts"; export default function App(){return <html><head/><body>{[${[...imported.map((item) => item.name), "relative", "exact"].join(",")}].join(":")}</body></html>;}`,
    );

    await writeFile(
      join(root, "hesperia.config.ts"),
      `const result=${JSON.stringify(pluginResult)}; const transforms=${JSON.stringify(transforms)}; export default {plugins:[{name:"final-map-identities", importTypes:{mapped(input){return {declaration:{...result.declaration,origin:input.importSpan},browser:{...result.browser,origin:input.importSpan}};}}, transformSource(input){const map=transforms[input.filename]; return map ? {code:input.current,map} : undefined;}}]};`,
    );

    const built = await prepareBuild(root, true);

    expect(built.diagnostics).toStrictEqual([]);

    const scripts = await Promise.all(
      [...built.files]
        .filter(([name]) => name.endsWith(".js"))
        .map(async ([name, file]) => ({ name, code: await file.text() })),
    );
    const expected = [
      ...imported.map((item) => ({
        marker: item.marker,
        source: item.name === "file" ? join(root, "originals/file.ts") : item.source,
        content: item.content,
      })),
      {
        marker: "RELATIVE_SOURCE_LITERAL",
        source: join(root, "originals/relative-original.ts"),
        content: relativeSource,
      },
      { marker: "EXACT_SOURCE_LITERAL", source: exactFilename, content: exactSource },
    ];
    const actual = [];

    for (const item of expected) {
      const script = scripts.find((script) => script.code.includes(item.marker));

      expect(script).toBeDefined();

      const map = JSON.parse(
        await built.files.get(`${script!.name}.map`)!.text(),
      ) as SourceMapInput;
      const trace = new TraceMap(map);
      const mapped = originalPositionFor(
        trace,
        position(script!.code, script!.code.indexOf(item.marker) - 1),
      );
      const sourceIndex = trace.resolvedSources.indexOf(mapped.source!);

      actual.push({
        source: mapped.source?.replaceAll("\\", "/"),
        line: mapped.line,
        column: mapped.column,
        content: trace.sourcesContent?.[sourceIndex],
      });
    }

    expect(actual).toStrictEqual(
      expected.map((item) => ({
        source: item.source.replaceAll("\\", "/"),
        ...position(item.content, item.content.indexOf(item.marker) - 1),
        content: item.content,
      })),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function position(source: string, offset: number): { line: number; column: number } {
  const prefix = source.slice(0, offset);
  return { line: prefix.split("\n").length, column: offset - prefix.lastIndexOf("\n") - 1 };
}
