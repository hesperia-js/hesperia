import { afterEach, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Window } from "happy-dom";
import { mount, type Component } from "hesperia";
import { PluginPipeline } from "../../packages/tooling/src/plugin-pipeline.ts";
import { checkProject, checkSources, prepareBuild } from "../../packages/tooling/src/project.ts";
import { linkFrameworkPackages, unlinkFrameworkPackages } from "./fixture-dependencies.ts";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await unlinkFrameworkPackages(root);

    await rm(root, { recursive: true, force: true });
  }
});

test("text and parsed JSON are separate views of one captured revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-assets-"));

  roots.push(root);

  const filename = join(root, "app.ts");
  const asset = join(root, "data.json");

  await writeFile(asset, '{"label":"visible","count":3,"tags":["one","two"]}');

  const authored = `import text from "./data.json";
import data from "./data.json" with { type: "json" };
export const later = () => import("./data.json", { with: { type: "json" } });
const label: string = data.label;
export { text, label };`;
  const pipeline = new PluginPipeline();
  const prepared = await pipeline.prepareImports(new Map([[filename, authored]]), root);

  expect(pipeline.capturedFiles).toHaveLength(1);

  expect(pipeline.capturedFiles[0]?.filename).toBe(asset);

  expect(prepared.projections).toHaveLength(3);

  expect(prepared.projections[0]?.result.browser.code).toContain("one");

  expect(prepared.projections[0]?.result.declaration.code).toContain("value: string");

  expect(prepared.projections[1]?.result.browser.code).toContain("JSON.parse");

  expect(prepared.projections[1]?.result.declaration.code).toContain('"label": string');

  expect(prepared.projections[1]?.result.declaration.code).toContain('"count": number');

  expect(prepared.projections[1]?.result.declaration.code).toContain('"tags": string[]');

  expect(prepared.sources.get(filename)?.current).not.toContain("with {");

  expect(prepared.sources.get(filename)?.current).toContain("() => import(");

  const diagnostics = await checkSources(new Map([[filename, authored]]), root);

  expect(diagnostics.filter((item) => item.severity === "error")).toStrictEqual([]);
});

test("quoted type keys select the same static and finite dynamic JSON interpretation", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-assets-"));

  roots.push(root);

  const filename = join(root, "app.ts");

  await writeFile(join(root, "data.json"), '{"count":7}');

  const authored = `import data from "./data.json" with { "type": "json" };
export const count: number = data.count;
export const later = () => import("./data.json", { "with": { "type": "json" } });`;
  const pipeline = new PluginPipeline();
  const prepared = await pipeline.prepareImports(new Map([[filename, authored]]), root);

  expect(pipeline.diagnostics).toStrictEqual([]);

  expect(pipeline.capturedFiles).toHaveLength(1);

  expect(prepared.projections).toHaveLength(2);

  expect(
    prepared.projections.every((item) => item.result.browser.code.includes("JSON.parse")),
  ).toBe(true);

  expect(prepared.sources.get(filename)?.current).not.toContain('"type": "json"');

  expect(
    (await checkSources(new Map([[filename, authored]]), root)).filter(
      (item) => item.severity === "error",
    ),
  ).toStrictEqual([]);

  await expect(
    new PluginPipeline().prepareImports(
      new Map([[filename, 'import data from "./data.json" with { "mode": "json" };']]),
      root,
    ),
  ).rejects.toThrow("Only with { type:");

  await expect(
    new PluginPipeline().prepareImports(
      new Map([
        [
          filename,
          'export const later = () => import("./data.json", { with: { "mode": "json" } });',
        ],
      ]),
      root,
    ),
  ).rejects.toThrow("Only import(path");

  for (const source of [
    'export const later = () => import("./data.json", { with: { ["type"]: "json" } });',
    'export const later = () => import("./data.json", { ["with"]: { type: "json" } });',
  ])
    await expect(
      new PluginPipeline().prepareImports(new Map([[filename, source]]), root),
    ).rejects.toThrow("Only import(path");
});

