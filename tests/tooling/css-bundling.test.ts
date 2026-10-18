import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleCssRoots } from "../../packages/tooling/src/css-bundling.ts";
import { PluginPipeline } from "../../packages/tooling/src/plugin-pipeline.ts";
import { checkSources } from "../../packages/tooling/src/project.ts";
import type { PluginStyleArtifact } from "../../packages/tooling/src/plugins.ts";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("CSS output keys match the browser pathname for punctuation in filenames", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-css-path-"));

  roots.push(root);

  const app = join(root, "app.ts");

  await writeFile(join(root, "@theme+v2^name.css"), "body { color: red }");

  const pipeline = new PluginPipeline();
  const prepared = await pipeline.prepareImports(
    new Map([[app, 'import "./@theme+v2^name.css";']]),
    root,
  );
  const bundled = await bundleCssRoots(root, prepared.styles, [], pipeline);
  const path = bundled.roots[0]!.path;

  expect(path).toMatch(/^\/assets\/@theme\+v2%5Ename-/u);

  expect(bundled.files.has(new URL(`https://example.test${path}`).pathname)).toBe(true);
});

test("side-effect CSS imports retain source order and Bun bundles each root with nested URLs", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-css-bundle-"));

  roots.push(root);

  await mkdir(join(root, "src"));

  const app = join(root, "app.ts");
  const first = join(root, "src", "first.css");
  const second = join(root, "src", "second.css");

  await writeFile(first, '@import "./nested.css"; .first { background: url("./pixel.png") }');

  await writeFile(second, ".second { color: blue }");

  await writeFile(join(root, "src", "nested.css"), ".nested { color: red }");

  await writeFile(join(root, "src", "pixel.png"), new Uint8Array([0, 1, 2, 3]));

  const source =
    'import "./src/first.css"; import "./src/second.css"; import text from "./src/first.css" with { type: "string" }; export const count = text.length;';
  const pipeline = new PluginPipeline();
  const prepared = await pipeline.prepareImports(new Map([[app, source]]), root);

  expect(prepared.styles.map((item) => item.filename)).toStrictEqual([first, second]);

  expect(prepared.sources.get(app)?.current).not.toContain("with { type:");

  expect(prepared.projections).toHaveLength(1);

  expect(
    (await checkSources(new Map([[app, source]]), root)).filter(
      (item) => item.severity === "error",
    ),
  ).toStrictEqual([]);

  const bundled = await bundleCssRoots(root, prepared.styles, [], pipeline);

  expect(bundled.roots).toHaveLength(2);

  const firstCss = await bundled.files.get(bundled.roots[0]!.path)?.text();
  const secondCss = await bundled.files.get(bundled.roots[1]!.path)?.text();

  expect(firstCss).toContain(".nested{color:red}");

  expect(firstCss).toContain(".first{background:url(");

  expect(secondCss).toContain(".second{color:#00f}");

  expect(pipeline.capturedFiles.map((item) => item.filename)).toContain(
    join(root, "src", "pixel.png"),
  );
});

test("explicit css uses the ordinary captured stylesheet path and string stays inert", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-css-bundle-"));

  roots.push(root);

  const app = join(root, "app.ts");
  const css = join(root, "global.css");

  await writeFile(css, ".global { color: red }");

  const source = `import "./global.css" with { type: "css" };
import text from "./global.css" with { "type": "string" };
export { text };`;
  const pipeline = new PluginPipeline();
  const prepared = await pipeline.prepareImports(new Map([[app, source]]), root);

  expect(pipeline.diagnostics).toStrictEqual([]);

  expect(prepared.styles.map((item) => item.filename)).toStrictEqual([css]);

  expect(prepared.projections).toHaveLength(1);

  expect(prepared.projections[0]?.result.declaration.code).toContain("value: string");

  expect(pipeline.capturedFiles).toHaveLength(1);

  expect(prepared.sources.get(app)?.current).not.toContain('type: "css"');

  expect((await bundleCssRoots(root, prepared.styles, [], pipeline)).roots).toHaveLength(1);

  const dynamic = new PluginPipeline();
  const dynamicPrepared = await dynamic.prepareImports(
    new Map([
      [app, 'export const later = () => import("./global.css", { with: { "type": "css" } });'],
    ]),
    root,
  );

  expect(dynamic.diagnostics[0]?.message).toContain("have no owner");

  expect(dynamicPrepared.styles).toHaveLength(0);

  expect(dynamicPrepared.projections).toHaveLength(0);
});

