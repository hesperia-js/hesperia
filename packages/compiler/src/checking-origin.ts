import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type { Project } from "typescript/unstable/async";
import type { CheckingView } from "./checking-view.ts";
import type { CheckingInputSnapshot } from "./checking-inputs.ts";
import type { ModuleAnalysis } from "./compilation.ts";
import type { CheckingSession, ProjectCheckingResult, VirtualModule } from "./checking.ts";
import { normalizeFilename } from "./utils.ts";

export interface CapturedCheckingModules {
  readonly modules: readonly VirtualModule[];
  readonly sourceFacts: readonly {
    readonly filename: string;
    readonly source: string;
    readonly sourceDigest: string;
  }[];
}

export interface CheckedAnalysisOrigin {
  readonly filename: string;
  readonly analysis: ModuleAnalysis;
  readonly emissionAnalysis: ModuleAnalysis;
  readonly sourceDigest: string;
  readonly fingerprint: string;
  readonly mapOffset: ModuleAnalysis["mapOffset"];
}

export interface CheckedSourceOrigin {
  readonly project: Project;
  readonly session: CheckingSession;
  readonly population: readonly {
    readonly filename: string;
    readonly source: string;
    readonly sourceDigest: string;
    readonly nativeKey: string;
  }[];
  readonly analyses: ReadonlyMap<string, CheckedAnalysisOrigin>;
  readonly analysisEntries: readonly (readonly [string, ModuleAnalysis])[];
  readonly viewEntries: readonly (readonly [string, CheckingView])[];
  readonly inputSnapshot: CheckingInputSnapshot;
  readonly isActive: () => boolean;
}

interface ResultRecord {
  readonly owner: Owner;
  readonly result: ProjectCheckingResult;
  readonly checkingInputs: ProjectCheckingResult["checkingInputs"];
  readonly encoding: string;
}

interface Owner extends CheckedSourceOrigin {
  readonly sessionShape: string;
  readonly analysisMap: ReadonlyMap<string, ModuleAnalysis>;
  readonly viewMap: ReadonlyMap<string, CheckingView>;
  readonly dispose: CheckingSession["dispose"];
  readonly fixedResult: string;
}

interface DiagnosticOwner {
  readonly project: Project;
  readonly session: CheckingSession;
  readonly inputSnapshot: CheckingInputSnapshot;
  readonly isActive: () => boolean;
  readonly sessionShape: string;
  readonly analysisMap: ReadonlyMap<string, ModuleAnalysis>;
  readonly viewMap: ReadonlyMap<string, CheckingView>;
  readonly analysisEntries: readonly (readonly [string, ModuleAnalysis])[];
  readonly viewEntries: readonly (readonly [string, CheckingView])[];
  readonly analysisFacts: readonly {
    readonly analysis: ModuleAnalysis;
    readonly fingerprint: string;
    readonly mapOffset: ModuleAnalysis["mapOffset"];
  }[];
  readonly viewFacts: readonly {
    readonly nativeKey: string;
    readonly view: CheckingView;
    readonly source: string;
    readonly diagnostics: string;
    readonly mapOffset: CheckingView["mapOffset"];
    readonly generatedOffset: CheckingView["generatedOffset"];
  }[];
  readonly finalFiles: ReadonlyMap<string, string>;
  readonly dispose: CheckingSession["dispose"];
  readonly fixedResult: string;
}

interface DiagnosticResultRecord {
  readonly owner: DiagnosticOwner;
  readonly result: ProjectCheckingResult;
  readonly checkingInputs: ProjectCheckingResult["checkingInputs"];
  readonly encoding: string;
}

const projectOwners = new WeakMap<Project, Owner>();
const sessionOwners = new WeakMap<CheckingSession, Owner>();
const analysisOwners = new WeakMap<
  ModuleAnalysis,
  { readonly owner: Owner; readonly fact: CheckedAnalysisOrigin }
>();
const resultOwners = new WeakMap<ProjectCheckingResult, ResultRecord>();
const diagnosticProjectOwners = new WeakMap<Project, DiagnosticOwner>();
const diagnosticSessionOwners = new WeakMap<CheckingSession, DiagnosticOwner>();
const diagnosticResultOwners = new WeakMap<ProjectCheckingResult, DiagnosticResultRecord>();
const objectIds = new WeakMap<object, number>();
const symbolIds = new Map<symbol, number>();
let nextId = 1;