test("binary assets need explicit types and produce completed native Blobs", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-assets-"));

  roots.push(root);

  const filename = join(root, "app.ts");

  await writeFile(join(root, "photo.jpg"), new Uint8Array([0, 255, 1, 2]));

  const pipeline = new PluginPipeline();

  await pipeline.prepareImports(new Map([[filename, 'import photo from "./photo.jpg";']]), root);

  expect(pipeline.diagnostics[0]?.message).toContain("requires an explicit type");

  const prepared = await new PluginPipeline().prepareImports(
    new Map([[filename, 'import photo from "./photo.jpg" with { type: "image/png" };']]),
    root,
  );
  const result = prepared.projections[0]!.result;

  expect(result.diagnostics?.[0]?.message).toContain("bytes are not converted");

  const browserModule = join(root, "projected.mjs");

  await writeFile(browserModule, result.browser.code);

  const module = await import(pathToFileURL(browserModule).href);

  expect(module.default).toBeInstanceOf(Blob);

  expect(module.default.type).toBe("image/png");

  expect([...new Uint8Array(await module.default.arrayBuffer())]).toStrictEqual([0, 255, 1, 2]);

  const wrongCategory = new PluginPipeline();

  await wrongCategory.prepareImports(
    new Map([[filename, 'import photo from "./photo.jpg" with { type: "audio" };']]),
    root,
  );

  expect(wrongCategory.diagnostics[0]?.message).toContain("needs a full MIME type");
});

test("malformed text, missing assets, and unsupported explicit types fail at the import", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-assets-"));

  roots.push(root);

  const filename = join(root, "app.ts");

  await writeFile(join(root, "bad.data"), new Uint8Array([0xff]));

  await writeFile(join(root, "bad.json"), "{not json}");

  const diagnostic = async (source: string) => {
    const pipeline = new PluginPipeline();

    await pipeline.prepareImports(new Map([[filename, source]]), root);

    return pipeline.diagnostics[0];
  };

  expect((await diagnostic('import value from "./bad.data";'))?.message).toContain(
    "Malformed UTF-8",
  );

  expect((await diagnostic('import value from "./missing.txt";'))?.message).toContain("ENOENT");

  expect(
    (await diagnostic('import value from "./bad.data" with { type: "not-supported" };'))?.message,
  ).toContain("Unknown custom import type");

  expect(
    (await diagnostic('import value from "./bad.json" with { type: "json" };'))?.message,
  ).toContain("Invalid JSON");

  const checked = await checkSources(
    new Map([[filename, 'import value from "./bad.data";']]),
    root,
  );

  expect(
    checked.some(
      (item) =>
        item.code === "HES-PLUGIN" &&
        item.filename === filename &&
        item.span?.start === 0 &&
        item.message.includes("Malformed UTF-8"),
    ),
  ).toBe(true);
});

test("untyped SVG is source text while explicit image/svg+xml is a Blob", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-assets-"));

  roots.push(root);

  const filename = join(root, "app.ts");

  await writeFile(join(root, "logo.svg"), '<svg viewBox="0 0 1 1"></svg>');

  const pipeline = new PluginPipeline();
  const prepared = await pipeline.prepareImports(
    new Map([
      [
        filename,
        'import text from "./logo.svg"; import blob from "./logo.svg" with { type: "image/svg+xml" };',
      ],
    ]),
    root,
  );

  expect(pipeline.diagnostics).toStrictEqual([]);

  expect(pipeline.capturedFiles).toHaveLength(1);

  expect(prepared.projections[0]?.result.declaration.code).toContain("value: string");

  expect(prepared.projections[1]?.result.declaration.code).toContain("value: Blob");
});

test(
  "HTML and SVG imports build as checked components with the default permission",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "hesperia-markup-assets-"));

    roots.push(root);

    await mkdir(join(root, "src"));

    const filename = join(root, "app.tsx");

    await writeFile(join(root, "panel.html"), '<button title="from file">Click</button>');

    await writeFile(
      join(root, "fragment.html"),
      '<span id="fragment-one">one</span><span id="fragment-two">two</span>',
    );

    await writeFile(
      join(root, "icon.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0 0"/></svg>',
    );

    await writeFile(
      filename,
      `import Panel from "./panel.html" with { type: "html" };
import Fragment from "./fragment.html" with { type: "html" };
import Icon from "./icon.svg" with { type: "svg" };
export default function App() { return <html><head /><body><main><Panel title="caller" /><Fragment /><Icon /></main></body></html>; }`,
    );

    await linkFrameworkPackages(root);

    expect((await checkProject(root)).filter((item) => item.severity === "error")).toStrictEqual(
      [],
    );

    const build = await prepareBuild(root);

    expect(build.sources).toContain(join(root, "panel.html"));

    expect(build.sources).toContain(join(root, "fragment.html"));

    expect(build.sources).toContain(join(root, "icon.svg"));

    const source = await Bun.file(filename).text();

    for (const badUse of [
      '<Fragment title="blocked" />',
      '<Fragment children="blocked" />',
      "<Fragment bind={{}} />",
    ]) {
      await writeFile(filename, source.replace("<Fragment />", badUse));

      const invalidProps = await checkProject(root);

      expect(invalidProps.some((item) => item.severity === "error")).toBe(true);
    }

    await writeFile(filename, source);
  },
  { timeout: 30_000 },
);