test("explicit css parses a non-css extension and an extensionless captured root", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-css-bundle-"));

  roots.push(root);

  const app = join(root, "app.ts");
  const theme = join(root, "theme.style");
  const bare = join(root, "reset");

  await writeFile(theme, '@import "./nested.css"; .theme { color: red }');

  await writeFile(bare, ".reset { margin: 0 }");

  await writeFile(join(root, "nested.css"), ".nested { color: green }");

  const pipeline = new PluginPipeline();
  const prepared = await pipeline.prepareImports(
    new Map([
      [
        app,
        'import "./theme.style" with { type: "css" }; import "./reset" with { "type": "css" };',
      ],
    ]),
    root,
  );

  expect(pipeline.diagnostics).toStrictEqual([]);

  expect(prepared.styles.map((item) => item.filename)).toStrictEqual([theme, bare]);

  const bundled = await bundleCssRoots(root, prepared.styles, [], pipeline);

  expect(bundled.roots.map((item) => item.id)).toStrictEqual(["css:theme.style", "css:reset"]);

  expect(await bundled.files.get(bundled.roots[0]!.path)?.text()).toContain(".nested{color:green}");

  expect(await bundled.files.get(bundled.roots[0]!.path)?.text()).toContain(".theme{color:red}");

  expect(await bundled.files.get(bundled.roots[1]!.path)?.text()).toContain(".reset{margin:0}");
});

test("generated styles are separate Bun roots and resolve assets at their authored origin", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-css-bundle-"));

  roots.push(root);

  await mkdir(join(root, "src"));

  await writeFile(join(root, "src", "pixel.png"), new Uint8Array([0, 1, 2, 3]));

  const source = join(root, "src", "Card.tsx");
  const pipeline = new PluginPipeline();
  const bundled = await bundleCssRoots(
    root,
    [],
    [
      {
        id: "card-skin",
        owner: { kind: "component", id: `${source}#Card` },
        css: '.card { background: url("./pixel.png") }',
        origin: { filename: source, start: 0, end: 1 },
      },
    ],
    pipeline,
  );

  expect(bundled.roots[0]?.id).toBe("generated:card-skin");

  expect(await bundled.files.get(bundled.roots[0]!.path)?.text()).toContain(
    ".card{background:url(",
  );

  expect(pipeline.capturedFiles.map((item) => item.filename)).toContain(
    join(root, "src", "pixel.png"),
  );
});

