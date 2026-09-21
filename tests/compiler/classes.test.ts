import { expect, test } from "bun:test";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { compile } from "../../src/compiler/index.ts";

async function importGenerated<T extends object>(code: string): Promise<T> {
  const directory = resolve(import.meta.dir, "../../.hesperia");
  await mkdir(directory, { recursive: true });
  const filename = join(directory, `classes-${randomUUID()}.mjs`);
  await writeFile(filename, code);
  try {
    return await import(pathToFileURL(filename).href);
  } finally {
    await unlink(filename);
  }
}

test("classes preserve native inheritance, super calls, and new.target", async () => {
  const result = compile(
    `class Base {
      constructor(value: number) { this.value = value; }
      read() { return this.value; }
    }
    class Child extends Base {
      constructor(value: number) { super(value + 1); this.kind = new.target.name; }
      read() { return super.read() + 1; }
    }
    export function evaluate() {
      const item = new Child(2);
      return [item.value, item.read(), item.kind, item instanceof Base, item.constructor === Child];
    }`,
    { filename: "classes-inheritance.ts" },
  );
  expect(result.diagnostics).toStrictEqual([]);
  const generated = await importGenerated<{
    evaluate: () => [number, number, string, boolean, boolean];
  }>(result.code);
  expect(generated.evaluate()).toStrictEqual([3, 4, "Child", true, true]);
});

test("class definition order separates computed keys and static work from instance fields", async () => {
  const result = compile(
    `const events: string[] = [];
    const key = () => { events.push("key"); return "computed"; };
    const mark = (label: string, value: number) => { events.push(label); return value; };
    class Example {
      static [key()] = mark("static", 7);
      #secret = 3;
      value = mark("field", 4);
      [key()]() { events.push("method"); }
      get secret() { return this.#secret; }
      set secret(value: number) { this.#secret = value; }
    }
    export function evaluate() {
      const defined = events.join(",");
      const item = new Example();
      const constructed = events.join(",");
      item.secret = 9;
      item.computed();
      return [defined, constructed, item.value, item.secret, Example.computed];
    }`,
    { filename: "classes-order.ts" },
  );
  expect(result.diagnostics).toStrictEqual([]);
  const generated = await importGenerated<{
    evaluate: () => [string, string, number, number, number];
  }>(result.code);
  expect(generated.evaluate()).toStrictEqual(["key,key,static", "key,key,static,field", 4, 9, 7]);
});

test("static blocks run at definition time before later static fields", async () => {
  const result = compile(
    `const events: string[] = [];
    const mark = (label: string, value: number) => { events.push(label); return value; };
    class Example {
      static { events.push("block"); }
      static value = mark("static", 2);
    }
    export const value = [events.join(","), Example.value];`,
    { filename: "classes-static-block.ts" },
  );
  expect(result.diagnostics).toStrictEqual([]);
  const generated = await importGenerated<{ value: [string, number] }>(result.code);
  expect(generated.value).toStrictEqual(["block,static", 2]);
});

test("private names remain class-local across inheritance", async () => {
  const result = compile(
    `class Base {
      #value = 2;
      readBase() { return this.#value; }
    }
    class Child extends Base {
      #value = 3;
      read() { return super.readBase() + this.#value; }
    }
    export function evaluate() { return new Child().read(); }`,
    { filename: "classes-private.ts" },
  );
  expect(result.diagnostics).toStrictEqual([]);
  const generated = await importGenerated<{ evaluate: () => number }>(result.code);
  expect(generated.evaluate()).toBe(5);
});

test("named class expressions keep their lexical name while capturing an outer value", async () => {
  const result = compile(
    `export function make(value: string) {
      return class Named {
        read() { return Named.name + ":" + value; }
      };
    }`,
    { filename: "classes-expression.ts" },
  );
  expect(result.diagnostics).toStrictEqual([]);
  const generated = await importGenerated<{
    make: (value: string) => new () => { read(): string };
  }>(result.code);
  expect(new (generated.make("captured"))().read()).toBe("Named:captured");
});

test("class declarations keep their inner name and private identities stable across renames", async () => {
  const first = compile(
    `class Alpha {
      #value = 1;
      read() { return this.#value; }
      static self() { return Alpha; }
    }
    export { Alpha as Value };
    export function evaluate() {
      const original = Alpha;
      Alpha = class Replacement {};
      return [original.self() === original, original.name, new original().read()];
    }`,
    { filename: "classes-identity.ts" },
  );
  const renamed = compile(
    `class Beta {
      #other = 1;
      read() { return this.#other; }
      static self() { return Beta; }
    }
    export { Beta as Value };
    export function evaluate() {
      const original = Beta;
      Beta = class Replacement {};
      return [original.self() === original, original.name, new original().read()];
    }`,
    { filename: "classes-identity.ts" },
  );
  expect(first.diagnostics).toStrictEqual([]);
  expect(renamed.diagnostics).toStrictEqual([]);
  expect(first.semanticHash).toBe(renamed.semanticHash);
  const generated = await importGenerated<{
    evaluate: () => [boolean, string, number];
  }>(first.code);
  expect(generated.evaluate()).toStrictEqual([true, "Alpha", 1]);
});
