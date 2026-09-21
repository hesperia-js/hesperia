import { expect, test } from "bun:test";
import { analyzeModule } from "../../src/compiler/compilation.ts";
import { validateComponentBindingReads } from "../../src/compiler/body-validation.ts";

function validate(source: string) {
  const analyzed = analyzeModule(source, { filename: "body-bindings.tsx" }).result;
  return validateComponentBindingReads(analyzed.ir);
}

test.each([
  "try { var view = <span/>; } finally {}",
  "try { throw 1; } catch { var view = <span/>; }",
  "try {} finally { var view = <span/>; }",
  "for (const item of [1]) { var view = <span/>; }",
  "switch (1) { case 1: var view = <span/>; }",
])("a render value escaping a control-flow block identifies its component: %s", (body) => {
  const source = `import { bind } from "hesperia/client"; function App() { const binding = bind(); binding(); ${body} return view; }`;
  expect(validate(source).map((item) => item.code)).toStrictEqual(["HES-BIND-BODY"]);
});

test.each([
  "switch (binding()) { default: break; }",
  "switch (1) { case binding(): break; }",
  "switch (1) { case 1: binding(); break; }",
  "const [...[value = binding()]] = [];",
])("switch and rest pattern evaluation cannot hide immediate binding reads: %s", (body) => {
  const source = `import { bind } from "hesperia/client"; function App() { const binding = bind(); ${body} return <span/>; }`;
  expect(validate(source).map((item) => item.code)).toStrictEqual(["HES-BIND-BODY"]);
});

test.each([
  "try { binding(); } catch {}",
  "try { throw 1; } catch (error) { binding(); }",
  "try {} finally { binding(); }",
  "try { throw {}; } catch ({ value = binding() }) {}",
  "const values = [...binding()];",
])("immediate binding reads remain forbidden in try and array spread work: %s", (body) => {
  const source = `import { bind } from "hesperia/client"; function App() { const binding = bind(); ${body} return <span/>; }`;
  const analyzed = analyzeModule(source, { filename: "try-binding.tsx" }).result;
  expect(analyzed.diagnostics.filter((item) => item.code !== "HES-BIND-BODY")).toStrictEqual([]);
  expect(validateComponentBindingReads(analyzed.ir).map((item) => item.code)).toStrictEqual([
    "HES-BIND-BODY",
  ]);
});

test.each([
  "try { return <span/>; } finally {}",
  "try { throw 1; } catch { return <span/>; }",
  "try {} finally { return <span/>; }",
])("rendered returns in try branches identify the component body: %s", (body) => {
  const source = `import { bind } from "hesperia/client"; function App() { const binding = bind(); binding(); ${body} }`;
  expect(validate(source).map((item) => item.code)).toStrictEqual(["HES-BIND-BODY"]);
});

test("catch binding names do not inherit an outer binding factory result", () => {
  const source =
    'import { bind } from "hesperia/client"; function App() { const binding = bind(); try { throw () => 1; } catch (binding) { binding(); } return <span/>; }';
  expect(validate(source)).toStrictEqual([]);
});

test.each([
  "for (const value of binding()) {}",
  "for (const key in binding()) {}",
  "for (let index = binding(); index < 1; index++) {}",
  "for (let index = 0; index < binding(); index++) {}",
  "for (let index = 0; index < 1; index += binding()) {}",
  "while (binding()) { break; }",
  "do {} while (binding());",
  "outer: for (const item of [1]) { binding(); break outer; }",
  "for (const { value = binding() } of [{}]) {}",
])("binding reads remain forbidden in immediate loop work: %s", (body) => {
  const source = `import { bind } from "hesperia/client"; function App() { const binding = bind(); ${body} return <span/>; }`;
  const analysis = analyzeModule(source, { filename: "loop-binding.tsx" }).result;
  expect(analysis.diagnostics.filter((item) => item.code !== "HES-BIND-BODY")).toStrictEqual([]);
  const diagnostics = validateComponentBindingReads(analysis.ir);
  expect(diagnostics.map((item) => item.code)).toStrictEqual(["HES-BIND-BODY"]);
});

test("a component returning inside a loop still checks its immediate binding read", () => {
  const source =
    'import { bind } from "hesperia/client"; function App() { const binding = bind(); for (const item of [1]) { binding(); return <span/>; } }';
  expect(validate(source).map((item) => item.code)).toStrictEqual(["HES-BIND-BODY"]);
});

test("a do-while condition cannot read the binding created by its first iteration", () => {
  const source =
    'import { bind } from "hesperia/client"; function App() { do { var binding = bind(); } while (binding()); return <span/>; }';
  expect(validate(source).map((item) => item.code)).toStrictEqual(["HES-BIND-BODY"]);
});

test("rejects required and unsafe binding reads in a component body after an awaited child", () => {
  const diagnostics = validate(`
    import * as client from "hesperia/client";
    import { unsafeBind as optional } from "hesperia/client";
    async function Child() { return <span>ready</span>; }
    async function App() {
      const required = client.bind<HTMLDivElement>();
      const absent = optional<HTMLSpanElement>();
      const child = await (<Child />);
      const first = required();
      return <main>{child}{first}{absent()}</main>;
    }
  `);

  expect(diagnostics).toHaveLength(2);
  expect(diagnostics.map((item) => item.code)).toStrictEqual(["HES-BIND-BODY", "HES-BIND-BODY"]);
  expect(diagnostics.every((item) => item.severity === "error")).toBe(true);
});

