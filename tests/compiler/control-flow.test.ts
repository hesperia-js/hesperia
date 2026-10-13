import { expect, test } from "bun:test";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Window } from "happy-dom";
import { mount, type Component } from "hesperia";
import { compile } from "../../packages/compiler/src/index.ts";
import { analyzeRouteModule } from "../../packages/compiler/src/route-analysis.ts";

async function importGenerated<T extends object>(code: string): Promise<T> {
  const directory = resolve(import.meta.dir, "../../.hesperia");

  await mkdir(directory, { recursive: true });

  const filename = join(directory, `control-flow-${randomUUID()}.mjs`);

  await writeFile(filename, code);

  try {
    return await import(pathToFileURL(filename).href);
  } finally {
    await unlink(filename);
  }
}

test("if and else branches preserve native component returns", async () => {
  const source = [
    'import type { Component } from "hesperia";',
    "type Props = { show: boolean };",
    "export default function App(props: Component.Props<Props>) {",
    "  if (props.show()) return <strong>yes</strong>;",
    "  else return <em>no</em>;",
    "}",
  ].join("\n");
  const result = await compile(source, { filename: "if-component.tsx" });

  expect(result.diagnostics).toEqual([]);

  const generated = await importGenerated<{ default: Component<{ show: boolean }> }>(result.code);
  const window = new Window();

  try {
    const target = window.document.body as unknown as Element;
    const yes = mount(target, generated.default, { show: true });

    await yes.settled();

    expect(target.innerHTML).toContain("<strong>yes</strong>");

    yes.dispose();

    const no = mount(target, generated.default, { show: false });

    await no.settled();

    expect(target.innerHTML).toContain("<em>no</em>");

    no.dispose();
  } finally {
    window.close();
  }
});

test("throw statements retain branch order in helpers and effect callbacks", async () => {
  const source = [
    'import { client } from "hesperia";',
    "export function fail(value: boolean) {",
    '  if (value) throw { message: "helper failure" };',
    '  return "ok";',
    "}",
    "export default function App() {",
    "  const trigger = client.state(false);",
    "  client.effect(() => {",
    '    if (trigger()) throw { message: "effect failure" };',
    "  });",
    "  return <button on:click={() => trigger.set(true)}>run</button>;",
    "}",
  ].join("\n");
  const result = await compile(source, { filename: "throw-flow.tsx" });

  expect(result.diagnostics).toEqual([]);

  const generated = await importGenerated<{
    default: Component;
    fail: (value: boolean) => string;
  }>(result.code);

  expect(generated.fail(false)).toBe("ok");

  let thrown: unknown;

  try {
    generated.fail(true);
  } catch (error) {
    thrown = error;
  }

  expect((thrown as { message: string }).message).toBe("helper failure");

  const errors: unknown[] = [];
  const window = new Window();

  try {
    const target = window.document.body as unknown as Element;
    const application = mount(
      target,
      generated.default,
      {},
      { onError: (error) => errors.push(error) },
    );

    await application.settled();

    (target.firstElementChild as HTMLButtonElement).click();

    await application.settled();

    expect(errors).toHaveLength(1);

    expect((errors[0] as Error).message).toBe("effect failure");

    application.dispose();
  } finally {
    window.close();
  }
});

