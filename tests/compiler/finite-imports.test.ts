import { expect, test } from "bun:test";
import { analyzeBrowserCapabilities } from "../../src/compiler/capability-analysis.ts";
import { compile } from "../../src/compiler/index.ts";

function check(source: string, second = 'export const value = "second";') {
  return analyzeBrowserCapabilities(
    [
      {
        filename: "app.tsx",
        source:
          'import { load } from "./loader.ts"; export default function App() { return <html><head/><body><button on:click={load}/></body></html>; }',
      },
      { filename: "loader.ts", source },
      { filename: "first.ts", source: 'export const value = "first";' },
      { filename: "second.ts", source: second },
    ],
    ".",
  );
}

test.each([
  'export const load = () => import("./first.ts");',
  'export const load = (choose) => import(choose ? "./first.ts" : "./second.ts");',
  'const name = "./first.ts"; const alias = name; export const load = () => import(alias);',
  'export function load(choose) { const name = choose ? "first" : "second"; return import(`./${name}.ts`); }',
  'export function load(choose) { const name = choose ? "first" : "second"; return import("./" + name + ".ts"); }',
])("checks every known dynamic import target: %s", (source) => {
  expect(check(source)).toStrictEqual([]);
});

test.each([
  "export const load = (name) => import(name);",
  'let name = "./first.ts"; export const load = () => import(name);',
  "const name = name; export const load = () => import(name);",
  'const name = "./first.ts"; export function load(name) { return import(name); }',
  "export const load = () => import(globalThis.location.href);",
])("rejects an import whose target set is not proved: %s", (source) => {
  expect(check(source)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: "HES-CAPABILITY-DYNAMIC", filename: "loader.ts" }),
    ]),
  );
});

test("a conditional target cannot conceal a host-backed exported value", () => {
  const diagnostics = check(
    'export const load = (choose) => import(choose ? "./first.ts" : "./second.ts");',
    "export const read = () => process.env.SECRET;",
  );
  expect(diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: "HES-CAPABILITY", filename: "second.ts" }),
    ]),
  );
  expect(diagnostics.some((item) => item.message.includes("import(./second.ts)"))).toBe(true);
});

test("import options retain host provenance", () => {
  expect(
    check('export const load = () => import("./first.ts", { with: { type: process.env.TYPE } });'),
  ).toEqual(expect.arrayContaining([expect.objectContaining({ code: "HES-CAPABILITY" })]));
});

test.each(["import(binding())", 'import("./first.ts", binding())'])(
  "component import operands cannot hide a binding read: %s",
  (expression) => {
    const result = compile(
      `import { bind } from "hesperia/client";
    export default function App() { const binding = bind<string>(); ${expression}; return <span/>; }`,
      { filename: "import-body.tsx" },
    );
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "HES-BIND-BODY" })]),
    );
  },
);
