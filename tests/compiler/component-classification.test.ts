import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Window } from "happy-dom";
import { mount, type Component } from "hesperia";
import { compile } from "../../src/compiler/index.ts";

async function importGenerated<T>(code: string): Promise<T> {
  const directory = resolve(import.meta.dir, "../../.hesperia");
  await mkdir(directory, { recursive: true });
  const filename = resolve(directory, `component-classification-${randomUUID()}.mjs`);
  await writeFile(filename, code);
  try {
    return (await import(pathToFileURL(filename).href)) as T;
  } finally {
    await unlink(filename);
  }
}

test("functions and arrows returning aliased native handles retain state and native identity", async () => {
  for (const declaration of ["function App()", "const App = () =>"]) {
    const result = compile(
      `
      import { state } from "hesperia/client";
      let bodies = 0;
      export function bodyCount() { return bodies; }
      export ${declaration} {
        bodies++;
        const count = state(0);
        const node = <button on:click={() => count.update(value => value + 1)}>{count()}</button>;
        const output = node;
        return output;
      }
    `,
      { filename: "handle-component.tsx" },
    );
    expect(result.diagnostics).toStrictEqual([]);
    expect([...result.semantics.components]).toStrictEqual(["App"]);
    const generated = await importGenerated<{ App: Component<object>; bodyCount(): number }>(
      result.code,
    );
    const window = new Window();
    const app = mount(window.document.body as unknown as Element, generated.App, {});
    try {
      await app.settled();
      const button = window.document.querySelector("button")!;
      expect(button.textContent).toBe("0");
      button.click();
      expect(button.textContent).toBe("1");
      expect(window.document.querySelector("button")).toBe(button);
      expect(generated.bodyCount()).toBe(1);
    } finally {
      app.dispose();
      await window.happyDOM.close();
    }
  }
});

test("ordinary ternary values and functions remain executable without component ownership", async () => {
  const result = compile(
    `
    export const label = true ? "first" : "second";
    export const choose = flag => flag ? label : "other";
    export function answer(flag) { return flag ? "yes" : "no"; }
  `,
    { filename: "ordinary-values.tsx" },
  );
  expect(result.diagnostics).toStrictEqual([]);
  expect([...result.semantics.components]).toStrictEqual([]);
  const generated = await importGenerated<{
    label: string;
    choose(flag: boolean): string;
    answer(flag: boolean): string;
  }>(result.code);
  expect(generated.label).toBe("first");
  expect([generated.choose(true), generated.choose(false)]).toStrictEqual(["first", "other"]);
  expect([generated.answer(true), generated.answer(false)]).toStrictEqual(["yes", "no"]);
});

test("a component local can shadow a named client import without duplicate declarations", async () => {
  const result = compile(
    `
    import { state } from "hesperia/client";
    export function App() {
      const state = () => "local";
      return <main>{state()}</main>;
    }
  `,
    { filename: "local-client-shadow.tsx" },
  );
  expect(result.diagnostics).toStrictEqual([]);
  const generated = await importGenerated<{ App: Component<object> }>(result.code);
  const window = new Window();
  const app = mount(window.document.body as unknown as Element, generated.App, {});
  try {
    await app.settled();
    expect(window.document.body.textContent).toBe("local");
  } finally {
    app.dispose();
    await window.happyDOM.close();
  }
});

test("lowers a typed function-expression component with owner-bound props", async () => {
  const result = compile(
    `
    import type { Component } from "hesperia";
    type Props = { label: string };
    const Child = function (props: Component.Props<Props>) {
      return <span>{props.label()}</span>;
    };
    export default function App() { return <Child label="works" />; }
  `,
    { filename: "function-expression-component.tsx" },
  );
  expect(result.diagnostics).toStrictEqual([]);
  expect([...result.semantics.components]).toContain("Child");
  expect(result.code).toContain("props: { label:");

  const generated = await importGenerated<{ default: Component<object> }>(result.code);
  const window = new Window();
  const target = window.document.createElement("div") as unknown as Element;
  const application = mount(target, generated.default, {});
  try {
    await application.settled();
    expect(target.textContent).toBe("works");
  } finally {
    application.dispose();
    await window.happyDOM.close();
  }
});

test("keeps named function-expression recursion on the registered component identity", async () => {
  const result = compile(
    `
    import type { Component } from "hesperia";
    type Props = { depth: number };
    export const Tree = function Branch(props: Component.Props<Props>) {
      return props.depth() > 0
        ? <section><Branch depth={props.depth() - 1} /></section>
        : <span>leaf</span>;
    };
  `,
    { filename: "named-function-expression-component.tsx" },
  );
  expect(result.diagnostics).toStrictEqual([]);
  expect(result.code).toContain("const __component");

  const generated = await importGenerated<{ Tree: Component<{ depth: number }> }>(result.code);
  const window = new Window();
  const target = window.document.createElement("div") as unknown as Element;
  const application = mount(target, generated.Tree, { depth: 2 });
  try {
    await application.settled();
    expect(target.textContent).toBe("leaf");
    expect(() => generated.Tree({ depth: 0 } as never)).toThrow(
      "Components must be reached through JSX",
    );
  } finally {
    application.dispose();
    await window.happyDOM.close();
  }
});

test("keeps ordinary function expressions ordinary and validates function-expression bind bodies", () => {
  const ordinary = compile("export const handler = function (value) { return value; };", {
    filename: "ordinary-function-expression.tsx",
  });
  expect(ordinary.diagnostics).toStrictEqual([]);
  expect([...ordinary.semantics.components]).toStrictEqual([]);
  expect(ordinary.code).toContain("const handler = function");

  const binding = compile(
    `
    import { bind } from "hesperia/client";
    import type { Component } from "hesperia";
    type Output = { focus(): void };
    const Child = function (props: Component.Props<{ bind: Output }>) {
      const target = bind<HTMLInputElement>();
      target();
      return <input bind={target} />;
    };
  `,
    { filename: "function-expression-bind.tsx" },
  );
  expect(binding.semantics.components.has("Child")).toBe(true);
  expect(binding.diagnostics.map((item) => item.code)).toStrictEqual(["HES-BIND-BODY"]);
});

test("uses the async component lowering for async function expressions", () => {
  const result = compile(
    `
    const Child = async function () { return <span>ready</span>; };
    export default Child;
  `,
    { filename: "async-function-expression-component.tsx" },
  );
  expect(result.diagnostics).toStrictEqual([]);
  expect(result.semantics.components.has("Child")).toBe(true);
  expect(result.code).toContain("runAsyncBody");
  expect(result.code).toContain("async: true");
});
