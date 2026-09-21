import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { compileProjectModules } from "../../src/compiler/project-compilation.ts";

test("data guide examples pass authored checking and executable emission", async () => {
  const guide = await Bun.file(resolve(import.meta.dir, "../../docs/data.md")).text();
  const componentExamples = [...guide.matchAll(/```tsx\r?\n([\s\S]*?)```/gu)];
  const apiExamples = [...guide.matchAll(/```ts\r?\n([\s\S]*?)```/gu)].filter((match) =>
    match[1]?.includes("withAeolia"),
  );
  expect(componentExamples).toHaveLength(2);
  expect(apiExamples).toHaveLength(1);
  const source = componentExamples.find((match) => match[1]?.includes("AsyncBoundary"))![1]!;
  const api = apiExamples[0]![1]!;
  const filename = "data-guide.tsx";
  const compiled = compileProjectModules([
    { filename, source },
    { filename: "api.ts", source: api },
  ]);
  expect(compiled.checking.diagnostics).toStrictEqual([]);
  expect(compiled.modules.get(filename)?.code).toContain("runAsyncBody");
  expect(compiled.modules.get("api.ts")?.code).toContain("withAeolia");

  const projectionExample = componentExamples.find((match) =>
    match[1]?.includes("function Activity"),
  )![1]!;
  const streamApi = `import { createGraph, createStream, defineContract } from "aeolia";
import { withAeolia } from "hesperia/aeolia";
const events = createStream({
  name: "guide.events", key: (channel: string) => channel,
  open: async function* (_channel: string) { yield { kind: "view" }; },
});
const contract = defineContract({ namespace: "guide", operations: { activity: { events } } });
export const api = withAeolia(createGraph({ contract }), contract);`;
  const projected = compileProjectModules([
    { filename: "stream-api.ts", source: streamApi },
    {
      filename: "activity-guide.tsx",
      source: `import { api } from "./stream-api.ts";\n${projectionExample}`,
    },
  ]);
  expect(projected.checking.diagnostics).toStrictEqual([]);
  expect(projected.modules.get("activity-guide.tsx")?.code).toContain("project");
});

test("public stream projection types preserve initialized values and stop chaining", () => {
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
  const valid = compileProjectModules([
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

  const invalid = compileProjectModules([
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
