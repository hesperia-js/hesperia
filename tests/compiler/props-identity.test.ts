import { expect, test } from "bun:test";
import { compile } from "../../src/compiler/index.ts";

test("canonical prop contracts survive type import aliases and affect semantic identity", () => {
  const source = (name: string, optional: boolean) => `
    import { type Component as ${name} } from "hesperia";
    function Child(props: ${name}.Props<{ done${optional ? "?" : ""}: () => string }>) {
      return <span />;
    }
  `;
  const direct = compile(source("Component", true), { filename: "props-direct.tsx" });
  const alias = compile(source("C", true), { filename: "props-alias.tsx" });
  const required = compile(source("C", false), { filename: "props-required.tsx" });
  for (const result of [direct, alias, required]) expect(result.diagnostics).toStrictEqual([]);
  expect(direct.ir.body.find((statement) => statement.kind === "function")?.props).toStrictEqual({
    done: { kind: "value", optional: true },
  });
  expect(alias.ir.body.find((statement) => statement.kind === "function")?.props).toStrictEqual({
    done: { kind: "value", optional: true },
  });
  expect(required.ir.body.find((statement) => statement.kind === "function")?.props).toStrictEqual({
    done: { kind: "callback", optional: false },
  });
  expect(alias.semanticHash).toBe(direct.semanticHash);
  expect(required.semanticHash).not.toBe(alias.semanticHash);
});

test.each(["span", "diagnostics", "__proto__"])(
  "prop named %s remains part of canonical meaning",
  (name) => {
    const source = (optional: boolean) => `
    import { type Component } from "hesperia";
    function Child(props: Component.Props<{ "${name}"${optional ? "?" : ""}: () => string }>) {
      return <span />;
    }
  `;
    const optional = compile(source(true), { filename: "named-prop.tsx" });
    const required = compile(source(false), { filename: "named-prop.tsx" });
    expect(optional.diagnostics).toStrictEqual([]);
    expect(required.diagnostics).toStrictEqual([]);
    const props = optional.ir.body.find((statement) => statement.kind === "function")?.props;
    expect(Object.hasOwn(props!, name)).toBe(true);
    expect(optional.semanticHash).not.toBe(required.semanticHash);
  },
);

test("named function-expression self references use resolved identity in semantic encoding", () => {
  const source = (name: string) => `
    const Tree = function ${name}() {
      return <${name} />;
    };
  `;
  const branch = compile(source("Branch"), { filename: "named-self.tsx" });
  const node = compile(source("Node"), { filename: "named-self.tsx" });
  expect(branch.diagnostics).toStrictEqual([]);
  expect(node.diagnostics).toStrictEqual([]);
  expect(branch.semanticHash).toBe(node.semanticHash);
});

test("function-expression prop schemas are order-independent semantic dictionaries", () => {
  const source = (fields: string) => `
    import { type Component } from "hesperia";
    type Props = { ${fields} };
    const Child = function (props: Component.Props<Props>) {
      return <span />;
    };
  `;
  const first = compile(
    source('"span"?: () => string; "diagnostics": () => string; "__proto__": () => string;'),
    { filename: "function-prop-order.tsx" },
  );
  const second = compile(
    source('"__proto__": () => string; "span"?: () => string; "diagnostics": () => string;'),
    { filename: "function-prop-order.tsx" },
  );
  expect(first.diagnostics).toStrictEqual([]);
  expect(second.diagnostics).toStrictEqual([]);
  expect(first.semanticHash).toBe(second.semanticHash);
});

test.each(["span", "diagnostics", "__proto__"])(
  "function-expression prop named %s is semantic metadata",
  (name) => {
    const source = (alias: string, optional: boolean) => `
    import { type Component as ${alias} } from "hesperia";
    const Child = function (props: ${alias}.Props<{ "${name}"${optional ? "?" : ""}: () => string }>) {
      return <span />;
    };
  `;
    const optional = compile(source("Component", true), { filename: "function-prop.tsx" });
    const alias = compile(source("C", true), { filename: "function-prop.tsx" });
    const required = compile(source("C", false), { filename: "function-prop.tsx" });
    for (const result of [optional, alias, required]) expect(result.diagnostics).toStrictEqual([]);

    const initializer = optional.ir.body.find((statement) => statement.kind === "variable")
      ?.declarations[0]?.initializer;
    expect(initializer?.kind).toBe("function-expression");
    expect((initializer as { readonly props?: Record<string, unknown> }).props).toStrictEqual({
      [name]: { kind: "value", optional: true },
    });
    expect(alias.semanticHash).toBe(optional.semanticHash);
    expect(required.semanticHash).not.toBe(optional.semanticHash);
  },
);
