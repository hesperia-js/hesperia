import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Window } from "happy-dom";
import { compile as compileModule } from "../../packages/compiler/src/index.ts";
import {
  asyncBoundary,
  component,
  defineComponent,
  mount,
  type Component,
} from "../../packages/hesperia/src/runtime/index.ts";

function compile(source: string, options: Parameters<typeof compileModule>[1]) {
  return compileModule(source, {
    ...options,
    runtimeModule: pathToFileURL(
      resolve(import.meta.dir, "../../packages/hesperia/src/runtime/index.ts"),
    ).href,
  });
}

async function renderBody(body: Component<Record<string, never>>): Promise<string> {
  const window = new Window();
  let resolveReady!: () => void;
  let rejectFault!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectFault = reject;
  });
  const App = defineComponent((owner) =>
    asyncBoundary(
      owner,
      "imports",
      () => "loading",
      (content) => component(content, body, {}, "body"),
      (installed) => void installed.then(resolveReady, rejectFault),
    ),
  );
  const app = mount(window.document.body as unknown as Element, App, {}, { onError: rejectFault });

  try {
    await ready;
    return window.document.body.textContent;
  } finally {
    app.dispose();

    await window.happyDOM.close();
  }
}

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

test.each([false, true])(
  "compiled components await direct imports and stored aliases (browser emission: %s)",
  async (browserTarget) => {
    const result = await compile(
      `export const stored = import("./dependency.mjs");
      const alias = stored;
      export async function Body() {
        const direct = await import("./dependency.mjs");
        const cached = await alias;
        return <output>{String(direct === cached)}:{cached.value}</output>;
      }`,
      { filename: "import-expression-body.tsx", browserTarget },
    );

    expect(result.diagnostics).toStrictEqual([]);

    await importGenerated<{ Body: Component<Record<string, never>> }, void>(
      result.code,
      { "dependency.mjs": "export const value = 23;" },
      async (generated) => {
        expect(await renderBody(generated.Body)).toBe("true:23");
      },
    );
  },
);

test.each([false, true])(
  "compiled component catch receives import rejection (browser emission: %s)",
  async (browserTarget) => {
    const result = await compile(
      `export async function Body() {
        let caught = false;
        try { await import("./missing.mjs"); } catch { caught = true; }
        return <output>{caught ? "caught" : "continued"}</output>;
      }`,
      { filename: "import-expression-rejection.tsx", browserTarget },
    );

    expect(result.diagnostics).toStrictEqual([]);

    await importGenerated<{ Body: Component<Record<string, never>> }, void>(
      result.code,
      {},
      async (generated) => {
        expect(await renderBody(generated.Body)).toBe("caught");
      },
    );
  },
);

test("compiled component catch receives finite import operand failures", async () => {
  const result = await compile(
    `export async function Body() {
      const events: string[] = [];
      try {
        await import((() => { throw new Error("source"); })() ? "./first.mjs" : "./second.mjs");
      } catch (error) { events.push(error.message); }
      try {
        await import(true ? "./first.mjs" : "./second.mjs", (() => { throw new Error("options"); })());
      } catch (error) { events.push(error.message); }
      try {
        await import((await import("./selector.mjs")).first ? "./first.mjs" : "./second.mjs", (() => { throw new Error("awaited-options"); })());
      } catch (error) { events.push(error.message); }
      return <output>{events.join(",")}</output>;
    }`,
    { filename: "import-expression-operand-failure.tsx", browserTarget: true },
  );

  expect(result.diagnostics).toStrictEqual([]);

  await importGenerated<{ Body: Component<Record<string, never>> }, void>(
    result.code,
    {
      "first.mjs": "export const value = 1;",
      "second.mjs": "export const value = 2;",
      "selector.mjs": "export const first = true;",
    },
    async (generated) => {
      expect(await renderBody(generated.Body)).toBe("source,options,awaited-options");
    },
  );
});

test.each([false, true])(
  "component import operand continuations retain lexical context (browser emission: %s)",
  async (browserTarget) => {
    const result = await compile(
      `export async function Body() {
        const ownThis = this;
        const ownArguments = arguments;
        const ownTarget = new.target;
        const loaded = await import(
          (await import("./selector.mjs")).first &&
          arguments === ownArguments &&
          (() => this === ownThis)() &&
          new.target === ownTarget &&
          (function(value) { return arguments[0] === value && this.enabled; }).call({ enabled: true }, 1)
            ? "./first.mjs" : "./second.mjs",
          (await import("./options.mjs")).default,
        );
        return <output>{loaded.value}</output>;
      }`,
      { filename: "import-expression-operand-context.tsx", browserTarget },
    );

    expect(result.diagnostics).toStrictEqual([]);

    await importGenerated<{ Body: Component<Record<string, never>> }, void>(
      result.code,
      {
        "selector.mjs": "export const first = true;",
        "options.mjs": "export default {};",
        "first.mjs": 'export const value = "first";',
        "second.mjs": 'export const value = "second";',
      },
      async (generated) => {
        expect(await renderBody(generated.Body)).toBe("first");
      },
    );
  },
);

test.each([
  [false, 'Promise.resolve("unregistered")'],
  [true, 'import("./first.mjs").then((value) => value)'],
  [false, 'import((await Promise.resolve(true)) ? "./first.mjs" : "./second.mjs")'],
  [true, 'import((await Promise.resolve(true)) ? "./first.mjs" : "./second.mjs")'],
  [true, 'import(true ? "./first.mjs" : "./second.mjs", await Promise.resolve({}))'],
])(
  "compiled component bodies reject unregistered waits (%s, %s)",
  async (browserTarget, waiting) => {
    const result = await compile(
      `export async function Body() {
      await ${waiting};
      return <output>continued</output>;
    }`,
      { filename: "import-expression-ordinary-promise.tsx", browserTarget },
    );

    expect(result.diagnostics).toStrictEqual([]);

    await importGenerated<{ Body: Component<Record<string, never>> }, void>(
      result.code,
      { "first.mjs": "export const value = 1;", "second.mjs": "export const value = 2;" },
      async (generated) => {
        await expect(renderBody(generated.Body)).rejects.toMatchObject({ kind: "render-await" });
      },
    );
  },
);

test("dynamic imports preserve native module caching and rejection", async () => {
  const result = await compile(
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
  const result = await compile(
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
  async () => {
    const first = await compile(`export function load(path: string) { return import(path); }`, {
      filename: "import-expression-identity.ts",
    });
    const renamed = await compile(
      `export function load(source: string) { return import(source); }`,
      {
        filename: "import-expression-identity.ts",
      },
    );
    const withOptions = await compile(
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
  const result = await compile(
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
  const result = await compile(
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
  const result = await compile(
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
  const result = await compile(
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
