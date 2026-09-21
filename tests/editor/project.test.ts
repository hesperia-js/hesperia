import { expect, test } from "bun:test";
import { EditorProject } from "../../src/editor/project.ts";

test("editor uses native DOM types and authored locations across JSX and imported components", () => {
  const source =
    'import { Child } from "./child.tsx";\r\nexport function App(){\r\n const emoji = "🐈"; const field = <input />;\r\n return <div title={field.value}>{field.value}<Child /></div>;\r\n}';
  const child = "export function Child(){ return <span>child</span>; }";
  const project = new EditorProject([
    { filename: "editor-app.tsx", source },
    { filename: "child.tsx", source: child },
  ]);
  try {
    expect(project.diagnostics.diagnostics).toStrictEqual([]);
    const valuePosition = source.lastIndexOf("field.value");
    expect(project.hover("editor-app.tsx", valuePosition)?.type).toBe("HTMLInputElement");
    expect(project.hover("editor-app.tsx", valuePosition + "field.".length)?.type).toBe("string");
    const completions = project.completions("editor-app.tsx", valuePosition + "field.".length);
    expect(completions.some((entry) => entry.label === "focus")).toBe(true);
    expect(completions.some((entry) => entry.label === "value")).toBe(true);
    const local = project.definitions("editor-app.tsx", valuePosition);
    expect(local[0]?.start).toBe(source.indexOf("field ="));
    expect(local[0]?.end).toBe(source.indexOf("field =") + "field".length);
    const imported = project.definitions("editor-app.tsx", source.indexOf("Child />"));
    expect(imported[0]?.filename.replaceAll("\\", "/").endsWith("/child.tsx")).toBe(true);
    expect(imported[0]?.start).toBe(child.indexOf("Child"));
    expect(imported[0]?.end).toBe(child.indexOf("Child") + "Child".length);
  } finally {
    project.dispose();
  }
});

test("editor snapshots do not leak stale diagnostics across source edits or outlive disposal", () => {
  const filename = "editor-edits.tsx";
  const broken = new EditorProject([
    { filename, source: "export const field = <input />; field.missing();" },
  ]);
  expect(broken.diagnostics.diagnostics.some((item) => item.code === "TS2339")).toBe(true);
  broken.dispose();
  broken.dispose();
  expect(() => broken.hover(filename, 13)).toThrow("disposed");
  const fixed = new EditorProject([
    { filename, source: "export const field = <input />; field.focus();" },
  ]);
  try {
    expect(fixed.diagnostics.diagnostics).toStrictEqual([]);
    expect(fixed.hover("unknown.tsx", 0)).toBeUndefined();
    expect(fixed.definitions(filename, -1)).toStrictEqual([]);
  } finally {
    fixed.dispose();
  }
});

test("editor enables document-shell validation only for the project root app", () => {
  const shell = `export default function App() {
  return <html><head><title>Shell</title></head><body><main>Ready</main></body></html>;
}`;
  const project = new EditorProject(
    [
      { filename: "app.tsx", source: shell },
      { filename: "Child.tsx", source: "export default function Child(){ return <html/>; }" },
    ],
    { root: ".", documentShell: true },
  );
  try {
    expect(
      project.diagnostics.modules.find((item) => item.filename === "app.tsx")?.diagnostics,
    ).toEqual([]);
    expect(
      project.diagnostics.modules
        .find((item) => item.filename === "Child.tsx")
        ?.diagnostics.some((item) => item.code === "HES-HTML-CONTEXT"),
    ).toBe(true);
  } finally {
    project.dispose();
  }
});

test("editor reports unsaved nested document-shell edits at the authored element", () => {
  const source = `export default function App() {
  return <html><head/><body><html /></body></html>;
}`;
  const project = new EditorProject([{ filename: "app.tsx", source }], {
    root: ".",
    documentShell: true,
  });
  try {
    const diagnostic = project.diagnostics.diagnostics.find(
      (item) => item.code === "HES-DOCUMENT-SHELL",
    );
    expect(diagnostic?.span).toEqual({
      start: source.lastIndexOf("<html />"),
      end: source.lastIndexOf("<html />") + "<html />".length,
    });
  } finally {
    project.dispose();
  }
});
