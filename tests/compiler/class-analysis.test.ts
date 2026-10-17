import { expect, test } from "bun:test";
import { analyzeBrowserCapabilities } from "../../packages/compiler/src/capability-analysis.ts";
import { analyzeModule } from "../../packages/compiler/src/compilation.ts";
import { validateComponentBindingReads } from "../../packages/compiler/src/body-validation.ts";

function capabilities(source: string) {
  return analyzeBrowserCapabilities(
    [
      {
        filename: "app.tsx",
        source:
          'import { value } from "./api.ts"; export default function App() { return <html><head/><body>{value}</body></html>; }',
      },
      { filename: "api.ts", source },
    ],
    ".",
  );
}

test.each([
  "class Unused extends process.env.Base {}",
  "class Unused { [process.env.NAME]() {} }",
  "class Unused { static value = process.env.SECRET; }",
  "class Unused { static { process.env.SECRET; } }",
])("unused classes still execute their definition-time work: %s", (declaration) => {
  expect(
    capabilities(`${declaration} export const value = 1;`).map((item) => item.code),
  ).toStrictEqual(["HES-CAPABILITY"]);
});

test.each([
  "class Unused { value = process.env.SECRET; }",
  "class Unused { method() { return process.env.SECRET; } }",
  "class Unused { constructor(value = process.env.SECRET) {} }",
])("unused class instance work stays deferred: %s", (declaration) => {
  expect(capabilities(`${declaration} export const value = 1;`)).toStrictEqual([]);
});

test.each([
  "export class value { field = process.env.SECRET; }",
  "export class value { method() { return process.env.SECRET; } }",
  "export class value { constructor(input = process.env.SECRET) {} }",
  "export const value = class { get read() { return process.env.SECRET; } };",
  "export class value { #read() { return process.env.SECRET; } read() { return this.#read(); } }",
])("a retained class exposes its instance capabilities: %s", (source) => {
  expect(capabilities(source).map((item) => item.code)).toStrictEqual(["HES-CAPABILITY"]);
});

test("a named class expression captures its own name independently of an outer host helper", () => {
  expect(
    capabilities(
      "const process = () => Bun.env.SECRET; export const value = class process { static read() { return process; } };",
    ),
  ).toStrictEqual([]);
});

test("static block var declarations do not overwrite outer capability provenance", () => {
  expect(
    capabilities(
      "var value = () => process.env.SECRET; class Unused { static { var value = () => 1; } } export { value };",
    ).map((item) => item.code),
  ).toStrictEqual(["HES-CAPABILITY"]);
});

test.each([
  "class Unused { static { const callback = () => process.env.SECRET; value = callback; } }",
  "const Unused = class { static { const callback = () => process.env.SECRET; value = callback; } };",
  "[class { static { const callback = () => process.env.SECRET; value = callback; } }];",
])("a callback escaping a static block retains its host capability: %s", (declaration) => {
  expect(
    capabilities(`let value; ${declaration} export { value };`).map((item) => item.code),
  ).toStrictEqual(["HES-CAPABILITY"]);
});

test.each([
  "class Value extends binding() {}",
  "class Value { [binding()]() {} }",
  "class Value { static value = binding(); }",
  "class Value { static { binding(); } }",
])("component-body class definitions cannot read a binding immediately: %s", (declaration) => {
  const analyzed = analyzeModule(
    `import { bind } from "hesperia/client"; function App() { const binding = bind(); ${declaration} return <span/>; }`,
    { filename: "class-bindings.tsx" },
  ).result;

  expect(analyzed.diagnostics.filter((item) => item.code !== "HES-BIND-BODY")).toStrictEqual([]);

  expect(validateComponentBindingReads(analyzed.ir).map((item) => item.code)).toStrictEqual([
    "HES-BIND-BODY",
  ]);
});

test.each(["class Value { field = binding(); }", "class Value { method() { return binding(); } }"])(
  "unconstructed class instance work is not an immediate binding read: %s",
  (declaration) => {
    const analyzed = analyzeModule(
      `import { bind } from "hesperia/client"; function App() { const binding = bind(); ${declaration} return <span/>; }`,
      { filename: "class-bindings.tsx" },
    ).result;

    expect(analyzed.diagnostics).toStrictEqual([]);

    expect(validateComponentBindingReads(analyzed.ir)).toStrictEqual([]);
  },
);
