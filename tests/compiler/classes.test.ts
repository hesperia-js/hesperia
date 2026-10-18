import { expect, test } from "bun:test";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { compile } from "../../packages/compiler/src/index.ts";

const classFixtures = join(import.meta.dir, "fixtures/applications/classes");

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
  const result = await compile(await readFile(join(classFixtures, "inheritance.ts"), "utf8"), {
    filename: "classes-inheritance.ts",
  });

  expect(result.diagnostics).toStrictEqual([]);

  const generated = await importGenerated<{
    evaluate: () => [number, number, string, boolean, boolean];
  }>(result.code);

  expect(generated.evaluate()).toStrictEqual([3, 4, "Child", true, true]);
});

test("class definition order separates computed keys and static work from instance fields", async () => {
  const result = await compile(await readFile(join(classFixtures, "definition-order.ts"), "utf8"), {
    filename: "classes-order.ts",
  });

  expect(result.diagnostics).toStrictEqual([]);

  const generated = await importGenerated<{
    evaluate: () => [string, string, number, number, number];
  }>(result.code);

  expect(generated.evaluate()).toStrictEqual(["key,key,static", "key,key,static,field", 4, 9, 7]);
});

test("static blocks run at definition time before later static fields", async () => {
  const result = await compile(await readFile(join(classFixtures, "static-block.ts"), "utf8"), {
    filename: "classes-static-block.ts",
  });

  expect(result.diagnostics).toStrictEqual([]);

  const generated = await importGenerated<{ value: [string, number] }>(result.code);

  expect(generated.value).toStrictEqual(["block,static", 2]);
});

test("private names remain class-local across inheritance", async () => {
  const result = await compile(
    await readFile(join(classFixtures, "private-inheritance.ts"), "utf8"),
    { filename: "classes-private.ts" },
  );

  expect(result.diagnostics).toStrictEqual([]);

  const generated = await importGenerated<{ evaluate: () => number }>(result.code);

  expect(generated.evaluate()).toBe(5);
});

test("named class expressions keep their lexical name while capturing an outer value", async () => {
  const result = await compile(await readFile(join(classFixtures, "named-expression.ts"), "utf8"), {
    filename: "classes-expression.ts",
  });

  expect(result.diagnostics).toStrictEqual([]);

  const generated = await importGenerated<{
    make: (value: string) => new () => { read(): string };
  }>(result.code);

  expect(new (generated.make("captured"))().read()).toBe("Named:captured");
});

test("class declarations keep their inner name and private identities stable across renames", async () => {
  const first = await compile(await readFile(join(classFixtures, "identity-alpha.ts"), "utf8"), {
    filename: "classes-identity.ts",
  });

  const renamed = await compile(await readFile(join(classFixtures, "identity-beta.ts"), "utf8"), {
    filename: "classes-identity.ts",
  });

  expect(first.diagnostics).toStrictEqual([]);

  expect(renamed.diagnostics).toStrictEqual([]);

  expect(first.semanticHash).toBe(renamed.semanticHash);

  const generated = await importGenerated<{
    evaluate: () => [boolean, string, number];
  }>(first.code);

  expect(generated.evaluate()).toStrictEqual([true, "Alpha", 1]);
});