test("native stylesheet roots preserve their parser-resolved local closure and content revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-native-css-"));

  roots.push(root);

  await mkdir(join(root, "styles", "media"), { recursive: true });

  const app = join(root, "app.tsx");
  const stylesheet = join(root, "styles", "main.css");
  const nested = join(root, "styles", "media", "nested.css");
  const extensionless = join(root, "styles", "media", "nested-theme");
  const utf16Parent = join(root, "styles", "utf16-parent.css");
  const tile = join(root, "styles", "media", "tile.png");
  const escapedTile = join(root, "styles", "media", "space # %.png");
  const latin1Tile = join(root, "styles", "media", "café.png");
  const inheritedLatin1Tile = join(root, "styles", "media", "child-café.png");
  const inheritedUtf8Tile = join(root, "styles", "media", "child-caf\uFFFD.png");
  const stylesheetPrefix = new TextEncoder().encode(
    '@charset "windows-1252";\n@import "./media/nested.css?from=main";\n@import "./media/nested-theme";\n@import "./utf16-parent.css";\n',
  );
  const stylesheetMiddle = new TextEncoder().encode(
    '\n.panel { background: url("./media/tile.png?asset=one,two#pixel"); }\n.panel { border-image-source: url("./media/space%20%23%20%25.png?asset=escaped"); }\n.panel::before { content: "',
  );
  const stylesheetAfterContent = new TextEncoder().encode(
    '"; }\n.panel { list-style-image: url("./media/caf',
  );
  const stylesheetSuffix = new TextEncoder().encode('.png?asset=latin1"); }\n');
  const stylesheetBytes = new Uint8Array([
    ...stylesheetPrefix,
    0xe9,
    ...stylesheetMiddle,
    ...stylesheetAfterContent,
    0xe9,
    ...stylesheetSuffix,
  ]);
  const nestedCssPrefix = new TextEncoder().encode(
    '@import url("../main.css?cycle=back");\n.panel { border: 1px solid red; }\n.panel::after { background-image: url("./child-caf',
  );
  const nestedCssSuffix = new TextEncoder().encode('.png?asset=inherited-charset"); }\n');
  const nestedBytes = new Uint8Array([...nestedCssPrefix, 0xe9, ...nestedCssSuffix]);
  const extensionlessBytes = ".panel { word-spacing: 3px; }\n";
  const utf16ParentBytes =
    '@charset "utf-16le";\n@import "./media/nested.css?from=utf16-parent";\n';

  await writeFile(stylesheet, stylesheetBytes);

  await writeFile(nested, nestedBytes);

  await writeFile(extensionless, extensionlessBytes);

  await writeFile(utf16Parent, utf16ParentBytes);

  await writeFile(tile, new Uint8Array([1, 2, 3, 4]));

  await writeFile(escapedTile, new Uint8Array([5, 6, 7, 8]));

  await writeFile(latin1Tile, new Uint8Array([9, 10, 11, 12]));

  await writeFile(inheritedLatin1Tile, new Uint8Array([13, 14, 15, 16]));

  await writeFile(inheritedUtf8Tile, new Uint8Array([17, 18, 19, 20]));

  await writeFile(join(root, "styles", "unreferenced.png"), new Uint8Array([9]));

  const style: PluginStyleArtifact = {
    id: "native-sheet",
    owner: { kind: "component", id: `${app}#Card` },
    css: "",
    origin: { filename: app, start: 0, end: 1 },
  };
  const native = {
    styleId: "generated:native-sheet",
    href: "./main.css?revision=one#sheet",
    sourceFilename: stylesheet,
    suffix: "?revision=one#sheet",
    origin: { filename: app, start: 0, end: 1 },
  } as const;
  const first = await bundleCssRoots(root, [], [style], new PluginPipeline(), [native]);
  const second = await bundleCssRoots(root, [], [style], new PluginPipeline(), [native]);
  const firstRoot = first.roots[0]!;
  const secondRoot = second.roots[0]!;

  expect(firstRoot.revision).toBe(secondRoot.revision);

  expect(firstRoot.href).toMatch(/\/main\.css\?revision=one#sheet$/u);

  expect(firstRoot.href).not.toContain("/styles/main.css");

  expect([...new Uint8Array(await first.files.get(firstRoot.path)!.arrayBuffer())]).toStrictEqual([
    ...stylesheetBytes,
  ]);

  expect(first.files.size).toBe(9);

  const nestedPath = [...first.files.keys()].find((path) => path.endsWith("/nested.css"));
  const extensionlessPath = [...first.files.keys()].find((path) => path.endsWith("/nested-theme"));
  const utf16ParentPath = [...first.files.keys()].find((path) =>
    path.endsWith("/utf16-parent.css"),
  );
  const tilePath = [...first.files.keys()].find((path) => path.endsWith("/tile.png"));
  const escapedTilePath = [...first.files.keys()].find((path) =>
    path.endsWith("/space%20%23%20%25.png"),
  );
  const latin1TilePath = [...first.files.keys()].find((path) => path.endsWith("/caf%C3%A9.png"));
  const inheritedLatin1TilePath = [...first.files.keys()].find((path) =>
    path.endsWith("/child-caf%C3%A9.png"),
  );
  const inheritedUtf8TilePath = [...first.files.keys()].find((path) =>
    path.endsWith("/child-caf%EF%BF%BD.png"),
  );

  expect(nestedPath).toBeDefined();

  expect(extensionlessPath).toBeDefined();

  expect(utf16ParentPath).toBeDefined();

  expect(inheritedUtf8TilePath).toBeDefined();

  expect(await first.files.get(extensionlessPath!)?.text()).toBe(extensionlessBytes);

  expect(tilePath).toBeDefined();

  expect(escapedTilePath).toBeDefined();

  expect(latin1TilePath).toBeDefined();

  expect(inheritedLatin1TilePath).toBeDefined();

  expect([...new Uint8Array(await first.files.get(nestedPath!)!.arrayBuffer())]).toStrictEqual([
    ...nestedBytes,
  ]);

  expect([...new Uint8Array(await first.files.get(tilePath!)!.arrayBuffer())]).toStrictEqual([
    1, 2, 3, 4,
  ]);

  expect([...new Uint8Array(await first.files.get(escapedTilePath!)!.arrayBuffer())]).toStrictEqual(
    [5, 6, 7, 8],
  );

  expect([...new Uint8Array(await first.files.get(latin1TilePath!)!.arrayBuffer())]).toStrictEqual([
    9, 10, 11, 12,
  ]);

  expect([
    ...new Uint8Array(await first.files.get(inheritedLatin1TilePath!)!.arrayBuffer()),
  ]).toStrictEqual([13, 14, 15, 16]);

  expect([
    ...new Uint8Array(await first.files.get(inheritedUtf8TilePath!)!.arrayBuffer()),
  ]).toStrictEqual([17, 18, 19, 20]);

  expect([...first.files.keys()].some((path) => path.endsWith("/unreferenced.png"))).toBe(false);

  await writeFile(tile, new Uint8Array([1, 2, 3, 5]));

  const changed = await bundleCssRoots(root, [], [style], new PluginPipeline(), [native]);

  expect(changed.roots[0]?.revision).not.toBe(firstRoot.revision);
});

