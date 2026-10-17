import { expect, test } from "bun:test";
import { EditorProject } from "../../packages/language-server/src/project.ts";

test("the starter counter resolves its update callback and client namespace import", async () => {
  const source = `import * as client from "hesperia/client";

export default function Page() {
  const count = client.state(0);
  const update = () => count.update((value) => value + 1);
  return (
    <main>
      <h1>Hesperia</h1>
      <button on:click={update}>Count: {count()}</button>
    </main>
  );
}
`;
  const filename = "src/routes/+page.tsx";
  const project = await EditorProject.create([{ filename, source }]);

  try {
    for (let character = 0; character < "update".length; character++) {
      const [target] = await project.definitions(
        filename,
        source.indexOf("{update}") + 1 + character,
      );

      expect(target?.start).toBe(source.indexOf("update ="));

      expect(target?.end).toBe(source.indexOf("update =") + "update".length);
    }

    for (const text of ["client from", "client.state"]) {
      const [target] = await project.definitions(filename, source.indexOf(text) + 2);

      expect(target?.filename.replaceAll("\\", "/")).toEndWith("/dist/client.d.ts");
    }

    const [module] = await project.definitions(filename, source.indexOf('"hesperia/client"') + 3);

    expect(module?.filename.replaceAll("\\", "/")).toEndWith("/dist/client.d.ts");
  } finally {
    await project.dispose();
  }
});

test("JSX attributes navigate to declared component props and native DOM properties", async () => {
  const child = `import type { Component } from "hesperia";
export type ChildProps = { label: string; onSave: () => void };
export function Child(props: Component.Props<ChildProps>) { return <span>{props.label()}</span>; }`;
  const source = `import { Child } from "./definition-child.tsx";\r\nexport function App() {\r\n const emoji = "🐈"; function save() {}\r\n return <div title="Hello"><button disabled={false} on:click={save}>Save</button><Child label="Hi" onSave={save} /></div>;\r\n}`;
  const filename = "definition-app.tsx";
  const project = await EditorProject.create([
    { filename, source },
    { filename: "definition-child.tsx", source: child },
  ]);

  try {
    for (const name of ["label", "onSave"]) {
      const [location] = await project.definitions(filename, source.indexOf(`${name}=`) + 2);

      expect(location?.filename.replaceAll("\\", "/")).toEndWith("/definition-child.tsx");

      expect(location?.start).toBe(child.indexOf(`${name}:`));

      expect(child.slice(location!.start, location!.end)).toBe(name);
    }

    for (const [attribute, declaration] of [
      ["title", "title"],
      ["disabled", "disabled"],
      ["on:click", "onclick"],
    ] as const) {
      const [location] = await project.definitions(filename, source.indexOf(`${attribute}=`) + 2);

      expect(location?.filename.replaceAll("\\", "/")).toEndWith("/lib.dom.d.ts");

      const native = await Bun.file(location!.filename).text();

      expect(native.slice(location!.start, location!.end)).toBe(declaration);
    }
  } finally {
    await project.dispose();
  }
});

test("functions resolve from both component tags and deferred expressions", async () => {
  const child = "export function Child() { return <span/>; }";
  const source = `import * as client from "hesperia/client";
import { Child } from "./definition-child.tsx";
export function App() {
 function save() {}
 client.effect(save);
 return <Child>{save()}</Child>;
}`;
  const filename = "definition-functions.tsx";
  const project = await EditorProject.create([
    { filename, source },
    { filename: "definition-child.tsx", source: child },
  ]);

  try {
    const effect = await project.definitions(filename, source.indexOf("effect(save)") + 2);

    expect(effect[0]?.filename.replaceAll("\\", "/")).toEndWith("/dist/client.d.ts");

    const local = await project.definitions(filename, source.indexOf("{save()}") + 2);

    expect(local[0]?.start).toBe(source.indexOf("save() {}"));

    for (const tag of ["<Child>", "</Child>"]) {
      const offset = source.indexOf(tag) + tag.indexOf("Child") + 2;
      const [location] = await project.definitions(filename, offset);

      expect(location?.filename.replaceAll("\\", "/")).toEndWith("/definition-child.tsx");

      expect(location?.start).toBe(child.indexOf("Child"));
    }
  } finally {
    await project.dispose();
  }
});
