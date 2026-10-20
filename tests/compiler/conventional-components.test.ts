import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Window } from "happy-dom";
import { mount, type Component } from "hesperia";
import { compile } from "../../packages/compiler/src/index.ts";
import { startProcessDiagnostics } from "../tooling/fixtures/drivers/process-diagnostics.mjs";

async function importGenerated<T extends object>(code: string): Promise<T> {
  const directory = resolve(import.meta.dir, "../../.hesperia", `conventional-${randomUUID()}`);

  await mkdir(directory, { recursive: true });

  const filename = join(directory, "module.mjs");

  await writeFile(filename, code);

  try {
    return (await import(pathToFileURL(filename).href)) as T;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("conventional default route functions are components even when they throw", async () => {
  const tryDiagnostics = <T>(run: () => T): T | undefined => {
    try {
      return run();
    } catch {
      return undefined;
    }
  };
  const diagnostics = tryDiagnostics(() =>
    startProcessDiagnostics({
      directory: resolve(
        import.meta.dir,
        "../../.hesperia/browser-diagnostics",
        `conventional-components-${randomUUID()}`,
      ),
      label: "bun-parent",
    }),
  );

  const mark = (phase: string, detail?: unknown): void => {
    tryDiagnostics(() => diagnostics?.mark(phase, detail));
  };

  mark("case-start");

  try {
    mark("compile-start");

    const result = await compile(
      `export default function Broken() {
      throw new Error("route failed");
    }
    export function helper() { return "ordinary"; }`,
      { filename: "src/routes/+error.tsx" },
    );

    mark("compile-complete");

    expect(result.diagnostics).toStrictEqual([]);

    expect([...result.semantics.components]).toStrictEqual(["Broken"]);

    mark("generated-import-start");

    const generated = await importGenerated<{
      default: Component;
      helper: () => string;
    }>(result.code);

    mark("generated-import-complete");

    expect(generated.helper()).toBe("ordinary");

    mark("window-create-start");

    const window = new Window();

    mark("window-create-complete");

    const errors: Error[] = [];

    mark("mount-start");

    const application = mount(
      window.document.body as unknown as Element,
      generated.default,
      {},
      {
        onError: (error) => errors.push(error instanceof Error ? error : new Error(String(error))),
      },
    );

    mark("mount-complete");

    mark("settled-start");

    await application.settled();

    mark("settled-complete");

    expect(errors[0]?.message).toBe("route failed");

    mark("application-dispose-start");

    application.dispose();

    mark("application-dispose-complete");

    mark("window-close-start");

    await window.happyDOM.close();

    mark("window-close-complete");

    mark("case-complete");
  } catch (error) {
    mark("case-failed", { error });

    throw error;
  } finally {
    tryDiagnostics(() => diagnostics?.dispose());
  }
});

test("conventional default aliases are components while ordinary helpers stay ordinary", async () => {
  const result = await compile(
    `const Page = () => null;
    const helper = () => null;
    export default Page;
    export { helper };`,
    { filename: "src/routes/+page.tsx" },
  );

  expect(result.diagnostics).toStrictEqual([]);

  expect([...result.semantics.components]).toStrictEqual(["Page"]);

  const generated = await importGenerated<{
    default: Component;
    helper: () => null;
  }>(result.code);

  expect(generated.helper()).toBeNull();

  expect(() => generated.default({} as never)).toThrow("Components must be reached through JSX");
});

test("conventional direct default arrows and function expressions are registered components", async () => {
  for (const [filename, source] of [
    ["src/routes/+loading.tsx", "export default () => null;"],
    ["+loading.tsx", "export default () => null;"],
    ["src/routes/+not-found.tsx", "export default (function Missing() { return null; });"],
  ] as const) {
    const result = await compile(source, { filename });

    expect(result.diagnostics).toStrictEqual([]);

    const generated = await importGenerated<{ default: Component }>(result.code);

    expect(() => generated.default({} as never)).toThrow("Components must be reached through JSX");
  }
}, 30000);

test("conventional default sequence expressions mark and render their final component once", async () => {
  const result = await compile(
    `export const events: string[] = [];
export default (events.push("prefix"), () => { events.push("render"); return null; });`,
    { filename: "src/routes/+page.tsx" },
  );

  expect(result.diagnostics).toStrictEqual([]);

  const generated = await importGenerated<{ default: Component; events: string[] }>(result.code);

  expect(generated.events).toStrictEqual(["prefix"]);

  expect(() => generated.default({} as never)).toThrow("Components must be reached through JSX");

  expect(generated.events).toStrictEqual(["prefix"]);

  const window = new Window();
  const application = mount(window.document.body as unknown as Element, generated.default, {});

  try {
    await application.settled();

    expect(generated.events).toStrictEqual(["prefix", "render"]);
  } finally {
    application.dispose();

    await window.happyDOM.close();
  }
});

for (const source of [
  "function Page() { return null; } export default Page;",
  "function Page() { return null; } const Selected = Page; export default Selected;",
  "export const Page = () => null; export default Page;",
  "function Page() { return null; } export { Page as default };",
]) {
  test(`conventional defaults retain component identity through declarations: ${source}`, async () => {
    const result = await compile(source, { filename: "src/routes/+page.tsx" });

    expect(result.diagnostics).toStrictEqual([]);

    const generated = await importGenerated<{ default: Component }>(result.code);

    expect(() => generated.default({} as never)).toThrow("Components must be reached through JSX");

    const window = new Window();
    const errors: unknown[] = [];
    const application = mount(
      window.document.body as unknown as Element,
      generated.default,
      {},
      {
        onError: (error) => errors.push(error),
      },
    );

    await application.settled();

    expect(errors).toStrictEqual([]);

    expect(window.document.body.textContent).toBe("");

    application.dispose();

    await window.happyDOM.close();
  });
}

test("trusted component prop types identify null-returning components outside route conventions", async () => {
  const result = await compile(
    `import type { Component as C } from "hesperia";
export function Empty(_props: C.Props<{}>) { return null; }
export const EmptyArrow = (_props: C.Props<{}>) => null;
type Props<T> = T;
export function ordinary(_props: Props<{}>) { return null; }`,
    { filename: "empty-components.tsx" },
  );

  expect(result.diagnostics).toStrictEqual([]);

  const generated = await importGenerated<{
    Empty: Component;
    EmptyArrow: Component;
    ordinary: (props: object) => null;
  }>(result.code);

  expect(() => generated.Empty({} as never)).toThrow("Components must be reached through JSX");

  expect(() => generated.EmptyArrow({} as never)).toThrow("Components must be reached through JSX");

  expect(generated.ordinary({})).toBeNull();
});
