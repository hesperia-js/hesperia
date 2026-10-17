import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { compile } from "../../packages/compiler/src/index.ts";

type Constructor = new (first: string, second: string) => unknown;

type Construct = (lookup: () => Constructor, first: () => string, second: () => string) => unknown;

async function compiledConstructor(): Promise<Construct> {
  const source = [
    "export function make(",
    "  lookup: () => new (first: string, second: string) => unknown,",
    "  first: () => string, second: () => string",
    ") { return new (lookup())(first(), second()); }",
  ].join("\n");
  const compiled = await compile(source, { filename: "constructor-order.ts" });

  expect(compiled.diagnostics).toStrictEqual([]);

  const directory = resolve(import.meta.dir, "../../.hesperia");

  await mkdir(directory, { recursive: true });

  const filename = resolve(directory, `constructor-order-${randomUUID()}.mjs`);

  await writeFile(filename, compiled.code);

  try {
    const generated = await import(pathToFileURL(filename).href);
    return generated.make as Construct;
  } finally {
    await unlink(filename);
  }
}

test("constructor lookup and ordered arguments preserve the native instance and new.target", async () => {
  const make = await compiledConstructor();
  const events: string[] = [];

  class Product {
    readonly target: typeof Product;

    constructor(
      readonly first: string,
      readonly second: string,
    ) {
      events.push("construct");

      this.target = new.target;
    }
  }

  const result = make(
    () => {
      events.push("lookup");

      return Product;
    },
    () => {
      events.push("first");

      return "A";
    },
    () => {
      events.push("second");

      return "B";
    },
  );

  expect(events).toStrictEqual(["lookup", "first", "second", "construct"]);

  expect(result).toBeInstanceOf(Product);

  expect((result as Product).target).toBe(Product);

  expect([(result as Product).first, (result as Product).second]).toStrictEqual(["A", "B"]);
});

test("argument and constructor failures preserve native evaluation and thrown values", async () => {
  const make = await compiledConstructor();
  const events: string[] = [];
  const argumentFailure = { reason: "argument" };
  const constructorFailure = { reason: "constructor" };

  class Broken {
    constructor() {
      events.push("construct");

      throw constructorFailure;
    }
  }

  const lookup = () => {
    events.push("lookup");

    return Broken;
  };

  const second = () => {
    events.push("second");

    return "B";
  };

  let thrown: unknown;

  try {
    make(
      lookup,
      () => {
        events.push("first");

        throw argumentFailure;
      },
      second,
    );
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBe(argumentFailure);

  expect(events).toStrictEqual(["lookup", "first"]);

  events.length = 0;

  try {
    make(
      lookup,
      () => {
        events.push("first");

        return "A";
      },
      second,
    );
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBe(constructorFailure);

  expect(events).toStrictEqual(["lookup", "first", "second", "construct"]);

  events.length = 0;

  try {
    make(
      () => {
        events.push("lookup");

        return (() => undefined) as unknown as Constructor;
      },
      () => {
        events.push("first");

        return "A";
      },
      second,
    );
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(TypeError);

  expect(events).toStrictEqual(["lookup", "first", "second"]);
});
