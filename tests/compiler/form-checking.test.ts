import { expect, test } from "bun:test";
import { checkProjectModules } from "../../src/compiler/checking.ts";

test("form submit handlers receive SubmitEvent and an HTMLFormElement receiver", () => {
  const source = `export function App() {
  return <form on:submit={function (event) {
    const form: HTMLFormElement = this;
    const submit: SubmitEvent = event;
    event.preventDefault();
    return form.method + submit.type;
  }} />;
}`;
  expect(checkProjectModules([{ filename: "form-submit.tsx", source }]).diagnostics).toStrictEqual(
    [],
  );
});

test("form submit handlers reject properties absent from SubmitEvent at authored offsets", () => {
  const source = `export function App() {
  return <form on:submit={(event) => event.clientX} />;
}`;
  const result = checkProjectModules([{ filename: "form-submit-event-error.tsx", source }]);
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]).toMatchObject({
    code: "TS2339",
    span: { start: source.indexOf("clientX") },
  });
  expect(result.diagnostics[0]?.message).toContain("SubmitEvent");
});

test("native form property types remain checked while custom attributes and events stay open", () => {
  const source = `export function App() {
  return <form action={123} method={false} data-count={42} on:custom={(event) => event.type} />;
}`;
  const result = checkProjectModules([{ filename: "form-attributes.tsx", source }]);
  expect(result.diagnostics.filter((item) => item.code === "TS2322")).toHaveLength(2);
  expect(result.diagnostics.map((item) => item.span?.start)).toStrictEqual([
    source.indexOf("action={123}"),
    source.indexOf("method={false}"),
  ]);
});

test("native form handles retain DOM type checking outside JSX", () => {
  const source = `export function App() {
  const form = <form />;
  const control: RadioNodeList | Element | null = form.elements.namedItem("name");
  const method: number = form.method;
  console.log(control, method);
  return form;
}`;
  const result = checkProjectModules([{ filename: "form-native-handle.tsx", source }]);
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]).toMatchObject({ code: "TS2322" });
  expect(result.diagnostics[0]?.message).toContain("string");
});
