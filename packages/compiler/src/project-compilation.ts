import {
  analyzeModule,
  emitAnalysis,
  type CompileOptions,
  type CompileResult,
} from "./compilation.ts";
import {
  openCheckingProject,
  type CheckingSession,
  type ProjectCheckingOptions,
  type ProjectCheckingResult,
  type VirtualModule,
} from "./checking.ts";
import { relative } from "node:path";

/**
 * Compile one module, obtaining declared prop mappings from the native TypeScript checker.
 *
 * @param source Authored TypeScript or TSX module source.
 * @param options Filename and compiler behavior for this module.
 * @returns A promise for emitted code and diagnostics after the native checker has been disposed.
 * The promise rejects if native checking fails; a cleanup failure is combined with a checking
 * failure in an `AggregateError`.
 */
export async function compile(
  source: string,
  options: CompileOptions = {},
): Promise<CompileResult> {
  const filename = options.filename ?? "module.tsx";
  const session = await openCheckingProject([{ filename, source }], {
    allowUnsafeHTML: options.allowUnsafeHTML,
    documentShell: options.documentShell,
  });

  try {
    return emitAnalysis(session.analyses.get(filename) ?? analyzeModule(source, options), options);
  } finally {
    await session.dispose();
  }
}

/** One immutable, checked application snapshot and its emitted TSX modules. */
export interface ProjectCompilation {
  /** Authored diagnostics and checking views from the shared project snapshot. */
  readonly checking: ProjectCheckingResult;
  /** Per-source compiler results keyed by the input filename; inspect diagnostics before using code. */
  readonly modules: ReadonlyMap<string, CompileResult>;
}

/**
 * Check once and emit from the same resolved project snapshot; errors prohibit project emission.
 *
 * @param modules Authored modules checked together in one project snapshot.
 * @param options Project root and compiler, routing, and resolution options.
 * @returns A promise for authored diagnostics and emitted modules. No modules are emitted when
 * checking reports an error; emission diagnostics are merged into the checking result.
 * @throws Rejects when native TypeScript setup, queries, or cleanup fail.
 */
export async function compileProjectModules(
  modules: readonly VirtualModule[],
  options: ProjectCheckingOptions = {},
): Promise<ProjectCompilation> {
  const session = await openCheckingProject(modules, options);

  try {
    return emitCheckingSession(session, options);
  } finally {
    await session.dispose();
  }
}

/** Emit from a retained checking session without taking ownership of its disposal. */
export function emitCheckingSession(
  session: CheckingSession,
  options: ProjectCheckingOptions = {},
): ProjectCompilation {
  const checking = session.result;
  const emitted = new Map<string, CompileResult>();
  const emissionErrors = new Map<string, Readonly<CompileResult["diagnostics"]>>();

  if (!checking.diagnostics.some((item) => item.severity === "error")) {
    for (const [filename, analysis] of session.analyses) {
      const result = emitAnalysis(analysis, {
        filename,
        allowUnsafeHTML: options.allowUnsafeHTML,
        allowUnsafeEmbed: options.allowUnsafeEmbed,
        documentShell: options.documentShell,
        browserTarget: options.browserTarget,
        runtimeModule: options.runtimeModule,
        styleRuntimeModule:
          options.styledEntryIds?.has(filename) || options.styleShellEntryId === filename
            ? options.styleRuntimeModule
            : undefined,
        styleEntryId:
          options.styledEntryIds?.has(filename) || options.styleShellEntryId === filename
            ? styleIdentity(filename, options.styleIdentityRoot)
            : undefined,
        stylePreloadEntry: options.styledEntryIds?.has(filename) ?? false,
        styleIdentity: styleIdentity(filename, options.styleIdentityRoot),
      });

      emitted.set(filename, result);

      const errors = result.diagnostics.filter(
        (item) =>
          item.severity === "error" &&
          !checking.modules
            .find((module) => module.filename === filename)
            ?.diagnostics.some(
              (prior) =>
                prior.code === item.code &&
                prior.message === item.message &&
                prior.span?.start === item.span?.start &&
                prior.span?.end === item.span?.end,
            ),
      );

      if (errors.length) emissionErrors.set(filename, errors);
    }
  }

  if (!emissionErrors.size) return { checking, modules: emitted };

  const modulesWithEmissionErrors = checking.modules.map((module) => ({
    ...module,
    diagnostics: [...module.diagnostics, ...(emissionErrors.get(module.filename) ?? [])],
  }));
  return {
    checking: {
      ...checking,
      diagnostics: modulesWithEmissionErrors.flatMap((module) => module.diagnostics),
      modules: modulesWithEmissionErrors,
    },
    modules: emitted,
  };
}

function styleIdentity(filename: string, root: string | undefined): string {
  return root ? relative(root, filename).replaceAll("\\", "/") : filename;
}
