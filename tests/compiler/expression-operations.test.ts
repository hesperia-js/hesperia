import { expect, test } from "bun:test";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { compile } from "../../src/compiler/index.ts";
import { Window } from "happy-dom";
import { mount, type Component } from "hesperia";

async function importGenerated<T extends object>(code: string): Promise<T> {
  const directory = resolve(import.meta.dir, "../../.hesperia");
  await mkdir(directory, { recursive: true });
  const filename = join(directory, `expression-operations-${randomUUID()}.mjs`);
  await writeFile(filename, code);
  try {
    return await import(pathToFileURL(filename).href);
  } finally {
    await unlink(filename);
  }
}

test("assignment expressions preserve native results and short-circuiting", async () => {
  const result = compile(
    `
    export function evaluate() {
      const events: string[] = [];
      const rhs = (input: number) => { events.push("rhs" + input); return input; };
      let value: number | undefined;
      const first = (value = 2);
      const second = (value += 3);
      value ||= rhs(8);
      value &&= rhs(9);
      value ??= rhs(10);
      return [first, second, value, events.join(",")];
    }
  `,
    { filename: "assignment.ts" },
  );
  expect(result.diagnostics).toStrictEqual([]);
  const generated = await importGenerated<{ evaluate: () => (number | string)[] }>(result.code);
  expect(generated.evaluate()).toStrictEqual([2, 5, 9, "rhs9"]);
}, 30_000);

test("computed member assignment evaluates one target and preserves getter/setter behavior", async () => {
  const result = compile(
    `
    export function evaluate() {
      const events: string[] = [];
      const key = () => { events.push("key"); return "value"; };
      const target = {
        get value() { events.push("get"); return 0; },
        set value(next: number) { events.push("set" + next); },
      };
      const rhs = () => { events.push("rhs"); return 4; };
      target[key()] ||= rhs();
      return events;
    }
  `,
    { filename: "computed-assignment.ts" },
  );
  expect(result.diagnostics).toStrictEqual([]);
  const generated = await importGenerated<{ evaluate: () => string[] }>(result.code);
  expect(generated.evaluate()).toStrictEqual(["key", "get", "rhs", "set4"]);
}, 30_000);

test("call and constructor argument spreads preserve order and native construction", async () => {
  const result = compile(
    `
    export function evaluate() {
      const events: string[] = [];
      const values = () => { events.push("spread"); return [2, 7]; };
      const tail = () => { events.push("tail"); return 1; };
      const maximum = Math.max(...values(), tail());
      const copy = new Array(...[2, 7]);
      const date = new Date(...[2020, 0, 2]);
      return [maximum, copy[0], copy[1], date instanceof Date, date.getUTCFullYear(), events.join(",")];
    }
  `,
    { filename: "argument-spreads.ts" },
  );
  expect(result.diagnostics).toStrictEqual([]);
  const generated = await importGenerated<{ evaluate: () => (number | boolean | string)[] }>(
    result.code,
  );
  expect(generated.evaluate()).toStrictEqual([7, 2, 7, true, 2020, "spread,tail"]);
}, 30_000);

test("assignment and spread forms contribute to semantic meaning", () => {
  const assignment = compile("export const value = () => { let x = 0; return x = 1; };", {
    filename: "meaning.ts",
  });
  const compound = compile("export const value = () => { let x = 0; return x += 1; };", {
    filename: "meaning.ts",
  });
  const spread = compile("export const value = (items: number[]) => Math.max(...items);", {
    filename: "meaning.ts",
  });
  const renamed = compile("export const value = (values: number[]) => Math.max(...values);", {
    filename: "meaning.ts",
  });
  const ordinary = compile("export const value = (items: number[]) => Math.max(items);", {
    filename: "meaning.ts",
  });
  for (const result of [assignment, compound, spread, renamed, ordinary])
    expect(result.diagnostics).toStrictEqual([]);
  expect(assignment.semanticHash).not.toBe(compound.semanticHash);
  expect(spread.semanticHash).toBe(renamed.semanticHash);
  expect(spread.semanticHash).not.toBe(ordinary.semanticHash);
}, 30_000);

test("destructuring assignment remains an explicit unsupported form", () => {
  const result = compile("let value = 0; [value] = [1];", { filename: "destructure.ts" });
  expect(result.code).toBe("");
  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({ code: "HES-ASSIGN", severity: "error" }),
  );
});

test.each(["row = 2;", "for (row of [2]) {}", "for (row in { value: 2 }) {}"])(
  "list parameter writes fail checking instead of emitting an out-of-scope assignment: %s",
  (write) => {
    const result = compile(
      `export function App() {
      return <div>{[1].map(row => <button key={row} on:click={() => { ${write} }}>{row}</button>)}</div>;
    }`,
      { filename: "list-write.tsx" },
    );
    expect(result.code).toBe("");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "HES-ASSIGN-CAPTURE", severity: "error" }),
    );
  },
);

test("list member writes and shadowed callback parameters preserve their actual bindings", async () => {
  const result = compile(
    `export const rows = [{ id: 1, value: 1 }];
    export function App() {
      return <div>{rows.map(row => <button key={row.id} on:click={() => {
        const change = (row: number) => row += 2;
        row.value = change(row.value);
      }}>{row.value}</button>)}</div>;
    }`,
    { filename: "list-member-write.tsx" },
  );
  expect(result.diagnostics).toStrictEqual([]);
  const generated = await importGenerated<{
    App: Component<Record<string, never>>;
    rows: { id: number; value: number }[];
  }>(result.code);
  const window = new Window();
  const target = window.document.createElement("div");
  const application = mount(target as unknown as Element, generated.App, {});
  try {
    await application.settled();
    const button = target.querySelector("button")!;
    button.click();
    expect(generated.rows).toStrictEqual([{ id: 1, value: 3 }]);
    expect(target.querySelector("button")).toBe(button);
  } finally {
    application.dispose();
  }
});
