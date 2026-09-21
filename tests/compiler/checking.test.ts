import { expect, test } from "bun:test";
import { checkProjectModules, openCheckingProject } from "../../src/compiler/checking.ts";
import { resolve } from "node:path";
import { compile } from "../../src/compiler/index.ts";
import { EditorProject } from "../../src/editor/project.ts";

test("checking and editor snapshots report compiler rejection at authored positions", () => {
  const filename = "invalid-native-tree.tsx";
  const source =
    'const label: string = "🐈";\r\nexport function App() { return <table><tr><td>{label}</td></tr></table>; }';
  const compiled = compile(source, { filename });
  const expected = compiled.diagnostics.find((item) => item.code === "HES-HTML-CONTEXT");
  if (!expected) throw new Error("The compiler accepted a parser-sensitive table tree");
  expect(expected?.severity).toBe("error");
  expect(compiled.code).toBe("");
  const checked = checkProjectModules([{ filename, source }]);
  expect(checked.diagnostics).toContainEqual(expected);
  const editor = new EditorProject([{ filename, source }]);
  try {
    expect(editor.diagnostics.diagnostics).toContainEqual(expected);
  } finally {
    editor.dispose();
  }
});

test("binding body reads fail emission and checking at the authored call", () => {
  const filename = "invalid-binding-read.tsx";
  const source =
    'import { client } from "hesperia";\r\ntype Target = HTMLInputElement;\r\nexport function App() { const label = "🐈"; const input = client.bind<Target>(); input().focus(); return <input bind={input} />; }';
  const compiled = compile(source, { filename });
  const diagnostic = compiled.diagnostics.find((item) => item.code === "HES-BIND-BODY");
  expect(diagnostic).toMatchObject({
    code: "HES-BIND-BODY",
    severity: "error",
    span: { start: source.indexOf("input()"), end: source.indexOf("input()") + 7 },
  });
  expect(compiled.code).toBe("");
  if (!diagnostic) throw new Error("The compiler accepted a binding body read");
  expect(checkProjectModules([{ filename, source }]).diagnostics).toContainEqual(diagnostic);
});

test("checking retains spread and nested JSX expressions with exact authored offsets", () => {
  const source =
    'const emoji = "🐈";\r\nexport function App() {\r\n const field = <input />;\r\n return <div {...missingSpread}>{field.nonexistent()} {true ? <input value={missingValue} /> : null}</div>;\r\n}';
  const result = checkProjectModules([{ filename: "mapped-expressions.tsx", source }]);
  for (const [code, word] of [
    ["TS2304", "missingSpread"],
    ["TS2339", "nonexistent"],
    ["TS2304", "missingValue"],
  ]) {
    expect(
      result.diagnostics.some(
        (item) => item.code === code && item.span?.start === source.indexOf(word!),
      ),
    ).toBe(true);
  }
});

test("native property types also check attributes supplied through a spread", () => {
  const source =
    'export function App() { const props = { disabled: "no" }; return <button {...props} />; }';
  const result = checkProjectModules([{ filename: "spread-types.tsx", source }]);
  expect(
    result.diagnostics.some(
      (item) => item.severity === "error" && item.message.includes("disabled"),
    ),
  ).toBe(true);
});

test("unsafe permission recognizes Hesperia marker imports without rejecting unrelated methods", () => {
  const plain = checkProjectModules([
    {
      filename: "plain-method.tsx",
      source: 'const object = { unsafeHTML() { return "plain"; } }; object.unsafeHTML();',
    },
  ]);
  expect(plain.diagnostics).toStrictEqual([]);
  const alias = checkProjectModules([
    {
      filename: "aliased-marker.tsx",
      source:
        'import { unsafeHTML as insert } from "hesperia/client"; export function App(){ return insert(<article />, "text"); }',
    },
  ]);
  expect(alias.diagnostics.some((item) => item.code === "HES-RAW-DISABLED")).toBe(true);
});

