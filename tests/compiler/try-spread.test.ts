import { expect, test } from "bun:test";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { compile } from "../../packages/compiler/src/index.ts";

async function importGenerated<T extends object>(code: string): Promise<T> {
  const directory = resolve(import.meta.dir, "../../.hesperia");

  await mkdir(directory, { recursive: true });

  const filename = join(directory, `try-spread-${randomUUID()}.mjs`);

  await writeFile(filename, code);

  try {
    return await import(pathToFileURL(filename).href);
  } finally {
    await unlink(filename);
  }
}

test("native try/catch preserves catch lexical shadowing and var hoisting", async () => {
  const result = await compile(
    `export function evaluate() {
      var error = "outer";
      let caught;
      try { throw "caught"; }
      catch (error) {
        var error = "changed";
        caught = [error, (() => error)()];
      }
      return [caught, error];
    }
    export function optional() {
      try { throw { value: 4 }; } catch ({ value = 9 }) { return value; }
    }
    export function bare() {
      try { throw 1; } catch { return "handled"; }
    }
    export function loopHoist() {
      var value = "outer";
      try { throw 1; }
      catch (value) { for (var value of ["changed"]) {} }
      return value;
    }`,
    { filename: "try-shadowing.ts" },
  );

  expect(result.diagnostics).toStrictEqual([]);

  const generated = await importGenerated<{
    evaluate: () => [[string, string], string];
    optional: () => number;
    bare: () => string;
    loopHoist: () => string;
  }>(result.code);

  expect(generated.evaluate()).toStrictEqual([["changed", "changed"], "outer"]);

  expect(generated.optional()).toBe(4);

  expect(generated.bare()).toBe("handled");

  expect(generated.loopHoist()).toBe("outer");
});

test("finally runs for return, throw, and loop break and preserves native abrupt completion", async () => {
  const result = await compile(
    `export function evaluate() {
      const events: string[] = [];
      function returned() {
        try { return "try"; } finally { events.push("return-finally"); }
      }
      function thrown() {
        try { throw "try"; } finally { events.push("throw-finally"); }
      }
      const returnedValue = returned();
      let thrownValue = "";
      try { thrown(); } catch (error) { thrownValue = String(error); }
      let count = 0;
      for (let index = 0; index < 3; index++) {
        try { count += index; if (index === 1) break; }
        finally { events.push("break-" + index); }
      }
      return [returnedValue, thrownValue, count, events.join(",")];
    }`,
    { filename: "try-finally.ts" },
  );

  expect(result.diagnostics).toStrictEqual([]);

  const generated = await importGenerated<{ evaluate: () => [string, string, number, string] }>(
    result.code,
  );

  expect(generated.evaluate()).toStrictEqual([
    "try",
    "try",
    1,
    "return-finally,throw-finally,break-0,break-1",
  ]);
});

test("array spread evaluates iterables in place and preserves sparse holes", async () => {
  const result = await compile(
    `export function evaluate() {
      const events: string[] = [];
      const values = {
        [Symbol.iterator]() {
          events.push("iterator");
          return [2, 3][Symbol.iterator]();
        }
      } as Iterable<number>;
      const result = [1, ...values, , 4];
      return [result.length, result[0], result[1], result[2], result[3], result[4], 3 in result, events.join(",")];
    }`,
    { filename: "array-spread.ts" },
  );

  expect(result.diagnostics).toStrictEqual([]);

  const generated = await importGenerated<{
    evaluate: () => [number, number, number, number, number | undefined, number, boolean, string];
  }>(result.code);

  expect(generated.evaluate()).toStrictEqual([5, 1, 2, 3, undefined, 4, false, "iterator"]);
});

test("regexp and bigint literals retain native values and semantic distinctions", async () => {
  const first = await compile("export const pattern = /a+/gi; export const amount = 123n;", {
    filename: "literal-forms.ts",
  });
  const second = await compile("export const pattern = /a+/g; export const amount = 124n;", {
    filename: "literal-forms.ts",
  });

  expect(first.diagnostics).toStrictEqual([]);

  expect(second.diagnostics).toStrictEqual([]);

  expect(first.semanticHash).not.toBe(second.semanticHash);

  const generated = await importGenerated<{
    pattern: RegExp;
    amount: bigint;
  }>(first.code);

  expect(generated.pattern).toEqual(/a+/gi);

  expect(generated.pattern.flags).toBe("gi");

  expect(generated.amount).toBe(123n);
});