test("checked SVG imports preserve XML names and normalized attributes", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-svg-xml-"));

  roots.push(root);

  const filename = join(root, "app.ts");
  const browserModule = join(root, "icon.mjs");

  await writeFile(
    join(root, "icon.svg"),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      "<!--prolog-->",
      "<?tool data?>",
      '<svg:svg xmlns:svg="http://www.w3.org/2000/svg" viewBox="0 0 1 1">',
      "<svg:text>A&amp;B&#65;&#x1F600;\rC\r\nD<![CDATA[E\r\nF]]>G</svg:text>",
      '<svg:path d="M0 0" data-note=" \t A  &amp;&#x20;&#66;&#9; \r\n C  "/>',
      "</svg:svg>",
      "<!--epilog-->",
      "<?tool data?>",
    ].join(""),
  );

  await linkFrameworkPackages(root);

  const pipeline = new PluginPipeline();
  const prepared = await pipeline.prepareImports(
    new Map([[filename, 'import Icon from "./icon.svg" with { type: "svg" };']]),
    root,
  );

  expect(pipeline.diagnostics).toStrictEqual([]);

  expect(prepared.projections).toHaveLength(1);

  expect(prepared.projections[0]?.result.diagnostics ?? []).toStrictEqual([]);

  await writeFile(browserModule, prepared.projections[0]!.result.browser.code);

  const generated = (await import(pathToFileURL(browserModule).href)) as {
    default: Component<object>;
  };
  const window = new Window();
  let app: ReturnType<typeof mount> | undefined;

  try {
    app = mount(window.document.body as unknown as Element, generated.default, {});

    await app.settled();

    const text = window.document.getElementsByTagName("svg:text")[0];
    const path = window.document.getElementsByTagName("svg:path")[0];

    expect(text?.namespaceURI).toBe("http://www.w3.org/2000/svg");

    expect(text?.localName).toBe("text");

    expect(text?.textContent).toBe("A&BA😀\nC\nDE\nFG");

    expect(path?.namespaceURI).toBe("http://www.w3.org/2000/svg");

    expect(path?.localName).toBe("path");

    expect(path?.getAttribute("data-note")).toBe("   A  & B\t   C  ");
  } finally {
    app?.dispose();

    await window.happyDOM.close();
  }
});

const logicalTextRunLimit = 10_000_000;

const repeatedText = (length: number): string => "x".repeat(length);

const svgWithText = (content: string, attributes = ""): string =>
  `<svg xmlns="http://www.w3.org/2000/svg"><text${attributes}>${content}</text></svg>`;

