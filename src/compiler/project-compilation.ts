import {
  analyzeModule,
  emitAnalysis,
  type CompileOptions,
  type CompileResult,
} from "./compilation.ts";
import {
  openCheckingProject,
  type ProjectCheckingOptions,
  type ProjectCheckingResult,
  type VirtualModule,
} from "./checking.ts";

/** Compile one module, obtaining declared prop mappings from the native TypeScript checker. */
export function compile(source: string, options: CompileOptions = {}): CompileResult {
  const filename = options.filename ?? "module.tsx";
  const session = openCheckingProject([{ filename, source }], {
    allowUnsafeHTML: options.allowUnsafeHTML,
    documentShell: options.documentShell,
  });
  try {
    return emitAnalysis(session.analyses.get(filename) ?? analyzeModule(source, options), options);
  } finally {
    session.dispose();
  }
}

/** One immutable, checked application snapshot and its emitted TSX modules. */
export interface ProjectCompilation {
  /** Authored diagnostics and checking views from the shared project snapshot. */
  readonly checking: ProjectCheckingResult;
  /** Per-source compiler results keyed by the input filename; inspect diagnostics before using code. */
  readonly modules: ReadonlyMap<string, CompileResult>;
}

/** Check once and emit from the same resolved project snapshot; errors prohibit project emission. */
export function compileProjectModules(
  modules: readonly VirtualModule[],
  options: ProjectCheckingOptions = {},
): ProjectCompilation {
  const session = openCheckingProject(modules, options);
  try {
    const emitted = new Map<string, CompileResult>();
    const emissionErrors = new Map<string, Readonly<CompileResult["diagnostics"]>>();
    if (!session.result.diagnostics.some((item) => item.severity === "error")) {
      for (const [filename, analysis] of session.analyses) {
        const result = emitAnalysis(analysis, {
          filename,
          allowUnsafeHTML: options.allowUnsafeHTML,
          documentShell: options.documentShell,
          browserTarget: options.browserTarget,
          runtimeModule: options.runtimeModule,
        });
        emitted.set(filename, result);
        const errors = result.diagnostics.filter(
          (item) =>
            item.severity === "error" &&
            !session.result.modules
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
    if (!emissionErrors.size) return { checking: session.result, modules: emitted };
    const modulesWithEmissionErrors = session.result.modules.map((module) => ({
      ...module,
      diagnostics: [...module.diagnostics, ...(emissionErrors.get(module.filename) ?? [])],
    }));
    return {
      checking: {
        ...session.result,
        diagnostics: modulesWithEmissionErrors.flatMap((module) => module.diagnostics),
        modules: modulesWithEmissionErrors,
      },
      modules: emitted,
    };
  } finally {
    session.dispose();
  }
}