test("branch captures remain alpha-stable and rejected binding or route reads stay visible", async () => {
  const validFirst = await compile(
    [
      'const captured = "yes";',
      "export function choose() {",
      "  if (true) return captured;",
      '  return "no";',
      "}",
    ].join("\n"),
    { filename: "branch-capture.ts" },
  );
  const validSecond = await compile(
    [
      'const renamed = "yes";',
      "export function choose() {",
      "  if (true) return renamed;",
      '  return "no";',
      "}",
    ].join("\n"),
    { filename: "branch-capture-renamed.ts" },
  );

  expect(validFirst.diagnostics).toEqual([]);

  expect(validSecond.diagnostics).toEqual([]);

  expect(validFirst.semanticHash).toBe(validSecond.semanticHash);

  const first = [
    'import { client } from "hesperia";',
    "export default function App() {",
    "  const inputBinding = client.bind<HTMLInputElement>();",
    "  if (true) { inputBinding(); }",
    "  return <input bind={inputBinding} />;",
    "}",
  ].join("\n");
  const second = first.replaceAll("inputBinding", "fieldBinding");
  const firstResult = await compile(first, { filename: "branch-binding.tsx" });
  const secondResult = await compile(second, { filename: "branch-binding-renamed.tsx" });

  expect(firstResult.diagnostics.some((item) => item.code === "HES-BIND-BODY")).toBe(true);

  expect(secondResult.diagnostics.some((item) => item.code === "HES-BIND-BODY")).toBe(true);

  const route = analyzeRouteModule(
    [
      'import { route } from "hesperia/routing";',
      'import fs from "node:fs";',
      "const guard = (value: boolean) => {",
      '  if (value) throw fs.existsSync("/private") ? "yes" : "no";',
      "  return true;",
      "};",
      "export default route({ guard });",
    ].join("\n"),
    { filename: "src/routes/+route.ts" },
  );

  expect(route.artifact).toBeUndefined();

  expect(route.diagnostics.some((item) => item.code === "HES-ROUTE-CAPABILITY")).toBe(true);
}, 30000);

test("function-scoped var facts survive branch validation and component classification", async () => {
  const binding = await compile(
    [
      'import { client } from "hesperia";',
      "export default function App() {",
      "  if (true) { var binding = client.bind<HTMLInputElement>(); }",
      "  binding();",
      "  return <input bind={binding} />;",
      "}",
    ].join("\n"),
    { filename: "branch-var-binding.tsx" },
  );

  expect(binding.code).toBe("");

  expect(binding.diagnostics.some((item) => item.code === "HES-BIND-BODY")).toBe(true);

  const rendered = await compile(
    [
      "export default function App() {",
      "  if (true) { var node = <span>hello</span>; }",
      "  return node;",
      "}",
    ].join("\n"),
    { filename: "branch-var-rendered.tsx" },
  );

  expect(rendered.diagnostics).toEqual([]);

  const generated = await importGenerated<{ default: Component }>(rendered.code);
  const window = new Window();

  try {
    const target = window.document.body as unknown as Element;
    const application = mount(target, generated.default, {});

    await application.settled();

    expect(target.innerHTML).toContain("<span>hello</span>");

    application.dispose();
  } finally {
    window.close();
  }
}, 30000);

test("lexical branch and nested-function locals do not leak into outer analysis", async () => {
  const source = [
    'import { client } from "hesperia";',
    "export default function App() {",
    "  const binding = () => 1;",
    "  if (true) {",
    "    const binding = client.bind<HTMLInputElement>();",
    "    binding();",
    "  }",
    "  function nested() {",
    "    const binding = client.bind<HTMLInputElement>();",
    "    binding();",
    "    return <span>nested</span>;",
    "  }",
    "  return <div>{binding()}</div>;",
    "}",
  ].join("\n");
  const result = await compile(source, { filename: "control-flow-shadowing.tsx" });

  expect(result.diagnostics.map((item) => item.code)).toStrictEqual(["HES-BIND-BODY"]);

  const ordinary = await compile(
    [
      "export const helper = () => {",
      '  const node = "plain";',
      "  if (false) { const node = <span>branch</span>; }",
      "  function nested() { const node = <em>nested</em>; return node; }",
      "  return node;",
      "};",
    ].join("\n"),
    { filename: "control-flow-ordinary.tsx" },
  );

  expect(ordinary.diagnostics).toEqual([]);

  const generated = await importGenerated<{ helper: () => string }>(ordinary.code);

  expect(generated.helper()).toBe("plain");
}, 30000);