test.each([
  {
    name: "accepts an exact literal run",
    svg: () => svgWithText(repeatedText(logicalTextRunLimit)),
    rejects: false,
  },
  {
    name: "counts predefined, decimal, hexadecimal, and astral references at the exact limit",
    svg: () => svgWithText(repeatedText(logicalTextRunLimit - 5) + "&amp;&#65;&#x41;&#x1F600;"),
    rejects: false,
  },
  {
    name: "rejects a decoded reference beyond the exact limit",
    svg: () => svgWithText(repeatedText(logicalTextRunLimit - 4) + "&amp;&#65;&#x41;&#x1F600;"),
    rejects: true,
  },
  {
    name: "counts CR and CRLF as two normalized units at the exact limit",
    svg: () => svgWithText(repeatedText(logicalTextRunLimit - 2) + "\r\r\n"),
    rejects: false,
  },
  {
    name: "rejects a normalized CR beyond the exact limit",
    svg: () => svgWithText(repeatedText(logicalTextRunLimit) + "\r"),
    rejects: true,
  },
  {
    name: "rejects a normalized CRLF beyond the exact limit",
    svg: () => svgWithText(repeatedText(logicalTextRunLimit) + "\r\n"),
    rejects: true,
  },
  {
    name: "joins CDATA and ordinary text at the exact limit",
    svg: () => svgWithText(`<![CDATA[${repeatedText(5_000_000)}]]>${repeatedText(5_000_000)}`),
    rejects: false,
  },
  {
    name: "rejects CDATA and ordinary text when their joined run exceeds the limit",
    svg: () => svgWithText(`<![CDATA[${repeatedText(5_000_001)}]]>${repeatedText(5_000_000)}`),
    rejects: true,
  },
  {
    name: "rejects ordinary text followed by CDATA when their joined run exceeds the limit",
    svg: () => svgWithText(`${repeatedText(5_000_000)}<![CDATA[${repeatedText(5_000_001)}]]>`),
    rejects: true,
  },
  {
    name: "resets at a nested element boundary",
    svg: () => svgWithText(`${repeatedText(5_000_001)}<tspan>${repeatedText(5_000_000)}</tspan>`),
    rejects: false,
  },
  {
    name: "resets at a comment boundary",
    svg: () => svgWithText(`${repeatedText(5_000_001)}<!-- split -->${repeatedText(5_000_000)}`),
    rejects: false,
  },
  {
    name: "resets at a processing instruction boundary",
    svg: () => svgWithText(`${repeatedText(5_000_001)}<?split data?>${repeatedText(5_000_000)}`),
    rejects: false,
  },
  {
    name: "keeps attribute content outside the text-run limit",
    svg: () =>
      svgWithText(repeatedText(logicalTextRunLimit), ' data-note="&amp;&#65;&#x41;&#x1F600;"'),
    rejects: false,
  },
])(
  "checked SVG imports enforce decoded logical text runs: $name",
  async (entry) => {
    const root = await mkdtemp(join(tmpdir(), "hesperia-svg-text-limit-"));

    roots.push(root);

    const filename = join(root, "app.tsx");
    const assetFilename = join(root, "icon.svg");

    await mkdir(join(root, "src"));

    await writeFile(assetFilename, entry.svg());

    await writeFile(
      filename,
      `import Icon from "./icon.svg" with { type: "svg" };
export { Icon };
export default function App() { return <html><head /><body /></html>; }`,
    );

    await linkFrameworkPackages(root);

    const errors = (await checkProject(root)).filter((item) => item.severity === "error");

    if (entry.rejects) {
      expect(errors).toHaveLength(1);

      expect(errors[0]).toMatchObject({
        code: "HES-PLUGIN",
        filename: assetFilename,
        message: "Invalid standalone SVG/XML: Limit exceeded",
      });

      expect(errors[0]?.span).toBeUndefined();
    } else {
      expect(errors).toStrictEqual([]);
    }
  },
  { timeout: 45_000 },
);

