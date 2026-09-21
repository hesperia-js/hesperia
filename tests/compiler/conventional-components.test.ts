import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Window } from "happy-dom";
import { mount, type Component } from "hesperia";
import { compile } from "../../src/compiler/index.ts";

async function importGenerated<T extends object>(code: string): Promise<T> {
  const directory = resolve(import.meta.dir, "../../.hesperia", `conventional-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const filename = join(directory, "module.mjs");
  await writeFile(filename, code);
  try {
    return (await import(pathToFileURL(filename).href)) as T;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("conventional default route functions are components even when they throw", async () => {
  const result = compile(
    `export default function Broken() {
      throw new Error("route failed");
    }
    export function helper() { return "ordinary"; }`,
    { filename: "src/routes/+error.tsx" },
  );
  expect(result.diagnostics).toStrictEqual([]);
  expect([...result.semantics.components]).toStrictEqual(["Broken"]);
  const generated = await importGenerated<{
    default: Component;
    helper: () => string;
  }>(result.code);
  expect(generated.helper()).toBe("ordinary");
  const window = new Window();
  const errors: Error[] = [];
  const application = mount(
    window.document.body as unknown as Element,
    generated.default,
    {},
    {
      onError: (error) => errors.push(error instanceof Error ? error : new Error(String(error))),
    },
  );
  await application.settled();
  expect(errors[0]?.message).toBe("route failed");
  application.dispose();
  await window.happyDOM.close();
});

test("conventional default aliases are components while ordinary helpers stay ordinary", async () => {
  const result = compile(
    `const Page = () => null;
    const helper = () => null;
    export default Page;
    export { helper };`,
    { filename: "src/routes/+page.tsx" },
  );
  expect(result.diagnostics).toStrictEqual([]);
  expect([...result.semantics.components]).toStrictEqual(["Page"]);
  const generated = await importGenerated<{
    default: Component;
    helper: () => null;
  }>(result.code);
  expect(generated.helper()).toBeNull();
  expect(() => generated.default({} as never)).toThrow("Components must be reached through JSX");
});

test("conventional direct default arrows and function expressions are registered components", async () => {
  for (const [filename, source] of [
    ["src/routes/+loading.tsx", "export default () => null;"],
    ["+loading.tsx", "export default () => null;"],
    ["src/routes/+not-found.tsx", "export default (function Missing() { return null; });"],
  ] as const) {
    const result = compile(source, { filename });
    expect(result.diagnostics).toStrictEqual([]);
    const generated = await importGenerated<{ default: Component }>(result.code);
    expect(() => generated.default({} as never)).toThrow("Components must be reached through JSX");
  }
}, 30000);

for (const source of [
  "function Page() { return null; } export default Page;",
  "function Page() { return null; } const Selected = Page; export default Selected;",
  "export const Page = () => null; export default Page;",
  "function Page() { return null; } export { Page as default };",
]) {
  test(`conventional defaults retain component identity through declarations: ${source}`, async () => {
    const result = compile(source, { filename: "src/routes/+page.tsx" });
    expect(result.diagnostics).toStrictEqual([]);
    const generated = await importGenerated<{ default: Component }>(result.code);
    expect(() => generated.default({} as never)).toThrow("Components must be reached through JSX");
    const window = new Window();
    const errors: unknown[] = [];
    const application = mount(
      window.document.body as unknown as Element,
      generated.default,
      {},
      {
        onError: (error) => errors.push(error),
      },
    );
    await application.settled();
    expect(errors).toStrictEqual([]);
    expect(window.document.body.textContent).toBe("");
    application.dispose();
    await window.happyDOM.close();
  });
}

test("trusted component prop types identify null-returning components outside route conventions", async () => {
  const result = compile(
    `import type { Component as C } from "hesperia";
export function Empty(_props: C.Props<{}>) { return null; }
export const EmptyArrow = (_props: C.Props<{}>) => null;
type Props<T> = T;
export function ordinary(_props: Props<{}>) { return null; }`,
    { filename: "empty-components.tsx" },
  );
  expect(result.diagnostics).toStrictEqual([]);
  const generated = await importGenerated<{
    Empty: Component;
    EmptyArrow: Component;
    ordinary: (props: object) => null;
  }>(result.code);
  expect(() => generated.Empty({} as never)).toThrow("Components must be reached through JSX");
  expect(() => generated.EmptyArrow({} as never)).toThrow("Components must be reached through JSX");
  expect(generated.ordinary({})).toBeNull();
});
