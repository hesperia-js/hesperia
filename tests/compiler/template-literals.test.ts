import { expect, test } from "bun:test";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Window } from "happy-dom";
import { mount, type Component } from "hesperia";
import { analyzeRouteModule, compile } from "../../src/compiler/index.ts";

async function importGenerated<T extends object>(code: string): Promise<T> {
  const directory = resolve(import.meta.dir, "../../.hesperia");
  await mkdir(directory, { recursive: true });
  const filename = join(directory, `template-${randomUUID()}.mjs`);
  await writeFile(filename, code);
  try {
    return await import(pathToFileURL(filename).href);
  } finally {
    await unlink(filename);
  }
}

test("untagged templates preserve cooked escapes, left-to-right evaluation, and reactive reads", async () => {
  const source = [
    'import { client } from "hesperia/client";',
    "export const events: string[] = [];",
    "function read(label: string) { events.push(label); return label; }",
    "export default function App() {",
    "  const count = client.state(1);",
    '  const value = `\\u0061${read("first")}\\n${read("second")}`;',
    "  return <button on:click={() => count.set(count() + 1)}>{`${value}:${count()}`}</button>;",
    "}",
  ].join("\n");
  const result = compile(source, { filename: "templates.tsx" });
  expect(result.diagnostics).toEqual([]);
  expect(result.code).toContain("u0061");
  const generated = await importGenerated<{
    default: Component;
    events: string[];
  }>(result.code);
  const window = new Window();
  try {
    const target = window.document.body as unknown as Element;
    const application = mount(target, generated.default, {});
    await application.settled();
    expect(generated.events).toStrictEqual(["first", "second"]);
    const button = target.firstElementChild as HTMLButtonElement;
    expect(button.textContent).toBe("afirst\nsecond:1");
    button.click();
    await application.settled();
    expect(button.textContent).toBe("afirst\nsecond:2");
    application.dispose();
  } finally {
    window.close();
  }
});

test("tagged templates remain an explicit unsupported expression", () => {
  const result = compile(
    'const tag = (value: TemplateStringsArray) => value[0] ?? ""; export default function App(){ return <output>{tag`x`}</output>; }',
    { filename: "tagged-template.tsx" },
  );
  expect(result.code).toBe("");
  expect(result.diagnostics.some((item) => item.code === "HES-EXPRESSION")).toBe(true);
});

test("interpolation cannot hide component-body binding reads or server-only guard dependencies", () => {
  const bindingSource = [
    'import { bind } from "hesperia/client";',
    "export default function App() {",
    "  const input = bind<HTMLInputElement>();",
    "  const title = `${input()}`;",
    "  return <input bind={input} title={title} />;",
    "}",
  ].join("\n");
  const binding = compile(bindingSource, { filename: "template-binding.tsx" });
  expect(binding.code).toBe("");
  expect(binding.diagnostics).toContainEqual(
    expect.objectContaining({
      code: "HES-BIND-BODY",
      span: { start: bindingSource.indexOf("input()"), end: bindingSource.indexOf("input()") + 7 },
    }),
  );

  const guard = analyzeRouteModule(
    [
      'import { route } from "hesperia/routing";',
      'import fs from "node:fs";',
      'const guard = () => `${fs.existsSync("/private")}` === "true";',
      "export default route({ guard });",
    ].join("\n"),
    { filename: "src/routes/+route.ts" },
  );
  expect(guard.artifact).toBeUndefined();
  expect(guard.diagnostics).toContainEqual(
    expect.objectContaining({ code: "HES-ROUTE-CAPABILITY" }),
  );
});

test("untagged templates use native object coercion and reject Symbols", async () => {
  const source = [
    'import { client } from "hesperia/client";',
    "export default function App() {",
    '  const object = { toString: () => "object", valueOf: () => 7 };',
    "  return <output>{`value:${object}`}</output>;",
    "}",
  ].join("\n");
  const result = compile(source, { filename: "template-coercion.tsx" });
  expect(result.diagnostics).toEqual([]);
  const generated = await importGenerated<{ default: Component }>(result.code);
  const window = new Window();
  try {
    const target = window.document.body as unknown as Element;
    const application = mount(target, generated.default, {});
    await application.settled();
    expect(target.textContent).toBe("value:object");
    application.dispose();
  } finally {
    window.close();
  }

  const symbolResult = compile(
    [
      'import { client } from "hesperia/client";',
      "export default function App() {",
      '  const value = Symbol("value");',
      "  return <output>{`${value}`}</output>;",
      "}",
    ].join("\n"),
    { filename: "template-symbol.tsx" },
  );
  expect(symbolResult.diagnostics).toEqual([]);
  const symbolGenerated = await importGenerated<{ default: Component }>(symbolResult.code);
  const symbolWindow = new Window();
  try {
    const target = symbolWindow.document.body as unknown as Element;
    expect(() => mount(target, symbolGenerated.default, {})).toThrow(TypeError);
  } finally {
    symbolWindow.close();
  }
});
