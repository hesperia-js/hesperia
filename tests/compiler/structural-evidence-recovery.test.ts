import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { openCheckingProject } from "../../packages/compiler/src/checking.ts";
import { emitCheckingSession } from "../../packages/compiler/src/project-compilation.ts";
import {
  issuedProjectTypingEvidence,
  requestTypingEvidenceCapture,
} from "../../packages/compiler/src/typing-inputs.ts";

async function capture(source: string, filename: string) {
  const session = await openCheckingProject(
    [{ filename, source }],
    requestTypingEvidenceCapture({ root: resolve(import.meta.dir, "../..") }),
  );

  try {
    const compilation = emitCheckingSession(session);
    const evidence = issuedProjectTypingEvidence(compilation);

    if (!evidence) throw new Error("Checking session did not issue typing evidence");

    const module = evidence.modules.find((entry) => entry.filename === filename);

    if (!module) throw new Error("Checking session did not retain the component module");

    return { diagnostics: compilation.checking.diagnostics, evidence, module };
  } finally {
    await session.dispose();
  }
}

test("checked props distinguish the intrinsic iterator from a local lookalike", async () => {
  const genuine = await capture(
    `import type { Component } from "hesperia";
interface Sequence { [Symbol.iterator](): { next(): { value: string; done: boolean } } }
const item: Sequence = { [Symbol.iterator]() { return { next() { return { value: "x", done: false }; } }; } };
function View(props: Component.Props<{ item: Sequence }>) { return <span>{props.item().toString()}</span>; }
export function App() { return <View item={item} />; }`,
    "iterator-props.tsx",
  );
  const lookalike = await capture(
    `import type { Component } from "hesperia";
declare const token: unique symbol;
const Symbol = { iterator: token } as const;
interface Sequence { [Symbol.iterator](): string }
const item: Sequence = { [Symbol.iterator]() { return "local"; } };
function View(props: Component.Props<{ item: Sequence }>) { return <span>{props.item().toString()}</span>; }
export function App() { return <View item={item} />; }`,
    "local-symbol-props.tsx",
  );

  expect(genuine.diagnostics).toStrictEqual([]);
  expect(genuine.module.sourceJoin).toBe(true);
  expect(genuine.module.components).toHaveLength(1);
  expect(genuine.module.components[0]).toMatchObject({
    emittedComponentJoin: "matched",
    props: {
      kind: "props",
      entries: [
        {
          name: "item",
          mappedType: {
            kind: "structural",
            shape: {
              kind: "reference",
              surface: { properties: [expect.objectContaining({ name: "[Symbol.iterator]" })] },
            },
          },
        },
      ],
    },
  });
  expect(lookalike.diagnostics).toStrictEqual([]);
  expect(lookalike.module.sourceJoin).toBe(true);
  expect(lookalike.module.components).toHaveLength(1);
  expect(lookalike.module.components[0]).toMatchObject({
    emittedComponentJoin: "matched",
    props: {
      kind: "props",
      entries: [{ name: "item", mappedType: { kind: "unproved", reason: "symbol-origin" } }],
    },
  });
}, 120_000);

test("checked props retain generic semantics and reject nominal class evidence", async () => {
  const result = await capture(
    `import type { Component } from "hesperia";
type Handler = <T extends string>(value: T) => Uppercase<T>;
type Mode = "open" | "closed";
class Account { private token = "secret"; name = "customer"; }
const account = new Account();
function handler<T extends string>(value: T): Uppercase<T> { return value.toUpperCase() as Uppercase<T>; }
function View(props: Component.Props<{ account: Account; mode: Mode; handler: Handler }>) { return <span>{props.account().name}:{props.mode()}</span>; }
export function App() { return <View account={account} mode="open" handler={handler} />; }`,
    "generic-callback-props.tsx",
  );

  expect(result.diagnostics).toStrictEqual([]);
  expect(result.module.sourceJoin).toBe(true);
  expect(result.module.components).toHaveLength(1);
  expect(result.module.components[0]).toMatchObject({
    emittedComponentJoin: "matched",
    props: {
      kind: "props",
      entries: [
        {
          name: "account",
          category: "value",
          mappedType: { kind: "unproved", reason: "nominal-origin" },
        },
        {
          name: "handler",
          category: "callback",
          mappedType: {
            kind: "structural",
            shape: {
              kind: "reference",
              surface: {
                calls: [
                  {
                    typeParameters: [
                      expect.objectContaining({
                        kind: "type-parameter",
                        constraint: { kind: "primitive", name: "string" },
                      }),
                    ],
                    parameters: [
                      expect.objectContaining({
                        type: expect.objectContaining({ kind: "type-parameter" }),
                      }),
                    ],
                    returns: {
                      kind: "string-mapping",
                      operation: "Uppercase",
                      target: expect.objectContaining({ kind: "type-parameter" }),
                    },
                  },
                ],
              },
            },
          },
        },
        {
          name: "mode",
          category: "value",
          mappedType: {
            kind: "structural",
            shape: {
              kind: "union",
              types: expect.arrayContaining([
                { kind: "literal", base: "string", value: "open" },
                { kind: "literal", base: "string", value: "closed" },
              ]),
            },
          },
        },
      ],
    },
  });
}, 120_000);