/**
 * Copy eligible own-data module inputs synchronously. If a malformed input or accessor is
 * present, return undefined so the caller keeps its existing ordinary-checker path.
 */
export function captureCheckingModules(
  modules: readonly VirtualModule[],
): CapturedCheckingModules | undefined {
  try {
    const copied: VirtualModule[] = [];
    const facts: { filename: string; source: string; sourceDigest: string }[] = [];

    for (let index = 0; index < modules.length; index++) {
      const item = Object.getOwnPropertyDescriptor(modules, String(index));

      if (!item || !("value" in item)) return undefined;
      const value: unknown = item.value;

      if (typeof value !== "object" || value === null) return undefined;
      const filename = Object.getOwnPropertyDescriptor(value, "filename");
      const source = Object.getOwnPropertyDescriptor(value, "source");

      if (
        !filename ||
        !("value" in filename) ||
        typeof filename.value !== "string" ||
        !source ||
        !("value" in source) ||
        typeof source.value !== "string"
      )
        return undefined;

      const module = Object.freeze({ filename: filename.value, source: source.value });

      copied.push(module);
      facts.push(
        Object.freeze({
          filename: filename.value,
          source: source.value,
          sourceDigest: digest(source.value),
        }),
      );
    }

    return Object.freeze({
      modules: Object.freeze(copied),
      sourceFacts: Object.freeze(facts),
    });
  } catch {
    return undefined;
  }
}

export function nativePopulation(
  captured: CapturedCheckingModules | undefined,
  root: string,
): CheckedSourceOrigin["population"] | undefined {
  try {
    if (!captured) return undefined;
    const keys = new Set<string>();
    const population: {
      filename: string;
      source: string;
      sourceDigest: string;
      nativeKey: string;
    }[] = [];

    for (const fact of captured.sourceFacts) {
      const path = isAbsolute(fact.filename)
        ? resolve(fact.filename)
        : resolve(root, fact.filename);
      const nativeKey = normalizeFilename(path);

      if (keys.has(nativeKey)) return undefined;
      keys.add(nativeKey);
      population.push(Object.freeze({ ...fact, nativeKey }));
    }

    return Object.freeze(population);
  } catch {
    return undefined;
  }
}
/**
 * Constructor-only issuer, called in createCheckingSession after successful native checking and
 * before returning the session. It captures fixed result/session baselines once.
 */
export function issueNativeCheckingOrigin(
  project: Project,
  session: CheckingSession,
  population: CheckedSourceOrigin["population"] | undefined,
  analyses: ReadonlyMap<string, ModuleAnalysis>,
  views: ReadonlyMap<string, CheckingView>,
  finalFiles: ReadonlyMap<string, string>,
  inputSnapshot: CheckingInputSnapshot,
  internalResult: ProjectCheckingResult,
  isActive: () => boolean,
): (
  result: ProjectCheckingResult,
  checkingInputs: ProjectCheckingResult["checkingInputs"],
) => void {
  const refuse = (
    _result: ProjectCheckingResult,
    _checkingInputs: ProjectCheckingResult["checkingInputs"],
  ): void => {};

  if (!population || session.project !== project) return refuse;

  if (internalResult.diagnostics.some((item) => item.severity === "error"))
    return issueDiagnosticCheckingSession(
      project,
      session,
      population,
      analyses,
      views,
      finalFiles,
      inputSnapshot,
      internalResult,
      isActive,
    );

  const analysisFacts = new Map<string, CheckedAnalysisOrigin>();
  const expectedAnalysisNames: string[] = [];

  for (const module of population) {
    const view = views.get(module.nativeKey);

    if (!view || view.source !== finalFiles.get(module.nativeKey)) return refuse;

    if (!/\.(?:ts|tsx|mts)$/u.test(module.filename)) continue;
    expectedAnalysisNames.push(module.filename);
    const analysis = analyses.get(module.filename);

    if (!analysis || analysis.authoredSourceDigest !== module.sourceDigest) return refuse;
    const emission = captureEmissionAnalysis(analysis);

    if (!emission) return refuse;
    analysisFacts.set(
      module.filename,
      Object.freeze({
        filename: module.filename,
        analysis,
        emissionAnalysis: emission.analysis,
        sourceDigest: module.sourceDigest,
        fingerprint: emission.fingerprint,
        mapOffset: analysis.mapOffset,
      }),
    );
  }

  if (
    analyses.size !== expectedAnalysisNames.length ||
    !sameMapKeys(analyses, expectedAnalysisNames)
  )
    return refuse;

  const analysisEntries = freezeEntries(analyses);
  const viewEntries = freezeEntries(views);
  const fixedResult = encodeFixedResult(internalResult);
  const sessionShape = encodeSessionShape(session);

  if (!fixedResult || !sessionShape) return refuse;

  const owner: Owner = Object.freeze({
    project,
    session,
    population,
    analyses: analysisFacts,
    analysisEntries,
    viewEntries,
    inputSnapshot,
    isActive,
    sessionShape,
    analysisMap: analyses,
    viewMap: views,
    dispose: session.dispose,
    fixedResult,
  });

  projectOwners.set(project, owner);
  sessionOwners.set(session, owner);
  for (const fact of analysisFacts.values()) analysisOwners.set(fact.analysis, { owner, fact });

  return (result, checkingInputs): void => {
    try {
      if (
        projectOwners.get(project) !== owner ||
        sessionOwners.get(session) !== owner ||
        !owner.isActive() ||
        !sourceOwnerIntact(session, owner) ||
        result.checkingInputs !== checkingInputs ||
        !inputSnapshot.ownsCaptured(checkingInputs) ||
        encodeFixedResult(internalResult) !== owner.fixedResult ||
        encodeFixedResult(result) !== owner.fixedResult
      )
        return;

      const encoding = encodeIssuedResult(result);

      if (encoding === undefined) return;
      resultOwners.set(result, Object.freeze({ owner, result, checkingInputs, encoding }));
    } catch {
      return;
    }
  };
}

