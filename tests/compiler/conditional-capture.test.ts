import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Window } from "happy-dom";
import type { Component } from "hesperia";
import { mount } from "hesperia";
import { compile } from "../../packages/compiler/src/index.ts";

const applicationFixtureRoot = join(
  import.meta.dir,
  "fixtures/applications/conditional-capture/src",
);

async function importGenerated<T extends object>(code: string): Promise<T> {
  const directory = resolve(import.meta.dir, "../../.hesperia");

  await mkdir(directory, { recursive: true });

  const filename = join(directory, `conditional-capture-${randomUUID()}.mjs`);

  await writeFile(filename, code);

  try {
    return await import(pathToFileURL(filename).href);
  } finally {
    await unlink(filename);
  }
}

test("conditional native branches transport row captures through updates and keyed moves", async () => {
  const result = await compile(
    await readFile(join(applicationFixtureRoot, "row-updates-and-keyed-moves.tsx"), "utf8"),
    { filename: "conditional-capture.tsx" },
  );

  expect(result.diagnostics).toStrictEqual([]);

  expect(result.code).toContain("scope.row().label");

  const generated = await importGenerated<{ default: Component<Record<string, never>> }>(
    result.code,
  );

  const window = new Window();

  const target = window.document.createElement("div") as unknown as Element;

  const application = mount(target, generated.default, {});

  await application.settled();

  const first = target.querySelector('li[data-row="a"] span')!;

  const second = target.querySelector('li[data-row="b"] span')!;

  expect(first.textContent).toBe("A");

  expect(second.textContent).toBe("B");

  (target.querySelector("#toggle") as unknown as HTMLButtonElement).click();

  await application.settled();

  expect(target.querySelector('li[data-row="a"] span')).toBeNull();

  expect(target.querySelector('li[data-row="b"] span')).toBe(second);

  (target.querySelector("#reorder") as unknown as HTMLButtonElement).click();

  await application.settled();

  expect([...target.querySelectorAll("li")].map((item) => item.dataset.row)).toStrictEqual([
    "b",
    "a",
  ]);

  expect(target.querySelector('li[data-row="b"] span')).toBe(second);

  expect(target.querySelector('li[data-row="a"] span')?.textContent).toBe("A");

  application.dispose();

  window.close();
});

test("nested map callbacks with the same parameter spelling keep conditional captures distinct", async () => {
  const result = await compile(
    await readFile(join(applicationFixtureRoot, "nested-same-name-captures.tsx"), "utf8"),
    { filename: "nested-conditional-capture.tsx" },
  );

  expect(result.diagnostics).toStrictEqual([]);

  const generated = await importGenerated<{ default: Component<Record<string, never>> }>(
    result.code,
  );

  const window = new Window();

  const target = window.document.createElement("div") as unknown as Element;

  const application = mount(target, generated.default, {});

  await application.settled();

  expect(target.querySelector('[data-group="g"] [data-item="i"] b')?.textContent).toBe("inner");

  application.dispose();

  window.close();
});
