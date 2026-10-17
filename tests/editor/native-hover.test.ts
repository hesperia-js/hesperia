import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { EditorProject } from "../../packages/language-server/src/project.ts";

test("every character of native opening and closing tags has its DOM type", async () => {
  const source = `export function App() {\r\n const emoji = "🐈";\r\n const input = <input />;\r\n return <main><button>{input}</button><svg><circle/><foreignObject><input /></foreignObject></svg><math><mi>x</mi></math></main>;\r\n}`;

  const filename = "native-hover.tsx";

  const project = await EditorProject.create([{ filename, source }]);

  try {
    expect(project.diagnostics.diagnostics).toStrictEqual([]);

    const types: Record<string, string> = {
      input: "HTMLInputElement",
      main: "HTMLElement",
      button: "HTMLButtonElement",
      svg: "SVGSVGElement",
      circle: "SVGCircleElement",
      foreignObject: "SVGForeignObjectElement",
      math: "MathMLElement",
      mi: "MathMLElement",
    };

    for (const match of source.matchAll(/<\/?([A-Za-z]+)/gu)) {
      const name = match[1]!;

      const start = match.index + match[0].indexOf(name);

      for (let index = 0; index < name.length; index++)
        expect((await project.hover(filename, start + index))?.type).toBe(types[name]);
    }

    expect((await project.hover(filename, source.indexOf("{input}") + 2))?.type).toBe(
      "HTMLInputElement",
    );
  } finally {
    await project.dispose();
  }
});

test("document shell tags resolve to their native types and declarations", async () => {
  const source =
    "export default function App() { return <html><head><title>App</title></head><body><main /></body></html>; }";

  const filename = "app.tsx";

  const project = await EditorProject.create([{ filename, source }], { documentShell: true });

  try {
    expect(project.diagnostics.diagnostics).toStrictEqual([]);

    for (const [tag, type] of [
      ["html", "HTMLHtmlElement"],
      ["head", "HTMLHeadElement"],
      ["title", "HTMLTitleElement"],
      ["body", "HTMLBodyElement"],
    ] as const) {
      const offset = source.indexOf(`<${tag}>`) + 2;

      expect((await project.hover(filename, offset))?.type).toBe(type);

      const locations = await project.definitions(filename, offset);

      expect(locations.length).toBeGreaterThan(0);

      for (const location of locations) {
        expect(location.filename.replaceAll("\\", "/")).toEndWith("/lib.dom.d.ts");

        const declaration = await Bun.file(location.filename).text();

        expect(declaration.slice(location.start, location.end)).toBe(type);
      }
    }
  } finally {
    await project.dispose();
  }
});

test("authored embedded-document markup gets the compiler's Hesperia Embed guidance", async () => {
  const source = `export function App(props: { source: string; blob: Blob }) {
  return <>
    <iframe src={props.source} />
    <iframe src={props.blob} />
    <embed src={props.source} />
    <embed src={props.blob} />
    <object src={props.source} />
    <object src={props.blob} />
  </>;
}`;

  const filename = "embedded-document.tsx";

  const project = await EditorProject.create([{ filename, source }]);

  try {
    const diagnostics = project.diagnostics.diagnostics.filter((item) => item.code === "HES-EMBED");

    expect(diagnostics).toHaveLength(6);

    for (const tag of ["iframe", "embed", "object"]) {
      const offset = source.indexOf(`<${tag}`);

      expect(
        diagnostics.some(
          (item) =>
            item.span?.start === offset &&
            item.message.includes("official Embed component from hesperia/embed"),
        ),
      ).toBe(true);
    }

    expect(diagnostics.every((item) => item.message.includes("hesperia/embed"))).toBe(true);
  } finally {
    await project.dispose();
  }
});

test("editor snapshots accept the same native Blob source forms as compiler checking", async () => {
  const source = await readFile(
    new URL("./fixtures/applications/blob-attributes/src/BlobAttributes.tsx", import.meta.url),
    "utf8",
  );

  const project = await EditorProject.create([{ filename: "blob-attributes.tsx", source }]);

  try {
    expect(project.diagnostics.diagnostics).toStrictEqual([]);
  } finally {
    await project.dispose();
  }
});