/** Exact actual project/session/result join. Existing issued results remain usable after disposal. */
export function checkedSourceOrigin(
  session: CheckingSession,
  result: ProjectCheckingResult,
): CheckedSourceOrigin | undefined {
  try {
    const owner = sessionOwners.get(session);
    const resultRecord = resultOwners.get(result);

    if (
      !owner ||
      !resultRecord ||
      resultRecord.owner !== owner ||
      resultRecord.result !== result ||
      !sourceOwnerIntact(session, owner) ||
      !issuedResultIntact(result, resultRecord)
    )
      return undefined;

    return owner;
  } catch {
    return undefined;
  }
}

/** Keep the admitted owner live while the private typing inventory is being collected. */
export function nativeCheckingSessionGuard(
  session: CheckingSession,
  initialResult: ProjectCheckingResult,
  inputSnapshot: CheckingInputSnapshot,
  internalResult: ProjectCheckingResult,
): (() => boolean) | undefined {
  try {
    const owner = sessionOwners.get(session);

    if (
      !owner ||
      owner.inputSnapshot !== inputSnapshot ||
      checkedSourceOrigin(session, initialResult) !== owner ||
      !inputSnapshot.ownsCaptured(initialResult.checkingInputs) ||
      encodeFixedResult(internalResult) !== owner.fixedResult
    )
      return undefined;

    return (): boolean => {
      try {
        return (
          owner.isActive() &&
          sourceOwnerIntact(session, owner) &&
          encodeFixedResult(internalResult) === owner.fixedResult &&
          inputSnapshot.ownsCaptured(inputSnapshot.captured)
        );
      } catch {
        return false;
      }
    };
  } catch {
    return undefined;
  }
}
/** New emissions may enroll only from an unchanged active native session. */
export function checkedAnalysisOrigin(
  analysis: ModuleAnalysis,
): { readonly origin: CheckedSourceOrigin; readonly fact: CheckedAnalysisOrigin } | undefined {
  try {
    const found = analysisOwners.get(analysis);

    if (!found || !found.owner.isActive()) return undefined;
    const mapOffset = ownData(analysis, "mapOffset");

    if (
      !mapOffset.ok ||
      found.fact.analysis !== analysis ||
      mapOffset.value !== found.fact.mapOffset ||
      analysisFingerprint(analysis) !== found.fact.fingerprint ||
      !sourceOwnerIntact(found.owner.session, found.owner)
    )
      return undefined;

    return { origin: found.owner, fact: found.fact };
  } catch {
    return undefined;
  }
}

