import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Window } from "happy-dom";
import { mount, type Component } from "hesperia";
import { compile } from "../../packages/compiler/src/index.ts";

async function importGenerated<T>(code: string): Promise<T> {
  const directory = resolve(import.meta.dir, "../../.hesperia");

  await mkdir(directory, { recursive: true });

  const filename = resolve(directory, `control-scope-${randomUUID()}.mjs`);

  await writeFile(filename, code);

  try {
    return await import(pathToFileURL(filename).href);
  } finally {
    await unlink(filename);
  }
}

test("nested if statements preserve test order, the nearest else, and the thrown value", async () => {
  const source = [
    "const events: string[] = [];",
    'export const failure = { message: "inner failed" };',
    "function record(value: boolean, label: string) { events.push(label); return value; }",
    "export function takeEvents() { return events.splice(0); }",
    "export function choose(outer: boolean, inner: boolean) {",
    '  if (record(outer, "outer"))',
    '    if (record(inner, "inner")) return "both";',
    "    else throw failure;",
    '  else return "neither";',
    "}",
  ].join("\n");
  const compiled = await compile(source, { filename: "nested-if.ts" });

  expect(compiled.diagnostics).toStrictEqual([]);

  const generated = await importGenerated<{
    failure: object;

    choose(outer: boolean, inner: boolean): string;

    takeEvents(): string[];
  }>(compiled.code);

  expect(generated.choose(false, true)).toBe("neither");

  expect(generated.takeEvents()).toStrictEqual(["outer"]);

  expect(generated.choose(true, true)).toBe("both");

  expect(generated.takeEvents()).toStrictEqual(["outer", "inner"]);

  let thrown: unknown;

  try {
    generated.choose(true, false);
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBe(generated.failure);

  expect(generated.takeEvents()).toStrictEqual(["outer", "inner"]);
});

test("a var declared inside an if keeps its function identity before and after the block", async () => {
  const source =
    "export function read() { const before = typeof answer; if (true) { var answer = 1; } return `${before}:${answer}`; }";
  const first = await compile(source, { filename: "block-var.ts" });
  const renamed = await compile(source.replaceAll("answer", "result"), {
    filename: "block-var.ts",
  });

  expect(first.diagnostics).toStrictEqual([]);

  expect(renamed.diagnostics).toStrictEqual([]);

  expect(first.semanticHash).toBe(renamed.semanticHash);

  const generated = await importGenerated<{ read(): string }>(first.code);

  expect(generated.read()).toBe("undefined:1");
});

test("a keyed region reads a helper's function-scoped var while retaining its native node", async () => {
  const source = [
    'import * as client from "hesperia/client";',
    "function readName(row: { name: string }) {",
    "  if (true) { var label = row.name; }",
    "  return label;",
    "}",
    "export default function App() {",
    '  const rows = client.state([{ id: "one", name: "before" }]);',
    "  return <section>",
    '    <button on:click={() => rows.set([{ id: "one", name: "after" }])}>Update</button>',
    "    {rows().map((row) => <span key={row.id}>{readName(row)}</span>)}",
    "  </section>;",
    "}",
  ].join("\n");
  const compiled = await compile(source, { filename: "branch-var-capture.tsx" });

  expect(compiled.diagnostics).toStrictEqual([]);

  const generated = await importGenerated<{ default: Component }>(compiled.code);
  const window = new Window();

  try {
    const target = window.document.body as unknown as Element;
    const app = mount(target, generated.default, {});

    await app.settled();

    const span = target.querySelector("span");

    expect(span?.textContent).toBe("before");

    target.querySelector<HTMLButtonElement>("button")!.click();

    await app.settled();

    expect(target.querySelector("span")).toBe(span);

    expect(span?.textContent).toBe("after");

    app.dispose();
  } finally {
    window.close();
  }
});

test("a component-body if runs once while JSX reads in its selected branch remain reactive", async () => {
  const source = [
    'import type { Component } from "hesperia";',
    'import * as client from "hesperia/client";',
    "const events: string[] = [];",
    "export function bodies() { return events.slice(); }",
    "function Child(props: Component.Props<{ selected: boolean; label: string }>) {",
    '  events.push("child body");',
    "  if (props.selected()) return <strong>{props.label()}</strong>;",
    "  return <em>{props.label()}</em>;",
    "}",
    "export default function App() {",
    "  const selected = client.state(false);",
    '  const label = client.state("before");',
    "  return <section>",
    "    <Child selected={selected()} label={label()} />",
    '    <button on:click={() => { selected.set(true); label.set("after"); }}>Update</button>',
    "  </section>;",
    "}",
  ].join("\n");
  const compiled = await compile(source, { filename: "body-if-lifetime.tsx" });

  expect(compiled.diagnostics).toStrictEqual([]);

  const generated = await importGenerated<{ default: Component; bodies(): string[] }>(
    compiled.code,
  );
  const window = new Window();

  try {
    const target = window.document.body as unknown as Element;
    const app = mount(target, generated.default, {});

    await app.settled();

    const selectedBranch = target.querySelector("em");

    expect(selectedBranch?.textContent).toBe("before");

    target.querySelector<HTMLButtonElement>("button")!.click();

    await app.settled();

    expect(target.querySelector("em")).toBe(selectedBranch);

    expect(selectedBranch?.textContent).toBe("after");

    expect(target.querySelector("strong")).toBeNull();

    expect(generated.bodies()).toStrictEqual(["child body"]);

    app.dispose();
  } finally {
    window.close();
  }
});

test("a retained list handler reads updated row captures inside an if", async () => {
  const source = [
    'import * as client from "hesperia/client";',
    "const events: string[] = [];",
    "export function selected() { return events.slice(); }",
    "export default function App() {",
    '  const rows = client.state([{ id: "one", enabled: false, name: "before" }]);',
    "  return <section>",
    '    <button id="update" on:click={() => rows.set([{ id: "one", enabled: true, name: "after" }])}>Update</button>',
    '    {rows().map((row) => <button id="row" key={row.id} on:click={() => { if (row.enabled) events.push(row.name); }}>{row.name}</button>)}',
    "  </section>;",
    "}",
  ].join("\n");
  const compiled = await compile(source, { filename: "if-row-handler.tsx" });

  expect(compiled.diagnostics).toStrictEqual([]);

  const generated = await importGenerated<{ default: Component; selected(): string[] }>(
    compiled.code,
  );
  const window = new Window();

  try {
    const target = window.document.body as unknown as Element;
    const app = mount(target, generated.default, {});

    await app.settled();

    const row = target.querySelector<HTMLButtonElement>("#row")!;

    row.click();

    expect(generated.selected()).toStrictEqual([]);

    target.querySelector<HTMLButtonElement>("#update")!.click();

    await app.settled();

    expect(target.querySelector("#row")).toBe(row);

    expect(row.textContent).toBe("after");

    row.click();

    expect(generated.selected()).toStrictEqual(["after"]);

    app.dispose();
  } finally {
    window.close();
  }
});
