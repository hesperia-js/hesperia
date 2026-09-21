import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { compile } from "../../src/compiler/index.ts";

async function importGenerated<T extends object, R>(
  code: string,
  dependencies: Record<string, string> = {},
  exercise: (module: T) => Promise<R> | R,
): Promise<R> {
  const directory = resolve(
    import.meta.dir,
    "../../.hesperia",
    `import-expression-${randomUUID()}`,
  );
  await mkdir(directory, { recursive: true });
  const filename = join(directory, "module.mjs");
  const dependencyFiles = Object.entries(dependencies).map(([name, source]) => {
    const path = join(directory, name);
    return { path, source };
  });
  await writeFile(filename, code);
  await Promise.all(dependencyFiles.map((file) => writeFile(file.path, file.source)));
  try {
    const module = await import(pathToFileURL(filename).href);
    return await exercise(module as T);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("dynamic imports preserve native module caching and rejection", async () => {
  const result = compile(
    `export async function evaluate() {
      const first = await import("./import-expression-dependency.mjs");
      const second = await import("./import-expression-dependency.mjs");
      let rejected = false;
      try { await import("./import-expression-missing.mjs"); } catch { rejected = true; }
      return [first === second, first.value, rejected];
    }`,
    { filename: "import-expression-cache.ts" },
  );
  expect(result.diagnostics).toStrictEqual([]);
  const value = await importGenerated<
    {
      evaluate: () => Promise<[boolean, number, boolean]>;
    },
    [boolean, number, boolean]
  >(
    result.code,
    {
      "import-expression-dependency.mjs": "export const value = 23;",
    },
    (generated) => generated.evaluate(),
  );
  expect(value).toStrictEqual([true, 23, true]);
});

test("dynamic imports retain source expressions and import options", async () => {
  const result = compile(
    `export async function load(suffix: string) {
      const events: string[] = [];
      const record = (label: string, value: unknown) => { events.push(label); return value; };
      const source = record("source", "./import-expression-data" + suffix);
      const options = record("options", { with: { type: "json" } });
      const loaded = await import(source, options);
      return [events.join(","), loaded.default.value];
    }`,
    { filename: "import-expression-options.ts" },
  );
  expect(result.diagnostics).toStrictEqual([]);
  const value = await importGenerated<
    {
      load: (suffix: string) => Promise<[string, number]>;
    },
    [string, number]
  >(
    result.code,
    {
      "import-expression-data.json": '{ "value": 41 }',
    },
    (generated) => generated.load(".json"),
  );
  expect(value).toStrictEqual(["source,options", 41]);
});

test(
  "dynamic import identities alpha-rename while options remain semantic",
  () => {
    const first = compile(`export function load(path: string) { return import(path); }`, {
      filename: "import-expression-identity.ts",
    });
    const renamed = compile(`export function load(source: string) { return import(source); }`, {
      filename: "import-expression-identity.ts",
    });
    const withOptions = compile(
      `export function load(path: string) { return import(path, { with: { type: "json" } }); }`,
      { filename: "import-expression-identity.ts" },
    );
    expect(first.diagnostics).toStrictEqual([]);
    expect(renamed.diagnostics).toStrictEqual([]);
    expect(withOptions.diagnostics).toStrictEqual([]);
    expect(first.semanticHash).toBe(renamed.semanticHash);
    expect(first.semanticHash).not.toBe(withOptions.semanticHash);
  },
  { timeout: 20_000 },
);

test("browser emission lowers finite imports without eager target evaluation", async () => {
  const result = compile(
    `export function load(first: boolean) {
      const name = first ? "first" : "second";
      return import("./" + name + ".mjs");
    }`,
    { filename: "import-expression-browser.ts", browserTarget: true },
  );
  expect(result.diagnostics).toStrictEqual([]);
  const value = await importGenerated<
    {
      load: (first: boolean) => Promise<{ value: string }>;
    },
    [string, string, boolean]
  >(
    result.code,
    {
      "first.mjs":
        'globalThis.firstLoaded = (globalThis.firstLoaded ?? 0) + 1; export const value = "first";',
      "second.mjs":
        'globalThis.secondLoaded = (globalThis.secondLoaded ?? 0) + 1; export const value = "second";',
    },
    async (generated) => {
      const first = await generated.load(true);
      const second = await generated.load(false);
      const cached = first === (await generated.load(true));
      return [first.value, second.value, cached];
    },
  );
  expect(value).toStrictEqual(["first", "second", true]);
});

test("finite import lowering keeps source and options throws as rejected promises", async () => {
  const result = compile(
    `export function sourceThrows() {
      return import((() => { throw new Error("source"); })() ? "./first.mjs" : "./second.mjs");
    }
    export function optionsThrow() {
      return import(true ? "./first.mjs" : "./second.mjs", (() => { throw new Error("options"); })());
    }`,
    { filename: "import-expression-errors.ts", browserTarget: true },
  );
  expect(result.diagnostics).toStrictEqual([]);
  const value = await importGenerated<
    {
      sourceThrows: () => Promise<unknown>;
      optionsThrow: () => Promise<unknown>;
    },
    [string, string]
  >(
    result.code,
    { "first.mjs": "export const value = 1;", "second.mjs": "export const value = 2;" },
    async (generated) => {
      const source = generated.sourceThrows();
      const options = generated.optionsThrow();
      const errorMessage = (promise: Promise<unknown>): Promise<string> =>
        promise.then(
          () => "resolved",
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        );
      const sourceError = await errorMessage(source);
      const optionsError = await errorMessage(options);
      return [sourceError, optionsError];
    },
  );
  expect(value).toStrictEqual(["source", "options"]);
});

test("finite lowering keeps awaited source tests and options native", async () => {
  const result = compile(
    `export async function load(first: boolean) {
      const loaded = await import((await Promise.resolve(first)) ? "./first.mjs" : "./second.mjs", await Promise.resolve({}));
      return loaded.value;
    }`,
    { filename: "import-expression-await.ts", browserTarget: true },
  );
  expect(result.diagnostics).toStrictEqual([]);
  const value = await importGenerated<
    {
      load: (first: boolean) => Promise<string>;
    },
    [string, string]
  >(
    result.code,
    {
      "first.mjs": 'export const value = "first";',
      "second.mjs": 'export const value = "second";',
    },
    (generated) => Promise.all([generated.load(true), generated.load(false)]),
  );
  expect(value).toStrictEqual(["first", "second"]);
});

test("finite lowering composes nested finite import operands", async () => {
  const result = compile(
    `export async function load(first: boolean) {
      const selected = await import(first ? "./a.mjs" : "./b.mjs");
      return import((selected.value ? "./c.mjs" : "./d.mjs"));
    }`,
    { filename: "import-expression-nested.ts", browserTarget: true },
  );
  expect(result.diagnostics).toStrictEqual([]);
  const value = await importGenerated<
    {
      load: (first: boolean) => Promise<{ value: string }>;
    },
    [string, string]
  >(
    result.code,
    {
      "a.mjs": "export const value = true;",
      "b.mjs": "export const value = false;",
      "c.mjs": 'export const value = "c";',
      "d.mjs": 'export const value = "d";',
    },
    async (generated) => [(await generated.load(true)).value, (await generated.load(false)).value],
  );
  expect(value).toStrictEqual(["c", "d"]);
});