function issueDiagnosticCheckingSession(
  project: Project,
  session: CheckingSession,
  population: CheckedSourceOrigin["population"],
  analyses: ReadonlyMap<string, ModuleAnalysis>,
  views: ReadonlyMap<string, CheckingView>,
  finalFiles: ReadonlyMap<string, string>,
  inputSnapshot: CheckingInputSnapshot,
  internalResult: ProjectCheckingResult,
  isActive: () => boolean,
): (
  result: ProjectCheckingResult,
  checkingInputs: ProjectCheckingResult["checkingInputs"],
) => void {
  const refuse = (): void => {};

  try {
    const analysisFacts: DiagnosticOwner["analysisFacts"][number][] = [];
    const viewFacts: DiagnosticOwner["viewFacts"][number][] = [];
    const expectedAnalysisNames: string[] = [];

    for (const module of population) {
      const view = views.get(module.nativeKey);
      const diagnostics = view && checkedDataEncoding(view.diagnostics, false);

      if (!view || view.source !== finalFiles.get(module.nativeKey) || diagnostics === undefined)
        return refuse;

      viewFacts.push(
        Object.freeze({
          nativeKey: module.nativeKey,
          view,
          source: view.source,
          diagnostics,
          mapOffset: view.mapOffset,
          generatedOffset: view.generatedOffset,
        }),
      );

      if (!/\.(?:ts|tsx|mts)$/u.test(module.filename)) continue;
      expectedAnalysisNames.push(module.filename);
      const analysis = analyses.get(module.filename);
      const fingerprint = analysis && analysisFingerprint(analysis);

      if (!analysis || analysis.authoredSourceDigest !== module.sourceDigest || !fingerprint)
        return refuse;

      analysisFacts.push(Object.freeze({ analysis, fingerprint, mapOffset: analysis.mapOffset }));
    }

    if (
      analyses.size !== expectedAnalysisNames.length ||
      !sameMapKeys(analyses, expectedAnalysisNames)
    )
      return refuse;

    const fixedResult = encodeFixedResult(internalResult);
    const sessionShape = encodeSessionShape(session);

    if (!fixedResult || !sessionShape) return refuse;

    const owner: DiagnosticOwner = Object.freeze({
      project,
      session,
      inputSnapshot,
      isActive,
      sessionShape,
      analysisMap: analyses,
      viewMap: views,
      analysisEntries: freezeEntries(analyses),
      viewEntries: freezeEntries(views),
      analysisFacts: Object.freeze(analysisFacts),
      viewFacts: Object.freeze(viewFacts),
      finalFiles,
      dispose: session.dispose,
      fixedResult,
    });

    diagnosticProjectOwners.set(project, owner);
    diagnosticSessionOwners.set(session, owner);

    return (result, checkingInputs): void => {
      try {
        if (
          !diagnosticOwnerIntact(session, owner) ||
          result.checkingInputs !== checkingInputs ||
          !inputSnapshot.ownsCaptured(checkingInputs) ||
          encodeFixedResult(internalResult) !== owner.fixedResult ||
          encodeFixedResult(result) !== owner.fixedResult
        )
          return;

        const encoding = encodeIssuedResult(result);

        if (encoding === undefined) return;

        diagnosticResultOwners.set(
          result,
          Object.freeze({ owner, result, checkingInputs, encoding }),
        );
      } catch {
        return;
      }
    };
  } catch {
    return refuse;
  }
}

function diagnosticOwnerIntact(session: CheckingSession, owner: DiagnosticOwner): boolean {
  if (
    !owner.isActive() ||
    diagnosticProjectOwners.get(owner.project) !== owner ||
    diagnosticSessionOwners.get(session) !== owner ||
    session !== owner.session ||
    session.project !== owner.project ||
    session.analyses !== owner.analysisMap ||
    session.views !== owner.viewMap ||
    session.dispose !== owner.dispose ||
    encodeSessionShape(session) !== owner.sessionShape ||
    !sameEntries(session.analyses, owner.analysisEntries) ||
    !sameEntries(session.views, owner.viewEntries)
  )
    return false;

  for (const fact of owner.analysisFacts) {
    const mapOffset = ownData(fact.analysis, "mapOffset");

    if (
      !mapOffset.ok ||
      mapOffset.value !== fact.mapOffset ||
      analysisFingerprint(fact.analysis) !== fact.fingerprint
    )
      return false;
  }

  return owner.viewFacts.every(
    (fact) =>
      fact.view.source === fact.source &&
      owner.finalFiles.get(fact.nativeKey) === fact.source &&
      fact.view.mapOffset === fact.mapOffset &&
      fact.view.generatedOffset === fact.generatedOffset &&
      checkedDataEncoding(fact.view.diagnostics, false) === fact.diagnostics,
  );
}

