import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { openCheckingProject } from "../../src/compiler/checking.ts";
import { analyzeComponentProps } from "../../src/compiler/props-analysis.ts";

function analyze(source: string) {
  const filename = "props-analysis.tsx";
  const session = openCheckingProject([{ filename, source }]);
  const absolute = resolve(filename);
  const view = session.views.get(absolute.replaceAll("\\", "/").toLowerCase());
  const result = analyzeComponentProps(session.project!, absolute, view?.mapOffset);
  session.dispose();
  return result;
}

function analyzeModules(modules: readonly { filename: string; source: string }[]) {
  const filename = modules[0]!.filename;
  const session = openCheckingProject(modules);
  const absolute = resolve(filename);
  const view = session.views.get(absolute.replaceAll("\\", "/").toLowerCase());
  const result = analyzeComponentProps(session.project!, absolute, view?.mapOffset);
  session.dispose();
  return result;
}

test("recovers aliases and preserves optional callback/value semantics", () => {
  const source = `
    import { type Component } from "hesperia";
    type Props<T> = {
      optionalCallback?: T;
      requiredValue: string;
      requiredCallback: () => void;
      requiredUndefined: (() => void) | undefined;
      bind?: { read(): string };
    };
    function Child(props: Component.Props<Props<() => string>>) {
      return <span>{props.requiredValue()}</span>;
    }
  `;
  const result = analyze(source);
  const key = String(source.indexOf("props: Component"));
  expect(result.diagnostics).toStrictEqual([]);
  expect(result.byParameterStart[key]?.props).toStrictEqual({
    optionalCallback: { kind: "value", optional: true },
    requiredValue: { kind: "value", optional: false },
    requiredCallback: { kind: "callback", optional: false },
    requiredUndefined: { kind: "value", optional: false },
    bind: { kind: "binding", optional: true },
  });
});

test("handles destructured and contextually typed component parameters", () => {
  const source = `
    import { type Component } from "hesperia";
    type ChildProps = { value?: number; done: () => void };
    function Destructured({ value }: Component.Props<ChildProps>) {
      return <span>{value()}</span>;
    }
    const Contextual: Component<ChildProps> = (props) => <span>{props.value()}</span>;
  `;
  const result = analyze(source);
  expect(result.diagnostics).toStrictEqual([]);
  expect(Object.values(result.byParameterStart)).toHaveLength(2);
  const entries = Object.values(result.byParameterStart).map((item) => item.props);
  expect(entries).toContainEqual({
    value: { kind: "value", optional: true },
    done: { kind: "callback", optional: false },
  });
  expect(
    Object.keys(result.byParameterStart).some((key) => Number(key) === source.indexOf("props)")),
  ).toBe(true);
});

test("resolves imported prop aliases through the native project", () => {
  const result = analyzeModules([
    {
      filename: "props-import.tsx",
      source: `
        import { type Component } from "hesperia";
        import type { ImportedProps } from "./props-imported.ts";
        function Child(props: Component.Props<ImportedProps>) {
          return <span>{props.value()}</span>;
        }
      `,
    },
    {
      filename: "props-imported.ts",
      source: "export type ImportedProps = { value: string; done?: () => void };",
    },
  ]);
  expect(result.diagnostics).toStrictEqual([]);
  expect(Object.values(result.byParameterStart)[0]?.props).toStrictEqual({
    value: { kind: "value", optional: false },
    done: { kind: "value", optional: true },
  });
});

test("follows renamed Component imports and ignores foreign ComponentProps brands", () => {
  const result = analyzeModules([
    {
      filename: "props-renamed.tsx",
      source: `
        import { type Component as C } from "hesperia";
        import type { ForeignProps } from "./props-foreign.ts";
        function Child(props: C.Props<{ done?: () => string }>) {
          return <span>{props.done()?.()}</span>;
        }
        function Foreign(props: ForeignProps) {
          return <span />;
        }
      `,
    },
    {
      filename: "props-foreign.ts",
      source: `
        declare const componentPropsType: unique symbol;
        type ForeignComponentProps<P> = { readonly [componentPropsType]?: P };
        export type ForeignProps = ForeignComponentProps<{ forged: string }>;
      `,
    },
  ]);
  const entries = Object.values(result.byParameterStart);
  expect(entries).toHaveLength(1);
  expect(entries[0]?.props).toStrictEqual({
    done: { kind: "value", optional: true },
  });
});

test("keeps constrained generic properties and rejects open index contracts", () => {
  const source = `
    import { type Component } from "hesperia";
    function Constrained<P extends { value: string }>(props: Component.Props<P>) {
      return <span>{props.value()}</span>;
    }
    function Open<P extends Record<string, unknown>>(props: Component.Props<P>) {
      return <span />;
    }
  `;
  const result = analyze(source);
  const constrainedKey = String(source.indexOf("props: Component"));
  expect(result.byParameterStart[constrainedKey]?.props).toStrictEqual({
    value: { kind: "value", optional: false },
  });
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]?.code).toBe("HES-PROPS");
  expect(result.diagnostics[0]?.message).toContain("named properties");
});

test("does not claim untyped functions as component prop contracts", () => {
  const result = analyze("function helper(value: string) { return value; }");
  expect(result.diagnostics).toStrictEqual([]);
  expect(result.byParameterStart).toStrictEqual({});
});
