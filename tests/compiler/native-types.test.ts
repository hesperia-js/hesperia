import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { checkProjectModules } from "../../src/compiler/checking.ts";
import { compile } from "../../src/compiler/index.ts";

test("native bindings reject a mismatched target and accept the declared native type", () => {
  const source = `import * as client from "hesperia/client";
export function App() {
  const input = client.bind<HTMLInputElement>();
  const textarea = client.bind<HTMLTextAreaElement>();
  const good = <input bind={input} />;
  const bad = <input bind={textarea} />;
  return good;
}`;
  const result = checkProjectModules([{ filename: "native-bindings.tsx", source }]);
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]?.code).toBe("TS2322");
  expect(result.diagnostics[0]?.message).toContain("HTMLInputElement");
  expect(result.diagnostics[0]?.span?.start).toBe(source.lastIndexOf("bind="));
});

test("native event callbacks retain event-specific properties and receiver types", () => {
  const source = `export function App() {
  return <button
    on:click={function (event) { console.log(this.disabled, event.clientX); this.focus(); }}
    on:keydown={(event) => console.log(event.key)}
  />;
}`;
  const result = checkProjectModules([{ filename: "native-events.tsx", source }]);
  expect(result.diagnostics).toStrictEqual([]);
});

test("native event callbacks still reject properties absent from that event", () => {
  const source = `export function App() {
  return <button on:keydown={(event) => console.log(event.clientX)} />;
}`;
  const result = checkProjectModules([{ filename: "native-event-error.tsx", source }]);
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]?.code).toBe("TS2339");
  expect(result.diagnostics[0]?.message).toContain("KeyboardEvent");
  expect(result.diagnostics[0]?.span?.start).toBe(source.indexOf("clientX"));
});

test("native event checking validates declared handler types and the target receiver", () => {
  const source = `export function App() {
  const keyboardOnly = (event: KeyboardEvent) => console.log(event.key);
  return <button on:click={keyboardOnly} on:focus={function () { console.log(this.href); }} />;
}`;
  const result = checkProjectModules([{ filename: "native-handler-types.tsx", source }]);
  expect(result.diagnostics).toHaveLength(2);
  expect(result.diagnostics.some((item) => item.code === "TS2322")).toBe(true);
  expect(
    result.diagnostics.some(
      (item) => item.code === "TS2339" && item.message.includes("HTMLButtonElement"),
    ),
  ).toBe(true);
});

test("custom native events retain the base Event type", () => {
  const source = `export function App() {
  return <div on:custom={(event) => console.log(event.type)} />;
}`;
  expect(checkProjectModules([{ filename: "custom-event.tsx", source }]).diagnostics).toStrictEqual(
    [],
  );
});

test("explicit component type arguments constrain the caller props", () => {
  const source = `import { type Component } from "hesperia";
function Child<T>(props: Component.Props<{ value: T }>) { return <span>{String(props.value())}</span>; }
export function App() { return <Child<number> value="wrong" />; }`;
  const result = checkProjectModules([{ filename: "generic-component.tsx", source }]);
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]).toMatchObject({ code: "TS2769", severity: "error" });
  expect(result.diagnostics[0]?.message).toContain(
    "Type 'string' is not assignable to type 'number'",
  );
  expect(
    checkProjectModules([
      { filename: "valid-generic.tsx", source: source.replace('value="wrong"', "value={1}") },
    ]).diagnostics,
  ).toStrictEqual([]);
});

test("component type argument diagnostics retain their authored positions", () => {
  const source = `import { type Component } from "hesperia";
function Child<T>(props: Component.Props<{ value: T }>) { return <span>{String(props.value())}</span>; }
export function App() { return <Child<Missing> value={1} />; }`;
  const result = checkProjectModules([{ filename: "generic-type-name.tsx", source }]);
  expect(
    result.diagnostics.some(
      (item) => item.code === "TS2304" && item.span?.start === source.indexOf("Missing"),
    ),
  ).toBe(true);
});

test("native binding and receiver types follow SVG, MathML and HTML integration contexts", () => {
  const source = `import * as client from "hesperia/client";
export function App() {
  const svgLink = client.bind<SVGAElement>();
  const htmlLink = client.bind<HTMLAnchorElement>();
  const mathLink = client.bind<HTMLAnchorElement>();
  const math = client.bind<MathMLElement>();
  return <div>
    <svg><><a bind={svgLink} on:click={function () { console.log(this.href.baseVal); }} /></>
      <foreignObject><a bind={htmlLink} on:click={function () { console.log(this.href.length); }} /></foreignObject>
    </svg>
    <math><mi bind={math} /><mtext><a bind={mathLink} /></mtext></math>
  </div>;
}`;
  expect(
    checkProjectModules([{ filename: "native-namespaces.tsx", source }]).diagnostics,
  ).toStrictEqual([]);
});

test("native markup accepts CSS text and scalar SVG attribute values", () => {
  const source = `export function App() {
  return <div style="color: red"><svg viewBox="0 0 10 10">
    <a href="#target"><circle r={3} cx="5" cy={5} /></a>
  </svg></div>;
}`;
  expect(
    checkProjectModules([{ filename: "native-attribute-values.tsx", source }]).diagnostics,
  ).toStrictEqual([]);
});

test("the native browser application passes the authored project checker", async () => {
  const filename = resolve(import.meta.dir, "../browser/Native.tsx");
  const source = await Bun.file(filename).text();
  expect(checkProjectModules([{ filename, source }]).diagnostics).toStrictEqual([]);
});

test("native element guide examples pass checking and executable emission", async () => {
  const guide = await Bun.file(resolve(import.meta.dir, "../../docs/native-elements.md")).text();
  const examples = [...guide.matchAll(/```tsx\r?\n([\s\S]*?)```/gu)];
  expect(examples).toHaveLength(5);
  for (const [index, example] of examples.entries()) {
    const documentShell = index === 3;
    const filename = documentShell ? "app.tsx" : `native-guide-${index}.tsx`;
    const source = example[1]!;
    expect(
      checkProjectModules([{ filename, source }], { documentShell }).diagnostics,
    ).toStrictEqual([]);
    const result = compile(source, { filename, documentShell });
    expect(result.diagnostics).toStrictEqual([]);
    expect(result.code.length).toBeGreaterThan(0);
  }
});
