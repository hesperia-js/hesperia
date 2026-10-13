import { expect, test } from "bun:test";
import { EditorProject } from "../../packages/language-server/src/project.ts";

if (process.platform !== "win32") {
  test("editor preserves uppercase source identity on case-sensitive hosts", async () => {
    const upper = "export const marker: string = 'upper';";
    const consumer = 'import { marker } from "./Feature.ts"; export const observed = marker;';
    const project = await EditorProject.create([
      { filename: "Feature.ts", source: upper },
      { filename: "consumer.ts", source: consumer },
    ]);

    try {
      expect(project.diagnostics.diagnostics).toStrictEqual([]);

      expect(await project.hover("Feature.ts", upper.indexOf("marker"))).toMatchObject({
        type: "string",
      });

      expect(await project.hover("consumer.ts", consumer.lastIndexOf("marker"))).toMatchObject({
        type: "string",
      });

      expect(await project.definitions("consumer.ts", consumer.lastIndexOf("marker"))).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            filename: expect.stringMatching(/\/Feature\.ts$/u),
            start: upper.indexOf("marker"),
            end: upper.indexOf("marker") + "marker".length,
          }),
        ]),
      );
    } finally {
      await project.dispose();
    }
  });
}

test("editor uses native DOM types and authored locations across JSX and imported components", async () => {
  const source =
    'import { Child } from "./child.tsx";\r\nexport function App(){\r\n const emoji = "🐈"; const field = <input />;\r\n return <div title={field.value}>{field.value}<Child /></div>;\r\n}';
  const child = "export function Child(){ return <span>child</span>; }";
  const project = await EditorProject.create([
    { filename: "editor-app.tsx", source },
    { filename: "child.tsx", source: child },
  ]);

  try {
    expect(project.diagnostics.diagnostics).toStrictEqual([]);

    const valuePosition = source.lastIndexOf("field.value");

    expect((await project.hover("editor-app.tsx", valuePosition))?.type).toBe("HTMLInputElement");

    expect((await project.hover("editor-app.tsx", valuePosition + "field.".length))?.type).toBe(
      "string",
    );

    const completions = await project.completions(
      "editor-app.tsx",
      valuePosition + "field.".length,
    );

    expect(completions.some((entry) => entry.label === "focus")).toBe(true);

    expect(completions.some((entry) => entry.label === "value")).toBe(true);

    const local = await project.definitions("editor-app.tsx", valuePosition);

    expect(local[0]?.start).toBe(source.indexOf("field ="));

    expect(local[0]?.end).toBe(source.indexOf("field =") + "field".length);

    const imported = await project.definitions("editor-app.tsx", source.indexOf("Child />"));

    expect(imported[0]?.filename.replaceAll("\\", "/").endsWith("/child.tsx")).toBe(true);

    expect(imported[0]?.start).toBe(child.indexOf("Child"));

    expect(imported[0]?.end).toBe(child.indexOf("Child") + "Child".length);
  } finally {
    await project.dispose();
  }
});

test("editor snapshots do not leak stale diagnostics across source edits or outlive disposal", async () => {
  const filename = "editor-edits.tsx";
  const broken = await EditorProject.create([
    { filename, source: "export const field = <input />; field.missing();" },
  ]);

  expect(broken.diagnostics.diagnostics.some((item) => item.code === "TS2339")).toBe(true);

  await broken.dispose();

  await broken.dispose();

  expect(broken.diagnostics.diagnostics.some((item) => item.code === "TS2339")).toBe(true);

  await expect(broken.hover(filename, 13)).rejects.toThrow("disposed");

  const fixed = await EditorProject.create([
    { filename, source: "export const field = <input />; field.focus();" },
  ]);

  try {
    expect(fixed.diagnostics.diagnostics).toStrictEqual([]);

    expect(await fixed.hover("unknown.tsx", 0)).toBeUndefined();

    expect(await fixed.definitions(filename, -1)).toStrictEqual([]);
  } finally {
    await fixed.dispose();
  }
});

test("editor disposal waits for semantic requests already using its snapshot", async () => {
  const filename = "editor-request-disposal.tsx";
  const source =
    "export function App(){ const field = <input />; return <div>{field.value}</div>; }";
  const project = await EditorProject.create([{ filename, source }]);
  const query = project.hover(filename, source.indexOf("field.value") + 2);
  const disposal = project.dispose();

  expect(project.dispose()).toBe(disposal);

  await expect(query).resolves.toMatchObject({ type: "HTMLInputElement" });

  await disposal;

  expect(project.diagnostics.diagnostics).toStrictEqual([]);
}, 45000);

test("editor enables document-shell validation only for the project root app", async () => {
  const shell = `export default function App() {
  return <html><head><title>Shell</title></head><body><main>Ready</main></body></html>;
}`;
  const project = await EditorProject.create(
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
    await project.dispose();
  }
});

test("editor reports unsaved nested document-shell edits at the authored element", async () => {
  const source = `export default function App() {
  return <html><head/><body><html /></body></html>;
}`;
  const project = await EditorProject.create([{ filename: "app.tsx", source }], {
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
    await project.dispose();
  }
});
