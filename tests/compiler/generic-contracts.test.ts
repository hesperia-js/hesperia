import { expect, test } from "bun:test";
import { checkProjectModules } from "../../src/compiler/checking.ts";

function diagnostics(source: string) {
  return checkProjectModules([{ filename: "generic-contract.tsx", source }]).diagnostics;
}

function expectComponentCallError(source: string, message: string): void {
  const result = diagnostics(source);
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({ code: "TS2769", severity: "error" });
  expect(result[0]?.message).toContain(message);
}

test("inferred generic value and callback components retain their caller contracts", () => {
  const source = `
    import { type Component } from "hesperia";
    function Echo<T>(props: Component.Props<{ value: T }>) {
      return <span>{String(props.value())}</span>;
    }
    function Callback<T>(props: Component.Props<{ done: T }>) {
      return <span>{String(props.done())}</span>;
    }
    const callback = () => "done";
    export function App() {
      return <main><Echo value="text" /><Callback done={callback} /></main>;
    }
  `;
  expect(diagnostics(source)).toStrictEqual([]);
});

test("concrete component contracts reject excess properties", () => {
  expectComponentCallError(
    `
      import { type Component } from "hesperia";
      function Child(props: Component.Props<{ value: string }>) {
        return <span>{props.value()}</span>;
      }
      export function App() {
        return <Child value="ok" extra="unexpected" />;
      }
    `,
    '"extra"',
  );
});

test("concrete component contracts reject an invalid callback", () => {
  expectComponentCallError(
    `
      import { type Component } from "hesperia";
      function Child(props: Component.Props<{ done: () => string }>) {
        return <span>{props.done()}</span>;
      }
      export function App() {
        return <Child done="not callable" />;
      }
    `,
    "() => string",
  );
});

test("concrete component contracts reject an incompatible binding", () => {
  expectComponentCallError(
    `
      import { type Component } from "hesperia";
      import * as client from "hesperia/client";
      type Output = { read(): string };
      function Child(props: Component.Props<{ bind: Output }>) {
        return <span />;
      }
      export function App() {
        const wrong = client.bind<{ other(): number }>();
        return <Child bind={wrong} />;
      }
    `,
    "Binding",
  );
});

test("generic component contracts preserve correlated and constrained types", () => {
  expectComponentCallError(
    `
      import { type Component } from "hesperia";
      function Pair<T>(props: Component.Props<{ value: T; other: T }>) {
        return <span>{String(props.value())}</span>;
      }
      export function App() {
        return <Pair value="text" other={1} />;
      }
    `,
    "other",
  );
  expectComponentCallError(
    `
      import { type Component } from "hesperia";
      function Text<T extends string>(props: Component.Props<{ value: T }>) {
        return <span>{props.value()}</span>;
      }
      export function App() {
        return <Text value={1} />;
      }
    `,
    "string",
  );
});

test("explicit component type arguments constrain caller values", () => {
  const prefix = `
    import { type Component } from "hesperia";
    function Echo<T>(props: Component.Props<{ value: T }>) {
      return <span>{String(props.value())}</span>;
    }
    export function App() {
      return `;
  expectComponentCallError(`${prefix}<Echo<number> value="wrong" />; }`, "number");
  expect(diagnostics(`${prefix}<Echo<number> value={1} />; }`)).toStrictEqual([]);
});
