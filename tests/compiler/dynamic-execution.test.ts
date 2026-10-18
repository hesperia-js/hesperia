import { expect, test } from "bun:test";
import { analyzeBrowserCapabilities } from "../../packages/compiler/src/capability-analysis.ts";

function check(source: string) {
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
  'export const value = eval("1");',
  'export const value = new Function("return 1")();',
  'export const value = Function("return 1")();',
  'const execute = eval; export const value = execute("1");',
  'const Construct = Function; export const value = new Construct("return 1")();',
  'export const value = globalThis.eval("1");',
  'export const value = window["Function"]("return 1")();',
  'export const value = self.eval("1");',
  'export const value = Function.bind(null, "return 1")();',
  'export const value = Function.prototype.constructor("return 1")();',
  'export const value = globalThis["Function"]["prototype"]["constructor"]("return 1")();',
  'const C = Function.prototype.constructor; export const value = C("return 1")();',
  'const holder = { run: Function.prototype.constructor }; export const value = holder.run("return 1")();',
  'const get = () => Function.prototype.constructor; export const value = get()("return 1")();',
  'let C; C = Function.prototype.constructor; export const value = C("return 1")();',
  'export const value = (() => {}).constructor("return 1")();',
])("browser bindings reject native dynamic execution: %s", (source) => {
  const diagnostics = check(source);

  expect(diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: "HES-CAPABILITY-DYNAMIC",
        filename: "api.ts",
        severity: "error",
      }),
    ]),
  );

  expect(diagnostics.some((item) => item.message.includes("app.tsx -> ./api.ts"))).toBe(true);
});

test.each([
  "const Function = (value) => value; export const value = Function(1);",
  "const tools = { eval: (value) => value }; export const value = tools.eval(1);",
  "export function value(Function) { return new Function(); }",
  "const window = { Function: (value) => value }; export const value = window.Function(1);",
  "export const value = Function.prototype;",
  'export const value = Function["prototype"];',
  "export const value = Function.name;",
  "export const value = globalThis.Function.prototype;",
  "export const value = Function.prototype.constructor.name;",
])("ordinary local callables and native function metadata remain available: %s", (source) => {
  expect(check(source)).toStrictEqual([]);
});

test("explicit generated entries receive capability checks and missing sources fail", () => {
  expect(
    analyzeBrowserCapabilities(
      [
        {
          filename: "generated-runtime.js",
          source: "export function run() { return process.env.SECRET; }",
        },
      ],
      ".",
      undefined,
      ["generated-runtime.js"],
    ).map((item) => item.code),
  ).toStrictEqual(["HES-CAPABILITY"]);

  expect(
    analyzeBrowserCapabilities([], ".", undefined, ["missing-runtime.js"]).map((item) => item.code),
  ).toStrictEqual(["HES-CAPABILITY-RESOLVE"]);
});
