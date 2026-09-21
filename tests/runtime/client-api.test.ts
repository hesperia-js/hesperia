import { afterEach, expect, test } from "bun:test";
import { createGraph, createMutation, createQuery, defineContract } from "aeolia";
import { Window } from "happy-dom";
import { withAeolia } from "../../src/aeolia/index.ts";
import { bindImported } from "../../src/data/api.ts";
import type { HesperiaContractApi } from "../../src/data/contract.ts";
import { element, defineComponent, mount } from "../../src/runtime/dom.ts";

const windows: Window[] = [];

afterEach(() => {
  for (const window of windows.splice(0)) window.close();
});

function target(): Element {
  const window = new Window();
  windows.push(window);
  return window.document.body as unknown as Element;
}

test("a direct imported API is owner-bound when a compiled component reads it", async () => {
  const responses: Array<(value: { name: string }) => void> = [];
  const query = createQuery({
    name: "imported-api.user",
    key: (id: string) => id,
    fetch: (id: string) =>
      new Promise<{ name: string }>((resolve) => {
        responses.push(() => resolve({ name: id }));
      }),
  });
  const mutation = createMutation({
    name: "imported-api.save",
    run: async (name: string) => ({ saved: name }),
    affects: [],
  });
  const contract = defineContract({
    namespace: "imported-api",
    operations: { user: { get: query }, save: mutation },
  });
  const graph = createGraph({ contract });
  const imported = withAeolia(graph, contract);
  let api!: HesperiaContractApi<typeof contract>;
  const App = defineComponent((owner) => {
    api = bindImported(owner, imported) as HesperiaContractApi<typeof contract>;
    return element(owner, "main");
  });

  const app = mount(target(), App, {});
  const view = api.user.get("ada");
  const ready = view.revalidate();
  for (const resolve of responses.splice(0)) resolve({ name: "Ada" });
  await ready;
  expect(view.value()).toStrictEqual({ name: "ada" });
  await expect(api.save().run("Ada")).resolves.toStrictEqual({ saved: "Ada" });

  app.dispose();
  expect(() => api.user.get("after-disposal")).toThrow("no longer active");
  expect(graph.api.user.get("ada")).toBeDefined();
  graph.dispose();
});

test("separate component roots receive isolated imported API projections over one graph", () => {
  const contract = defineContract({ namespace: "imported-api-isolation", operations: {} });
  const graph = createGraph({ contract });
  const imported = withAeolia(graph, contract);
  const apis: unknown[] = [];
  const App = defineComponent((owner) => {
    apis.push(bindImported(owner, imported));
    return element(owner, "main");
  });

  const first = mount(target(), App, {});
  const second = mount(target(), App, {});
  expect(apis).toHaveLength(2);
  expect(apis[0]).not.toBe(apis[1]);

  first.dispose();
  second.dispose();
  expect(graph.api).toBeDefined();
  graph.dispose();
});