test("checked SVG imports report distinct XML and namespace errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-markup-svg-errors-"));

  roots.push(root);

  const filename = join(root, "app.ts");
  const cases = [
    {
      asset: "invalid-character-reference.svg",
      contents: '<svg xmlns="http://www.w3.org/2000/svg"><text>&#x0;</text></svg>',
      message: "Character reference to invalid character",
    },
    {
      asset: "undeclared-entity.svg",
      contents: '<svg xmlns="http://www.w3.org/2000/svg"><text>&missing;</text></svg>',
      message: "Entity 'missing' is not declared",
    },
    {
      asset: "undeclared-prefix.svg",
      contents: "<svg:svg><svg:text>text</svg:text></svg:svg>",
      message: "Namespace prefix is not declared",
    },
    {
      asset: "duplicate-expanded-attribute.svg",
      contents:
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:a="urn:duplicate" xmlns:b="urn:duplicate"><g a:value="first" b:value="second"/></svg>',
      message: "Attribute 'b:value' appears multiple times",
    },
    {
      asset: "invalid-xml-declaration-order.svg",
      contents: '<?xml encoding="UTF-8" version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>',
      message: "XML declaration is not well-formed",
    },
    {
      asset: "invalid-comment.svg",
      contents: '<svg xmlns="http://www.w3.org/2000/svg"><!--bad -- comment--></svg>',
      message: "Comment contains invalid sequence '--'",
    },
    {
      asset: "reserved-xml-processing-instruction.svg",
      contents: '<?XML reserved?><svg xmlns="http://www.w3.org/2000/svg"/>',
      message: "Processing instruction target 'XML' is reserved",
    },
    {
      asset: "invalid-text-cdata-end.svg",
      contents: '<svg xmlns="http://www.w3.org/2000/svg"><text>bad]]>text</text></svg>',
      message: "Content contains invalid sequence ']]>'",
    },
    {
      asset: "reserved-xml-prefix.svg",
      contents: '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xml="urn:wrong"/>',
      message: "Namespace prefixes 'xml' and 'xmlns' are reserved",
    },
    {
      asset: "reserved-xml-namespace.svg",
      contents:
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:p="http://www.w3.org/XML/1998/namespace"/>',
      message: "XML and XMLNS namespaces are reserved",
    },
    {
      asset: "reserved-xmlns-namespace.svg",
      contents: '<svg xmlns="http://www.w3.org/2000/svg" xmlns:p="http://www.w3.org/2000/xmlns/"/>',
      message: "XML and XMLNS namespaces are reserved",
    },
    {
      asset: "prefix-undeclaring.svg",
      contents: '<svg xmlns="http://www.w3.org/2000/svg" xmlns:p="urn:outer"><g xmlns:p=""/></svg>',
      message: "Namespace prefix undeclaring is not supported",
    },
    {
      asset: "empty-document.svg",
      contents: "",
      message: "Unexpected end of file",
    },
    {
      asset: "unclosed-root.svg",
      contents: '<svg xmlns="http://www.w3.org/2000/svg">',
      message: "Unexpected end of file",
    },
    {
      asset: "text-after-root.svg",
      contents: '<svg xmlns="http://www.w3.org/2000/svg"/>trailing',
      message: "Content appears outside root element",
    },
    {
      asset: "anonymous-end-tag.svg",
      contents: '<svg xmlns="http://www.w3.org/2000/svg"></>',
      message: "End tag is not well-formed",
    },
    {
      asset: "malformed-qname.svg",
      contents:
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:p="urn:declared"><p:bad:name/></svg>',
      message: "QName is not well-formed",
    },
    {
      asset: "xmlns-element-prefix.svg",
      contents: '<svg xmlns="http://www.w3.org/2000/svg"><xmlns:g/></svg>',
      message: "Namespace prefixes 'xml' and 'xmlns' are reserved",
    },
    {
      asset: "unquoted-attribute.svg",
      contents: '<svg xmlns="http://www.w3.org/2000/svg"><g id=value/></svg>',
      message: "Start tag is not well-formed",
    },
    {
      asset: "literal-less-than-attribute.svg",
      contents: '<svg xmlns="http://www.w3.org/2000/svg"><g id="<"/></svg>',
      message: "Attribute value contains a literal '<'",
    },
    {
      asset: "duplicate-raw-attribute.svg",
      contents: '<svg xmlns="http://www.w3.org/2000/svg"><g id="first" id="second"/></svg>',
      message: "Attribute 'id' appears multiple times",
    },
    {
      asset: "missing-reference-semicolon.svg",
      contents: '<svg xmlns="http://www.w3.org/2000/svg"><text>&amp</text></svg>',
      message: "Entity reference is not well-formed",
    },
    {
      asset: "malformed-hex-reference.svg",
      contents: '<svg xmlns="http://www.w3.org/2000/svg"><text>&#x4G;</text></svg>',
      message: "Character reference to invalid character",
    },
    {
      asset: "malformed-doctype-token.svg",
      contents: '<!DOCTYPEx><svg xmlns="http://www.w3.org/2000/svg"/>',
      message: "Content appears outside root element",
    },
    {
      asset: "doctype-after-root.svg",
      contents: '<svg xmlns="http://www.w3.org/2000/svg"/><!DOCTYPE svg>',
      message: "DOCTYPE declaration is not well-formed",
    },
    {
      asset: "colon-processing-instruction.svg",
      contents: '<?p:tool data?><svg xmlns="http://www.w3.org/2000/svg"/>',
      message: "NCName contains colon ':'",
    },
    {
      asset: "colon-entity-reference.svg",
      contents: '<svg xmlns="http://www.w3.org/2000/svg"><text>&p:missing;</text></svg>',
      message: "NCName contains colon ':'",
    },
    {
      asset: "malformed-attribute-qname.svg",
      contents:
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:p="urn:declared"><g p:bad:name="value"/></svg>',
      message: "QName is not well-formed",
    },
  ] as const;

  for (const { asset, contents, message } of cases) {
    await writeFile(join(root, asset), contents);

    const prepared = await new PluginPipeline().prepareImports(
      new Map([[filename, `import Icon from "./${asset}" with { type: "svg" };`]]),
      root,
    );

    expect(prepared.projections).toHaveLength(1);

    expect(prepared.projections[0]?.result.diagnostics).toHaveLength(1);

    expect(prepared.projections[0]?.result.diagnostics?.[0]).toMatchObject({
      severity: "error",
      origin: { filename: join(root, asset) },
      message: `Invalid standalone SVG/XML: ${message}`,
    });
  }
});

