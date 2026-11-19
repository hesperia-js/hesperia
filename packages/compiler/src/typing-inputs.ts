import { createHash } from "node:crypto";
import { version as typeScriptVersion } from "typescript";
import type { Project } from "typescript/unstable/async";
import type {
  CapturedCheckingInput,
  CheckingSession,
  ProjectCheckingOptions,
  ProjectCheckingResult,
  VirtualModule,
} from "./checking.ts";
import type { CompileResult, ModuleAnalysis } from "./compilation.ts";
import type { ProjectCompilation } from "./project-compilation.ts";
import { encodeCanonicalModule, type CanonicalModule } from "./ir.ts";
import { normalizeFilename as normalizePath } from "./utils.ts";
function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value) as T;
  }

  if (typeof value !== "object" || value === null) return value;

  for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);

  return Object.freeze(value);
}

export type TypingHostOperation =
  | "readFile"
  | "fileExists"
  | "directoryExists"
  | "getAccessibleEntries"
  | "realpath";

export interface TypingHostObservation {
  readonly operation: TypingHostOperation;
  readonly path: string;
  readonly result:
    | string
    | boolean
    | null
    | undefined
    | {
        readonly files: readonly string[];
        readonly directories: readonly string[];
      };
}

export class TypingHostObservationRecorder {
  readonly #observations: TypingHostObservation[] = [];
  #closed = false;
  #lateObservation = false;
  #delegated = false;

  record(observation: TypingHostObservation): void {
    if (this.#closed) {
      this.#lateObservation = true;
      return;
    }

    if (observation.result === undefined) this.#delegated = true;

    const result =
      observation.operation === "readFile" && typeof observation.result === "string"
        ? sourceDigest(observation.result)
        : observation.result;

