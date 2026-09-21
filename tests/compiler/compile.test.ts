import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Window } from "happy-dom";
import { mount } from "hesperia";
import type { Component } from "hesperia";
import { parseFragment } from "parse5";
import { checkProjectModules, checkVirtualModule, compile } from "../../src/compiler/index.ts";

async function importGenerated<T extends object>(code: string): Promise<T> {
  const directory = resolve(import.meta.dir, "../../.hesperia");
  await mkdir(directory, { recursive: true });
  const filename = join(directory, `compiler-test-${randomUUID()}.mjs`);
  await writeFile(filename, code);
  try {
    return await import(pathToFileURL(filename).href);
  } finally {
    await unlink(filename);
  }
}

describe("compiler foundation", () => {
  test("retains lazy native generator and delegated-yield semantics", async () => {
    const result = compile(
      `export const events: string[] = [];
function* delegated(): Generator<number, number, number> {
  try { return (yield 2) + 1; }
  finally { events.push("delegated:cleanup"); }
}
export function* values(): Generator<number, number, number> {
  events.push("start");
  try {
    const input = yield 1;
    events.push("input:" + input);
    return yield* delegated();
  } finally { events.push("cleanup"); }
}
export async function* asyncValues() {
  events.push("async:start");
  try { yield await Promise.resolve(4); return 5; }
  finally { events.push("async:cleanup"); }
}
export function* bare(): Generator<undefined, number, number> { return yield; }`,
      { filename: "generators.ts" },
    );
    expect(result.diagnostics).toEqual([]);
    const generated = await importGenerated<{
      events: string[];
      values(): Generator<number, number, number>;
      asyncValues(): AsyncGenerator<number, number, unknown>;
      bare(): Generator<undefined, number, number>;
    }>(result.code);
    const values = generated.values();
    expect(generated.events).toStrictEqual([]);
    expect(values.next()).toEqual({ value: 1, done: false });
    expect(generated.events).toStrictEqual(["start"]);
    expect(values.next(10)).toEqual({ value: 2, done: false });
    expect(values.next(20)).toEqual({ value: 21, done: true });
    expect(generated.events).toStrictEqual(["start", "input:10", "delegated:cleanup", "cleanup"]);
    generated.events.length = 0;
    const interrupted = generated.values();
    interrupted.next();
    interrupted.next(30);
    expect(interrupted.return(99)).toEqual({ value: 99, done: true });
    expect(generated.events).toStrictEqual(["start", "input:30", "delegated:cleanup", "cleanup"]);
    generated.events.length = 0;
    const asyncValues = generated.asyncValues();
    expect(generated.events).toStrictEqual([]);
    expect(await asyncValues.next()).toEqual({ value: 4, done: false });
    expect(await asyncValues.next()).toEqual({ value: 5, done: true });
    expect(generated.events).toStrictEqual(["async:start", "async:cleanup"]);
    const bare = generated.bare();
    expect(bare.next()).toEqual({ value: undefined, done: false });
    expect(bare.next(7)).toEqual({ value: 7, done: true });
  });

  test("compiles a native JSX counter through canonical IR and fresh AST generation", () => {
    const result = compile(
      `import { client } from "hesperia";
export function Counter() {
  const count = client.state(0);
  return <button disabled={count()} on:click={() => count.set(count() + 1)}>{count()}</button>;
}`,
      { filename: "Counter.tsx" },
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.code).toContain("defineComponent");
    expect(result.code).toContain("createClient");
    expect(result.code).toContain("element");
    expect(result.code).toContain("on:click");
    expect(result.ir.version).toBe(1);
    expect(result.semanticHash).toMatch(/^sha256-[0-9a-f]{64}$/);
    expect(Object.keys(result.debug.spans).length).toBeGreaterThan(0);
  });

  test("does not emit executable code after parser recovery reports an error", () => {
    const result = compile("export function Broken( {", { filename: "broken.tsx" });
    expect(result.code).toBe("");
    expect(result.diagnostics.some((item) => item.severity === "error")).toBe(true);
  });

  test("rejects parser-sensitive HTML composition", () => {
    const result = compile(
      "export function Table() { return <table><tr><td>x</td></tr></table>; }",
      { filename: "table.tsx" },
    );
    expect(result.code).toBe("");
    expect(result.diagnostics.some((item) => item.code === "HES-HTML-CONTEXT")).toBe(true);
  });

  test("accepts parser-safe paragraph markup", () => {
    const result = compile("export function EmptyState() { return <p>No todos found.</p>; }", {
      filename: "paragraph.tsx",
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.code).toContain('"p"');
  });

  test("accepts paragraph phrasing children and HTML void elements", () => {
    const result = compile(
      'export function EmptyState() { return <p><strong>No todos</strong><br /><img alt="empty" /> found.</p>; }',
      { filename: "paragraph-phrasing.tsx" },
    );
    expect(result.diagnostics).toEqual([]);
  });

  test("rejects paragraph content that the browser reparses outside the paragraph", () => {
    const result = compile(
      "export function InvalidParagraph() { return <p><div>not valid</div></p>; }",
      { filename: "invalid-paragraph.tsx" },
    );
    expect(result.code).toBe("");
    expect(result.diagnostics.some((item) => item.code === "HES-HTML-CONTEXT")).toBe(true);
  });

  test("rejects a paragraph nested directly in a paragraph", () => {
    const result = compile("export function InvalidParagraph() { return <p><p>nested</p></p>; }", {
      filename: "nested-paragraph.tsx",
    });
    expect(result.code).toBe("");
    expect(result.diagnostics.some((item) => item.code === "HES-HTML-CONTEXT")).toBe(true);
  });

  test("canonical meaning is stable when only formatting changes", () => {
    const a = compile("export function App(){return <button>go</button>}", { filename: "app.tsx" });
    const b = compile("// comment\nexport function App() {\n  return <button>go</button>;\n}", {
      filename: "app.tsx",
    });
    expect(a.semanticHash).toBe(b.semanticHash);
  });

  test("resolves shadowed names and keeps bound meaning stable across alpha renames", () => {
    const first = compile(
      "const value = 1; export default function App(value){ const inner = value; return <button>{inner}</button>; }",
      { filename: "bindings.tsx" },
    );
    const renamed = compile(
      "const outer = 1; export default function App(input){ const nested = input; return <button>{nested}</button>; }",
      { filename: "bindings.tsx" },
    );
    expect(first.diagnostics).toEqual([]);
    expect(renamed.diagnostics).toEqual([]);
    expect(first.semanticHash).toBe(renamed.semanticHash);
    const element = first.ir.body.find((item) => item.kind === "export");
    expect(JSON.stringify(element)).toContain("referenceId");
  });

  test("resolves imported aliases and nested list captures without using source offsets", () => {
    const result = compile(
      `import * as api from "hesperia/client";
export default function App(){
  const prefix = api.state("item");
  const rows = api.state([{id: "a", label: "A"}]);
  return <ul>{rows().map((row) => <li key={row.id}>{prefix()}:{row.label}</li>)}</ul>;
}`,
      { filename: "captures.tsx" },
    );
    expect(result.diagnostics).toEqual([]);
    const encoded = JSON.stringify(result.ir);
    expect(encoded).toContain('"referenceId":"m/b');
    expect(result.code).toContain("scope.row().label");
    expect(result.debug.spans.n000000).toBeDefined();
  });

  test.each([
    ["export const first = 1;", "export const second = 1;"],
    ["export function first(){return 1;}", "export function second(){return 1;}"],
    ["export const {key: first} = {key: 1};", "export const {key: second} = {key: 1};"],
  ])("public export renames change semantic identity: %s", (first, second) => {
    const a = compile(first);
    const b = compile(second);
    expect(a.diagnostics).toStrictEqual([]);
    expect(b.diagnostics).toStrictEqual([]);
    expect(a.semanticHash).not.toBe(b.semanticHash);
  });

  test("local import aliases preserve semantic identity", () => {
    const a = compile('import {value as first} from "source"; export const output = first;');
    const b = compile('import {value as second} from "source"; export const output = second;');
    expect(a.diagnostics).toStrictEqual([]);
    expect(b.diagnostics).toStrictEqual([]);
    expect(a.semanticHash).toBe(b.semanticHash);
  });

  test("local export aliases hash by binding identity and public name", () => {
    const a = compile("const value = 1; export { value as answer };");
    const b = compile("const renamed = 1; export { renamed as answer };");
    const c = compile("const value = 1; export { value as result };");
    expect(a.diagnostics).toStrictEqual([]);
    expect(b.diagnostics).toStrictEqual([]);
    expect(c.diagnostics).toStrictEqual([]);
    expect(a.semanticHash).toBe(b.semanticHash);
    expect(a.semanticHash).not.toBe(c.semanticHash);
  }, 30000);

  test("reports destructured declarations and only public export names in module semantics", () => {
    const result = compile(
      `const local = 0;
export const { value: first } = { value: 1 };
export const [second] = [2];
export default function App(){ return <span />; }`,
      { filename: "module-semantics.tsx" },
    );
    expect(result.diagnostics).toEqual([]);
    expect([...result.semantics.declarations]).toEqual(["local", "first", "second", "App"]);
    expect([...result.semantics.exports]).toEqual(["first", "second", "default"]);
  });

  test("arrow locals and computed object keys resolve to their lexical bindings", async () => {
    const a = compile(
      'export const create = () => { const key = "result"; const value = 1; return {[key]: value}; };',
    );
    const b = compile(
      'export const create = () => { const property = "result"; const output = 1; return {[property]: output}; };',
    );
    expect(a.diagnostics).toStrictEqual([]);
    expect(b.diagnostics).toStrictEqual([]);
    expect(a.semanticHash).toBe(b.semanticHash);
    expect(JSON.stringify(a.ir)).not.toContain("unresolved/key");
    expect(JSON.stringify(a.ir)).not.toContain("unresolved/value");
    const generated = await importGenerated<{ create(): { result: number } }>(a.code);
    expect(generated.create()).toStrictEqual({ result: 1 });
  });

  test("preserves optional member and call short-circuiting in generated JavaScript", async () => {
    const result = compile(
      `export const read = (value) => value?.nested?.value ?? "fallback";
export const invoke = (value) => value?.run?.(3) ?? "fallback";`,
      { filename: "optional-chain.tsx" },
    );
    expect(result.diagnostics).toEqual([]);
    const generated = await importGenerated<{
      read(value: unknown): unknown;
      invoke(value: unknown): unknown;
    }>(result.code);
    expect(generated.read(null)).toBe("fallback");
    expect(generated.read({ nested: null })).toBe("fallback");
    expect(generated.read({ nested: { value: 4 } })).toBe(4);
    expect(generated.invoke(undefined)).toBe("fallback");
    expect(generated.invoke({ run: () => undefined })).toBe("fallback");
    expect(generated.invoke({ run: (value: number) => value + 1 })).toBe(4);
  });

  test("compiled object spreads preserve order and native own-property copying", async () => {
    const result = compile(
      'export const merge = (source) => ({ before: "initial", ...source, after: "final" });',
    );
    expect(result.diagnostics).toStrictEqual([]);
    const generated = await importGenerated<{
      merge(source: unknown): Record<PropertyKey, unknown>;
    }>(result.code);
    const symbol = Symbol("copied");
    let reads = 0;
    const input = Object.create({ inherited: "not copied" });
    Object.defineProperties(input, {
      before: {
        enumerable: true,
        get: () => {
          reads++;
          return "spread";
        },
      },
      after: { enumerable: true, value: "overwritten" },
      hidden: { enumerable: false, value: "not copied" },
    });
    Object.defineProperty(input, "__proto__", { enumerable: true, value: "plain data" });
    Object.defineProperty(input, symbol, { enumerable: true, value: 3 });
    const merged = generated.merge(input);
    expect(merged.before).toBe("spread");
    expect(merged.after).toBe("final");
    expect(merged[symbol]).toBe(3);
    expect(reads).toBe(1);
    expect(Object.hasOwn(merged, "hidden")).toBe(false);
    expect(Object.hasOwn(merged, "inherited")).toBe(false);
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect(Object.hasOwn(merged, "__proto__")).toBe(true);
    expect(merged.__proto__).toBe("plain data");
    expect(generated.merge(null)).toStrictEqual({ before: "initial", after: "final" });
  });

  test("preserves ordinary functions, object methods, and accessor descriptors", async () => {
    const result = compile(`export const object = {
  value: 4,
  method(first, second) { return this.value + first + second + arguments.length; },
  get doubled() { return this.value * 2; },
  set doubled(value) { return value; },
};
export const make = function local(value) { return local.name + value; };`);
    expect(result.diagnostics).toEqual([]);
    const generated = await importGenerated<{
      object: {
        value: number;
        method(first: number, second: number): number;
        doubled: number;
      };
      make(value: number): string;
    }>(result.code);
    expect(generated.object.method(2, 3)).toBe(11);
    expect(generated.object.method.call({ value: 1 }, 2, 3)).toBe(8);
    expect(generated.object.doubled).toBe(8);
    generated.object.doubled = 9;
    expect(generated.object.value).toBe(4);
    expect(generated.make(7)).toBe("local7");
    const descriptor = Object.getOwnPropertyDescriptor(generated.object, "doubled");
    expect(descriptor?.get).toBeTypeOf("function");
    expect(descriptor?.set).toBeTypeOf("function");
  });

  test("distinguishes method, ordinary function, and arrow semantic identities", () => {
    const method = compile("export const value = { run() { return 1; } };");
    const functionProperty = compile("export const value = { run: function() { return 1; } };");
    const arrowProperty = compile("export const value = { run: () => 1 };");
    expect(method.diagnostics).toEqual([]);
    expect(functionProperty.diagnostics).toEqual([]);
    expect(arrowProperty.diagnostics).toEqual([]);
    expect(method.semanticHash).not.toBe(functionProperty.semanticHash);
    expect(method.semanticHash).not.toBe(arrowProperty.semanticHash);
    expect(functionProperty.semanticHash).not.toBe(arrowProperty.semanticHash);
  });

  test("gives nested lexical blocks distinct binding identities", () => {
    const result = compile(
      "export default function App(){ const value = 1; { const value = 2; console.log(value); } return <span>{value}</span>; }",
      { filename: "shadow-block.tsx" },
    );
    expect(result.diagnostics).toEqual([]);
    const encoded = JSON.stringify(result.ir);
    expect((encoded.match(/bindingId/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect((encoded.match(/referenceId/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  test("lowers an arrow component and preserves lazy props", () => {
    const result = compile(
      'const Child = (props) => <span>{props.label}</span>; export function App(){ return <Child label="x" />; }',
      { filename: "arrow.tsx" },
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.code).toContain("defineComponent");
    expect(result.code).toContain("component");
  });

  test("emits native defaults for named, arrow, and function-expression components", async () => {
    const result = compile(
      `
import { state } from "hesperia/client";
export function Named(props: { label?: string } = {}) { return <span>{props.label ?? "named"}</span>; }
export const Arrow = (props: { label?: string } = {}) => <span>{props.label ?? "arrow"}</span>;
export const Expression = function Expression(props: { label?: string } = {}) { return <span>{props.label ?? "expression"}</span>; };
export function Marker(value = state(1)) { return <span>{typeof value === "function" ? value() : value}</span>; }
`,
      { filename: "component-defaults.tsx" },
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.code).toContain("createClient(owner).state(1)");
    const generated = await importGenerated<{
      Named: Component<{ label?: string }>;
      Arrow: Component<{ label?: string }>;
      Expression: Component<{ label?: string }>;
    }>(result.code);
    for (const [component, expected] of [
      [generated.Named, "named"],
      [generated.Arrow, "arrow"],
      [generated.Expression, "expression"],
    ] as const) {
      const window = new Window();
      const target = window.document.createElement("div") as unknown as Element;
      const application = mount(target, component, {});
      await application.settled();
      expect(target.textContent).toBe(expected);
      application.dispose();
    }
  });

  test("preserves authored component parameter bindings when names collide with runtime locals", async () => {
    const result = compile(
      "export default function App(owner){ return <span>{owner.value()}</span>; }",
      { filename: "component-parameter.tsx" },
    );
    expect(result.diagnostics).toEqual([]);
    const generated = await importGenerated<{ default: Component<{ value: string }> }>(result.code);
    const window = new Window();
    const target = window.document.createElement("div") as unknown as Element;
    const application = mount(target, generated.default, { value: "authored" });
    await application.settled();
    expect(target.textContent).toBe("authored");
    application.dispose();
  });

  test("keeps component self references and reactive defaults available during parameter initialization", async () => {
    const result = compile(
      `import { state } from "hesperia/client";
export function Named(props = {}, count = state(1)) { return <button on:click={() => count.set(count() + 1)}>{count()}</button>; }
export const Arrow = (props = {}, count = state(1)) => <button on:click={() => count.set(count() + 1)}>{count()}</button>;
export const Expression = function Self(props = {}, count = state(1), self = Self) { return <button on:click={() => count.set(count() + 1)}>{self === Self ? count() : "wrong"}</button>; };`,
      { filename: "component-default-ownership.tsx" },
    );
    expect(result.diagnostics).toEqual([]);
    const generated = await importGenerated<Record<string, Component<Record<string, never>>>>(
      result.code,
    );
    for (const name of ["Named", "Arrow", "Expression"]) {
      const window = new Window();
      const target = window.document.createElement("div");
      const application = mount(target as unknown as Element, generated[name]!, {});
      try {
        await application.settled();
        const button = target.querySelector("button")!;
        expect(button.textContent).toBe("1");
        button.click();
        await application.settled();
        expect(target.querySelector("button")).toBe(button);
        expect(button.textContent).toBe("2");
      } finally {
        application.dispose();
      }
    }
  });

  test("lowers named client aliases through one owner-bound capability and preserves mixed imports", async () => {
    const result = compile(
      `import { client as capability, mount as preservedMount } from "hesperia";
import { state as makeState, derived as makeDerived, effect as observe, cleanup as onCleanup, bind as makeBind } from "hesperia/client";
export default function App(){
  const value = makeState(1);
  const extra = capability.state(0);
  const doubled = makeDerived(() => value() * 2);
  const button = makeBind<HTMLButtonElement>();
  observe(() => { preservedMount; doubled(); });
  onCleanup(() => {});
  return <button bind={button} on:click={() => value.set(value() + 1)}>{doubled() + extra()}</button>;
}`,
      { filename: "named-client-aliases.tsx" },
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.code).toContain('import { mount as preservedMount } from "hesperia"');
    expect(result.code).not.toContain('from "hesperia/client"');
    expect(result.code).toContain("__client.state(1)");
    expect(result.code).toContain("__client.derived(() => value() * 2)");
    expect(result.code).toContain("__client.effect(() =>");
    expect(result.code).toContain("__client.cleanup(() => {}");
    expect(result.code).toContain("__client.bind()");

    const generated = await importGenerated<{ default: Component<Record<string, never>> }>(
      result.code,
    );
    const window = new Window();
    const target = window.document.createElement("div") as unknown as Element;
    const application = mount(target, generated.default, {});
    await application.settled();
    const button = target.querySelector("button") as unknown as HTMLButtonElement;
    expect(button.textContent).toBe("2");
    button.click();
    await application.settled();
    expect(button.textContent).toBe("4");
    application.dispose();
  });

  test("does not recreate a named client alias when a component parameter shadows its import", async () => {
    const result = compile(
      `import { state as makeState } from "hesperia/client";
export default function App(makeState){ return <span>{makeState.value()}</span>; }`,
      { filename: "shadowed-client-alias.tsx" },
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.code).not.toContain("const makeState = __client.state");
    const generated = await importGenerated<{ default: Component<{ value: string }> }>(result.code);
    const window = new Window();
    const target = window.document.createElement("div") as unknown as Element;
    const application = mount(target, generated.default, { value: "shadow" });
    await application.settled();
    expect(target.textContent).toBe("shadow");
    application.dispose();
  });

  test("keeps body-local client shadowing lexical while lowering the imported binding by ID", async () => {
    const result = compile(
      `import { state } from "hesperia/client";
export default function App(){
  const value = state(1);
  const local = () => { const state = () => "local"; return state(); };
  return <span>{value()}:{local()}</span>;
}`,
      { filename: "body-local-client-shadow.tsx" },
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.code).toContain("__client.state(1)");
    expect(result.code).not.toContain("__client.state()");
    const generated = await importGenerated<{ default: Component<Record<string, never>> }>(
      result.code,
    );
    const window = new Window();
    const target = window.document.createElement("div") as unknown as Element;
    const application = mount(target, generated.default, {});
    await application.settled();
    expect(target.textContent).toBe("1:local");
    application.dispose();
  });

  test("classifies native handles and aliases as components while retaining ordinary ternaries", async () => {
    const component = compile(
      `export default function App(){
  const content = <main>handle</main>;
  const alias = content;
  return alias;
}`,
      { filename: "local-native-handle.tsx" },
    );
    expect(component.diagnostics).toEqual([]);
    expect(component.code).toContain("defineComponent");
    const generated = await importGenerated<{ default: Component<Record<string, never>> }>(
      component.code,
    );
    const window = new Window();
    const target = window.document.createElement("div") as unknown as Element;
    const application = mount(target, generated.default, {});
    await application.settled();
    expect(target.textContent).toBe("handle");
    application.dispose();

    const values = compile(
      `export const choose = (show) => show ? "yes" : "no";
export function pick(show){ return show ? "yes" : "no"; }`,
      { filename: "ordinary-ternaries.tsx" },
    );
    expect(values.diagnostics).toEqual([]);
    expect(values.code).not.toContain("defineComponent");
    const valueModule = await importGenerated<{
      choose: (show: boolean) => string;
      pick: (show: boolean) => string;
    }>(values.code);
    expect(valueModule.choose(true)).toBe("yes");
    expect(valueModule.choose(false)).toBe("no");
    expect(valueModule.pick(true)).toBe("yes");
    expect(valueModule.pick(false)).toBe("no");
  });

  test("preserves side-effect imports while lowering marker imports", () => {
    const result = compile(
      `import "side-effect";
import { state as makeState } from "hesperia/client";
export function App(){ const value = makeState(1); return <span>{value()}</span>; }`,
      { filename: "side-effect-import.tsx" },
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.code).toContain('import "side-effect";');
    expect(result.code).not.toContain('from "hesperia/client"');
  });

  test("retains destructured keyed list bindings in the stable native row factory", async () => {
    const result = compile(
      'export default function App(){ const rows = [{ id: "a", label: "A" }]; return <ul>{rows.map(({ id, label }) => <li key={id}>{label}</li>)}</ul>; }',
      { filename: "destructured-list.tsx" },
    );
    expect(result.diagnostics).toEqual([]);
    const generated = await importGenerated<{ default: Component<Record<string, never>> }>(
      result.code,
    );
    const window = new Window();
    const target = window.document.createElement("div") as unknown as Element;
    const application = mount(target, generated.default, {});
    await application.settled();
    expect(target.textContent).toBe("A");
    application.dispose();
  });

  test("captures fallback expressions in destructured keyed list defaults", async () => {
    const result = compile(
      'export default function App(){ const fallback = "fallback"; const rows = [{ id: "a" }]; return <ul>{rows.map(({ id, label = fallback }) => <li key={id}>{label}</li>)}</ul>; }',
      { filename: "default-list.tsx" },
    );
    expect(result.diagnostics).toEqual([]);
    const generated = await importGenerated<{ default: Component<Record<string, never>> }>(
      result.code,
    );
    const window = new Window();
    const target = window.document.createElement("div") as unknown as Element;
    const application = mount(target, generated.default, {});
    await application.settled();
    expect(target.textContent).toBe("fallback");
    application.dispose();
  });

  test("keeps nested keyed list factories distinct and executable", async () => {
    const result = compile(
      `import * as client from "hesperia/client";
export default function App(){
  const groups = client.state([
    { id: "g", label: "G", items: [{ id: "i", label: "L" }, { id: "j", label: "J" }] },
    { id: "h", label: "H", items: [{ id: "k", label: "K" }] },
  ]);
  const update = () => groups.set([
    { id: "g", label: "G2", items: [{ id: "i", label: "L2" }, { id: "j", label: "J2" }] },
    { id: "h", label: "H", items: [{ id: "k", label: "K" }] },
  ]);
  const reorder = () => groups.set([
    { id: "h", label: "H", items: [{ id: "k", label: "K" }] },
    { id: "g", label: "G3", items: [{ id: "j", label: "J3" }, { id: "i", label: "L3" }] },
  ]);
  return <><button id="update" on:click={update}>update</button><button id="reorder" on:click={reorder}>reorder</button><ul>{groups().map((group) => <li key={group.id} data-group={group.label}>{group.items.map((item) => <span key={item.id} data-item={item.id}>{group.label}:{item.label}</span>)}</li>)}</ul></>;
}`,
      { filename: "nested-lists.tsx" },
    );
    expect(result.diagnostics).toEqual([]);
    const generated = await importGenerated<{ default: Component<Record<string, never>> }>(
      result.code,
    );
    const window = new Window();
    const target = window.document.createElement("div") as unknown as Element;
    const application = mount(target, generated.default, {});
    await application.settled();
    const group = target.querySelector('li[data-group="G"]')!;
    const item = group.querySelector('span[data-item="i"]')!;
    expect(group.textContent).toBe("G:LG:J");
    (target.querySelector("#update") as unknown as HTMLButtonElement).click();
    await application.settled();
    const updatedGroup = target.querySelector('li[data-group="G2"]')!;
    expect(updatedGroup).toBe(group);
    expect(updatedGroup.textContent).toBe("G2:L2G2:J2");
    expect(updatedGroup.querySelector('span[data-item="i"]')).toBe(item);
    (target.querySelector("#reorder") as unknown as HTMLButtonElement).click();
    await application.settled();
    const reorderedGroup = target.querySelector('li[data-group="G3"]')!;
    expect(reorderedGroup).toBe(group);
    expect(reorderedGroup.textContent).toBe("G3:J3G3:L3");
    expect(reorderedGroup.querySelector('span[data-item="i"]')).toBe(item);
    application.dispose();
  });

  test("keeps shadowed outer and inner keyed-list bindings distinct", async () => {
    const result = compile(
      `export default function App(){
  const groups = [{ id: "g", items: [{ id: "i", label: "L1" }, { id: "j", label: "L2" }] }];
  return <ul>{groups.map((group) => <li key={group.id}>{group.items.map((group) => <span key={group.id}>{group.label}</span>)}</li>)}</ul>;
}`,
      { filename: "shadowed-nested-lists.tsx" },
    );
    expect(result.diagnostics).toEqual([]);
    const generated = await importGenerated<{ default: Component<Record<string, never>> }>(
      result.code,
    );
    const window = new Window();
    const target = window.document.createElement("div") as unknown as Element;
    const application = mount(target, generated.default, {});
    await application.settled();
    expect(target.textContent).toBe("L1L2");
    application.dispose();
  });

  test("serializes hoisted list captures by binding and keeps alpha-renamed meaning stable", () => {
    const first = compile(
      `export default function App(){
  const groups = [{ id: "g", items: [{ id: "i", label: "L" }] }];
  return <ul>{groups.map((group) => <li key={group.id}>{group.items.map((item) => <span key={item.id}>{group.label}:{item.label}</span>)}</li>)}</ul>;
}`,
      { filename: "list-captures.tsx" },
    );
    const renamed = compile(
      `export default function App(){
  const collections = [{ id: "g", items: [{ id: "i", label: "L" }] }];
  return <ul>{collections.map((bucket) => <li key={bucket.id}>{bucket.items.map((entry) => <span key={entry.id}>{bucket.label}:{entry.label}</span>)}</li>)}</ul>;
}`,
      { filename: "list-captures.tsx" },
    );
    expect(first.diagnostics).toEqual([]);
    expect(renamed.diagnostics).toEqual([]);
    expect(first.semanticHash).toBe(renamed.semanticHash);
    const encoded = JSON.stringify(first.ir);
    expect(encoded).toContain('"captures":[{"bindingId":"m/f1/l1/b0","name":"group"}]');
    expect(encoded).toContain('"bindingId":"m/f1/l1/l1/b0","name":"item"');
    expect(first.code).toContain("groups.map((group)");
    expect(first.code).toContain("scope.group().items.map((item)");
  });

  test("composes generated and final Oxc source maps back to authored TSX", () => {
    const result = compile("export function App(){ return <button>go</button>; }", {
      filename: "mapped.tsx",
    });
    const map = result.map as { readonly sources?: readonly string[]; readonly mappings?: string };
    expect(map.sources).toEqual(["mapped.tsx"]);
    expect(typeof map.mappings).toBe("string");
  });

  test("reports TypeScript 7 diagnostics from a virtual module", () => {
    const result = checkVirtualModule({
      filename: "checker.ts",
      source: "const value: string = 1;",
    });
    expect(
      result.diagnostics.some((item) => item.code === "TS2322" && item.severity === "error"),
    ).toBe(true);
  });

  test("checks JSX through native element views and maps errors to authored offsets", () => {
    const source = 'const input = <input aria-label="Name" />; input.focus(); input.nonexistent();';
    const result = checkProjectModules([{ filename: "native.tsx", source }]);
    const diagnostic = result.diagnostics.find((item) => item.code === "TS2339");
    expect(diagnostic?.message).toContain("HTMLInputElement");
    expect(diagnostic?.span).toEqual({
      start: source.indexOf("nonexistent"),
      end: source.indexOf("nonexistent") + "nonexistent".length,
    });
  });

  test("checks a component body and caller binding in one project view", () => {
    const source = `import { type Component } from "hesperia";
import * as client from "hesperia/client";
type Output = { focus(): void };
function Child(props: Component.Props<{ bind: Output }>) {
  const input = <input />;
  client.effect(() => props.bind.set({ focus: () => input.focus() }));
  return <label>{input}</label>;
}
export function App() {
  const binding = client.bind<Output>();
  return <Child bind={binding} />;
}`;
    expect(checkProjectModules([{ filename: "component.tsx", source }]).diagnostics).toEqual([]);
  });

  test("preserves authored inline JSX spacing around dynamic children", () => {
    const result = compile(
      "export default function App(){ const count = 1; return <button>Count: {count}</button>; }",
      { filename: "spacing.tsx" },
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.code).toContain('"Count: "');
  });

  test("lowers component conditionals through a stable structural region slot", () => {
    const result = compile(
      'import * as client from "hesperia/client"; function A(){ return <i />; } function B(){ return <b />; } export default function App(){ const show = client.state(true); return <main>{show() ? <A /> : <B />}</main>; }',
      { filename: "conditional.tsx" },
    );
    expect(result.diagnostics).toEqual([]);
    const slots = [...result.code.matchAll(/"conditional:([^"]+)"/gu)].map((match) => match[1]);
    expect(slots).toHaveLength(3);
    expect(new Set(slots).size).toBe(1);
    expect(result.code).toContain("componentItem");
  });

  test("lowers native conditionals and keyed lists through stable factories", () => {
    const result = compile(
      `import * as client from "hesperia/client";
export default function App(){
  const show = client.state(true);
  const rows = client.state([{ id: "a", label: "A" }]);
  return <main>{show() ? <i>on</i> : <b>off</b>}{rows().map((row) => <input key={row.id} value={row.label} />)}</main>;
}`,
      { filename: "native-structures.tsx" },
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.code).toContain("nativeItem");
    const slots = [...result.code.matchAll(/region\(owner, "([^"]+)"/gu)].map((match) => match[1]!);
    expect(slots).toHaveLength(2);
    expect(slots[0]).toStartWith("conditional:");
    expect(slots[1]).toStartWith("list:");
    expect(slots[0]!.split(":")[1]).not.toBe(slots[1]!.split(":")[1]);
    expect(result.code).toContain("scope.row().label");
    expect(result.code).toContain("row.id");
  });

  test("lowers JSX fragments as multi-node native render values", () => {
    const result = compile(
      "export default function App(){ return <><input /><span>ready</span></>; }",
      { filename: "fragment.tsx" },
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.code).toContain("return [");
    expect((result.code.match(/element/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(result.code).toContain('"input"');
    expect(result.code).toContain('"span"');
  });

  test("creates nested SVG, foreignObject, and MathML descendants in their authored namespaces", async () => {
    const markup =
      `<svg><a><circle></circle></a><math><mi></mi></math><foreignObject><math><mi></mi></math><div><span></span><math><mi></mi></math></div></foreignObject><desc><em></em></desc></svg>` +
      `<math><mrow><svg><circle></circle></svg></mrow><mtext><math><mrow></mrow></math></mtext><mi><span></span><math><mrow></mrow></math></mi><mo><mglyph></mglyph></mo><annotation-xml encoding="text/html"><div></div></annotation-xml><annotation-xml><svg><circle></circle></svg></annotation-xml></math>`;
    const result = compile(`export default function App(){ return <>${markup}</>; }`, {
      filename: "namespaces.tsx",
    });
    expect(result.diagnostics).toEqual([]);
    const generated = await importGenerated<{ default: Component<Record<string, never>> }>(
      result.code,
    );
    const window = new Window();
    const target = window.document.createElement("div") as unknown as Element;
    const application = mount(target, generated.default, {});
    await application.settled();
    const svg = target.querySelector("svg")!;
    expect(svg.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(svg.querySelector("a")?.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(svg.querySelector("circle")?.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(svg.querySelector("foreignObject")?.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(svg.querySelector("foreignObject div")?.namespaceURI).toBe(
      "http://www.w3.org/1999/xhtml",
    );
    expect(svg.querySelector("foreignObject div math")?.namespaceURI).toBe(
      "http://www.w3.org/1998/Math/MathML",
    );
    expect(svg.querySelector("foreignObject > math")?.namespaceURI).toBe(
      "http://www.w3.org/1998/Math/MathML",
    );
    expect(svg.querySelector("desc em")?.namespaceURI).toBe("http://www.w3.org/1999/xhtml");
    expect(svg.querySelector(":scope > math")?.namespaceURI).toBe("http://www.w3.org/2000/svg");
    const math = [...target.querySelectorAll("math")].find(
      (element) => element.parentElement === target,
    )!;
    expect(math.namespaceURI).toBe("http://www.w3.org/1998/Math/MathML");
    expect(math.querySelector("mrow > svg")?.namespaceURI).toBe(
      "http://www.w3.org/1998/Math/MathML",
    );
    expect(math.querySelector("mi > math")?.namespaceURI).toBe(
      "http://www.w3.org/1998/Math/MathML",
    );
    expect(math.querySelector("mtext > math")?.namespaceURI).toBe(
      "http://www.w3.org/1998/Math/MathML",
    );
    expect(math.querySelector("mi span")?.namespaceURI).toBe("http://www.w3.org/1999/xhtml");
    expect(math.querySelector("annotation-xml div")?.namespaceURI).toBe(
      "http://www.w3.org/1999/xhtml",
    );
    expect(math.querySelector("mo mglyph")?.namespaceURI).toBe(
      "http://www.w3.org/1998/Math/MathML",
    );
    expect(math.querySelector("annotation-xml:not([encoding]) > svg")?.namespaceURI).toBe(
      "http://www.w3.org/2000/svg",
    );
    const parsed: Array<{ readonly nodeName: string; readonly namespaceURI: string | undefined }> =
      [];
    const visit = (node: { readonly childNodes?: readonly unknown[] }) => {
      for (const child of node.childNodes ?? []) {
        const element = child as { readonly nodeName?: string; readonly namespaceURI?: string };
        if (element.nodeName && element.nodeName !== "#text") {
          parsed.push({ nodeName: element.nodeName, namespaceURI: element.namespaceURI });
          visit(element as { readonly childNodes?: readonly unknown[] });
        }
      }
    };
    visit(parseFragment(markup) as { readonly childNodes?: readonly unknown[] });
    const generatedElements = [...target.querySelectorAll("*")].map((element) => ({
      nodeName: element.localName,
      namespaceURI: element.namespaceURI ?? undefined,
    }));
    expect(generatedElements).toEqual(parsed);
    application.dispose();
  });

  test("lowers native bind attributes as raw binding endpoints", async () => {
    const result = compile(
      `import * as client from "hesperia/client";
export default function App(){
  const circle = client.bind<SVGCircleElement>();
  const result = client.state("");
  client.effect(() => result.set(circle().namespaceURI));
  return <><svg><circle bind={circle} /></svg><output>{result()}</output></>;
}`,
      { filename: "native-bind.tsx" },
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.code).toContain("{ bind: circle }");
    const generated = await importGenerated<{ default: Component<Record<string, never>> }>(
      result.code,
    );
    const window = new Window();
    const target = window.document.createElement("div") as unknown as Element;
    const application = mount(target, generated.default, {});
    await application.settled();
    expect(target.querySelector("circle")?.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(target.querySelector("output")?.textContent).toBe("http://www.w3.org/2000/svg");
    application.dispose();
  });

  test("resets raw fragment context after an SVG HTML integration point", () => {
    const result = compile(
      `import * as client from "hesperia/client";
export default function App(){ return <svg><foreignObject><div>{client.unsafeHTML(<></>, "<span></span>")}</div></foreignObject></svg>; }`,
      { filename: "raw-native-context.tsx", allowUnsafeHTML: true },
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.code).toContain('"div", "http://www.w3.org/1999/xhtml"');
  });

  test("rejects an annotation-xml child namespace that a dynamic encoding cannot prove", () => {
    const result = compile(
      `export default function App(){ const encoding = getEncoding(); return <math><annotation-xml encoding={encoding}><div /></annotation-xml></math>; }`,
      { filename: "dynamic-annotation-xml.tsx" },
    );
    expect(result.code).toBe("");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "HES-HTML-CONTEXT",
        message:
          "Dynamic annotation-xml encoding cannot determine the namespace of its JSX children.",
      }),
    );
  });

  test("rejects dynamic annotation-xml encoding around a native expression child", () => {
    const result = compile(
      `export default function App(){ const input = <div />; const encoding = getEncoding(); return <math><annotation-xml encoding={encoding}>{input}</annotation-xml></math>; }`,
      { filename: "dynamic-annotation-expression.tsx" },
    );
    expect(result.code).toBe("");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "HES-HTML-CONTEXT" }),
    );
  });

  test("refuses unkeyed JSX callback output until keyed list lowering is available", () => {
    const result = compile(
      "export default function App(){ const rows = [1, 2]; return <ul>{rows.map((row) => <li>{row}</li>)}</ul>; }",
      { filename: "list.tsx" },
    );
    expect(result.code).toBe("");
    expect(result.diagnostics.some((item) => item.code === "HES-LIST")).toBe(true);
  });

  test("lowers async component bodies into the explicit owner-bound driver", () => {
    const result = compile(
      "async function App(){ const value = await load(); return <div>{value}</div>; }",
      { filename: "async.tsx" },
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.code).toContain("runAsyncBody");
    expect(result.code).toContain("function* ()");
    expect(result.code).toContain("yield load()");
  });

  test("lowers awaited child renders and AsyncBoundary trees through explicit runtime APIs", () => {
    const result = compile(
      `import { AsyncBoundary } from "hesperia/runtime";
async function Child(){ return <span>ready</span>; }
export default async function App(){
  const rendered = await <Child />;
  return <AsyncBoundary fallback={<div>loading</div>}><div>{rendered}</div></AsyncBoundary>;
}`,
      { filename: "async-boundary.tsx" },
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.code).toContain("awaitComponent");
    expect(result.code).toContain("asyncBoundary");
    expect(result.code).toContain("function* ()");
    expect(result.code).toContain("yield _$.awaitComponent");
  });

  test("rejects unsafeHTML unless the project permission is explicit", () => {
    const source =
      'import * as client from "hesperia/client"; export default function App(){ return client.unsafeHTML(<article />, html); }';
    const result = compile(source, { filename: "raw.tsx" });
    expect(result.code).toBe("");
    expect(result.diagnostics.some((item) => item.code === "HES-RAW-DISABLED")).toBe(true);
    const allowed = compile(source, { filename: "raw.tsx", allowUnsafeHTML: true });
    expect(allowed.diagnostics).toEqual([]);
    expect(allowed.code).toContain("rawHTML");
    expect(allowed.code).toContain('"article"');
  });

  test("lowers the unsafeHTML fragment form without an implicit host", () => {
    const source =
      'import { unsafeHTML } from "hesperia/client"; export default function App(){ return unsafeHTML(<></>, html); }';
    const denied = compile(source, { filename: "raw-fragment.tsx" });
    expect(denied.code).toBe("");
    expect(denied.diagnostics.some((item) => item.code === "HES-RAW-DISABLED")).toBe(true);
    const result = compile(source, { filename: "raw-fragment.tsx", allowUnsafeHTML: true });
    expect(result.diagnostics).toEqual([]);
    expect(result.code).toContain("rawHTML");
    expect(result.code).toContain("null");
  });

  test("does not mistake an unrelated unsafeHTML method for the compiler marker", () => {
    const result = compile(
      'const object = { unsafeHTML() { return "plain"; } }; export default function App(){ return object.unsafeHTML(<article />, html); }',
      { filename: "unrelated-raw.tsx", allowUnsafeHTML: true },
    );
    expect(result.code).toBe("");
    expect(result.diagnostics.some((item) => item.code === "HES-RAW-DISABLED")).toBe(false);
    expect(result.diagnostics.some((item) => item.code === "HES-EXPRESSION")).toBe(true);
  });

  test("passes the authored native context to hostless raw fragments", () => {
    const result = compile(
      'import { unsafeHTML } from "hesperia/client"; export default function App(){ return <select>{unsafeHTML(<></>, html)}</select>; }',
      { filename: "raw-context.tsx", allowUnsafeHTML: true },
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.code).toContain("rawHTML");
    expect(result.code).toContain('"select"');
  });

  test("preserves native default parameter evaluation and destructuring", async () => {
    const result = compile(
      `
let fallbackCalls = 0;
function fallback() { ++fallbackCalls; return 7; }
const outer = 10;
const later = "outer";
export function defaults(first = 2, second = first + 1) { return first + second; }
export function sideEffect(value = fallback()) { return value; }
export function calls() { return fallbackCalls; }
export function shadow(value = outer) { const outer = 3; return value + outer; }
export function nested({ value = 4 } = {}) { return value; }
export function closure(first = () => later, later = "parameter") {
  const body = "body";
  return [body, first(), later];
}
`,
      { filename: "defaults.ts" },
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.ir.body.some((item) => JSON.stringify(item).includes('"kind":"default"'))).toBe(
      true,
    );
    const generated = await importGenerated<{
      defaults(first?: number, second?: number): number;
      sideEffect(value?: number): number;
      calls(): number;
      shadow(value?: number): number;
      nested(value?: { value?: number }): number;
      closure(first?: () => string, later?: string): string[];
    }>(result.code);
    expect(generated.defaults()).toBe(5);
    expect(generated.defaults(5)).toBe(11);
    expect(generated.sideEffect(0)).toBe(0);
    expect(generated.calls()).toBe(0);
    expect(generated.sideEffect()).toBe(7);
    expect(generated.calls()).toBe(1);
    expect(generated.nested()).toBe(4);
    expect(generated.nested({ value: 9 })).toBe(9);
    expect(generated.shadow()).toBe(13);
    expect(generated.shadow(2)).toBe(5);
    expect(generated.closure()).toStrictEqual(["body", "parameter", "parameter"]);
  });

  test("keeps default binding meaning stable across alpha renames", () => {
    const a = compile("const base = 3; export function read(value = base) { return value; }", {
      filename: "default-hash.ts",
    });
    const b = compile(
      "const renamed = 3; export function read(input = renamed) { return input; }",
      { filename: "default-hash.ts" },
    );
    const c = compile("const base = 3; export function read(value = 4) { return value; }", {
      filename: "default-hash.ts",
    });
    expect(a.diagnostics).toEqual([]);
    expect(b.diagnostics).toEqual([]);
    expect(c.diagnostics).toEqual([]);
    expect(a.semanticHash).toBe(b.semanticHash);
    expect(a.semanticHash).not.toBe(c.semanticHash);
  });

  test("separates body declarations only when parameter defaults need it", () => {
    const simple = compile("export function read(value) { var value = 1; return value; }");
    const defaulted = compile("export function read(value = 0) { var value = 1; return value; }");
    expect(simple.diagnostics).toEqual([]);
    expect(defaulted.diagnostics).toEqual([]);
    const simpleFunction = simple.ir.body.find((item) => item.kind === "export");
    const defaultedFunction = defaulted.ir.body.find((item) => item.kind === "export");
    if (simpleFunction?.kind !== "export" || defaultedFunction?.kind !== "export")
      throw new Error("Expected exported function declarations.");
    if (
      simpleFunction.declaration.kind !== "function" ||
      defaultedFunction.declaration.kind !== "function"
    )
      throw new Error("Expected exported function declarations.");
    const simpleParameter = simpleFunction.declaration.parameters[0];
    const defaultedParameter = defaultedFunction.declaration.parameters[0];
    const simpleBodyPattern = simpleFunction.declaration.body.body[0];
    const defaultedBodyPattern = defaultedFunction.declaration.body.body[0];
    if (!simpleParameter || !defaultedParameter || !simpleBodyPattern || !defaultedBodyPattern)
      throw new Error("Expected exported function parameters and body declarations.");
    const defaultedLeft =
      defaultedParameter.kind === "default" ? defaultedParameter.left : defaultedParameter;
    if (
      simpleParameter.kind !== "identifier" ||
      defaultedLeft.kind !== "identifier" ||
      simpleBodyPattern.kind !== "variable" ||
      defaultedBodyPattern.kind !== "variable" ||
      simpleBodyPattern.declarations[0]?.pattern.kind !== "identifier" ||
      defaultedBodyPattern.declarations[0]?.pattern.kind !== "identifier"
    )
      throw new Error("Expected identifier parameter and variable patterns.");
    expect(simpleBodyPattern.declarations[0]!.pattern.bindingId).toBe(simpleParameter.bindingId);
    expect(defaultedBodyPattern.declarations[0]!.pattern.bindingId).not.toBe(
      defaultedLeft.bindingId,
    );
  });

  test("fails closed for unsupported import attributes", () => {
    const result = compile(
      'import data from "./data.json" with { type: "json" }; export default function App(){ return <div>{data}</div>; }',
      { filename: "unsupported-import.tsx" },
    );
    expect(result.code).toBe("");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "HES-IMPORT",
        message: "Import attributes are not supported by this compiler profile.",
      }),
    );
  });

  test("keeps empty and type-only exports as runtime-empty module markers", () => {
    for (const source of ["export {};", "export type { Widget };"]) {
      const result = compile(source, { filename: "type-only.tsx" });
      expect(result.diagnostics).toEqual([]);
      expect(result.code).not.toBe("");
    }
  });

  test("drops type-only imports while preserving runtime export specifier lists", () => {
    const typeOnly = compile(
      'import type { Widget } from "./widget"; export default function App(){ return <div />; }',
      { filename: "type-import.tsx" },
    );
    expect(typeOnly.diagnostics).toEqual([]);
    expect(typeOnly.code).toContain("export default");

    const exportList = compile("const value = 1; export { value as answer };", {
      filename: "export-list.tsx",
    });
    expect(exportList.diagnostics).toEqual([]);
    expect(exportList.code).toContain("export { value as answer }");
    expect(exportList.semantics.exports).toContain("answer");
  });

  test("keeps local and re-export aliases live in emitted ESM", async () => {
    const source = compile(
      "export let value = 1; export { value as localAlias }; export function bump(){ ++value; }",
      { filename: "source.ts" },
    );
    const barrel = compile(
      'export { value as forwarded, bump } from "./source.mjs"; export * as namespace from "./source.mjs";',
      { filename: "barrel.ts" },
    );
    expect(source.diagnostics).toEqual([]);
    expect(barrel.diagnostics).toEqual([]);
    expect(source.ir.body.some((item) => item.kind === "export-list")).toBe(true);
    expect(barrel.ir.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "export-list", source: "./source.mjs" }),
        expect.objectContaining({
          kind: "export-all",
          source: "./source.mjs",
          exported: "namespace",
        }),
      ]),
    );

    const directory = resolve(import.meta.dir, "../../.hesperia");
    await mkdir(directory, { recursive: true });
    const stem = `compiler-reexport-${randomUUID()}`;
    const sourceFile = join(directory, `${stem}-source.mjs`);
    const barrelFile = join(directory, `${stem}-barrel.mjs`);
    await writeFile(sourceFile, source.code);
    await writeFile(barrelFile, barrel.code.replaceAll("./source.mjs", `./${stem}-source.mjs`));
    try {
      const generated = await import(pathToFileURL(barrelFile).href);
      expect(generated.forwarded).toBe(1);
      expect(generated.namespace.value).toBe(1);
      generated.bump();
      expect(generated.forwarded).toBe(2);
      expect(generated.namespace.localAlias).toBe(2);
    } finally {
      await unlink(barrelFile);
      await unlink(sourceFile);
    }
  });

  test("preserves sourced empty lists and string-named re-exports", () => {
    const empty = compile('export {} from "./side-effect.mjs";', { filename: "empty.ts" });
    const named = compile('export { "not-valid" as answer } from "./source.mjs";', {
      filename: "named.ts",
    });
    expect(empty.diagnostics).toEqual([]);
    expect(empty.ir.body).toContainEqual(
      expect.objectContaining({ kind: "export-list", source: "./side-effect.mjs", specifiers: [] }),
    );
    expect(empty.code).toContain('export {} from "./side-effect.mjs"');
    expect(named.diagnostics).toEqual([]);
    expect(named.code).toContain('"not-valid" as answer');
  });

  test("preserves authored null values instead of turning them into missing returns", () => {
    const result = compile(
      "export default function App() { const value = null; return value === null ? null : <div />; }",
      { filename: "null-value.tsx" },
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.code).toContain("const value = null");
    expect(result.code).toContain("? null :");
  });

  test("fails closed for malformed keyed JSX list callback bodies", () => {
    const result = compile(
      "export default function App() { const rows = [1]; return <ul>{rows.map((row, index) => <li key={row}>{index}</li>)}</ul>; }",
      { filename: "list-callback.tsx" },
    );
    expect(result.code).toBe("");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "HES-LIST",
        message: "Keyed JSX list callbacks must declare exactly one item parameter.",
      }),
    );
  });
});
