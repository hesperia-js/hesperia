import { expect, test } from "bun:test";
import { EditorProject } from "../../packages/language-server/src/project.ts";

test("bare identifier completion keeps visible names and globals without requesting auto-imports", async () => {
  const source = `import { imported } from "./completion-dependency.ts";
function other() { const hidden = 1; }
export function App({ argument }: { argument: string }) {
 const count = 1;
 const update = () => count;
 return <button on:click={update}>{argument}</button>;
}`;
  const project = await EditorProject.create([
    { filename: "completion.tsx", source },
    {
      filename: "completion-dependency.ts",
      source: "export const imported = 1; export const notImported = 2;",
    },
  ]);

  try {
    const items = await project.completions("completion.tsx", source.indexOf("{update}") + 4);

    for (const name of [
      "update",
      "count",
      "argument",
      "imported",
      "document",
      "Promise",
      "HTMLElement",
    ])
      expect(items.some((item) => item.label === name)).toBe(true);

    for (const name of [
      "hidden",
      "notImported",
      "__hesperia_element",
      "HesperiaNativeAttributes",
      "HesperiaEventAttributes",
    ])
      expect(items.some((item) => item.label === name)).toBe(false);

    expect((await project.hover("completion.tsx", source.indexOf("{update}") + 2))?.type).toContain(
      "=>",
    );
  } finally {
    await project.dispose();
  }
});

test("bare completion follows scope through shadowing and unfinished component expressions", async () => {
  for (const marked of [
    "export function App(){ const document = 1; const local = 2; return <main>{|}</main>; }",
    "export function App(){ const globalThis = 1; const local = 2; return <main>{  |  }</main>; }",
    "export function App(){ const local = 2; loc|",
  ]) {
    const project = await EditorProject.create([
      { filename: "completion.tsx", source: marked.replace("|", "") },
    ]);

    try {
      const items = await project.completions("completion.tsx", marked.indexOf("|"));

      expect(items.filter((item) => item.label === "local")).toHaveLength(1);

      expect(items.filter((item) => item.label === "document")).toHaveLength(1);
    } finally {
      await project.dispose();
    }
  }
});