function diagnosticResultIntact(
  result: ProjectCheckingResult,
  record: DiagnosticResultRecord,
): boolean {
  return (
    diagnosticResultOwners.get(result) === record &&
    record.result === result &&
    result.checkingInputs === record.checkingInputs &&
    encodeIssuedResult(result) === record.encoding
  );
}

/** Bind diagnostic capture to the same active error-bearing session without issuing an origin. */
export function diagnosticCheckingSessionGuard(
  session: CheckingSession,
  initialResult: ProjectCheckingResult,
  inputSnapshot: CheckingInputSnapshot,
): ((current: ProjectCheckingResult) => boolean) | undefined {
  try {
    const owner = diagnosticSessionOwners.get(session);
    const initial = diagnosticResultOwners.get(initialResult);

    if (
      !owner ||
      owner.inputSnapshot !== inputSnapshot ||
      !initial ||
      initial.owner !== owner ||
      !diagnosticOwnerIntact(session, owner) ||
      !diagnosticResultIntact(initialResult, initial) ||
      !inputSnapshot.ownsCaptured(initialResult.checkingInputs)
    )
      return undefined;

    return (current): boolean => {
      try {
        const record = diagnosticResultOwners.get(current);

        return Boolean(
          owner.inputSnapshot === inputSnapshot &&
          diagnosticOwnerIntact(session, owner) &&
          diagnosticResultIntact(initialResult, initial) &&
          record &&
          record.owner === owner &&
          diagnosticResultIntact(current, record) &&
          inputSnapshot.ownsCaptured(current.checkingInputs),
        );
      } catch {
        return false;
      }
    };
  } catch {
    return undefined;
  }
}

export function checkedDataEncoding(value: unknown, includeIdentity = true): string | undefined {
  try {
    const encoded = encodeData(value, new WeakSet<object>(), includeIdentity);

    return encoded === undefined ? undefined : JSON.stringify(encoded);
  } catch {
    return undefined;
  }
}

export function analysisFingerprint(analysis: ModuleAnalysis): string | undefined {
  const result = ownData(analysis, "result");

  if (!result.ok || typeof result.value !== "object" || result.value === null) return undefined;
  const canonical = ownData(result.value, "ir");
  const semanticHash = ownData(result.value, "semanticHash");
  const diagnostics = ownData(result.value, "diagnostics");
  const sourceDigest = ownData(analysis, "authoredSourceDigest");
  const normalized = ownData(analysis, "normalized");
  const props = ownData(analysis, "componentProps");
  const operations = ownData(analysis, "operationCalls");

  if (
    !canonical.ok ||
    !semanticHash.ok ||
    !diagnostics.ok ||
    !sourceDigest.ok ||
    !normalized.ok ||
    !props.ok ||
    !operations.ok
  )
    return undefined;

  let normalizedCode: unknown;

  if (normalized.value === undefined) {
    normalizedCode = undefined;
  } else if (typeof normalized.value === "object" && normalized.value !== null) {
    const code = ownData(normalized.value, "code");

    if (!code.ok) return undefined;
    normalizedCode = code.value;
  } else {
    return undefined;
  }

  const encoded = checkedDataEncoding(
    {
      sourceDigest: sourceDigest.value,
      canonical: canonical.value,
      semanticHash: semanticHash.value,
      diagnostics: diagnostics.value,
      normalized: normalizedCode,
      props: props.value,
      operations: operations.value,
    },
    false,
  );

  return encoded === undefined ? undefined : digest(encoded);
}