test("does not inspect deferred effect and event callbacks", () => {
  const diagnostics = validate(`
    import * as client from "hesperia/client";
    function App() {
      const binding = client.bind<HTMLButtonElement>();
      client.effect(() => binding());
      return <button bind={binding} on:click={() => binding()} />;
    }
  `);

  expect(diagnostics).toStrictEqual([]);
});

test("rejects an immediate event-expression read while allowing a deferred handler", () => {
  const diagnostics = validate(`
    import * as client from "hesperia/client";
    function App() {
      const binding = client.bind<HTMLButtonElement>();
      return <button on:click={binding()} on:focus={() => binding()} />;
    }
  `);

  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({ code: "HES-BIND-BODY", severity: "error" });
});

test("does not treat same-named unrelated functions or helper arguments as binding reads", () => {
  const diagnostics = validate(`
    function read(value: () => string) { return value(); }
    function App(client: { bind(): () => string }) {
      const binding = client.bind();
      return <main>{read(binding)}</main>;
    }
  `);

  expect(diagnostics).toStrictEqual([]);
});

test("recognizes a direct imported factory call without confusing another module", () => {
  const diagnostics = validate(`
    import { bind as makeBinding } from "hesperia/client";
    import { bind as makeOther } from "other/client";
    function App() {
      const first = makeBinding<HTMLDivElement>();
      const second = makeOther<HTMLSpanElement>();
      return <main>{first()}{second()}</main>;
    }
  `);

  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({ code: "HES-BIND-BODY", severity: "error" });
});

test("recognizes the root client namespace and respects a shadowing parameter", () => {
  const diagnostics = validate(`
    import { client as h } from "hesperia";
    function RootClient() {
      const binding = h.bind<HTMLDivElement>();
      return <main>{binding()}</main>;
    }
    function Shadowed(h: { bind(): () => string }) {
      const binding = h.bind();
      return <main>{binding()}</main>;
    }
  `);

  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({ code: "HES-BIND-BODY", severity: "error" });
});

test("checks both computed object values and ordinary ternary binding reads", () => {
  const diagnostics = validate(`
    import { bind } from "hesperia/client";
    function App() {
      const binding = bind<HTMLDivElement>();
      const key = "element";
      const values = { [key]: binding() };
      const selected = key ? binding() : null;
      return <main>{values}{selected}</main>;
    }
  `);

  expect(diagnostics.map((item) => item.code)).toStrictEqual(["HES-BIND-BODY", "HES-BIND-BODY"]);
});

test("component classification and binding diagnostics agree for returned local handles", () => {
  for (const declaration of ["function App()", "const App = () =>"]) {
    const result = analyzeModule(
      `
      import { bind } from "hesperia/client";
      ${declaration} {
        const target = bind<HTMLDivElement>();
        const node = <div bind={target} />;
        const output = node;
        target();
        return output;
      }
    `,
      { filename: "local-handle.tsx" },
    ).result;
    expect([...result.semantics.components]).toStrictEqual(["App"]);
    expect(result.diagnostics.map((item) => item.code)).toStrictEqual(["HES-BIND-BODY"]);
  }
});

test.each([
  "const target = bind(); const [value = target()] = []; return <div>{value}</div>;",
  "const target = bind(); const { value = target() } = {}; return <div>{value}</div>;",
  "const [target = bind()] = []; return <div>{target()}</div>;",
])("component-body defaults cannot hide a binding read: %s", (body) => {
  const result = analyzeModule(
    `import { bind } from "hesperia/client";
function App() { ${body} }`,
    { filename: "default-body.tsx" },
  ).result;
  expect(result.diagnostics.map((item) => item.code)).toStrictEqual(["HES-BIND-BODY"]);
});

test.each([
  "function App(value = bind()()) { return <div>{value}</div>; }",
  "const App = (value = bind()()) => <div>{value}</div>;",
  "const App = function(value = bind()()) { return <div>{value}</div>; };",
])("component parameter defaults cannot hide a binding read: %s", (declaration) => {
  const result = analyzeModule(
    `import { bind } from "hesperia/client";
${declaration}`,
    { filename: "default-parameter.tsx" },
  ).result;
  expect(result.diagnostics.map((item) => item.code)).toStrictEqual(["HES-BIND-BODY"]);
});

test.each([
  "const target = bind(); let value; value = target();",
  "const target = bind(); const output = {}; output[target()] = 1;",
  "const target = bind(); Math.max(...[target()]);",
  "const target = bind(); new Array(...[target()]);",
  "let target; target = bind(); target();",
])("assignments and spread arguments cannot hide component-body binding reads: %s", (body) => {
  const result = analyzeModule(
    `import { bind } from "hesperia/client";
function App() { ${body} return <div/>; }`,
    { filename: "assignment-body.tsx" },
  ).result;
  expect(result.diagnostics.map((item) => item.code)).toStrictEqual(["HES-BIND-BODY"]);
});

test("a deferred callback's default does not read its binding during component construction", () => {
  const result = analyzeModule(
    `import { bind, effect } from "hesperia/client";
function App() {
  const target = bind();
  const later = (value = target()) => value;
  effect(() => later());
  return <div bind={target} />;
}`,
    { filename: "deferred-default.tsx" },
  ).result;
  expect(result.diagnostics).toStrictEqual([]);
});