test.each([
  { name: "URL strings", extended: false, rejected: "" },
  { name: "Blob and structured srcset", extended: true, rejected: "" },
  { name: "script Blob rejection", extended: false, rejected: "<Script src={blob} />" },
  { name: "caller children rejection", extended: false, rejected: '<Image children="blocked" />' },
  { name: "native iframe string rejection", extended: false, rejected: '<iframe src="/frame" />' },
  { name: "native iframe Blob rejection", extended: false, rejected: "<iframe src={blob} />" },
  { name: "native embed Blob rejection", extended: false, rejected: "<embed src={blob} />" },
  { name: "native object Blob rejection", extended: false, rejected: "<object data={blob} />" },
])(
  "imported HTML root source props: $name",
  async (entry) => {
    const root = await mkdtemp(join(tmpdir(), "hesperia-markup-source-props-"));

    roots.push(root);

    await cp(join(import.meta.dir, "fixtures/applications/imported-source-props"), root, {
      recursive: true,
    });

    await mkdir(join(root, "src"));

    await linkFrameworkPackages(root);

    const filename = join(root, "app.tsx");
    const authored = await readFile(filename, "utf8");
    const strings = authored
      .replaceAll("src={blob}", 'src="/image.png"')
      .replaceAll("poster={blob}", 'poster="/poster.png"')
      .replaceAll("srcset={sourceSet}", 'srcset="/image.png 480w, /large.png 960w"');
    const source = entry.extended ? authored : strings.replace("{/* rejected */}", entry.rejected);

    await writeFile(filename, source);

    const errors = (await checkProject(root)).filter((item) => item.severity === "error");

    if (entry.rejected === "") {
      expect(errors).toStrictEqual([]);
    } else {
      const start = source.indexOf(entry.rejected);

      const primary = errors.filter((item) => item.code !== "HES-CAPABILITY-UNRESOLVED");

      expect(primary.length).toBeGreaterThan(0);

      expect(
        primary.every(
          (item) =>
            item.span !== undefined &&
            item.span.start >= start &&
            item.span.end <= start + entry.rejected.length,
        ),
      ).toBe(true);

      if (
        entry.rejected.startsWith("<iframe") ||
        entry.rejected.startsWith("<embed") ||
        entry.rejected.startsWith("<object")
      )
        expect(primary.some((item) => item.code === "HES-EMBED")).toBe(true);
    }
  },
  { timeout: 30_000 },
);

test("MathML markup roots retain their namespace type through project checking", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-markup-mathml-"));

  roots.push(root);

  await mkdir(join(root, "src"));

  await writeFile(join(root, "hesperia.config.json"), '{"allowUnsafeHTML":true}');

  await writeFile(
    join(root, "root.html"),
    '<math xmlns="http://www.w3.org/1998/Math/MathML"><mi>x</mi></math>',
  );

  const filename = join(root, "app.tsx");
  const source = `import * as client from "hesperia/client";
import MathRoot from "./root.html" with { type: "html" };
export default function App() {
  const target = client.unsafeBind<MathMLElement>();
  return <html><head /><body><MathRoot bind={target} /></body></html>;
}`;

  await writeFile(filename, source);

  await linkFrameworkPackages(root);

  expect((await checkProject(root)).filter((item) => item.severity === "error")).toStrictEqual([]);
});