function captureEmissionAnalysis(
  analysis: ModuleAnalysis,
): { readonly analysis: ModuleAnalysis; readonly fingerprint: string } | undefined {
  try {
    const result = analysis.result;
    const normalized = analysis.normalized;
    const projection = copyPlainData({
      sourceDigest: analysis.authoredSourceDigest,
      canonical: result.ir,
      semanticHash: result.semanticHash,
      diagnostics: result.diagnostics,
      normalized: normalized?.code,
      props: analysis.componentProps,
      operations: analysis.operationCalls,
    });
    const encoded = checkedDataEncoding(projection, false);

    if (encoded === undefined) return undefined;
    const fingerprint = digest(encoded);

    if (fingerprint !== analysisFingerprint(analysis)) return undefined;

    // Freeze only our descriptor copy, after recording its original descriptor shape.
    freezePlainData(projection);

    return {
      fingerprint,
      analysis: Object.freeze({
        ...analysis,
        result: Object.freeze({
          ...result,
          ir: projection.canonical,
          semanticHash: projection.semanticHash,
          diagnostics: projection.diagnostics,
        }),
        authoredSourceDigest: projection.sourceDigest,
        normalized:
          projection.normalized === undefined
            ? undefined
            : Object.freeze({ ...normalized, code: projection.normalized }),
        componentProps: projection.props,
        operationCalls: projection.operations,
      }),
    };
  } catch {
    return undefined;
  }
}

function copyPlainData<T>(value: T, active = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") {
    if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint")
      throw new TypeError("Unsupported checked analysis value.");

    return value;
  }

  if (active.has(value)) throw new TypeError("Cyclic checked analysis value.");
  const prototype = Object.getPrototypeOf(value);
  const array = Array.isArray(value);

  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
    throw new TypeError("Unsupported checked analysis prototype.");

  const copied: object = array ? [] : Object.create(prototype);

  active.add(value);

  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);

    if (!descriptor || !("value" in descriptor))
      throw new TypeError("Checked analysis requires own data properties.");

    Object.defineProperty(copied, key, {
      ...descriptor,
      value: copyPlainData(descriptor.value, active),
    });
  }

  active.delete(value);
  return copied as T;
}

function freezePlainData(value: unknown): void {
  if (value === null || typeof value !== "object") return;

  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);

    if (descriptor && "value" in descriptor) freezePlainData(descriptor.value);
  }

  Object.freeze(value);
}

function ownData(
  value: unknown,
  key: PropertyKey,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  try {
    if (typeof value !== "object" || value === null) return { ok: false };
    const descriptor = Object.getOwnPropertyDescriptor(value, key);

    if (!descriptor) return { ok: true, value: undefined };
    if (!("value" in descriptor)) return { ok: false };
    return { ok: true, value: descriptor.value };
  } catch {
    return { ok: false };
  }
}
function sourceOwnerIntact(session: CheckingSession, owner: Owner): boolean {
  if (
    projectOwners.get(owner.project) !== owner ||
    sessionOwners.get(session) !== owner ||
    session !== owner.session ||
    session.project !== owner.project ||
    session.analyses !== owner.analysisMap ||
    session.views !== owner.viewMap ||
    session.dispose !== owner.dispose ||
    encodeSessionShape(session) !== owner.sessionShape ||
    !sameEntries(session.analyses, owner.analysisEntries) ||
    !sameEntries(session.views, owner.viewEntries)
  )
    return false;

  for (const fact of owner.analyses.values()) {
    const mapOffset = ownData(fact.analysis, "mapOffset");

    if (
      !mapOffset.ok ||
      mapOffset.value !== fact.mapOffset ||
      analysisFingerprint(fact.analysis) !== fact.fingerprint
    )
      return false;
  }

  return true;
}

function issuedResultIntact(result: ProjectCheckingResult, record: ResultRecord): boolean {
  return (
    resultOwners.get(result) === record &&
    record.result === result &&
    result.checkingInputs === record.checkingInputs &&
    encodeIssuedResult(result) === record.encoding
  );
}

function sameMapKeys(map: ReadonlyMap<string, unknown>, expected: readonly string[]): boolean {
  if (map.size !== expected.length) return false;
  let index = 0;

  for (const key of map.keys()) if (key !== expected[index++]) return false;
  return true;
}

function freezeEntries<T>(map: ReadonlyMap<string, T>): readonly (readonly [string, T])[] {
  return Object.freeze([...map].map(([key, value]) => Object.freeze([key, value] as const)));
}

