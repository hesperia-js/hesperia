import { expect, test } from "bun:test";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { compile } from "../../packages/compiler/src/index.ts";
import { analyzeModule } from "../../packages/compiler/src/compilation.ts";
import { Window } from "happy-dom";
import { mount, type Component } from "hesperia";

test("unsupported direct async iteration in a component fails at the authored loop", async () => {
  const source =
    "type Value = number;\r\nexport async function App() { for await (const value of []) {} return <span/>; }";
  const result = await compile(source, { filename: "component-iteration.tsx" });

  expect(result.code).toBe("");

  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({
      code: "HES-ASYNC-ITERATION",
      severity: "error",
      span: { start: source.indexOf("for await"), end: source.indexOf(" return") },
    }),
  );
});

test("an async helper declared inside an async component keeps native iteration", async () => {
  const result = await compile(
    `import { AsyncBoundary } from "hesperia";
    import { effect, state } from "hesperia/client";
    export const mounted = Promise.withResolvers<void>();
    async function Child() {
      async function sum() {
        let total = 0;
        for await (const value of [Promise.resolve(2), Promise.resolve(3)]) total += value;
        return await Promise.resolve(total);
      }
      const total = state(0);
      effect(() => { sum().then(value => { total.set(value); mounted.resolve(); }); });
      for (const item of [1]) { return <span>{total()}</span>; }
    }
    export function App() { return <AsyncBoundary fallback={<span>loading</span>}><Child/></AsyncBoundary>; }
  `,
    { filename: "nested-async-loop.tsx" },
  );

  expect(result.diagnostics).toStrictEqual([]);

  const generated = await importGenerated<{
    App: Component<Record<string, never>>;
    mounted: { promise: Promise<void> };
  }>(result.code);
  const window = new Window();
  const target = window.document.createElement("div");
  const application = mount(target as unknown as Element, generated.App, {});

  try {
    await generated.mounted.promise;

    await application.settled();

    expect(target.textContent).toBe("5");
  } finally {
    application.dispose();

    await window.happyDOM.close();
  }
});

test("loop labels have distinct identities and retain meaning when renamed", () => {
  const analyze = (first: string, second: string) =>
    analyzeModule(
      `export function evaluate() {
    ${first}: for (let index = 0; index < 2; index++) { break ${first}; }
    ${second}: while (true) { break ${second}; }
  }`,
      { filename: "labels.ts" },
    ).result;

  const original = analyze("first", "second");
  const renamed = analyze("outer", "another");

  expect(original.diagnostics).toStrictEqual([]);

  expect(renamed.diagnostics).toStrictEqual([]);

  expect(original.semanticHash).toBe(renamed.semanticHash);

  const declaration = original.ir.body[0];

  if (declaration?.kind !== "export" || declaration.declaration.kind !== "function")
    throw new Error("Expected exported function");

  const [first, second] = declaration.declaration.body.body;

  if (first?.kind !== "labeled" || second?.kind !== "labeled") throw new Error("Expected labels");

  expect(first.bindingId).not.toBe(second.bindingId);
});

test.each(["of", "in"])(
  "a loop's uninitialized lexical binding is visible on the right of for-%s",
  (operator) => {
    const result = analyzeModule(`const values = [1]; for (const values ${operator} values) {}`, {
      filename: "loop-tdz.ts",
    }).result;

    expect(result.diagnostics).toStrictEqual([]);

    const statement = result.ir.body[1];

    if (
      (statement?.kind !== "for-of" && statement?.kind !== "for-in") ||
      statement.left.kind !== "declaration" ||
      statement.left.pattern.kind !== "identifier" ||
      statement.right.kind !== "identifier"
    )
      throw new Error("Expected lexical loop");

    expect(statement.right.referenceId).toBe(statement.left.pattern.bindingId);
  },
);

async function importGenerated<T extends object>(code: string): Promise<T> {
  const directory = resolve(import.meta.dir, "../../.hesperia");

  await mkdir(directory, { recursive: true });

  const filename = join(directory, `loops-${randomUUID()}.mjs`);

  await writeFile(filename, code);

  try {
    return await import(pathToFileURL(filename).href);
  } finally {
    await unlink(filename);
  }
}

test("native loop forms preserve evaluation order and loop control", async () => {
  const result = await compile(
    `export function evaluate() {
      const events: string[] = [];
      let total = 0;
      const init = () => { events.push("init"); return 0; };
      const test = (i: number) => { events.push("test"); return i < 4; };
      const update = (i: number) => { events.push("update"); return i + 1; };
      for (let i = init(); test(i); i = update(i)) {
        if (i === 1) continue;
        if (i === 3) break;
        total += i;
      }
      const keys: string[] = [];
      for (const key in { a: 1, b: 2 }) keys.push(key);
      let remaining = 2;
      while (remaining > 0) remaining--;
      do total += 1; while (false);
      return [total, keys.join(","), events.join("|")];
    }`,
    { filename: "loops.ts" },
  );

  expect(result.diagnostics).toStrictEqual([]);

  const generated = await importGenerated<{
    evaluate: () => [number, string, string];
  }>(result.code);

  expect(generated.evaluate()).toStrictEqual([
    3,
    "a,b",
    "init|test|update|test|update|test|update|test",
  ]);
});

test("let loop bindings are per-iteration while var retains one binding", async () => {
  const result = await compile(
    `export function evaluate() {
      const letReaders: (() => number)[] = [];
      const varReaders: (() => number)[] = [];
      for (let i = 0; i < 3; i++) letReaders.push(() => i);
      for (var j = 0; j < 3; j++) varReaders.push(() => j);
      return [letReaders.map((read) => read()), varReaders.map((read) => read())];
    }`,
    { filename: "loop-bindings.ts" },
  );

  expect(result.diagnostics).toStrictEqual([]);

  const generated = await importGenerated<{
    evaluate: () => [number[], number[]];
  }>(result.code);

  expect(generated.evaluate()).toStrictEqual([
    [0, 1, 2],
    [3, 3, 3],
  ]);
});

test("labeled break and continue retain native targets", async () => {
  const result = await compile(
    `export function evaluate() {
      let value = 0;
      outer: for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          if (j === 0) continue;
          if (i === 1) break outer;
          value += i + j;
        }
      }
      return value;
    }`,
    { filename: "loop-labels.ts" },
  );

  expect(result.diagnostics).toStrictEqual([]);

  const generated = await importGenerated<{ evaluate: () => number }>(result.code);

  expect(generated.evaluate()).toBe(3);
});

test("async functions preserve native for-await-of semantics", async () => {
  const result = await compile(
    `export async function evaluate(values: AsyncIterable<number>) {
      let total = 0;
      for await (const value of values) total += value;
      return total;
    }`,
    { filename: "async-loops.ts" },
  );

  expect(result.diagnostics).toStrictEqual([]);

  const generated = await importGenerated<{
    evaluate: (values: AsyncIterable<number>) => Promise<number>;
  }>(result.code);

  async function* values() {
    yield 2;
    yield 5;
  }

  await expect(generated.evaluate(values())).resolves.toBe(7);
});