test("markup imports reject active content with either unsafe HTML permission", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-markup-assets-"));

  roots.push(root);

  const filename = join(root, "app.ts");
  const cases = [
    ["active.html", '<a href="data:text/plain,ordinary text">open</a>', "executable URL"],
    [
      "encoded-data-navigation.html",
      '<a href="&#x64;ata:text/plain,ordinary text">open</a>',
      "executable URL",
    ],
    ["handler.html", '<button ONCLICK="run()">go</button>', "inline event handlers"],
    [
      "unknown-handler.html",
      '<x-widget onfutureevent="run()"></x-widget>',
      "inline event handlers",
    ],
    ["doc.html", '<iframe src="about:blank"></iframe>', "embedded documents"],
    ["refresh.html", '<meta http-equiv="Refresh" content="0;url=/">', "refresh controls"],
    ["script.html", '<script type="importmap">{}</script>', "executable scripts"],
    [
      "prefixed-script.svg",
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:s="http://www.w3.org/2000/svg"><s:script>alert(1)</s:script></svg>',
      "executable scripts",
    ],
    [
      "invalid.svg",
      '<svg xmlns="http://www.w3.org/2000/svg"><g></svg>',
      "Invalid standalone SVG/XML",
    ],
    ["doctype.svg", '<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg"/>', "DOCTYPE"],
    [
      "animation.svg",
      '<svg xmlns="http://www.w3.org/2000/svg"><a href="#safe"><animate attributeName="href" values="#safe;javascript:alert(1)" dur=".01s" fill="freeze"/></a></svg>',
      "SMIL animation",
    ],
    [
      "prefixed-animation.svg",
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:a="http://www.w3.org/2000/svg"><a:animate attributeName="href" values="javascript:alert(1)" dur=".01s" fill="freeze"/></svg>',
      "SMIL animation",
    ],
    [
      "animation.html",
      '<svg xmlns="http://www.w3.org/2000/svg"><a href="#safe"><animate attributeName="href" values="#safe;javascript:alert(1)" dur=".01s" fill="freeze"/></a></svg>',
      "SMIL animation",
    ],
    [
      "xlink-javascript.svg",
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><a xlink:href="javascript:alert(1)"><text>go</text></a></svg>',
      "executable URL",
    ],
    [
      "inline-xlink.html",
      '<svg xmlns:xlink="http://www.w3.org/1999/xlink"><a xlink:href="data:text/plain,go"><text>go</text></a></svg>',
      "executable URL",
    ],
    ["active-srcset.html", '<img srcset="javascript:alert(1) 1x">', "executable URL"],
    [
      "escaped-css-url.svg",
      '<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:url(\'j\\61vascript:alert(1)\')"/></svg>',
      "executable CSS URL",
    ],
  ] as const;

  for (const allowUnsafeHTML of [false, true]) {
    for (const [asset, contents, expected] of cases) {
      await writeFile(join(root, asset), contents);

      const result = await new PluginPipeline([], { allowUnsafeHTML }).prepareImports(
        new Map([
          [
            filename,
            `import markup from "./${asset}" with { type: "${asset.endsWith(".svg") ? "svg" : "html"}" };`,
          ],
        ]),
        root,
      );

      expect(result.projections).toHaveLength(1);

      expect(result.projections[0]?.result.declaration.code).toContain("unknown");

      expect(result.projections[0]?.result.diagnostics?.[0]?.message).toContain(expected);

      if (asset.endsWith(".svg"))
        expect(result.projections[0]?.result.diagnostics?.[0]?.origin).toStrictEqual({
          filename: join(root, asset),
        });
      else
        expect(result.projections[0]?.result.diagnostics?.[0]?.origin).toMatchObject({
          filename,
          start: 0,
        });
    }
  }

  await writeFile(
    join(root, "safe.html"),
    '<script type="application/ld+json">{"ok":true}</script><img src="data:image/png;base64,AA==" srcset="/small.png 1x, /large.png 2x" style="background-image:url(#local)"><x-widget data-value="ok"></x-widget><svg><use href="#local"></use></svg>',
  );

  const pipeline = new PluginPipeline();
  const safe = await pipeline.prepareImports(
    new Map([[filename, 'import Markup from "./safe.html" with { type: "html" };']]),
    root,
  );

  expect(pipeline.diagnostics).toStrictEqual([]);

  expect(safe.projections[0]?.result.browser.code).toContain("x-widget");
});