function sameEntries<T>(
  map: ReadonlyMap<string, T>,
  entries: readonly (readonly [string, T])[],
): boolean {
  if (map.size !== entries.length) return false;
  let index = 0;

  for (const [key, value] of map)
    if (key !== entries[index]?.[0] || value !== entries[index++]?.[1]) return false;

  return true;
}

function encodeFixedResult(result: ProjectCheckingResult): string | undefined {
  return encodeResultFields(result, true);
}

function encodeIssuedResult(result: ProjectCheckingResult): string | undefined {
  return encodeResultFields(result, false);
}

function encodeResultFields(
  result: ProjectCheckingResult,
  omitCheckingInputValue: boolean,
): string | undefined {
  try {
    if (Object.getPrototypeOf(result) !== Object.prototype) return undefined;
    const fields = Reflect.ownKeys(result).map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(result, key);

      if (!descriptor || !("value" in descriptor)) throw new TypeError();
      const shape = [
        encodeKey(key),
        descriptor.enumerable,
        descriptor.configurable,
        descriptor.writable,
      ];

      if (omitCheckingInputValue && key === "checkingInputs")
        return [shape, "dynamic-checking-inputs"];

      const value = encodeData(descriptor.value);

      if (value === undefined) throw new TypeError();
      return [shape, value];
    });

    return JSON.stringify(fields);
  } catch {
    return undefined;
  }
}

function encodeSessionShape(session: CheckingSession): string | undefined {
  try {
    if (Object.getPrototypeOf(session) !== Object.prototype) return undefined;
    return JSON.stringify(
      Reflect.ownKeys(session).map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(session, key);

        if (!descriptor) throw new TypeError();
        const shape = [encodeKey(key), descriptor.enumerable, descriptor.configurable];

        if ("value" in descriptor)
          return [shape, "value", descriptor.writable, identity(descriptor.value)];

        return [
          shape,
          "accessor",
          descriptor.get ? identity(descriptor.get) : null,
          descriptor.set ? identity(descriptor.set) : null,
        ];
      }),
    );
  } catch {
    return undefined;
  }
}
function encodeData(
  value: unknown,
  active = new WeakSet<object>(),
  includeIdentity = true,
): unknown | undefined {
  if (typeof value === "number") {
    if (Number.isNaN(value)) return ["number", "NaN"];
    if (value === Number.POSITIVE_INFINITY) return ["number", "+Infinity"];
    if (value === Number.NEGATIVE_INFINITY) return ["number", "-Infinity"];
    if (Object.is(value, -0)) return ["number", "-0"];
    return ["number", value];
  }

  if (value === null || typeof value !== "object") {
    if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint")
      return undefined;

    return [typeof value, value];
  }

  if (active.has(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);

  if (prototype !== Array.prototype && prototype !== Object.prototype && prototype !== null)
    return undefined;

  active.add(value);
  const properties: unknown[] = [];

  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);

    if (!descriptor || !("value" in descriptor)) {
      active.delete(value);
      return undefined;
    }

    const child = encodeData(descriptor.value, active, includeIdentity);

    if (child === undefined) {
      active.delete(value);
      return undefined;
    }

    properties.push([
      encodeKey(key),
      descriptor.enumerable,
      descriptor.configurable,
      descriptor.writable,
      child,
    ]);
  }

  active.delete(value);
  return includeIdentity
    ? [
        "object",
        objectId(value),
        prototype === null ? "null" : prototype === Array.prototype ? "array" : "record",
        properties,
      ]
    : [
        "object",
        prototype === null ? "null" : prototype === Array.prototype ? "array" : "record",
        properties,
      ];
}
function encodeKey(key: PropertyKey): unknown {
  if (typeof key !== "symbol") return ["string", key];
  let id = symbolIds.get(key);

  if (id === undefined) {
    id = nextId++;
    symbolIds.set(key, id);
  }

  return ["symbol", key.description ?? "", id];
}

function identity(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return [typeof value, value];

  if (typeof value === "object" && value !== null) return ["object", objectId(value)];
  if (typeof value === "function") return ["function", objectId(value)];
  if (typeof value === "undefined") return ["undefined"];
  return undefined;
}

function objectId(value: object): number {
  let id = objectIds.get(value);

  if (id === undefined) {
    id = nextId++;
    objectIds.set(value, id);
  }

  return id;
}

function digest(value: string): string {
  return "sha256-" + createHash("sha256").update(value).digest("hex");
}