    this.#observations.push(
      deepFreeze({
        ...observation,
        result,
        ...(typeof result === "object" && result !== null
          ? {
              result: {
                files: [...result.files],
                directories: [...result.directories],
              },
            }
          : {}),
      }),
    );
  }

  close(): void {
    this.#closed = true;
  }

  snapshot(): {
    readonly observations: readonly TypingHostObservation[];
    readonly delegated: boolean;
    readonly lateObservation: boolean;
  } {
    return Object.freeze({
      observations: Object.freeze([...this.#observations]),
      delegated: this.#delegated,
      lateObservation: this.#lateObservation,
    });
  }
}

const typingEvidenceCaptureRequests = new WeakSet<object>();

/** @internal Mark one actual checker options object for compiler-owned evidence capture. */
export function requestTypingEvidenceCapture<T extends ProjectCheckingOptions>(options: T): T {
  typingEvidenceCaptureRequests.add(options);
  return options;
}

export function hasRequestedTypingEvidenceCapture(options: ProjectCheckingOptions): boolean {
  return typingEvidenceCaptureRequests.has(options);
}

export interface CapturedTypingSourceFile {
  readonly filename: string;
  readonly source: string;
  readonly digest: string;
  readonly isDefaultLibrary: boolean;
  readonly isFromExternalLibrary: boolean;
  readonly packageJsonType: string;
  readonly packageJsonDirectory: string;
  readonly impliedNodeFormat: number;
}

export interface TypingInputEnvironment {
  readonly state: "incomplete-capture";
  readonly snapshotId: number;
  readonly projectId: string;
  readonly configFileName: string;
  readonly projectInputs: {
    readonly root: string;
    readonly additionalFiles: readonly {
      readonly filename: string;
      readonly source: string;
      readonly digest: string;
    }[];
    readonly checkingRoots: readonly {
      readonly filename: string;
      readonly source: string;
      readonly digest: string;
    }[];
    readonly resolutionOverrides: Readonly<Record<string, string>>;
    readonly allowUnsafeHTML: boolean;
    readonly allowUnsafeEmbed: boolean;
    readonly documentShell: boolean;
    readonly browserTarget: boolean;
    readonly runtimeModule?: string;
    readonly styleRuntimeModule?: string;
    readonly styledEntryIds: readonly string[];
    readonly styleShellEntryId?: string;
    readonly styleIdentityRoot?: string;
    readonly externalResolverProvided: boolean;
  };
  readonly checkingInputs: readonly {
    readonly filename: string;
    readonly source: string;
    readonly digest: string;
    readonly digestMatchesSource: boolean;
  }[];
  readonly rootFiles: readonly string[];
  readonly projectCompilerOptions: Readonly<Record<string, unknown>>;
  readonly programCompilerOptions: Readonly<Record<string, unknown>>;
  readonly sourceFiles: readonly CapturedTypingSourceFile[];
  readonly host: {
    readonly observations: readonly TypingHostObservation[];
    readonly delegated: boolean;
    readonly lateObservation: boolean;
  };
  readonly typeScriptVersion: string;
  readonly nativeExecutableIdentity: "unobserved-default";
  readonly gaps: readonly string[];
}

export async function captureTypingInputEnvironment(
  project: Project,
  snapshotId: number,
  root: string,
  options: ProjectCheckingOptions,
  checkingInputs: readonly CapturedCheckingInput[],
  host: TypingHostObservationRecorder,
  additionalGaps: readonly string[] = [],
): Promise<TypingInputEnvironment> {
  const gaps = new Set<string>([
    "query-capsules-not-sealed",
    "native-executable-identity-unobserved",
    ...additionalGaps,
  ]);
  let projectCompilerOptions: Readonly<Record<string, unknown>> = Object.freeze({});
  let programCompilerOptions: Readonly<Record<string, unknown>> = Object.freeze({});
  const sourceFiles: CapturedTypingSourceFile[] = [];
  let rootFiles: readonly string[] = Object.freeze([]);

  try {
    projectCompilerOptions = freezeCaptureValue(project.compilerOptions);
    programCompilerOptions = freezeCaptureValue(project.program.getCompilerOptions());
    rootFiles = Object.freeze([...project.rootFiles]);
  } catch {
    gaps.add("final-compiler-options-unavailable");
  }

  try {
    const filenames = await project.program.getSourceFileNames();

    for (const filename of filenames) {
      try {
        const source = await project.program.getSourceFile(filename);
        const metadata = await project.program.getSourceFileMetadata(filename);

        if (!source || !metadata) {
          gaps.add("final-program-source-missing");
          continue;
        }

        sourceFiles.push(
          Object.freeze({
            filename,
            source: source.text,
            digest: sourceDigest(source.text),
            isDefaultLibrary: metadata.isDefaultLibrary,
            isFromExternalLibrary: metadata.isFromExternalLibrary,
            packageJsonType: metadata.packageJsonType,
            packageJsonDirectory: metadata.packageJsonDirectory,
            impliedNodeFormat: metadata.impliedNodeFormat,
          }),
        );
      } catch {
        gaps.add("final-program-source-unavailable");
      }
    }
  } catch {
    gaps.add("final-program-inventory-unavailable");
  }

  const hostSnapshot = host.snapshot();

  if (hostSnapshot.delegated) gaps.add("native-filesystem-fallback");
  if (hostSnapshot.lateObservation) gaps.add("late-filesystem-observation");

  return Object.freeze({
    state: "incomplete-capture",
    snapshotId,
    projectId: String(project.id),
    configFileName: project.configFileName,
    projectInputs: Object.freeze({
      root,
      additionalFiles: Object.freeze(
        (options.additionalFiles ?? []).map((file) =>
          Object.freeze({
            filename: file.filename,
            source: file.source,
            digest: sourceDigest(file.source),
          }),
        ),
      ),
      checkingRoots: Object.freeze(
        (options.checkingRoots ?? []).map((file) =>
          Object.freeze({
            filename: file.filename,
            source: file.source,
            digest: sourceDigest(file.source),
          }),
        ),
      ),
      resolutionOverrides: Object.freeze({ ...options.resolutionOverrides?.browser }),
      allowUnsafeHTML: options.allowUnsafeHTML === true,
      allowUnsafeEmbed: options.allowUnsafeEmbed === true,
      documentShell: options.documentShell === true,
      browserTarget: options.browserTarget === true,
      ...(options.runtimeModule ? { runtimeModule: options.runtimeModule } : {}),
      ...(options.styleRuntimeModule ? { styleRuntimeModule: options.styleRuntimeModule } : {}),
      styledEntryIds: Object.freeze([...(options.styledEntryIds ?? [])]),
      ...(options.styleShellEntryId ? { styleShellEntryId: options.styleShellEntryId } : {}),
      ...(options.styleIdentityRoot ? { styleIdentityRoot: options.styleIdentityRoot } : {}),
      externalResolverProvided: options.resolution !== undefined,
    }),
    checkingInputs: Object.freeze(
      checkingInputs.map(({ filename, source, digest }) => {
        const digestMatchesSource = digest === sourceDigest(source);
        if (!digestMatchesSource) gaps.add("checking-input-digest-mismatch");
        return Object.freeze({ filename, source, digest, digestMatchesSource });
      }),
    ),
    rootFiles,
    projectCompilerOptions,
    programCompilerOptions,
    sourceFiles: Object.freeze(sourceFiles),
    host: hostSnapshot,
    typeScriptVersion,
    nativeExecutableIdentity: "unobserved-default",
    gaps: Object.freeze([...gaps].sort()),
  });
}

export interface SealedModuleTypingEvidence {
  readonly filename: string;
  readonly nativeFilename: string;
  readonly sourceJoin: boolean;
  readonly checkingAnalysisAvailable: boolean;
  readonly emittedModuleAvailable: boolean;
  readonly sourceDigest: string;
  readonly checkingViewDigest: string;
  readonly checkedSemanticHash: string;
  readonly checkedIrDigest: string;
  readonly checkedMetadataDigest: string;
  readonly emittedCodeDigest: string;
  readonly emittedSemanticHash: string;
  readonly emittedIrDigest: string;
  readonly renderPlanJoin: "unavailable";
}

export interface SealedProjectTypingEvidence {
  readonly schema: 1;
  readonly state: "sealed";
  readonly snapshotId: number;
  readonly captureState: "incomplete-capture";
  readonly environment: TypingInputEnvironment;
  readonly modules: readonly SealedModuleTypingEvidence[];
  readonly certificates: readonly [];
  readonly projectPolicy: {
    readonly kind: "unproved";
    readonly reason: "missing-policy";
  };
  readonly unavailableTypeLocations: readonly (
    | "component-props"
    | "state-value"
    | "native-markup-context"
    | "native-binding"
    | "route-role-reference"
    | "render-plan-preservation"
  )[];
  readonly checkingHasErrors: boolean;
  readonly emissionHasErrors: boolean;
  readonly checkingResultJoin: boolean;
  readonly analysisJoin: boolean;
  readonly modulePopulationJoin: boolean;
}

interface CompilationBinding {
  readonly evidence: SealedProjectTypingEvidence;
  readonly compilationKeys: readonly PropertyKey[];
  readonly checkingKeys: readonly PropertyKey[];
  readonly checking: ProjectCompilation["checking"];
  readonly modules: ProjectCompilation["modules"];
  readonly moduleOutputs: readonly {
    readonly filename: string;
    readonly keys: readonly PropertyKey[];
    readonly result: CompileResult;
    readonly fingerprint: string;
    readonly diagnosticsFingerprint: string;
  }[];
  readonly checkingFingerprint: string;
  readonly host: TypingHostObservationRecorder;
}

interface CheckingSessionTypingState {
  readonly project: Project;
  readonly environment: TypingInputEnvironment;
  readonly snapshotId: number;
  readonly modules: readonly VirtualModule[];
  readonly views: readonly {
    readonly filename: string;
    readonly nativeFilename: string;
    readonly source: string;
  }[];
  readonly analyses: ReadonlyMap<string, ModuleAnalysis>;
  readonly resultGetter: (() => ProjectCheckingResult) | undefined;
  readonly isDisposed: () => boolean;
  readonly analysisEntries: readonly {
    readonly filename: string;
    readonly analysis: ModuleAnalysis;
    readonly result: ModuleAnalysis["result"];
    readonly componentProps: ModuleAnalysis["componentProps"];
    readonly normalized: ModuleAnalysis["normalized"];
    readonly operationCalls: ModuleAnalysis["operationCalls"];
    readonly mapOffset: ModuleAnalysis["mapOffset"];
    readonly fingerprint: string;
  }[];
  readonly baselineCheckingFingerprint: string;
  readonly baselineHasErrors: boolean;
  readonly host: TypingHostObservationRecorder;
}

const sessionTypingState = new WeakMap<CheckingSession, CheckingSessionTypingState>();
const compilationTypingBinding = new WeakMap<ProjectCompilation, CompilationBinding>();

export function registerCheckingSessionTypingState(
  session: CheckingSession,
  input: {
    readonly project: Project;
    readonly environment: TypingInputEnvironment;
    readonly snapshotId: number;
    readonly modules: readonly VirtualModule[];
    readonly views: readonly {
      readonly filename: string;
      readonly nativeFilename: string;
      readonly source: string;
    }[];
    readonly analyses: ReadonlyMap<string, ModuleAnalysis>;
    readonly baseline: ProjectCheckingResult;
    readonly host: TypingHostObservationRecorder;
    readonly isDisposed: () => boolean;
  },
): void {
  try {
    registerCheckingSessionTypingStateUnchecked(session, input);
  } catch {
    sessionTypingState.delete(session);
  }
}

function registerCheckingSessionTypingStateUnchecked(
  session: CheckingSession,
  input: {
    readonly project: Project;
    readonly environment: TypingInputEnvironment;
    readonly snapshotId: number;
    readonly modules: readonly VirtualModule[];
    readonly views: readonly {
      readonly filename: string;
      readonly nativeFilename: string;
      readonly source: string;
    }[];
    readonly analyses: ReadonlyMap<string, ModuleAnalysis>;
    readonly baseline: ProjectCheckingResult;
    readonly host: TypingHostObservationRecorder;
    readonly isDisposed: () => boolean;
  },
): void {
  const modules = Object.freeze(
    input.modules.map(({ filename, source }) => Object.freeze({ filename, source })),
  );
  const views = Object.freeze(
    input.views.map(({ filename, nativeFilename, source }) =>
      Object.freeze({ filename, nativeFilename, source }),
    ),
  );
  const analysisEntries = Object.freeze(
    [...input.analyses].map(([filename, analysis]) =>
      Object.freeze({
        filename,
        analysis,
        result: analysis.result,
        componentProps: analysis.componentProps,
        normalized: analysis.normalized,
        operationCalls: analysis.operationCalls,
        mapOffset: analysis.mapOffset,
        fingerprint: moduleAnalysisFingerprint(analysis),
      }),
    ),
  );
  const resultGetter = Object.getOwnPropertyDescriptor(session, "result")?.get;

  if (!resultGetter) return;

  sessionTypingState.set(
    session,
    Object.freeze({
      project: input.project,
      environment: input.environment,
      snapshotId: input.snapshotId,
      modules,
      views,
      analyses: input.analyses,
      resultGetter,
      isDisposed: input.isDisposed,
      analysisEntries,
      baselineCheckingFingerprint: fingerprintCheckingResult(input.baseline),
      baselineHasErrors: input.baseline.diagnostics.some((item) => item.severity === "error"),
      host: input.host,
    }),
  );
}

export function sealProjectTypingEvidence(
  session: CheckingSession,
  checkingAtEmission: ProjectCheckingResult,
  compilation: ProjectCompilation,
): void {
  try {
    sealProjectTypingEvidenceUnchecked(session, checkingAtEmission, compilation);
  } catch {
    sessionTypingState.delete(session);
  }
}

function sealProjectTypingEvidenceUnchecked(
  session: CheckingSession,
  checkingAtEmission: ProjectCheckingResult,
  compilation: ProjectCompilation,
): void {
  const state = sessionTypingState.get(session);

  if (!state) return;

  if (state.host.snapshot().lateObservation) {
    sessionTypingState.delete(session);
    return;
  }

  if (
    session.project !== state.project ||
    Object.getOwnPropertyDescriptor(session, "result")?.get !== state.resultGetter ||
    state.isDisposed()
  ) {
    sessionTypingState.delete(session);
    return;
  }

  const analysesMatch =
    state.analyses === session.analyses &&
    state.analysisEntries.length === session.analyses.size &&
    state.analysisEntries.every(
      ({
        filename,
        analysis,
        result,
        componentProps,
        normalized,
        operationCalls,
        mapOffset,
        fingerprint,
      }) =>
        session.analyses.get(filename) === analysis &&
        analysis.result === result &&
        analysis.componentProps === componentProps &&
        analysis.normalized === normalized &&
        analysis.operationCalls === operationCalls &&
        analysis.mapOffset === mapOffset &&
        moduleAnalysisFingerprint(analysis) === fingerprint,
    );
  const checkingMatches =
    checkingAtEmission.snapshotId === state.snapshotId &&
    fingerprintCheckingResult(checkingAtEmission) === state.baselineCheckingFingerprint;
  const modulePopulationMatches =
    compilation.modules.size === state.analysisEntries.length &&
    sameOwnKeys(
      [...compilation.modules.keys()],
      state.analysisEntries.map((entry) => entry.filename),
    );
  const cohortMatches = checkingMatches && analysesMatch && modulePopulationMatches;
  const modules = state.modules.map((module) => {
    const analysis = session.analyses.get(module.filename);
    const emitted = compilation.modules.get(module.filename);
    const view = state.views.find((item) => item.filename === module.filename);
    const sourceDigest_ = sourceDigest(module.source);
    const normalizedNativeFilename = view ? normalizePath(view.nativeFilename) : "";
    const nativeSource = state.environment.sourceFiles.find(
      (item) => normalizePath(item.filename) === normalizedNativeFilename,
    );
    const nativeFilenameCount = state.views.filter(
      (item) => normalizePath(item.nativeFilename) === normalizedNativeFilename,
    ).length;
    const sourceJoin = Boolean(
      analysis &&
      emitted &&
      view &&
      cohortMatches &&
      nativeSource &&
      nativeSource.source === view.source &&
      nativeFilenameCount === 1,
    );
    const metadata = analysis?.componentProps
      ? {
          props: analysis.componentProps.byParameterStart,
          operations: analysis.operationCalls,
        }
      : (analysis?.operationCalls ?? null);

    return Object.freeze({
      filename: module.filename,
      nativeFilename: view?.nativeFilename ?? "",
      sourceJoin,
      checkingAnalysisAvailable: analysis !== undefined,
      emittedModuleAvailable: emitted !== undefined,
      sourceDigest: sourceDigest_,
      checkingViewDigest: view ? sourceDigest(view.source) : "",
      checkedSemanticHash: analysis?.result.semanticHash ?? "",
      checkedIrDigest: analysis ? digestCanonicalModule(analysis.result.ir) : "",
      checkedMetadataDigest: sourceDigest(JSON.stringify(canonicalCaptureValue(metadata))),
      emittedCodeDigest: emitted ? sourceDigest(emitted.code) : "",
      emittedSemanticHash: emitted?.semanticHash ?? "",
      emittedIrDigest: emitted ? digestCanonicalModule(emitted.ir) : "",
      renderPlanJoin: "unavailable",
    });
  });
  const checkingHasErrors =
    state.baselineHasErrors ||
    compilation.checking.diagnostics.some((item) => item.severity === "error");
  const evidence: SealedProjectTypingEvidence = Object.freeze({
    schema: 1,
    state: "sealed",
    snapshotId: state.snapshotId,
    captureState: "incomplete-capture",
    environment: state.environment,
    modules: Object.freeze(modules),
    certificates: Object.freeze([] as const),
    projectPolicy: Object.freeze({ kind: "unproved", reason: "missing-policy" }),
    unavailableTypeLocations: Object.freeze([
      "component-props",
      "state-value",
      "native-markup-context",
      "native-binding",
      "route-role-reference",
      "render-plan-preservation",
    ] as const),
    checkingHasErrors,
    emissionHasErrors: [...compilation.modules.values()].some((result) =>
      result.diagnostics.some((item) => item.severity === "error"),
    ),
    checkingResultJoin: checkingMatches,
    analysisJoin: analysesMatch,
    modulePopulationJoin: modulePopulationMatches,
  });
  const moduleOutputs = Object.freeze(
    [...compilation.modules].map(([filename, result]) =>
      Object.freeze({
        filename,
        keys: Object.freeze(Reflect.ownKeys(result)),
        result,
        fingerprint: compileResultFingerprint(result),
        diagnosticsFingerprint: sourceDigest(
          JSON.stringify(canonicalCaptureValue(result.diagnostics)),
        ),
      }),
    ),
  );

  compilationTypingBinding.set(compilation, {
    evidence,
    compilationKeys: Object.freeze(Reflect.ownKeys(compilation)),
    checkingKeys: Object.freeze(Reflect.ownKeys(compilation.checking)),
    checking: compilation.checking,
    modules: compilation.modules,
    moduleOutputs,
    checkingFingerprint: fingerprintCheckingResult(compilation.checking),
    host: state.host,
  });
  sessionTypingState.delete(session);
}

export function issuedProjectTypingEvidence(
  compilation: ProjectCompilation,
): SealedProjectTypingEvidence | undefined {
  try {
    return issuedProjectTypingEvidenceUnchecked(compilation);
  } catch {
    return undefined;
  }
}

function issuedProjectTypingEvidenceUnchecked(
  compilation: ProjectCompilation,
): SealedProjectTypingEvidence | undefined {
  const binding = compilationTypingBinding.get(compilation);

  if (
    !binding ||
    !sameOwnKeys(Reflect.ownKeys(compilation), binding.compilationKeys) ||
    compilation.checking !== binding.checking ||
    !sameOwnKeys(Reflect.ownKeys(compilation.checking), binding.checkingKeys) ||
    compilation.modules !== binding.modules ||
    fingerprintCheckingResult(compilation.checking) !== binding.checkingFingerprint ||
    compilation.modules.size !== binding.moduleOutputs.length
  )
    return undefined;

  if (
    !sameOwnKeys(
      [...compilation.modules.keys()],
      binding.moduleOutputs.map((item) => item.filename),
    )
  )
    return undefined;

  for (const output of binding.moduleOutputs) {
    const result = compilation.modules.get(output.filename);

    if (
      !result ||
      result !== output.result ||
      compileResultFingerprint(result) !== output.fingerprint ||
      sourceDigest(JSON.stringify(canonicalCaptureValue(result.diagnostics))) !==
        output.diagnosticsFingerprint
    )
      return undefined;

    if (!sameOwnKeys(Reflect.ownKeys(result), output.keys)) return undefined;
  }

  const host = binding.host.snapshot();

  if (host.lateObservation) return undefined;

  return binding.evidence;
}

/** Carry an issued cohort only across Tooling's validated diagnostic/source-map projection. */
export function registerMappedProjectCompilation(
  source: ProjectCompilation,
  mapped: ProjectCompilation,
): boolean {
  try {
    return registerMappedProjectCompilationUnchecked(source, mapped);
  } catch {
    return false;
  }
}

function registerMappedProjectCompilationUnchecked(
  source: ProjectCompilation,
  mapped: ProjectCompilation,
): boolean {
  const binding = compilationTypingBinding.get(source);

  if (
    !binding ||
    !issuedProjectTypingEvidence(source) ||
    !isAllowedToolingProjection(source, mapped)
  )
    return false;

  compilationTypingBinding.set(mapped, {
    evidence: binding.evidence,
    compilationKeys: Object.freeze(Reflect.ownKeys(mapped)),
    checkingKeys: Object.freeze(Reflect.ownKeys(mapped.checking)),
    checking: mapped.checking,
    modules: mapped.modules,
    moduleOutputs: Object.freeze(
      [...mapped.modules].map(([filename, result]) =>
        Object.freeze({
          filename,
          keys: Object.freeze(Reflect.ownKeys(result)),
          result,
          fingerprint: compileResultFingerprint(result),
          diagnosticsFingerprint: sourceDigest(
            JSON.stringify(canonicalCaptureValue(result.diagnostics)),
          ),
        }),
      ),
    ),
    checkingFingerprint: fingerprintCheckingResult(mapped.checking),
    host: binding.host,
  });

  return true;
}

function isAllowedToolingProjection(
  source: ProjectCompilation,
  mapped: ProjectCompilation,
): boolean {
  if (
    !sameOwnKeys(Reflect.ownKeys(source), Reflect.ownKeys(mapped)) ||
    !sameOwnKeys(Reflect.ownKeys(source.checking), Reflect.ownKeys(mapped.checking)) ||
    source.checking.snapshotId !== mapped.checking.snapshotId ||
    source.checking.checkingInputs !== mapped.checking.checkingInputs ||
    source.checking.modules.length !== mapped.checking.modules.length ||
    source.modules.size !== mapped.modules.size
  )
    return false;

  for (const key of Reflect.ownKeys(source.checking)) {
    if (key === "diagnostics" || key === "modules") continue;
    if (
      (source.checking as unknown as Record<PropertyKey, unknown>)[key] !==
      (mapped.checking as unknown as Record<PropertyKey, unknown>)[key]
    )
      return false;
  }

  for (const [index, before] of source.checking.modules.entries()) {
    const after = mapped.checking.modules[index];

    if (
      !after ||
      !sameOwnKeys(Reflect.ownKeys(before), Reflect.ownKeys(after)) ||
      before.filename !== after.filename ||
      before.diagnostics.length !== after.diagnostics.length ||
      before.diagnostics.some(
        (item, diagnosticIndex) =>
          item.code !== after.diagnostics[diagnosticIndex]?.code ||
          item.severity !== after.diagnostics[diagnosticIndex]?.severity,
      )
    )
      return false;

    for (const key of Reflect.ownKeys(before)) {
      if (key === "diagnostics") continue;
      if (
        (before as unknown as Record<PropertyKey, unknown>)[key] !==
        (after as unknown as Record<PropertyKey, unknown>)[key]
      )
        return false;
    }
  }

  const mappedDiagnostics = mapped.checking.modules.flatMap((module) => module.diagnostics);

  if (
    mappedDiagnostics.length !== mapped.checking.diagnostics.length ||
    mappedDiagnostics.some(
      (item, index) => !sameDiagnostic(item, mapped.checking.diagnostics[index]),
    )
  )
    return false;

  const beforeEntries = [...source.modules];
  const afterEntries = [...mapped.modules];

  for (const [index, [filename, before]] of beforeEntries.entries()) {
    const afterEntry = afterEntries[index];

    if (!afterEntry || afterEntry[0] !== filename) return false;

    const after = afterEntry[1];
    const beforeKeys = Reflect.ownKeys(before);

    if (!sameOwnKeys(beforeKeys, Reflect.ownKeys(after))) return false;

    for (const key of beforeKeys) {
      if (key === "diagnostics" || key === "map") continue;
      if (
        (before as unknown as Record<PropertyKey, unknown>)[key] !==
        (after as unknown as Record<PropertyKey, unknown>)[key]
      )
        return false;
    }

    if (
      before.diagnostics.length !== after.diagnostics.length ||
      before.diagnostics.some(
        (item, diagnosticIndex) =>
          item.code !== after.diagnostics[diagnosticIndex]?.code ||
          item.severity !== after.diagnostics[diagnosticIndex]?.severity,
      )
    )
      return false;
  }

  return true;
}

function fingerprintCheckingResult(result: ProjectCheckingResult): string {
  return JSON.stringify(
    canonicalCaptureValue({
      snapshotId: result.snapshotId,
      diagnostics: result.diagnostics,
      checkingInputs: result.checkingInputs,
      modules: result.modules,
    }),
  );
}

function sameDiagnostic(left: unknown, right: unknown): boolean {
  return (
    JSON.stringify(canonicalCaptureValue(left)) === JSON.stringify(canonicalCaptureValue(right))
  );
}

function sameOwnKeys(left: readonly PropertyKey[], right: readonly PropertyKey[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

function digestCanonicalModule(module: CanonicalModule): string {
  return sourceDigest(encodeCanonicalModule(module));
}

function moduleAnalysisFingerprint(analysis: ModuleAnalysis): string {
  const componentProps = analysis.componentProps;

  return sourceDigest(
    JSON.stringify(
      canonicalCaptureValue({
        result: {
          semanticHash: analysis.result.semanticHash,
          ir: digestCanonicalModule(analysis.result.ir),
          diagnostics: analysis.result.diagnostics,
        },
        normalized: analysis.normalized,
        componentProps: componentProps
          ? {
              byParameterStart: componentProps.byParameterStart,
              diagnostics: componentProps.diagnostics,
            }
          : null,
        operationCalls: analysis.operationCalls,
      }),
    ),
  );
}

function compileResultFingerprint(result: CompileResult): string {
  const fields: Record<string, unknown> = Object.create(null);

  for (const key of Reflect.ownKeys(result)) {
    if (typeof key !== "string" || key === "diagnostics" || key === "map") continue;

    const value = (result as unknown as Record<string, unknown>)[key];
    fields[key] =
      key === "ir" && typeof value === "object" && value !== null
        ? digestCanonicalModule(value as CanonicalModule)
        : canonicalCaptureValue(value);
  }

  return JSON.stringify(fields);
}

function sourceDigest(source: string): string {
  return `sha256-${createHash("sha256").update(source).digest("hex")}`;
}

function freezeCaptureValue(value: unknown): Readonly<Record<string, unknown>> {
  const normalized = canonicalCaptureValue(value);

  return normalized && typeof normalized === "object" && !Array.isArray(normalized)
    ? deepFreeze(normalized as Record<string, unknown>)
    : Object.freeze({});
}

function canonicalCaptureValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalCaptureValue);

  if (typeof value !== "object" || value === null) return value;

  if (value instanceof Map)
    return {
      kind: "map",
      entries: [...value].map(([key, item]) => [
        canonicalCaptureValue(key),
        canonicalCaptureValue(item),
      ]),
    };

  if (value instanceof Set) return { kind: "set", values: [...value].map(canonicalCaptureValue) };

  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = Object.create(null);

  for (const key of Object.keys(record).sort(compareCodeUnits)) {
    const item = canonicalCaptureValue(record[key]);

    if (item !== undefined) result[key] = item;
  }

  return result;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
