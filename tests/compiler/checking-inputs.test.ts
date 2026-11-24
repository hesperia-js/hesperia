import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CheckingInputSnapshot } from "../../packages/compiler/src/checking-inputs.ts";
import {
  checkedAnalysisOrigin,
  checkedSourceOrigin,
} from "../../packages/compiler/src/checking-origin.ts";
import { checkProjectModules, openCheckingProject } from "../../packages/compiler/src/checking.ts";
import { ModuleResolver } from "../../packages/compiler/src/module-resolution.ts";
import { emitCheckingSession } from "../../packages/compiler/src/project-compilation.ts";
import {
  issuedProjectTypingEvidence,
  registerMappedProjectCompilation,
  requestTypingEvidenceCapture,
} from "../../packages/compiler/src/typing-inputs.ts";
import { normalizeFilename } from "../../packages/compiler/src/utils.ts";

test("typing evidence stays tied to the actual emitted module population", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-typing-evidence-"));
  const filename = join(root, "entry.ts");
  let session: Awaited<ReturnType<typeof openCheckingProject>> | undefined;

  try {
    session = await openCheckingProject(
      [{ filename, source: "export const value: string = 'ok';" }],
      requestTypingEvidenceCapture({ root }),
    );
    const result = session.result;
    const origin = checkedSourceOrigin(session, result);
    const analysis = session.analyses.get(filename);

    expect(origin).toBeDefined();
    expect(checkedSourceOrigin(session, { ...result })).toBeUndefined();
    expect(analysis && checkedAnalysisOrigin(analysis)?.origin).toBe(origin);
    const compilation = emitCheckingSession(session);
    const evidence = issuedProjectTypingEvidence(compilation);
    const emitted = compilation.modules.get(filename);

    expect(compilation.checking.diagnostics.filter((item) => item.severity === "error")).toEqual(
      [],
    );
    expect(emitted).toBeDefined();
    expect(evidence).toMatchObject({
      state: "sealed",
      captureState: "incomplete-capture",
      projectPolicy: { kind: "unproved" },
      modulePopulationJoin: true,
    });
    expect(evidence?.modules.map((item) => item.filename)).toEqual([filename]);
    expect(evidence?.unavailableTypeLocations).toContain("component-props");

    const modules = compilation.modules as Map<string, NonNullable<typeof emitted>>;
    modules.delete(filename);
    expect(issuedProjectTypingEvidence(compilation)).toBeUndefined();
    modules.set(filename, emitted!);
    expect(issuedProjectTypingEvidence(compilation)).toBe(evidence);

    const originalCode = emitted!.code;

    try {
      expect(Reflect.set(emitted!, "code", originalCode + "\n// changed output")).toBe(true);
      expect(issuedProjectTypingEvidence(compilation)).toBeUndefined();
    } finally {
      Reflect.set(emitted!, "code", originalCode);
    }

    expect(issuedProjectTypingEvidence(compilation)).toBe(evidence);

    const mapped = {
      ...compilation,
      checking: {
        ...compilation.checking,
        modules: compilation.checking.modules.map((module) => ({
          ...module,
          diagnostics: [...module.diagnostics],
        })),
      },
      modules: new Map(
        [...compilation.modules].map(
          ([name, result]) => [name, { ...result, diagnostics: [...result.diagnostics] }] as const,
        ),
      ),
    };

    expect(registerMappedProjectCompilation(compilation, mapped)).toBe(true);
    expect(issuedProjectTypingEvidence(mapped)).toBe(evidence);

    const forgedCode = {
      ...mapped,
      modules: new Map([[filename, { ...emitted!, code: originalCode + "\n// changed output" }]]),
    };

    expect(registerMappedProjectCompilation(compilation, forgedCode)).toBe(false);
    expect(issuedProjectTypingEvidence(forgedCode)).toBeUndefined();

    const injectedDiagnostic = {
      code: "HES-TEST",
      severity: "error" as const,
      message: "A projection cannot invent a diagnostic.",
    };
    const forgedOutputDiagnostics = {
      ...mapped,
      modules: new Map([[filename, { ...emitted!, diagnostics: [injectedDiagnostic] }]]),
    };

    expect(registerMappedProjectCompilation(compilation, forgedOutputDiagnostics)).toBe(false);
    expect(issuedProjectTypingEvidence(forgedOutputDiagnostics)).toBeUndefined();

    const forgedCheckingDiagnostics = {
      ...mapped,
      checking: {
        ...mapped.checking,
        diagnostics: [injectedDiagnostic],
        modules: mapped.checking.modules.map((module) => ({
          ...module,
          diagnostics: [injectedDiagnostic],
        })),
      },
    };

    expect(registerMappedProjectCompilation(compilation, forgedCheckingDiagnostics)).toBe(false);
    expect(issuedProjectTypingEvidence(forgedCheckingDiagnostics)).toBeUndefined();
    await session.dispose();
    expect(checkedSourceOrigin(session, result)).toBe(origin);
    expect(analysis && checkedAnalysisOrigin(analysis)).toBeUndefined();
    session = undefined;
  } finally {
    await session?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("typing evidence retains checked JSX props and marks unsupported types", async () => {
  const filename = "checked-origin-component.tsx";
  const source = `import { type Component } from "hesperia";
export function formatTitle(value: string) {
  return value.trim();
}
export function Page(props: Component.Props<{ title: string; serial: bigint }>) {
  return <main>{props.title()}</main>;
}`;
  const session = await openCheckingProject(
    [{ filename, source }],
    requestTypingEvidenceCapture({ root: join(import.meta.dir, "../..") }),
  );

  try {
    const checking = session.result;
    const origin = checkedSourceOrigin(session, checking);
    const analysis = session.analyses.get(filename);
    const compilation = emitCheckingSession(session);
    const evidence = issuedProjectTypingEvidence(compilation);
    const sourceDigest = `sha256-${createHash("sha256").update(source).digest("hex")}`;

    expect(checking.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    expect(analysis?.componentProps?.diagnostics).toEqual([]);
    expect(Object.keys(analysis?.componentProps?.byParameterStart ?? {})).toHaveLength(1);
    expect(origin?.analyses.get(filename)?.analysis).toBe(analysis);
    expect(analysis && checkedAnalysisOrigin(analysis)?.origin).toBe(origin);
    expect(origin?.project).toBe(session.project);
    expect(origin?.population).toHaveLength(1);
    expect(origin?.population[0]).toMatchObject({ filename, source, sourceDigest });
    expect(compilation.modules.get(filename)?.code).toBeTruthy();
    expect(evidence).toMatchObject({
      state: "sealed",
      captureState: "incomplete-capture",
      checkingResultJoin: true,
      analysisJoin: true,
      modulePopulationJoin: true,
    });
    expect(evidence?.unavailableTypeLocations).toContain("component-props");
    expect(evidence?.modules.map((item) => item.filename)).toEqual([filename]);
    const moduleEvidence = evidence?.modules[0];
    expect(moduleEvidence?.sourceDigest).toBe(sourceDigest);
    expect(moduleEvidence?.sourceJoin).toBe(true);
    expect(moduleEvidence?.components).toHaveLength(1);
    const component = moduleEvidence?.components[0];
    expect(component?.emittedComponentJoin).toBe("matched");
    expect(component?.parameterStart).toBe(source.indexOf("props: Component"));
    expect(component?.props).toMatchObject({
      kind: "props",
      entries: [
        {
          name: "serial",
          category: "value",
          optional: false,
          mappedType: { kind: "unproved", reason: "unsupported-type" },
        },
        {
          name: "title",
          category: "value",
          optional: false,
          mappedType: {
            kind: "structural",
            schema: 1,
            algorithm: "ts-shape-v1",
            shape: { kind: "primitive", name: "string" },
          },
        },
      ],
    });
  } finally {
    await session.dispose();
  }
});

test("typing evidence preserves object, instantiated and recursive prop contracts", async () => {
  const filename = "checked-structural-props.tsx";
  const source = `import { type Component } from "hesperia";
interface Info { readonly label: string; count: number }
interface Box<T> { value: T }
interface Link<T> { value: T; next?: Link<T> }
interface Lookup { readonly [key: string]: number }
type Handler = <T extends string = "seed">(value: T) => T;
declare class Secret { private hidden: string; visible: string }
export function Page(props: Component.Props<{
  info: Info;
  box: Box<number>;
  stringBox: Box<string>;
  chain: Link<string>;
  lookup: Lookup;
  handler: Handler;
  secret: Secret;
}>) {
  return <main>{props.info().label}</main>;
}`;
  const session = await openCheckingProject(
    [{ filename, source }],
    requestTypingEvidenceCapture({ root: join(import.meta.dir, "../..") }),
  );

  try {
    const compilation = emitCheckingSession(session);
    const evidence = issuedProjectTypingEvidence(compilation);

    expect(compilation.checking.diagnostics.filter((item) => item.severity === "error")).toEqual(
      [],
    );
    expect(compilation.modules.get(filename)?.code).toBeTruthy();
    expect(evidence).toMatchObject({
      state: "sealed",
      captureState: "incomplete-capture",
      checkingResultJoin: true,
      analysisJoin: true,
      modulePopulationJoin: true,
    });
    const module = evidence?.modules.find((item) => item.filename === filename);
    const component = module?.components.find(
      (item) => item.parameterStart === source.indexOf("props: Component"),
    );

    expect(module?.sourceDigest).toBe(
      `sha256-${createHash("sha256").update(source).digest("hex")}`,
    );
    expect(module?.sourceJoin).toBe(true);
    expect(component?.emittedComponentJoin).toBe("matched");
    expect(component?.props.kind).toBe("props");

    if (component?.props.kind !== "props") throw new Error("Expected checked component props");

    const entries = component.props.entries;
    const entry = (name: string) => entries.find((item) => item.name === name)?.mappedType;

    expect(entry("info")).toMatchObject({
      kind: "structural",
      shape: {
        kind: "reference",
        arguments: [],
        surface: {
          properties: expect.arrayContaining([
            expect.objectContaining({
              name: "label",
              readonly: true,
              optional: false,
              type: { kind: "primitive", name: "string" },
            }),
            expect.objectContaining({
              name: "count",
              readonly: false,
              optional: false,
              type: { kind: "primitive", name: "number" },
            }),
          ]),
        },
      },
    });
    const box = entry("box");

    expect(box).toMatchObject({
      kind: "structural",
      shape: {
        kind: "reference",
        arguments: [{ kind: "primitive", name: "number" }],
      },
    });

    if (box?.kind !== "structural" || box.shape.kind !== "reference")
      throw new Error("Expected an instantiated Box reference");

    expect(box.shape.surface.properties.find((item) => item.name === "value")).toMatchObject({
      name: "value",
      type: { kind: "type-parameter", identity: "$/surface/typeparam/0" },
    });

    const stringBox = entry("stringBox");

    expect(stringBox).toMatchObject({
      kind: "structural",
      shape: { kind: "reference", arguments: [{ kind: "primitive", name: "string" }] },
    });

    if (stringBox?.kind !== "structural" || stringBox.shape.kind !== "reference")
      throw new Error("Expected an instantiated Box<string> reference");

    expect(stringBox.shape.surface.properties.find((item) => item.name === "value")).toMatchObject({
      name: "value",
      type: { kind: "type-parameter", identity: "$/surface/typeparam/0" },
    });

    const chain = entry("chain");

    expect(chain).toMatchObject({
      kind: "structural",
      shape: {
        kind: "reference",
        arguments: [{ kind: "primitive", name: "string" }],
      },
    });

    if (chain?.kind !== "structural" || chain.shape.kind !== "reference")
      throw new Error("Expected an instantiated Link reference");

    const next = chain.shape.surface.properties.find((item) => item.name === "next");

    expect(next).toMatchObject({ name: "next", optional: true, type: { kind: "union" } });

    if (next?.type.kind !== "union") throw new Error("Expected an optional recursive link");

    expect(next.type.types).toContainEqual({ kind: "primitive", name: "undefined" });
    expect(next.type.types.find((item) => item.kind === "recursive")).toMatchObject({
      kind: "recursive",
      path: "$/surface",
    });

    const lookup = entry("lookup");

    expect(lookup).toMatchObject({ kind: "structural", shape: { kind: "reference" } });

    if (lookup?.kind !== "structural" || lookup.shape.kind !== "reference")
      throw new Error("Expected a checked Lookup reference");

    expect(lookup.shape.surface.indexes).toHaveLength(1);
    expect(lookup.shape.surface.indexes[0]).toMatchObject({
      readonly: true,
      key: { kind: "primitive", name: "string" },
      type: { kind: "primitive", name: "number" },
    });

    const handler = entry("handler");

    expect(handler).toMatchObject({ kind: "structural", shape: { kind: "reference" } });

    if (handler?.kind !== "structural" || handler.shape.kind !== "reference")
      throw new Error("Expected a checked Handler reference");

    expect(handler.shape.surface.calls).toHaveLength(1);
    const signature = handler.shape.surface.calls[0]!;

    expect(signature.typeParameters).toHaveLength(1);
    expect(signature.typeParameters[0]).toMatchObject({
      kind: "type-parameter",
      constraint: { kind: "primitive", name: "string" },
      default: { kind: "literal", base: "string", value: "seed" },
    });
    expect(signature.parameters).toHaveLength(1);
    expect(signature.parameters[0]).toMatchObject({
      optional: false,
      rest: false,
      type: { kind: "type-parameter" },
    });
    expect(signature.returns).toMatchObject({ kind: "type-parameter" });

    const typeParameter = signature.typeParameters[0];
    const parameter = signature.parameters[0]?.type;
    const returns = signature.returns;

    if (
      typeParameter?.kind !== "type-parameter" ||
      parameter?.kind !== "type-parameter" ||
      returns.kind !== "type-parameter"
    )
      throw new Error("Expected correlated generic signature types");

    expect(parameter.identity).toBe(typeParameter.identity);
    expect(returns.identity).toBe(typeParameter.identity);
    expect(entry("secret")).toEqual({ kind: "unproved", reason: "nominal-origin" });
  } finally {
    await session.dispose();
  }
}, 120_000);

async function captureAuthoredPropEvidence(filename: string, source: string) {
  const session = await openCheckingProject(
    [{ filename, source }],
    requestTypingEvidenceCapture({ root: join(import.meta.dir, "../..") }),
  );

  try {
    const compilation = emitCheckingSession(session);
    const evidence = issuedProjectTypingEvidence(compilation);
    const module = evidence?.modules.find((item) => item.filename === filename);

    if (!evidence || !module) throw new Error("Expected issued evidence for the authored module");

    return { diagnostics: compilation.checking.diagnostics, evidence, module };
  } finally {
    await session.dispose();
  }
}

test("typing evidence preserves correlated indexed and conditional callback types", async () => {
  const source = `import type { Component } from "hesperia";
type Catalog = { title: string; count: number };
type Select = <K extends keyof Catalog>(key: K, value: Catalog[K]) => K extends "title" ? \`title:\${string}\` : \`count:\${number}\`;
export function Page(props: Component.Props<{ select: Select }>) {
  return <main>{props.select("title", "ok")}</main>;
}`;
  const valid = await captureAuthoredPropEvidence("checked-indexed-callback.tsx", source);

  expect(valid.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
  expect(valid.module.sourceJoin).toBe(true);
  const component = valid.module.components.find(
    (item) => item.parameterStart === source.indexOf("props: Component"),
  );

  expect(component?.emittedComponentJoin).toBe("matched");

  if (component?.props.kind !== "props") throw new Error("Expected checked callback props");

  const select = component.props.entries.find((item) => item.name === "select");

  expect(select).toMatchObject({
    name: "select",
    category: "callback",
    mappedType: { kind: "structural" },
  });

  if (select?.mappedType.kind !== "structural" || select.mappedType.shape.kind !== "reference")
    throw new Error("Expected a checked callback reference");

  const calls = select.mappedType.shape.surface.calls;

  expect(calls).toHaveLength(1);
  const signature = calls[0]!;
  const typeParameter = signature.typeParameters[0];
  const key = signature.parameters[0]?.type;
  const value = signature.parameters[1]?.type;
  const result = signature.returns;

  expect(typeParameter).toMatchObject({
    kind: "type-parameter",
    constraint: {
      kind: "union",
      types: expect.arrayContaining([
        { kind: "literal", base: "string", value: "title" },
        { kind: "literal", base: "string", value: "count" },
      ]),
    },
  });
  expect(value).toMatchObject({ kind: "indexed-access", index: { kind: "type-parameter" } });
  expect(result).toMatchObject({
    kind: "conditional",
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
  });

  if (
    typeParameter?.kind !== "type-parameter" ||
    key?.kind !== "type-parameter" ||
    value?.kind !== "indexed-access" ||
    value.index.kind !== "type-parameter" ||
    result.kind !== "conditional" ||
    result.check.kind !== "type-parameter"
  )
    throw new Error("Expected a correlated generic callback");

  expect(key.identity).toBe(typeParameter.identity);
  expect(value.index.identity).toBe(typeParameter.identity);
  expect(result.check.identity).toBe(typeParameter.identity);

  const invalid = await captureAuthoredPropEvidence(
    "invalid-indexed-callback.tsx",
    source.replace('props.select("title", "ok")', 'props.select("title", 1)'),
  );

  expect(
    invalid.diagnostics.some((item) => item.code === "TS2345" && item.severity === "error"),
  ).toBe(true);
  expect(invalid.evidence.checkingHasErrors).toBe(true);
  expect(invalid.module.sourceJoin).toBe(false);
}, 120_000);

test("typing evidence retains intrinsic string mapping and its generic parameter", async () => {
  const source = `import type { Component } from "hesperia";
type Upper = <T extends string>(value: T) => Uppercase<T>;
export function Page(props: Component.Props<{ upper: Upper }>) {
  return <main>{props.upper("ok")}</main>;
}`;
  const result = await captureAuthoredPropEvidence("checked-string-mapping.tsx", source);

  expect(result.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
  expect(result.module.sourceJoin).toBe(true);
  const component = result.module.components.find(
    (item) => item.parameterStart === source.indexOf("props: Component"),
  );

  expect(component?.emittedComponentJoin).toBe("matched");

  if (component?.props.kind !== "props") throw new Error("Expected checked string-mapping props");

  const upper = component.props.entries.find((item) => item.name === "upper")?.mappedType;

  if (upper?.kind !== "structural" || upper.shape.kind !== "reference")
    throw new Error("Expected a checked intrinsic string-mapping callback");

  expect(upper.shape.surface.calls).toHaveLength(1);
  const upperCall = upper.shape.surface.calls[0]!;
  const upperParameter = upperCall.typeParameters[0];
  const upperReturn = upperCall.returns;

  expect(upperParameter).toMatchObject({
    kind: "type-parameter",
    constraint: { kind: "primitive", name: "string" },
  });
  expect(upperReturn).toMatchObject({ kind: "string-mapping", operation: "Uppercase" });

  if (
    upperParameter?.kind !== "type-parameter" ||
    upperReturn.kind !== "string-mapping" ||
    upperReturn.target.kind !== "type-parameter"
  )
    throw new Error("Expected the intrinsic mapping to retain its type parameter");

  expect(upperReturn.target.identity).toBe(upperParameter.identity);
}, 120_000);

test("typing evidence refuses unbound array and tuple surfaces", async () => {
  const source = `import type { Component } from "hesperia";
type Pair = readonly [label: string, count?: number];
export function Page(props: Component.Props<{ pair: Pair; values: readonly string[] }>) {
  return <main>{props.pair()[0]} {props.values()[0]}</main>;
}`;
  const result = await captureAuthoredPropEvidence("checked-collection-props.tsx", source);

  expect(result.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
  expect(result.module.sourceJoin).toBe(true);
  const component = result.module.components.find(
    (item) => item.parameterStart === source.indexOf("props: Component"),
  );

  expect(component?.emittedComponentJoin).toBe("matched");

  if (component?.props.kind !== "props") throw new Error("Expected checked collection props");

  expect(component.props.entries.find((item) => item.name === "pair")?.mappedType).toEqual({
    kind: "unproved",
    reason: "free-instantiation",
  });
  expect(component.props.entries.find((item) => item.name === "values")?.mappedType).toEqual({
    kind: "unproved",
    reason: "free-instantiation",
  });
}, 120_000);

test("typing evidence distinguishes the intrinsic iterator from a local symbol", async () => {
  const genuine = await captureAuthoredPropEvidence(
    "checked-intrinsic-iterator.tsx",
    `import type { Component } from "hesperia";
interface Sequence { [Symbol.iterator](): { next(): { value: string; done: boolean } } }
export function Page(props: Component.Props<{ item: Sequence }>) { return <span>{props.item().toString()}</span>; }`,
  );
  const lookalike = await captureAuthoredPropEvidence(
    "checked-local-iterator.tsx",
    `import type { Component } from "hesperia";
declare const token: unique symbol;
const Symbol = { iterator: token } as const;
interface Sequence { [Symbol.iterator](): string }
export function Page(props: Component.Props<{ item: Sequence }>) { return <span>{props.item().toString()}</span>; }`,
  );

  for (const result of [genuine, lookalike]) {
    expect(result.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    expect(result.module.sourceJoin).toBe(true);
    expect(result.module.components[0]?.emittedComponentJoin).toBe("matched");
  }

  const genuineProps = genuine.module.components[0]?.props;
  const localProps = lookalike.module.components[0]?.props;

  if (genuineProps?.kind !== "props" || localProps?.kind !== "props")
    throw new Error("Expected checked iterator props");

  const genuineType = genuineProps.entries.find((item) => item.name === "item")?.mappedType;

  expect(genuineType).toMatchObject({ kind: "structural", shape: { kind: "reference" } });

  if (genuineType?.kind !== "structural" || genuineType.shape.kind !== "reference")
    throw new Error("Expected the intrinsic iterator reference");

  expect(
    genuineType.shape.surface.properties.some((item) => item.name === "[Symbol.iterator]"),
  ).toBe(true);
  expect(localProps.entries.find((item) => item.name === "item")?.mappedType).toEqual({
    kind: "unproved",
    reason: "symbol-origin",
  });
}, 120_000);

test("typing evidence rejects inconsistent mapped checking diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-typing-diagnostics-"));
  const filename = join(root, "entry.ts");
  let session: Awaited<ReturnType<typeof openCheckingProject>> | undefined;

  try {
    session = await openCheckingProject(
      [{ filename, source: "export const value: string = 42;" }],
      requestTypingEvidenceCapture({ root }),
    );
    const checking = session.result;
    const analysis = session.analyses.get(filename);

    expect(checkedSourceOrigin(session, checking)).toBeUndefined();
    expect(analysis && checkedAnalysisOrigin(analysis)).toBeUndefined();
    const compilation = emitCheckingSession(session);
    const evidence = issuedProjectTypingEvidence(compilation);

    expect(compilation.checking.diagnostics.some((item) => item.code === "TS2322")).toBe(true);
    expect(compilation.modules.size).toBe(0);
    expect(evidence).toMatchObject({
      checkingHasErrors: true,
      modulePopulationJoin: false,
      certificates: [],
    });
    expect(evidence?.modules[0]).toMatchObject({
      sourceJoin: false,
      emittedModuleAvailable: false,
    });

    const checked = compilation.checking.modules.map((module) => ({
      ...module,
      diagnostics: module.diagnostics.map((item) => ({ ...item })),
    }));
    const mapped = {
      ...compilation,
      checking: {
        ...compilation.checking,
        modules: checked,
        diagnostics: checked.flatMap((module) => module.diagnostics.map((item) => ({ ...item }))),
      },
      modules: new Map(compilation.modules),
    };

    expect(registerMappedProjectCompilation(compilation, mapped)).toBe(true);
    expect(issuedProjectTypingEvidence(mapped)).toBe(evidence);

    const inconsistent = {
      ...mapped,
      checking: {
        ...mapped.checking,
        diagnostics: mapped.checking.diagnostics.map((item, index) =>
          index === 0 ? { ...item, message: `${item.message} (altered)` } : item,
        ),
      },
    };

    expect(registerMappedProjectCompilation(compilation, inconsistent)).toBe(false);
    expect(issuedProjectTypingEvidence(inconsistent)).toBeUndefined();
    expect(issuedProjectTypingEvidence(mapped)).toBe(evidence);
  } finally {
    await session?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("captures a declaration on first existence check and keeps its bytes immutable", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-checking-inputs-"));
  const physicalRoot = join(root, "physical");
  const aliasRoot = join(root, "alias");
  const declaration = join(physicalRoot, "node_modules/replacement/types/api.d.ts");
  const aliasedDeclaration = join(aliasRoot, "node_modules/replacement/types/api.d.ts");

  try {
    await mkdir(physicalRoot);
    await symlink(physicalRoot, aliasRoot, process.platform === "win32" ? "junction" : "dir");
    await mkdir(join(physicalRoot, "node_modules/replacement/types"), { recursive: true });

    await writeFile(declaration, "export declare const label: string;", { encoding: "utf8" });

    const snapshot = new CheckingInputSnapshot(new Map());

    expect(snapshot.fileExists(declaration)).toBe(true);

    expect(snapshot.captured).toHaveLength(1);

    const captured = snapshot.captured[0]!;

    expect(captured.filename).toBe(declaration);

    expect(captured.source).toContain("label: string");

    await writeFile(declaration, "export declare const label: number;", { encoding: "utf8" });

    expect(snapshot.readFile(declaration)).toBe(captured.source);

    expect(snapshot.readFile(aliasedDeclaration)).toBe(captured.source);

    expect(snapshot.captured[0]!.digest).toBe(captured.digest);

    await rm(declaration);

    expect(snapshot.fileExists(declaration)).toBe(true);

    expect(snapshot.fileExists(aliasedDeclaration)).toBe(true);

    expect(snapshot.readFile(declaration)).toBe(captured.source);

    expect(snapshot.readFile(aliasedDeclaration)).toBe(captured.source);

    const virtual = new CheckingInputSnapshot(
      new Map([
        [normalizeFilename(aliasedDeclaration), "virtual alias source"],
        [normalizeFilename(declaration), "virtual physical source"],
      ]),
    );

    expect(virtual.readFile(declaration)).toBe("virtual physical source");

    expect(virtual.readFile(aliasedDeclaration)).toBe("virtual alias source");

    const lateFiles = new Map<string, string>();
    const lateVirtual = new CheckingInputSnapshot(lateFiles);

    lateFiles.set(normalizeFilename(aliasedDeclaration), "virtual alias source added later");

    expect(lateVirtual.readFile(declaration)).toBe("virtual alias source added later");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("remembers a missing declaration instead of falling back after it appears", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-checking-inputs-"));
  const physicalRoot = join(root, "physical");
  const aliasRoot = join(root, "alias");
  const declaration = join(physicalRoot, "node_modules/replacement/types/api.d.ts");
  const aliasedDeclaration = join(aliasRoot, "node_modules/replacement/types/api.d.ts");

  try {
    await mkdir(physicalRoot);
    await symlink(physicalRoot, aliasRoot, process.platform === "win32" ? "junction" : "dir");

    const snapshot = new CheckingInputSnapshot(new Map());

    expect(snapshot.fileExists(declaration)).toBe(false);

    await mkdir(join(physicalRoot, "node_modules/replacement/types"), { recursive: true });

    await writeFile(declaration, "export declare const label: string;", { encoding: "utf8" });

    expect(snapshot.fileExists(declaration)).toBe(false);

    expect(snapshot.fileExists(aliasedDeclaration)).toBe(false);

    expect(snapshot.readFile(declaration)).toBeNull();

    expect(snapshot.readFile(aliasedDeclaration)).toBeNull();

    expect(snapshot.captured).toStrictEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("checking captures dependencies of the supplied project without opening an extra workspace project", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-checking-project-"));
  const dependency = join(root, "other-types.d.ts");
  const other = {
    filename: join(root, "other.ts"),
    source: 'import type { Other } from "./other-types.d.ts"; export const other: Other = 1;',
  };
  const entry = { filename: join(root, "entry.ts"), source: "export const value = 1;" };

  try {
    await writeFile(dependency, "export type Other = number;");

    await writeFile(other.filename, other.source);

    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ESNext",
          module: "ESNext",
          moduleResolution: "Bundler",
          types: [],
          skipLibCheck: true,
        },
        include: ["other.ts"],
      }),
    );

    const selected = await checkProjectModules([entry], { root });

    expect(selected.diagnostics).toStrictEqual([]);

    expect(selected.checkingInputs.some((input) => input.filename === dependency)).toBe(false);

    const included = await checkProjectModules([entry, other], { root });

    expect(included.diagnostics).toStrictEqual([]);

    expect(included.checkingInputs.some((input) => input.filename === dependency)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repeated checking retains the captured public type target in dependency records", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-reused-checking-inputs-"));
  const library = join(root, "node_modules/replacement");
  const declaration = join(library, "index.d.ts");
  const entry = {
    filename: join(root, "entry.ts"),
    source: 'import { label } from "chosen-library"; export const display: string = label;',
  };
  const original = "export declare const label: string;";
  const updated = "export declare const label: number;";
  const resolutionOverrides = { browser: { "chosen-library": "replacement" } };

  try {
    await mkdir(library, { recursive: true });

    await writeFile(
      join(library, "package.json"),
      JSON.stringify({
        name: "replacement",
        type: "module",
        exports: { ".": { types: "./index.d.ts", default: "./index.js" } },
      }),
    );

    await writeFile(join(library, "index.js"), 'export const label = "initial";');

    await writeFile(declaration, original);

    const sources = new Map([[entry.filename, entry.source]]);
    const resolution = new ModuleResolver(root, sources, "production", resolutionOverrides.browser);
    const options = { root, resolution, resolutionOverrides, browserTarget: true };
    const initial = await checkProjectModules([entry], options);

    const declarationIdentity = normalizeFilename(realpathSync(declaration));
    const dependency = (result: typeof initial) =>
      result.checkingInputs.find(
        (input) => normalizeFilename(realpathSync(input.filename)) === declarationIdentity,
      );

    expect(initial.diagnostics).toStrictEqual([]);

    expect(dependency(initial)?.source).toBe(original);

    await writeFile(declaration, updated);

    const repeated = await checkProjectModules([entry], options);

    expect(repeated.diagnostics).toStrictEqual([]);

    expect(dependency(repeated)).toStrictEqual(dependency(initial));

    const refreshed = await checkProjectModules([entry], {
      ...options,
      resolution: new ModuleResolver(root, sources, "production", resolutionOverrides.browser),
    });

    expect(refreshed.diagnostics.some((item) => item.code === "TS2322")).toBe(true);

    expect(dependency(refreshed)?.source).toBe(updated);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("each checking project keeps the dependency bytes captured for its own revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-checking-revisions-"));
  const dependency = join(root, "dependency.d.ts");
  const entry = join(root, "entry.ts");
  const module = {
    filename: entry,
    source: 'import { value } from "./dependency.d.ts"; export const numeric: number = value;',
  };
  let original: Awaited<ReturnType<typeof openCheckingProject>> | undefined;
  let refreshed: Awaited<ReturnType<typeof openCheckingProject>> | undefined;

  try {
    await writeFile(dependency, "export declare const value: string;");

    original = await openCheckingProject([module], { root });
    const originalInput = original.result.checkingInputs.find(
      (input) =>
        input.filename.replaceAll("\\", "/").toLowerCase() ===
        dependency.replaceAll("\\", "/").toLowerCase(),
    );

    expect(originalInput?.source).toBe("export declare const value: string;");

    expect(original.result.diagnostics.some((item) => item.code === "TS2322")).toBe(true);

    await writeFile(dependency, "export declare const value: number;");

    expect(originalInput?.source).toBe("export declare const value: string;");

    refreshed = await openCheckingProject([module], { root });
    const refreshedInput = refreshed.result.checkingInputs.find(
      (input) =>
        input.filename.replaceAll("\\", "/").toLowerCase() ===
        dependency.replaceAll("\\", "/").toLowerCase(),
    );

    expect(refreshedInput?.source).toBe("export declare const value: number;");

    expect(refreshed.result.diagnostics.some((item) => item.code === "TS2322")).toBe(false);
  } finally {
    await Promise.all([original?.dispose(), refreshed?.dispose()]);

    await rm(root, { recursive: true, force: true });
  }
});