test("missing nested CSS fails the Bun build without a partial bundle", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-css-bundle-"));

  roots.push(root);

  const source = join(root, "a.css");

  await writeFile(source, '@import "./absent.css";');

  await expect(
    bundleCssRoots(
      root,
      [
        {
          importer: join(root, "app.ts"),
          filename: source,
          origin: { filename: join(root, "app.ts"), start: 0, end: 24 },
        },
      ],
      [],
      new PluginPipeline(),
    ),
  ).rejects.toThrow("CSS bundling failed");
});

test("missing root CSS is an import-site check diagnostic", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-css-bundle-"));

  roots.push(root);

  const filename = join(root, "app.ts");
  const diagnostics = await checkSources(
    new Map([[filename, 'import "./absent.css"; export const value = 1;']]),
    root,
  );

  expect(
    diagnostics.some(
      (item) =>
        item.code === "HES-PLUGIN" &&
        item.filename === filename &&
        item.span?.start === 0 &&
        item.message.includes("Cannot read stylesheet"),
    ),
  ).toBe(true);
});

test("direct dynamic CSS import reports its missing owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-css-bundle-"));

  roots.push(root);

  const filename = join(root, "app.ts");
  const pipeline = new PluginPipeline();

  await pipeline.prepareImports(
    new Map([[filename, 'export const load = () => import("./theme.css");']]),
    root,
  );

  expect(
    pipeline.diagnostics.some(
      (item) =>
        item.severity === "error" &&
        item.message.includes("direct dynamic CSS imports have no owner"),
    ),
  ).toBe(true);
});