test("SVG DOCTYPE rejection happens before any external entity request", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-markup-entity-"));

  roots.push(root);

  const filename = join(root, "app.ts");
  let requests = 0;
  const server = Bun.serve({
    port: 0,

    fetch() {
      requests++;
      return new Response("unexpected external entity");
    },
  });

  try {
    await writeFile(
      join(root, "external.svg"),
      `<!DOCTYPE svg [<!ENTITY xxe SYSTEM "${server.url.href}entity">]><svg xmlns="http://www.w3.org/2000/svg">&xxe;</svg>`,
    );

    for (const allowUnsafeHTML of [false, true]) {
      const pipeline = new PluginPipeline([], { allowUnsafeHTML });
      const prepared = await pipeline.prepareImports(
        new Map([[filename, 'import Icon from "./external.svg" with { type: "svg" };']]),
        root,
      );

      expect(prepared.projections[0]?.result.diagnostics?.[0]?.message).toContain("DOCTYPE");

      expect(requests).toBe(0);
    }
  } finally {
    server.stop(true);
  }
});

test("an extensionless file and an unfamiliar extension default to strings", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-assets-"));

  roots.push(root);

  const filename = join(root, "app.ts");

  await writeFile(join(root, "notes"), "plain notes");

  await writeFile(join(root, "shape.mystery"), "unknown format");

  const prepared = await new PluginPipeline().prepareImports(
    new Map([[filename, 'import notes from "./notes"; import shape from "./shape.mystery";']]),
    root,
  );

  expect(prepared.projections.map((item) => item.result.declaration.code)).toStrictEqual([
    "declare const value: string; export default value;",
    "declare const value: string; export default value;",
  ]);

  expect(prepared.projections[0]?.result.browser.code).toContain("plain notes");

  expect(prepared.projections[1]?.result.browser.code).toContain("unknown format");
});

test("parsed JSON keeps an own __proto__ key in the browser value", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-assets-"));

  roots.push(root);

  const filename = join(root, "app.ts");

  await writeFile(join(root, "special.json"), '{"__proto__":{"x":1}}');

  const prepared = await new PluginPipeline().prepareImports(
    new Map([[filename, 'import value from "./special.json" with { type: "json" };']]),
    root,
  );
  const code = prepared.projections[0]!.result.browser.code;
  const browserModule = join(root, "special.mjs");

  await writeFile(browserModule, code);

  const value = (await import(pathToFileURL(browserModule).href)).default;

  expect(Object.hasOwn(value, "__proto__")).toBe(true);

  expect(value.__proto__).toStrictEqual({ x: 1 });

  expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
});

test("a project without config checks and bundles built-in asset views", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-assets-"));

  roots.push(root);

  await linkFrameworkPackages(root);

  await mkdir(join(root, "src"));

  await writeFile(join(root, "label.txt"), "hello from file");

  await writeFile(join(root, "data.json"), '{"count":4}');

  await writeFile(join(root, "photo.png"), new Uint8Array([0, 1, 2, 255]));

  await writeFile(
    join(root, "app.tsx"),
    `import label from "./label.txt";
import data from "./data.json" with { type: "json" };
import photo from "./photo.png" with { type: "image" };
export default function App() { const count: number = data.count;
  return <html><head></head><body>{label}{count}{photo.type}<button on:click={() => {
    void import("./data.json", { with: { type: "json" } }).then(result => console.log(result.default.count));
  }}>Load</button></body></html>; }`,
  );

  expect((await checkProject(root)).filter((item) => item.severity === "error")).toStrictEqual([]);

  const build = await prepareBuild(root);
  const js = (
    await Promise.all(
      [...build.files].filter(([path]) => path.endsWith(".js")).map(([, blob]) => blob.text()),
    )
  ).join("\n");

  expect(js).toContain("hello from file");

  expect(js).toContain("image/png");

  expect(js).not.toContain("with { type:");

  expect(build.sources).toContain(join(root, "photo.png"));
});
