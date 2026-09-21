import { expect, test } from "bun:test";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Window } from "happy-dom";
import { compile } from "../../src/compiler/index.ts";
import { mount } from "../../src/runtime/dom.ts";

const fixtureDirectory = resolve(import.meta.dir, "../../.hesperia");

async function writeFixture(name: string, source: string): Promise<string> {
  await mkdir(fixtureDirectory, { recursive: true });
  const filename = join(fixtureDirectory, `${name}-${randomUUID()}.ts`);
  await writeFile(filename, source);
  return filename;
}

async function importGenerated<T extends object>(code: string): Promise<T> {
  await mkdir(fixtureDirectory, { recursive: true });
  const filename = join(fixtureDirectory, `imported-api-${randomUUID()}.mjs`);
  await writeFile(filename, code);
  try {
    return await import(pathToFileURL(filename).href);
  } finally {
    await unlink(filename);
  }
}

test("direct imported values are preserved while component references bind through the owner", () => {
  const result = compile(
    `import api, { helper as named } from "./api";
import * as tools from "./tools";
export function App() {
  const user = api.users.get("ada");
  return <main>{user.value()}:{named()}:{tools.value}</main>;
}`,
    { filename: "imported-api.tsx" },
  );

  expect(result.diagnostics).toStrictEqual([]);
  expect(result.code).toContain('import api, { helper as named } from "./api";');
  expect(result.code).toContain('import * as tools from "./tools";');
  expect(result.code).toContain("_$.bindImported(owner, api)");
  expect(result.code).toContain("_$.bindImported(owner, named)");
  expect(result.code).toContain("_$.bindImported(owner, tools");
});

test("a compiled component consumes a public adapted API while ordinary namespace values stay live", async () => {
  const apiFile = await writeFixture(
    "api",
    `import { createGraph, createMutation, createQuery, defineContract } from "aeolia";
import { withAeolia } from "../src/aeolia/index.ts";
export const queryResolvers = [];
export const saveCalls = [];
export const activeTasks = [];
export let currentLabel = "before";
export const native = { value: "before", method() { return this.value; } };
export class Box { constructor(value) { this.value = value; } }
export let renderCount = 0;
export const recordRender = () => { renderCount++; };
export const registerTask = (task) => { activeTasks.push(task); };
const user = createQuery({ name: "fixture.user", key: (id) => id, fetch: (id) => new Promise((resolve) => queryResolvers.push(resolve)) });
const save = createMutation({ name: "fixture.save", run: async (name) => { saveCalls.push(name); return { saved: name }; }, affects: [] });
export const contract = defineContract({ namespace: "fixture", operations: { user: { get: user }, save } });
export const graph = createGraph({ contract });
export const api = withAeolia(graph, contract);
export default api;
`,
  );
  const componentFile = await writeFixture(
    "component",
    `import defaultApi, { api as namedApi, recordRender, registerTask } from "./${apiFile.split(/[\\/]/).pop()}";
import * as modules from "./${apiFile.split(/[\\/]/).pop()}";
import { client } from "hesperia";
export default function App() {
  recordRender();
  const user = namedApi.user.get("ada");
  const save = defaultApi.save();
  const task = client.task(({ signal }) => async (name) => {
    const result = await user;
    const saved = await save.run(name, { abortSignal: signal });
    return result().name + ":" + saved.saved;
  });
  registerTask(task);
  return <button>{modules.native.method()}:{new modules.Box("box").value}:{task.value() ?? "idle"}</button>;
}`,
  );
  const shimFile = await writeFixture(
    "runtime-shim",
    `export { attribute, child, component, componentItem, defineComponent, dynamic, element, region, text } from "../src/runtime/dom.ts";
export { nativeItem } from "../src/runtime/structure.ts";
export { asyncBoundary, awaitComponent, runAsyncBody } from "../src/runtime/async.ts";
export { rawHTML } from "../src/runtime/raw.ts";
export { createClient } from "../src/client.ts";
export { bindImported } from "../src/data/api.ts";
export { registerDeparture } from "../src/routing/navigation.ts";
`,
  );
  try {
    const componentSource = await Bun.file(componentFile).text();
    const result = compile(componentSource, {
      filename: "component.tsx",
      runtimeModule: pathToFileURL(shimFile).href,
    });
    expect(result.diagnostics).toStrictEqual([]);
    const module = await importGenerated<{ default: (props: object) => unknown }>(result.code);
    const apiModule = await import(pathToFileURL(apiFile).href);
    const window = new Window();
    try {
      const first = mount(window.document.body as unknown as Element, module.default as never, {});
      const button = window.document.body.firstElementChild as unknown as HTMLButtonElement;
      await first.settled();
      expect(button.textContent).toBe("before:box:idle");
      expect(apiModule.currentLabel).toBe("before");
      const firstTask = apiModule.activeTasks[0];
      const firstRun = firstTask.run("Grace");
      expect(apiModule.queryResolvers).toHaveLength(1);
      const secondTarget = window.document.createElement("section");
      window.document.body.append(secondTarget);
      const second = mount(secondTarget as unknown as Element, module.default as never, {});
      await second.settled();
      const secondButton = secondTarget.firstElementChild as unknown as HTMLButtonElement;
      const secondTask = apiModule.activeTasks[1];
      const secondRun = secondTask.run("Grace");
      expect(apiModule.queryResolvers).toHaveLength(1);
      first.dispose();
      await expect(firstRun).rejects.toHaveProperty("kind", "cancelled");
      apiModule.queryResolvers.shift()!({ name: "Ada" });
      await expect(secondRun).resolves.toBe("Ada:Grace");
      expect(apiModule.saveCalls).toStrictEqual(["Grace"]);
      expect(secondButton.textContent).toBe("before:box:Ada:Grace");
      expect(apiModule.currentLabel).toBe("before");
      expect(apiModule.renderCount).toBe(2);
      second.dispose();
      apiModule.graph.dispose();
    } finally {
      window.close();
    }
  } finally {
    await Promise.all([unlink(apiFile), unlink(componentFile), unlink(shimFile)]);
  }
});
