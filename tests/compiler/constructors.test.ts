import { expect, test } from "bun:test";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Window } from "happy-dom";
import { mount, type Component } from "hesperia";
import { compile, analyzeRouteModule } from "../../packages/compiler/src/index.ts";

async function importGenerated<T extends object>(code: string): Promise<T> {
  const directory = resolve(import.meta.dir, "../../.hesperia");

  await mkdir(directory, { recursive: true });

  const filename = join(directory, `constructors-${randomUUID()}.mjs`);

  await writeFile(filename, code);

  try {
    return await import(pathToFileURL(filename).href);
  } finally {
    await unlink(filename);
  }
}

test("constructors preserve native instances and alpha-stable captured lookup", async () => {
  const source = [
    "const Constructor = Error;",
    "export function make(message: string) { return new Constructor(message); }",
  ].join("\n");
  const renamed = source.replaceAll("Constructor", "Factory");
  const result = await compile(source, { filename: "constructors.ts" });
  const renamedResult = await compile(renamed, { filename: "constructors-renamed.ts" });

  expect(result.diagnostics).toEqual([]);

  expect(renamedResult.diagnostics).toEqual([]);

  expect(result.semanticHash).toBe(renamedResult.semanticHash);

  const generated = await importGenerated<{ make: (message: string) => Error }>(result.code);
  const error = generated.make("constructed");

  expect(error).toBeInstanceOf(Error);

  expect(error.message).toBe("constructed");
});

test("route dependency analysis traverses constructor callees and arguments", () => {
  const source = [
    'import { route } from "hesperia/routing";',
    'import { Stats } from "node:fs";',
    "const guard = () => new Stats().isFile();",
    "export default route({ guard });",
  ].join("\n");
  const result = analyzeRouteModule(source, { filename: "src/routes/+route.ts" });

  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({
      code: "HES-ROUTE-CAPABILITY",
      message: "Route guard imports server capability node:fs.",
    }),
  );

  expect(result.artifact).toBeUndefined();
});

test("constructor arguments cannot hide component binding reads", async () => {
  const source = [
    'import { client } from "hesperia";',
    "export default function App() {",
    "  const field = client.bind<HTMLInputElement>();",
    "  return <div>{new Error(field().value).message}</div>;",
    "}",
  ].join("\n");
  const result = await compile(source, { filename: "constructor-binding.tsx" });

  expect(result.code).toBe("");

  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({ code: "HES-BIND-BODY", severity: "error" }),
  );
});

test("unsupported constructor arguments fail closed", async () => {
  for (const argument of ["<span />", "() => <span />"]) {
    const result = await compile(`const value = new Error(${argument});`, {
      filename: "constructor-jsx.tsx",
    });

    expect(result.code).toBe("");

    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "HES-NEW", severity: "error" }),
    );
  }
});

test("retained keyed rows re-evaluate constructor arguments in their captured scope", async () => {
  const result = await compile(
    [
      'import * as client from "hesperia/client";',
      "export default function App() {",
      '  const prefix = client.state("A");',
      '  const rows = client.state([{ id: "one", label: "first" }]);',
      '  const update = () => { prefix.set("B"); rows.set([{ id: "one", label: "second" }]); };',
      '  return <><button id="update" on:click={update}>update</button><ul>{rows().map((row) => <li key={row.id}>{new Error(prefix() + ":" + row.label).message}</li>)}</ul></>;',
      "}",
    ].join("\n"),
    { filename: "constructor-list.tsx" },
  );

  expect(result.diagnostics).toEqual([]);

  const generated = await importGenerated<{ default: Component<Record<string, never>> }>(
    result.code,
  );
  const window = new Window();

  try {
    const target = window.document.createElement("div") as unknown as Element;
    const application = mount(target, generated.default, {});

    await application.settled();

    const row = target.querySelector("li")!;

    expect(row.textContent).toBe("A:first");

    (target.querySelector("#update") as unknown as HTMLButtonElement).click();

    await application.settled();

    expect(target.querySelector("li")).toBe(row);

    expect(row.textContent).toBe("B:second");

    application.dispose();
  } finally {
    window.close();
  }
});
