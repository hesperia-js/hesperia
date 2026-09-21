import { expect, test } from "bun:test";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { compile } from "../../src/compiler/index.ts";

async function importGenerated<T extends object>(code: string): Promise<T> {
  const directory = resolve(import.meta.dir, "../../.hesperia");
  await mkdir(directory, { recursive: true });
  const filename = join(directory, `switch-rest-${randomUUID()}.mjs`);
  await writeFile(filename, code);
  try {
    return await import(pathToFileURL(filename).href);
  } finally {
    await unlink(filename);
  }
}

test("switch preserves discriminant order, case source order, fallthrough, and break", async () => {
  const result = compile(
    `export function evaluate(input: number) {
      const events: string[] = [];
      var value = "outer";
      switch (input) {
        case 1:
          events.push("one");
          value = "one";
        case 2:
          events.push("two");
          break;
        default:
          events.push("default");
      }
      return [events.join(","), value];
    }
    export function hoisted() {
      switch (true) {
        case true: {
          const before = value;
          var value = "case";
          return before;
        }
        default:
          return value;
      }
    }`,
    { filename: "switch-flow.ts" },
  );
  expect(result.diagnostics).toStrictEqual([]);
  const generated = await importGenerated<{
    evaluate: (input: number) => [string, string];
    hoisted: () => string | undefined;
  }>(result.code);
  expect(generated.evaluate(1)).toStrictEqual(["one,two", "one"]);
  expect(generated.evaluate(9)).toStrictEqual(["default", "outer"]);
  expect(generated.hoisted()).toBeUndefined();
});

test("switch cases share lexical bindings while the discriminant resolves outside them", async () => {
  const result = compile(
    `export function evaluate() {
      let value = "outer";
      switch (value) {
        case "outer": {
          let value = "inner";
          return value;
        }
        default:
          return value;
      }
    }`,
    { filename: "switch-scope.ts" },
  );
  expect(result.diagnostics).toStrictEqual([]);
  const generated = await importGenerated<{ evaluate: () => string }>(result.code);
  expect(generated.evaluate()).toBe("inner");
});

test("rest parameters and destructuring preserve defaults and object exclusion", async () => {
  const result = compile(
    `export function evaluate(...values: number[]) {
      const [first = 7, ...remaining] = values;
      const { label = "default", ...rest } = { label: "chosen", count: remaining.length };
      return [first, remaining.join(","), label, rest.count];
    }`,
    { filename: "rest-patterns.ts" },
  );
  expect(result.diagnostics).toStrictEqual([]);
  const generated = await importGenerated<{
    evaluate: (...values: number[]) => [number, string, string, number];
  }>(result.code);
  expect(generated.evaluate()).toStrictEqual([7, "", "chosen", 0]);
  expect(generated.evaluate(1, 2, 3)).toStrictEqual([1, "2,3", "chosen", 2]);
});

test("array rest consumes an iterable in native order and retains sparse entries", async () => {
  const result = compile(
    `export function evaluate() {
      const events: string[] = [];
      const iterable = {
        [Symbol.iterator]() {
          events.push("iterator");
          return [1, 2, 3][Symbol.iterator]();
        }
      } as Iterable<number>;
      const [first, ...rest] = iterable;
      return [first, rest[0], rest[1], events.join(",")];
    }`,
    { filename: "rest-iterable.ts" },
  );
  expect(result.diagnostics).toStrictEqual([]);
  const generated = await importGenerated<{
    evaluate: () => [number, number, number, string];
  }>(result.code);
  expect(generated.evaluate()).toStrictEqual([1, 2, 3, "iterator"]);
});

test("switch and rest binding identities remain stable across local alpha renames", () => {
  const first = compile(
    `const value = 1;
    export function evaluate(...items: number[]) {
      const [head, ...tail] = items;
      switch (value) { case 1: return head + tail.length; default: return 0; }
    }`,
    { filename: "switch-rest-identity.ts" },
  );
  const renamed = compile(
    `const outer = 1;
    export function evaluate(...values: number[]) {
      const [first, ...remaining] = values;
      switch (outer) { case 1: return first + remaining.length; default: return 0; }
    }`,
    { filename: "switch-rest-identity.ts" },
  );
  expect(first.diagnostics).toStrictEqual([]);
  expect(renamed.diagnostics).toStrictEqual([]);
  expect(first.semanticHash).toBe(renamed.semanticHash);
});
