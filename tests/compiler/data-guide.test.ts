import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { compileProjectModules } from "../../packages/compiler/src/project-compilation.ts";

test("data guide examples pass authored checking and executable emission", async () => {
  const guide = await Bun.file(resolve(import.meta.dir, "../../docs/data.md")).text();
  const componentExamples = [...guide.matchAll(/```tsx\r?\n([\s\S]*?)```/gu)];
  const apiExamples = [...guide.matchAll(/```ts\r?\n([\s\S]*?)```/gu)].filter((match) =>
    match[1]?.includes("withAeolia"),
  );

  expect(apiExamples).toHaveLength(1);

  const findComponentExample = (marker: string): string => {
    const example = componentExamples.find((match) => match[1]?.includes(marker));

    expect(example).toBeDefined();

    return example![1]!;
  };

  const source = findComponentExample("AsyncBoundary");
  const taskSource = findComponentExample("function TaskButtons");
  const api = apiExamples[0]![1]!;
  const filename = "data-guide.tsx";
  const compiled = await compileProjectModules([
    { filename, source },
    { filename: "task-guide.tsx", source: taskSource },
    { filename: "api.ts", source: api },
  ]);

  expect(compiled.checking.diagnostics).toStrictEqual([]);

  expect(compiled.modules.get(filename)?.code).toContain("runAsyncBody");

  expect(compiled.modules.get("task-guide.tsx")?.code).toBeDefined();

  expect(compiled.modules.get("api.ts")?.code).toContain("withAeolia");

  const projectionExample = findComponentExample("function Activity");
  const streamApi = `import { createGraph, createStream, defineContract } from "aeolia";
import { withAeolia } from "hesperia/aeolia";
const events = createStream({
  name: "guide.events", key: (channel: string) => channel,
  open: async function* (_channel: string) { yield { kind: "view" }; },
});
const contract = defineContract({ namespace: "guide", operations: { activity: { events } } });
export const api = withAeolia(createGraph({ contract }), contract);`;
  const projected = await compileProjectModules([
    { filename: "stream-api.ts", source: streamApi },
    {
      filename: "activity-guide.tsx",
      source: `import { api } from "./stream-api.ts";\n${projectionExample}`,
    },
  ]);

  expect(projected.checking.diagnostics).toStrictEqual([]);

  expect(projected.modules.get("activity-guide.tsx")?.code).toContain("project");
});

test("public stream projection types preserve initialized values and stop chaining", async () => {
  const api = `import { createGraph, createStream, defineContract } from "aeolia";
import { withAeolia } from "hesperia/aeolia";
const events = createStream({
  name: "projection.events",
  key: (channel: string) => channel,
  open: async function* (_channel: string) { yield 1; },
});
const contract = defineContract({ namespace: "projection", operations: { events } });
const graph = createGraph({ contract });
export const api = withAeolia(graph, contract);
`;
  const valid = await compileProjectModules([
    { filename: "docs/projection-api.ts", source: api },
    {
      filename: "docs/projection-types.tsx",
      source: `import { api } from "./projection-api.ts";
export function App() {
  const events = api.events("all");
  const history = events.project({ kind: "accumulate", max: 4 });
  const total = events.project({ kind: "reduce", initial: 0, step: (sum, item) => sum + item });
  return <output>{history.value().join(",")}:{total.value().toFixed(0)}</output>;
}`,
    },
  ]);

  expect(valid.checking.diagnostics).toStrictEqual([]);

  const invalid = await compileProjectModules([
    { filename: "docs/projection-api.ts", source: api },
    {
      filename: "docs/projection-types.tsx",
      source: `import { api } from "./projection-api.ts";
export function App() {
  const events = api.events("all");
  const history = events.project({ kind: "accumulate", max: 4 });
  history.project({ kind: "accumulate", max: 2 });
  events.project({ kind: "reduce", initial: 0, step: (sum, item) => sum + item.toUpperCase() });
  return <output />;
}`,
    },
  ]);

  expect(invalid.checking.diagnostics.some((item) => item.message.includes("project"))).toBe(true);

  expect(invalid.checking.diagnostics.some((item) => item.message.includes("toUpperCase"))).toBe(
    true,
  );
});
