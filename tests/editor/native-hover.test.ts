import { expect, test } from "bun:test";
import { EditorProject } from "../../src/editor/project.ts";

test("every character of native opening and closing tags has its DOM type", () => {
  const source = `export function App() {\r\n const emoji = "🐈";\r\n const input = <input />;\r\n return <main><button>{input}</button><svg><circle/><foreignObject><input /></foreignObject></svg><math><mi>x</mi></math></main>;\r\n}`;
  const filename = "native-hover.tsx";
  const project = new EditorProject([{ filename, source }]);
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
        expect(project.hover(filename, start + index)?.type).toBe(types[name]);
    }
    expect(project.hover(filename, source.indexOf("{input}") + 2)?.type).toBe("HTMLInputElement");
  } finally {
    project.dispose();
  }
});

test("document shell tags resolve to their native types and declarations", async () => {
  const source =
    "export default function App() { return <html><head><title>App</title></head><body><main /></body></html>; }";
  const filename = "app.tsx";
  const project = new EditorProject([{ filename, source }], { documentShell: true });
  try {
    expect(project.diagnostics.diagnostics).toStrictEqual([]);
    for (const [tag, type] of [
      ["html", "HTMLHtmlElement"],
      ["head", "HTMLHeadElement"],
      ["title", "HTMLTitleElement"],
      ["body", "HTMLBodyElement"],
    ] as const) {
      const offset = source.indexOf(`<${tag}>`) + 2;
      expect(project.hover(filename, offset)?.type).toBe(type);
      const locations = project.definitions(filename, offset);
      expect(locations.length).toBeGreaterThan(0);
      for (const location of locations) {
        expect(location.filename.replaceAll("\\", "/")).toEndWith("/lib.dom.d.ts");
        const declaration = await Bun.file(location.filename).text();
        expect(declaration.slice(location.start, location.end)).toBe(type);
      }
    }
  } finally {
    project.dispose();
  }
});
