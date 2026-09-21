import { expect, test } from "bun:test";
import { checkProjectModules } from "../../src/compiler/checking.ts";

test("component callee diagnostics underline the authored name without a reversed range", () => {
  const source =
    'const emoji = "🐈";\r\nconst Broken = 1;\r\nexport function App() { return <Broken label="bad" />; }';
  const result = checkProjectModules([{ filename: "broken-component.tsx", source }]);
  const diagnostic = result.diagnostics.find((item) => item.code === "TS2769");
  expect(diagnostic).toBeDefined();
  expect(diagnostic?.span).toStrictEqual({
    start: source.lastIndexOf("Broken"),
    end: source.lastIndexOf("Broken") + "Broken".length,
  });
});

test("generic component calls infer value types from authored incoming props", () => {
  const source = `import { type Component } from "hesperia";
    function Echo<T>(props: Component.Props<{ value: T }>) {
      return <span>{String(props.value())}</span>;
    }
    export function App() { return <Echo value="text" />; }
  `;
  expect(
    checkProjectModules([{ filename: "inferred-component.tsx", source }]).diagnostics,
  ).toStrictEqual([]);
});