test("erroneous JSX cannot join its component to trusted checked props", async () => {
  const result = await capture(
    `import type { Component } from "hesperia";
function View(props: Component.Props<{ label: string }>) { return <span>{props.label()}</span>; }
export function App() { return <View label={12} />; }`,
    "invalid-component-props.tsx",
  );

  expect(
    result.diagnostics.some((item) => item.code === "TS2769" && item.severity === "error"),
  ).toBe(true);
  expect(result.evidence.checkingHasErrors).toBe(true);
  expect(result.module.sourceJoin).toBe(false);
  expect(result.module.components).toHaveLength(1);
  expect(result.module.components[0]).toMatchObject({
    emittedComponentJoin: "ambiguous",
    props: { kind: "unproved", reason: "ambiguous-join" },
  });
}, 120_000);

test("checked callback props preserve correlated generic and indexed types", async () => {
  const source = `import type { Component } from "hesperia";
type Catalog = { title: string; count: number };
type Select = <K extends keyof Catalog>(key: K, value: Catalog[K]) => K extends "title" ? \`title:\${string}\` : \`count:\${number}\`;
type Pair = readonly [label: string, count?: number];
function select<K extends keyof Catalog>(key: K, value: Catalog[K]): K extends "title" ? \`title:\${string}\` : \`count:\${number}\` { return (key + ":" + value) as never; }
function View(props: Component.Props<{ select: Select; pair: Pair; values: readonly string[]; lookup: Record<string, number> }>) { return <span>{props.pair()[0]} {props.select("title", "x")} {props.values()[0]} {props.lookup().x}</span>; }
export function App() { return <View select={select} pair={["a", 1]} values={["x"]} lookup={{x: 1}} />; }`;
  const result = await capture(source, "complex-live-props.tsx");

  expect(result.diagnostics).toStrictEqual([]);
  expect(result.module.sourceJoin).toBe(true);
  expect(result.module.components).toHaveLength(1);
  expect(result.module.components[0]).toMatchObject({
    emittedComponentJoin: "matched",
    props: {
      kind: "props",
      entries: [
        {
          name: "lookup",
          mappedType: {
            kind: "structural",
            shape: {
              kind: "reference",
              surface: {
                indexes: [
                  {
                    key: { kind: "primitive", name: "string" },
                    readonly: false,
                    type: { kind: "primitive", name: "number" },
                  },
                ],
              },
            },
          },
        },
        { name: "pair", mappedType: { kind: "unproved", reason: "free-instantiation" } },
        {
          name: "select",
          category: "callback",
          mappedType: {
            kind: "structural",
            shape: {
              kind: "reference",
              surface: {
                calls: [
                  {
                    typeParameters: [
                      {
                        kind: "type-parameter",
                        constraint: {
                          kind: "union",
                          types: expect.arrayContaining([
                            { kind: "literal", base: "string", value: "title" },
                            { kind: "literal", base: "string", value: "count" },
                          ]),
                        },
                      },
                    ],
                    parameters: [
                      { type: { kind: "type-parameter" } },
                      { type: { kind: "indexed-access", index: { kind: "type-parameter" } } },
                    ],
                    returns: {
                      kind: "conditional",
                      check: { kind: "type-parameter" },
                      extends: { kind: "literal", base: "string", value: "title" },
                      whenTrue: {
                        kind: "template-literal",
                        texts: ["title:", ""],
                        types: [{ kind: "primitive", name: "string" }],
                      },
                      whenFalse: {
                        kind: "template-literal",
                        texts: ["count:", ""],
                        types: [{ kind: "primitive", name: "number" }],
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        { name: "values", mappedType: { kind: "unproved", reason: "free-instantiation" } },
      ],
    },
  });

  const signature = (
    result.module.components[0] as unknown as {
      props: {
        entries: {
          name: string;
          mappedType: {
            shape: {
              surface: {
                calls: {
                  typeParameters: { identity: string }[];
                  parameters: { type: { identity?: string; index?: { identity: string } } }[];
                  returns: { check: { identity: string } };
                }[];
              };
            };
          };
        }[];
      };
    }
  ).props.entries.find((entry) => entry.name === "select")!.mappedType.shape.surface.calls[0]!;
  const identity = signature.typeParameters[0]!.identity;

  expect(signature.parameters[0]!.type.identity).toBe(identity);
  expect(signature.parameters[1]!.type.index!.identity).toBe(identity);
  expect(signature.returns.check.identity).toBe(identity);

  const invalid = await capture(
    source.replace('props.select("title", "x")', 'props.select("title", 1)'),
    "invalid-generic-props.tsx",
  );

  expect(
    invalid.diagnostics.some((item) => item.code === "TS2345" && item.severity === "error"),
  ).toBe(true);
  expect(invalid.evidence.checkingHasErrors).toBe(true);
  expect(invalid.module.sourceJoin).toBe(false);
}, 120_000);