test("editor positions round-trip inside authored JSX expressions", () => {
  const filename = "editor-positions.tsx";
  const source =
    "export function App(){ const field = <input />; return <div title={field.value}>{field.value}</div>; }";
  const session = openCheckingProject([{ filename, source }]);
  try {
    expect(session.result.diagnostics).toStrictEqual([]);
    const view = [...session.views.values()][0]!;
    const position = source.lastIndexOf("field.value") + "field.".length;
    const generated = view.generatedOffset(position);
    expect(view.source.slice(generated, generated + 5)).toBe("value");
    expect(view.mapOffset(generated)).toBe(position);
  } finally {
    session.dispose();
  }
});

test("checking respects project aliases, ambient declarations and strictness options", () => {
  const result = checkProjectModules(
    [
      {
        filename: "src/app.tsx",
        source:
          'import { value } from "@app/value"; const optional: string = null; export const app = <input value={value + appSuffix} />;',
      },
      { filename: "src/value.ts", source: 'export const value: string = "hello";' },
    ],
    {
      additionalFiles: [
        {
          filename: "tsconfig.json",
          source: JSON.stringify({
            compilerOptions: {
              strict: true,
              strictNullChecks: false,
              module: "ESNext",
              moduleResolution: "Bundler",
              paths: { "@app/*": ["./src/*"] },
              types: [],
              lib: ["DOM", "ESNext"],
            },
          }),
        },
        { filename: "globals.d.ts", source: "declare const appSuffix: string;" },
      ],
    },
  );
  expect(result.diagnostics).toStrictEqual([]);
});

test("project configuration errors cannot disappear from checking results", () => {
  const result = checkProjectModules(
    [{ filename: "valid.ts", source: "export const valid = true;" }],
    {
      additionalFiles: [
        { filename: "tsconfig.json", source: '{ "compilerOptions": { "strict": "incorrect" } }' },
      ],
    },
  );
  expect(
    result.diagnostics.some((item) => item.severity === "error" && item.message.includes("strict")),
  ).toBe(true);
  expect(
    result.modules.some(
      (item) =>
        resolve(item.filename) === resolve("tsconfig.json") &&
        item.diagnostics.some((diagnostic) => diagnostic.message.includes("strict")),
    ),
  ).toBe(true);
});

test("supplementary files do not overwrite an authored checking view", () => {
  const result = checkProjectModules(
    [{ filename: "view-wins.tsx", source: "export const field = <input />; field.focus();" }],
    {
      additionalFiles: [{ filename: "view-wins.tsx", source: "this is not valid TSX" }],
    },
  );
  expect(result.diagnostics).toStrictEqual([]);
});

test("reserved list keys do not become ordinary component props", () => {
  const prefix =
    'import { type Component } from "hesperia"; function Child(props: Component.Props<{ title: string }>){ return <span>{props.title()}</span>; }';
  expect(
    checkProjectModules([
      {
        filename: "keyed-child.tsx",
        source: prefix + 'export function App(){ return <Child key="row" title="hello" />; }',
      },
    ]).diagnostics,
  ).toStrictEqual([]);
  const missing = checkProjectModules([
    {
      filename: "missing-keyed-prop.tsx",
      source: prefix + 'export function App(){ return <Child key="row" />; }',
    },
  ]);
  expect(
    missing.diagnostics.some((item) => item.severity === "error" && item.message.includes("title")),
  ).toBe(true);
  const invalid = checkProjectModules([
    {
      filename: "invalid-keyed-child.tsx",
      source: prefix + 'export function App(){ return <Child key={{}} title="hello" />; }',
    },
  ]);
  expect(invalid.diagnostics.some((item) => item.severity === "error")).toBe(true);
});

test("the async boundary accepts its native fallback and requires that fallback", () => {
  const valid = checkProjectModules([
    {
      filename: "async-boundary-types.tsx",
      source:
        'import {AsyncBoundary} from "hesperia"; export function App(){return <AsyncBoundary fallback={<span>waiting</span>}><input /></AsyncBoundary>;}',
    },
  ]);
  expect(valid.diagnostics).toStrictEqual([]);
  const missing = checkProjectModules([
    {
      filename: "async-boundary-missing.tsx",
      source:
        'import {AsyncBoundary} from "hesperia"; export function App(){return <AsyncBoundary><input /></AsyncBoundary>;}',
    },
  ]);
  expect(missing.diagnostics.some((item) => item.severity === "error")).toBe(true);
});
