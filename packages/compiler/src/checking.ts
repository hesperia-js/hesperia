import { checkingView, type CheckingView } from "./checking-view.ts";
import { analyzeModule, type ModuleAnalysis } from "./compilation.ts";
import { analyzeNativeEventOptions } from "./event-options.ts";
export type { CheckingView } from "./checking-view.ts";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { API, fileNameToDocumentURI, type Project } from "typescript/unstable/async";
import type { CompilerDiagnostic } from "./ir.ts";
import { RouteScanError, scanRouteFiles } from "./scanner.ts";
import { analyzeRouteModule } from "./route-analysis.ts";
import { analyzeComponentProps } from "./props-analysis.ts";
import { createOperationCallAnalyzer } from "./operation-call-analysis.ts";
import { generatePageDeclarations, PAGE_DECLARATION_MARKER } from "./page-types.ts";
import { analyzeBrowserCapabilities } from "./capability-analysis.ts";
import { ModuleResolver, type ProjectResolutionOverrides } from "./module-resolution.ts";
import { CheckingInputSnapshot, type CapturedCheckingInput } from "./checking-inputs.ts";
import { normalizeFilename as normalize } from "./utils.ts";
export type { CapturedCheckingInput } from "./checking-inputs.ts";

/** A virtual module in one immutable TypeScript checking snapshot. */
export interface VirtualModule {
  /** Source identity, resolved against the checking root when relative. */
  readonly filename: string;
  /** Complete authored text captured for this checking snapshot. */
  readonly source: string;
}

/** Options for checking a group of authored modules as one project. */
export interface ProjectCheckingOptions {
  /** Filesystem root used to resolve relative module names and package imports. */
  readonly root?: string;
  /** Extra declaration or source files made available to every checked module. */
  readonly additionalFiles?: readonly VirtualModule[];
  /** @internal Server-only TypeScript roots kept out of compiler analysis and browser entries. */
  readonly checkingRoots?: readonly VirtualModule[];
  /** Permit the explicit unsafeHTML escape hatch in authored modules. */
  readonly allowUnsafeHTML?: boolean;
  /** Associate the embedded-document permission with emitted definitions. */
  readonly allowUnsafeEmbed?: boolean;
  /** Enable document-shell validation for the project's root app module. */
  readonly documentShell?: boolean;
  /** Prove that browser entries do not reach host-only capabilities. */
  readonly browserTarget?: boolean;
  /** @internal Shared build snapshot; supplied by Hesperia tooling. External callers use resolutionOverrides. */
  readonly resolution?: ModuleResolver;
  /** Exact browser import names mapped to replacement module specifiers. */
  readonly resolutionOverrides?: ProjectResolutionOverrides;
  /** @internal Compiler-generated runtime import identity supplied by Hesperia tooling. */
  readonly runtimeModule?: string;
  /** @internal Shared private CSS plan module for generated browser emission. */
  readonly styleRuntimeModule?: string;
  /** @internal Modules whose complete static CSS closure is nonempty. */
  readonly styledEntryIds?: ReadonlySet<string>;
  /** @internal Shell entry bound to the shared plan even when its static CSS closure is empty. */
  readonly styleShellEntryId?: string;
  /** @internal Root for project-relative private CSS entry and owner IDs. */
  readonly styleIdentityRoot?: string;
}

/** Diagnostics grouped by authored module. */
export interface CheckedModule {
  /** Authored module identity supplied to the checking project. */
  readonly filename: string;
  /** Compiler and TypeScript diagnostics belonging to this module. */
  readonly diagnostics: readonly CompilerDiagnostic[];
}

/** TypeScript 7 checking result for an authored TSX project. */
export interface ProjectCheckingResult {
  /** Combined diagnostics; use `modules` when the owning filename is needed. */
  readonly diagnostics: readonly CompilerDiagnostic[];
  /** External declarations and configuration files captured by the native TypeScript snapshot. */
  readonly checkingInputs: readonly CapturedCheckingInput[];
  /** Per-module diagnostics with positions mapped back to authored source. */
  readonly modules: readonly CheckedModule[];
  /** Native TypeScript snapshot identifier; not a reproducible build digest. */
  readonly snapshotId: number;
}

/**
 * Run TypeScript 7's native project checker against one virtual module.
 *
 * @param module Authored module to check.
 * @param additionalFiles Extra virtual files available to the checker.
 * @returns A promise for authored diagnostics and captured project inputs. The native project
 * snapshot is disposed before the promise resolves.
 */
export function checkVirtualModule(
  module: VirtualModule,
  additionalFiles: readonly VirtualModule[] = [],
): Promise<ProjectCheckingResult> {
  return checkProjectModules([module], { additionalFiles });
}

/**
 * Check authored TS/TSX modules in one immutable TypeScript 7 snapshot.
 *
 * A temporary project pins JSX preserve mode and loads the authored modules
 * plus the native DOM JSX declaration view. TypeScript diagnostics therefore
 * describe authored source and retain offsets into that source; generated JS
 * is never used for type checking. The returned promise resolves after the
 * native snapshot has been disposed.
 *
 * @param modules Authored modules checked together in one project snapshot.
 * @param options Root, auxiliary files, and checking behavior for the project.
 * @returns A promise for diagnostics mapped to authored source and the external inputs captured
 * by this check. The promise rejects if native checking fails; cleanup failures are included in
 * an `AggregateError` when checking also failed.
 */
export async function checkProjectModules(
  modules: readonly VirtualModule[],
  options: ProjectCheckingOptions = {},
): Promise<ProjectCheckingResult> {
  const session = await openCheckingProject(modules, options);

  try {
    return session.result;
  } finally {
    await session.dispose();
  }
}

/** One checked immutable project retained for editor queries into its virtual source. */
export interface CheckingSession {
  /** Serializable compiler results associated with this native checking snapshot. */
  readonly analyses: ReadonlyMap<string, ModuleAnalysis>;
  /** Native TypeScript project; absent only when project creation failed. */
  readonly project: Project | undefined;
  /** Compiler and type diagnostics mapped to authored files. */
  readonly result: ProjectCheckingResult;
  /** Checking views indexed by normalized absolute filename. */
  readonly views: ReadonlyMap<string, CheckingView>;

  /** Release the native project snapshot; repeated calls share the same cleanup promise. */
  dispose(): Promise<void>;
}

/**
 * Keep the same checking views and TypeScript snapshot available for editor operations.
 *
 * The returned project's async TypeScript services remain usable until `dispose` is awaited.
 *
 * @param modules Authored modules checked together in one project snapshot.
 * @param options Root, auxiliary files, and checking behavior for the project.
 * @returns A promise for the checking session after its diagnostics and component prop metadata
 * have been queried.
 */
export function openCheckingProject(
  modules: readonly VirtualModule[],
  options: ProjectCheckingOptions = {},
): Promise<CheckingSession> {
  return createCheckingSession(modules, options);
}

async function createCheckingSession(
  modules: readonly VirtualModule[],
  options: ProjectCheckingOptions,
): Promise<CheckingSession> {
  const root = resolve(options.root ?? process.cwd());
  const files = new Map<string, string>();
  const resolution =
    options.resolution ??
    (options.browserTarget === true || options.resolutionOverrides !== undefined
      ? new ModuleResolver(
          root,
          new Map(modules.map((module) => [module.filename, module.source])),
          "production",
          options.resolutionOverrides?.browser,
        )
      : undefined);
  const capabilityDiagnostics =
    options.browserTarget === true ? analyzeBrowserCapabilities(modules, root, resolution) : [];
  const analyses = new Map<string, ModuleAnalysis>();
  const modulePaths = modules.map((module) => virtualPath(module.filename, root));
  const modulePathKeys = new Set(modulePaths.map(normalize));
  const checkingRootPaths = (options.checkingRoots ?? [])
    .map((module) => virtualPath(module.filename, root))
    .filter((filename) => !modulePathKeys.has(normalize(filename)));
  const pageDeclarations = generatePageDeclarations(modules, { root });
  const pageDeclarationPath = normalize(virtualPath(pageDeclarations.declaration.filename, root));
  const routeDiagnostics = checkRouteFiles(
    modules.map((module, index) => ({ ...module, filename: modulePaths[index]! })),
    root,
    resolution,
  );

  for (const source of resolution?.capturedSources ?? [])
    files.set(normalize(source.filename), source.source);

  for (const manifest of resolution?.capturedManifests ?? [])
    files.set(normalize(manifest.filename), manifest.source);

  const viewDiagnostics = new Map<string, readonly CompilerDiagnostic[]>();
  const viewOffsets = new Map<string, (offset: number) => number>();
  const views = new Map<string, CheckingView>();

  for (let index = 0; index < modules.length; index++) {
    const module = modules[index]!;
    const documentShell =
      options.documentShell === true &&
      ((options.root === undefined && modules.length === 1) ||
        normalize(modulePaths[index]!) === normalize(join(root, "app.tsx")));
    const pageRouteContext = pageDeclarations.contexts.get(normalize(modulePaths[index]!));
    const importReplacements =
      resolution && options.resolutionOverrides
        ? checkingImportReplacements(
            module.filename,
            root,
            options.resolutionOverrides.browser,
            resolution,
          )
        : undefined;
    const analysis = /\.(?:ts|tsx|mts)$/u.test(module.filename)
      ? analyzeModule(module.source, {
          filename: module.filename,
          allowUnsafeHTML: options.allowUnsafeHTML,
          documentShell,
        })
      : undefined;
    const nativeEventHandlers = analysis
      ? analyzeNativeEventOptions(analysis.result.ir).contexts.flatMap((context) => {
          if (!analysis.mapOffset) return [];

          return [
            {
              ...context,
              span: {
                start: analysis.mapOffset(context.span.start),
                end: analysis.mapOffset(context.span.end),
              },
              attributeSpan: {
                start: analysis.mapOffset(context.attributeSpan.start),
                end: analysis.mapOffset(context.attributeSpan.end),
              },
            },
          ];
        })
      : [];
    const view = checkingView(
      module.source,
      module.filename,
      options.allowUnsafeHTML === true,
      pageRouteContext || importReplacements || nativeEventHandlers.length
        ? {
            ...(pageRouteContext ? { pageRouteContext } : {}),
            ...(importReplacements ? { importReplacements } : {}),
            ...(nativeEventHandlers.length ? { nativeEventHandlers } : {}),
          }
        : undefined,
    );

    files.set(normalize(virtualPath(module.filename, root)), view.source);

    if (analysis) analyses.set(module.filename, analysis);

    const compilerDiagnostics = analysis?.result.diagnostics ?? [];

    viewDiagnostics.set(module.filename, [
      ...view.diagnostics,
      ...compilerDiagnostics.filter(
        (item) =>
          item.code !== "HES-RAW-DISABLED" ||
          !view.diagnostics.some((existing) => existing.code === "HES-RAW-DISABLED"),
      ),
    ]);

    viewOffsets.set(module.filename, view.mapOffset);

    views.set(normalize(virtualPath(module.filename, root)), view);
  }

  for (const file of options.additionalFiles ?? []) {
    const filename = normalize(virtualPath(file.filename, root));

    if (!files.has(filename)) files.set(filename, file.source);
  }

  for (const file of options.checkingRoots ?? []) {
    const filename = normalize(virtualPath(file.filename, root));

    if (!files.has(filename)) files.set(filename, file.source);
  }

  const suppliedDeclaration = files.get(pageDeclarationPath);

  if (!suppliedDeclaration || suppliedDeclaration.includes(PAGE_DECLARATION_MARKER))
    files.set(pageDeclarationPath, pageDeclarations.declaration.source);

  const jsxPath = join(root, ".hesperia", "jsx.d.ts");

  files.set(normalize(jsxPath), jsxDeclarations());

  const configPath = join(root, ".hesperia", "check.tsconfig.json");
  const authorConfig = join(root, "tsconfig.json");
  const hasAuthorConfig = files.has(normalize(authorConfig)) || existsSync(authorConfig);
  const capturedAuthorConfig = !files.has(normalize(authorConfig)) && hasAuthorConfig;

  if (hasAuthorConfig && !files.has(normalize(authorConfig))) {
    try {
      files.set(normalize(authorConfig), readFileSync(authorConfig, "utf8"));
    } catch {
      // TypeScript will report an unreadable author configuration through its project diagnostics.
    }
  }

  const checkingInputs = new CheckingInputSnapshot(files);

  for (const file of options.checkingRoots ?? []) {
    const filename = virtualPath(file.filename, root);

    if (!modulePathKeys.has(normalize(filename))) checkingInputs.capture(filename, file.source);
  }

  if (capturedAuthorConfig) {
    const source = files.get(normalize(authorConfig));

    if (source !== undefined) checkingInputs.capture(authorConfig, source);
  }

  const virtualDirectories = new Set<string>();

  for (const filename of files.keys()) {
    let directory = dirname(filename);

    while (!existsSync(directory) && !virtualDirectories.has(normalize(directory))) {
      virtualDirectories.add(normalize(directory));

      const parent = dirname(directory);

      if (parent === directory) break;

      directory = parent;
    }
  }

  const api = new API({
    cwd: root,
    fs: {
      readFile(filename) {
        return checkingInputs.readFile(filename);
      },

      fileExists(filename) {
        return checkingInputs.fileExists(filename);
      },

      ...(virtualDirectories.size > 0
        ? {
            directoryExists: (filename: string) =>
              virtualDirectories.has(normalize(filename)) || undefined,
          }
        : {}),
    },
  });
  const overridePaths = options.resolutionOverrides
    ? Object.fromEntries(
        Object.entries(options.resolutionOverrides.browser).flatMap(([specifier, target]) => {
          if (target.startsWith(".")) return [];

          const selected = resolution?.resolveProjectTypesTarget(target);

          if (selected?.kind !== "resolved") return [];

          const { filename, source } = selected;

          // Resolver reuse must not remove declarations from dependency tracking.
          checkingInputs.capture(filename, source);

          const targetPath = relative(dirname(configPath), filename).replaceAll("\\", "/");
          return [[specifier, [targetPath.startsWith(".") ? targetPath : `./${targetPath}`]]];
        }),
      )
    : {};
  const authorPaths =
    hasAuthorConfig && Object.keys(overridePaths).length > 0
      ? await readAuthorPaths(api, authorConfig)
      : {};
  const checkingPaths = { ...authorPaths, ...overridePaths };

  // Resolving a package's public declaration may discover a captured source after
  // the initial resolver snapshot copy above. Keep the checker on those exact
  // bytes instead of allowing its native FS to reread the working tree.
  for (const source of resolution?.capturedSources ?? []) {
    const filename = normalize(source.filename);

    if (!files.has(filename)) {
      files.set(filename, source.source);

      checkingInputs.capture(source.filename, source.source);
    }
  }

  files.set(
    normalize(configPath),
    JSON.stringify({
      ...(hasAuthorConfig ? { extends: authorConfig } : {}),
      compilerOptions: {
        ...(!hasAuthorConfig
          ? {
              lib: ["ESNext", "DOM"],
              module: "ESNext",
              moduleDetection: "force",
              moduleResolution: "Bundler",
              noUncheckedIndexedAccess: true,
              skipLibCheck: true,
              strict: true,
              target: "ESNext",
              types: [],
              verbatimModuleSyntax: true,
            }
          : {}),
        allowImportingTsExtensions: true,
        noEmit: true,
        jsx: "preserve",
        ...(resolution
          ? {
              customConditions: resolution.activeConditions.filter(
                (condition) => condition !== "default" && condition !== "import",
              ),
            }
          : {}),
        ...(Object.keys(overridePaths).length > 0
          ? {
              paths: Object.fromEntries(
                Object.entries(checkingPaths).map(([specifier, targets]) => [
                  specifier,
                  targets.map((target) =>
                    isAbsolute(target) || /^[A-Za-z]:[\\/]/u.test(target)
                      ? `./${relative(dirname(configPath), target).replaceAll("\\", "/")}`
                      : target,
                  ),
                ]),
              ),
            }
          : {}),
      },
      files: [
        ...modulePaths,
        ...checkingRootPaths,
        ...(files.has(pageDeclarationPath) ? [pageDeclarations.declaration.filename] : []),
        ...(options.additionalFiles ?? [])
          .filter((file) => file.filename.endsWith(".d.ts"))
          .map((file) => virtualPath(file.filename, root)),
        jsxPath,
      ],
      include: [],
      exclude: [],
    }),
  );

  let snapshot: Awaited<ReturnType<API["updateSnapshot"]>> | undefined;
  let disposal: Promise<void> | undefined;

  const dispose = (): Promise<void> => {
    disposal ??= (async () => {
      try {
        await snapshot?.dispose();
      } finally {
        await api.close();
      }
    })();
    return disposal;
  };

  try {
    snapshot = await api.updateSnapshot({ openProjects: [configPath] });
    const project =
      snapshot.getProject(configPath) ??
      (await snapshot.getDefaultProjectForFile(modulePaths[0] ?? configPath));

    if (!project) {
      const diagnostic: CompilerDiagnostic = {
        code: "HES-TS-PROJECT",
        severity: "error",
        message: `TypeScript could not create a project for ${modules[0]?.filename ?? root}`,
      };
      const result: ProjectCheckingResult = {
        diagnostics: [diagnostic],
        modules: modules.map((module) => ({
          filename: module.filename,
          diagnostics: [diagnostic],
        })),
        checkingInputs: checkingInputs.captured,
        snapshotId: snapshot.id,
      };
      return {
        analyses,
        project,
        views,
        dispose,

        get result() {
          return { ...result, checkingInputs: checkingInputs.captured };
        },
      };
    }

    const analyzeOperationCalls = await createOperationCallAnalyzer(project);

    for (let index = 0; index < modules.length; index++) {
      const module = modules[index]!;
      const analysis = analyses.get(module.filename);
      const view = views.get(normalize(modulePaths[index]!));

      if (!analysis || !view) continue;

      const componentProps = await analyzeComponentProps(
        project,
        modulePaths[index]!,
        view.mapOffset,
      );
      const operationCalls = await analyzeOperationCalls(modulePaths[index]!, view.mapOffset);

      analyses.set(module.filename, {
        ...analysis,
        componentProps,
        operationCalls,
        result: {
          ...analysis.result,
          diagnostics: [
            ...analysis.result.diagnostics,
            ...componentProps.diagnostics,
            ...operationCalls.diagnostics,
          ],
        },
      });

      viewDiagnostics.set(module.filename, [
        ...(viewDiagnostics.get(module.filename) ?? []),
        ...componentProps.diagnostics,
        ...operationCalls.diagnostics,
      ]);
    }

    const checked = [] as { filename: string; diagnostics: CompilerDiagnostic[] }[];

    for (let index = 0; index < modules.length; index++) {
      const module = modules[index]!;
      const document = { uri: fileNameToDocumentURI(modulePaths[index]!) };
      const typeDiagnostics = [
        ...(await project.program.getSyntacticDiagnostics(document)),
        ...(await project.program.getSemanticDiagnostics(document)),
      ].map((item) => toDiagnostic(item, viewOffsets.get(module.filename)));
      const diagnostics = [
        ...(viewDiagnostics.get(module.filename) ?? []),
        ...(routeDiagnostics.get(modulePaths[index]!) ?? []),
        ...typeDiagnostics,
      ];

      checked.push({ filename: module.filename, diagnostics });
    }

    for (const module of options.checkingRoots ?? []) {
      const filename = virtualPath(module.filename, root);

      if (modulePathKeys.has(normalize(filename))) continue;

      const document = { uri: fileNameToDocumentURI(filename) };
      const diagnostics = [
        ...(await project.program.getSyntacticDiagnostics(document)),
        ...(await project.program.getSemanticDiagnostics(document)),
      ].map((item) => toDiagnostic(item));

      checked.push({ filename: module.filename, diagnostics });
    }

    for (const diagnostic of capabilityDiagnostics) {
      const group = checked.find((module) => module.filename === diagnostic.filename);

      if (group) group.diagnostics.push(diagnostic);
      else checked.push({ filename: diagnostic.filename, diagnostics: [diagnostic] });
    }

    const projectDiagnostics = [
      ...(await project.program.getProgramDiagnostics()),
      ...(await project.program.getGlobalDiagnostics()),
      ...(await project.program.getConfigFileParsingDiagnostics()),
    ];

    for (const item of projectDiagnostics) {
      const filename = item.fileName ?? authorConfig;
      const diagnostic = toDiagnostic(item, views.get(normalize(filename))?.mapOffset);
      const group = checked.find(
        (module) => normalize(virtualPath(module.filename, root)) === normalize(filename),
      );

      if (group) group.diagnostics.push(diagnostic);
      else checked.push({ filename, diagnostics: [diagnostic] });
    }

    const result: ProjectCheckingResult = {
      diagnostics: checked.flatMap((module) => module.diagnostics),
      modules: checked,
      checkingInputs: checkingInputs.captured,
      snapshotId: snapshot.id,
    };
    return {
      analyses,
      project,
      views,
      dispose,

      get result() {
        return { ...result, checkingInputs: checkingInputs.captured };
      },
    };
  } catch (error) {
    try {
      await dispose();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "TypeScript checking and cleanup failed", {
        cause: error,
      });
    }

    throw error;
  }
}

function virtualPath(filename: string, root: string): string {
  return isAbsolute(filename) ? resolve(filename) : resolve(root, filename);
}

function checkingImportReplacements(
  filename: string,
  root: string,
  overrides: Readonly<Record<string, string>>,
  resolution: ModuleResolver,
): Readonly<Record<string, string>> {
  const importer = resolve(root, filename);
  const replacements: Record<string, string> = Object.create(null);

  for (const [specifier, target] of Object.entries(overrides)) {
    const selected = resolution.resolveProjectTarget(target);

    if (selected.kind !== "resolved") continue;

    if (!target.startsWith(".")) {
      continue;
    }

    let replacement = relative(dirname(importer), selected.filename).replaceAll("\\", "/");

    if (!replacement.startsWith(".")) replacement = `./${replacement}`;

    replacements[specifier] = replacement;
  }

  return Object.freeze(replacements);
}

function checkRouteFiles(
  modules: readonly VirtualModule[],
  root: string,
  resolution?: ModuleResolver,
): ReadonlyMap<string, readonly CompilerDiagnostic[]> {
  const routeRoot = resolve(root, "src/routes");
  const prefix = `${normalize(routeRoot)}/`;
  const paths = modules
    .map((module) => module.filename)
    .filter((filename) => normalize(filename).startsWith(prefix));
  const diagnostics = new Map<string, CompilerDiagnostic[]>();
  let manifest;

  try {
    manifest = scanRouteFiles(routeRoot, paths);
  } catch (error) {
    if (!(error instanceof RouteScanError)) throw error;

    const implicated = error.paths.map(normalize);

    for (const filename of paths) {
      const normalized = normalize(filename);

      if (implicated.some((path) => normalized === path || normalized.startsWith(`${path}/`)))
        diagnostics.set(filename, [
          { code: "HES-ROUTE-SCAN", severity: "error", message: error.message },
        ]);
    }

    return diagnostics;
  }

  const sources = new Map(modules.map((module) => [module.filename, module.source]));
  const pending = [manifest.root];

  for (const node of pending) {
    pending.push(...node.children);

    const filename = node.files.route;

    if (!filename) continue;

    const analysis = analyzeRouteModule(sources.get(filename)!, { filename, modules, resolution });

    for (const item of analysis.diagnostics) {
      const target = item.filename;
      const existing = diagnostics.get(target) ?? [];

      if (
        !existing.some(
          (prior) =>
            prior.code === item.code &&
            prior.message === item.message &&
            prior.span?.start === item.span?.start &&
            prior.span?.end === item.span?.end,
        )
      )
        existing.push(item);

      diagnostics.set(target, existing);
    }
  }

  return diagnostics;
}

async function readAuthorPaths(
  api: API,
  filename: string,
): Promise<Readonly<Record<string, readonly string[]>>> {
  try {
    const parsed = await api.parseConfigFile(filename);
    const paths = parsed.options.paths;

    if (!paths || typeof paths !== "object" || Array.isArray(paths)) return {};

    const basePath =
      typeof parsed.options.pathsBasePath === "string"
        ? parsed.options.pathsBasePath
        : dirname(filename);
    return Object.fromEntries(
      Object.entries(paths).flatMap(([specifier, targets]) => {
        if (!Array.isArray(targets) || !targets.every((target) => typeof target === "string"))
          return [];

        return [
          [
            specifier,
            (targets as string[]).map((target) =>
              target.startsWith(".") ? resolve(basePath, target) : target,
            ),
          ],
        ];
      }),
    );
  } catch {
    return {};
  }
}

function toDiagnostic(
  item: {
    readonly code: number;
    readonly category: number;
    readonly text: string;
    readonly messageChain?: readonly DiagnosticMessage[];
    readonly pos: number;
    readonly end: number;
  },
  mapOffset: ((offset: number) => number) | undefined = undefined,
): CompilerDiagnostic {
  const start = mapOffset?.(item.pos) ?? item.pos;
  // The exclusive end can point into inserted checking code with a different anchor.
  const end =
    mapOffset && item.end > item.pos
      ? Math.max(start, mapOffset(item.end - 1) + 1)
      : (mapOffset?.(item.end) ?? item.end);
  return {
    code: `TS${item.code}`,
    severity: item.category === 1 ? "error" : item.category === 2 ? "warning" : "info",
    message: diagnosticText(item),
    span: { start, end },
  };
}

interface DiagnosticMessage {
  readonly text: string;
  readonly messageChain?: readonly DiagnosticMessage[];
}

function diagnosticText(message: DiagnosticMessage): string {
  return [message.text, ...(message.messageChain ?? []).map(diagnosticText)].join("\n");
}

function jsxDeclarations(): string {
  return `
export {};
declare global {
  type HesperiaNativeEvents<E extends Element> = E extends HTMLElement ? HTMLElementEventMap : E extends SVGElement ? SVGElementEventMap : MathMLElementEventMap;
  interface HesperiaNativeListenerOptions { readonly capture?: boolean; readonly once?: boolean; readonly passive?: boolean; }
  type HesperiaNativeEventType<E extends Element, Name extends string> = Name extends keyof HesperiaNativeEvents<E> ? Extract<HesperiaNativeEvents<E>[Name], Event> : Event;
  type HesperiaNativeHandler<E extends Element, V extends Event> = { handle(this: E, event: V): unknown }["handle"];
  type HesperiaNativeEventValue<E extends Element, Name extends string> = HesperiaNativeHandler<E, HesperiaNativeEventType<E, Name>> | readonly [HesperiaNativeHandler<E, HesperiaNativeEventType<E, Name>>, HesperiaNativeListenerOptions];
  type HesperiaNativeEventHandler<K extends string, N extends "html" | "svg" | "mathml", Name extends string> = HesperiaNativeHandler<HesperiaNativeElement<K, N>, HesperiaNativeEventType<HesperiaNativeElement<K, N>, Name>>;
  type HesperiaEventAttributes<E extends Element> = {
    [K in keyof HesperiaNativeEvents<E> as \`on:\${K & string}\`]?: HesperiaNativeEventValue<E, K & string>;
  } & {
    [name: \`on:\${string}\`]: HesperiaNativeEventValue<E, string> | undefined;
  };
  type HesperiaAttributeValue<T> = T extends CSSStyleDeclaration | SVGAnimatedString | SVGAnimatedRect | SVGAnimatedLengthList | SVGAnimatedNumberList | SVGAnimatedTransformList | SVGAnimatedPreserveAspectRatio | SVGPointList ? string : T extends SVGAnimatedLength | SVGAnimatedNumber | SVGAnimatedInteger | SVGAnimatedEnumeration | SVGAnimatedAngle ? string | number : T extends SVGAnimatedBoolean ? boolean : T;
  type HesperiaNativeProperties<E extends Element> = { [K in keyof E as string extends K ? never : number extends K ? never : K]?: HesperiaAttributeValue<E[K]> };
  type HesperiaSourceDescriptor = \`\${number}w\` | \`\${number}x\`;
  type HesperiaSourceSet = string | readonly (readonly [Blob | string, HesperiaSourceDescriptor])[];
  type HesperiaSrcAttribute<E extends Element> = E extends HTMLScriptElement ? string : E extends HTMLIFrameElement | HTMLEmbedElement | HTMLObjectElement ? never : E extends HTMLElement ? string | Blob : string;
  type HesperiaPosterAttribute<E extends Element> = E extends HTMLVideoElement ? string | Blob : string;
  type HesperiaSrcSetAttribute<E extends Element> = E extends HTMLImageElement | HTMLSourceElement ? HesperiaSourceSet : string;
  type HesperiaSourceAttributes<E extends Element> = {
    src?: HesperiaSrcAttribute<E>;
    poster?: HesperiaPosterAttribute<E>;
    srcset?: HesperiaSrcSetAttribute<E>;
  };
  type HesperiaNativeAttributes<E extends Element> = {
    [name: string]: unknown;
    bind?: import("hesperia/runtime").Binding<E | undefined>;
    key?: string | number;
  } & HesperiaEventAttributes<E> & Omit<HesperiaNativeProperties<E>, "src" | "poster" | "srcset"> & HesperiaSourceAttributes<E>;
  function __hesperia_fragment(children: readonly unknown[]): DocumentFragment;
  function __hesperia_child(read: () => unknown): Node;
  function __hesperia_component(definition: typeof import("hesperia").AsyncBoundary, props: import("hesperia").AsyncBoundaryProps & { readonly key?: string | number }): Node;
  function __hesperia_component(definition: () => unknown, props: import("hesperia/runtime").CallerProps<{}> & { readonly key?: string | number }): Node;
  function __hesperia_component<P>(definition: (props: import("hesperia/runtime").ComponentProps<P>) => unknown, props: import("hesperia/runtime").CallerProps<P> & { readonly key?: string | number }): Node;
  function __hesperia_component<B>(definition: (props: B) => unknown, props: HesperiaCallerProps<B>): Node;
  type HesperiaLocalTag<K extends string> = K extends \`svg:\${infer T}\` | \`math:\${infer T}\` ? T : K;
  type HesperiaNativeElement<K extends string, N extends "html" | "svg" | "mathml"> = N extends "svg" ? K extends keyof SVGElementTagNameMap ? SVGElementTagNameMap[K] : SVGElement : N extends "mathml" ? K extends keyof MathMLElementTagNameMap ? MathMLElementTagNameMap[K] : MathMLElement : K extends keyof HTMLElementTagNameMap ? HTMLElementTagNameMap[K] : HTMLElement;
  function __hesperia_element<K extends string, N extends "html" | "svg" | "mathml">(tag: K, namespace: N, props: HesperiaNativeAttributes<HesperiaNativeElement<HesperiaLocalTag<K>, N>>, children: readonly unknown[]): HesperiaNativeElement<HesperiaLocalTag<K>, N>;
  namespace JSX {
    type Element = Node;
    interface ElementClass {}
    interface ElementChildrenAttribute { children: {}; }
    interface IntrinsicElements {
      [name: string]: HesperiaNativeAttributes<Element>;
      a: HesperiaNativeAttributes<HTMLAnchorElement>;
      button: HesperiaNativeAttributes<HTMLButtonElement>;
      form: HesperiaNativeAttributes<HTMLFormElement>;
      input: HesperiaNativeAttributes<HTMLInputElement>;
      label: HesperiaNativeAttributes<HTMLLabelElement>;
      main: HesperiaNativeAttributes<HTMLElement>;
      option: HesperiaNativeAttributes<HTMLOptionElement>;
      select: HesperiaNativeAttributes<HTMLSelectElement>;
      textarea: HesperiaNativeAttributes<HTMLTextAreaElement>;
    }
  }
}
type HesperiaCallerProps<B> = B extends import("hesperia/runtime").ComponentProps<infer P> ? import("hesperia/runtime").CallerProps<P> & { readonly key?: string | number } : never;
type HesperiaPagePropsBrand<P> = import("hesperia/runtime").PagePropsBrand<P>;
type HesperiaCheckedContractApi<C extends import("aeolia").Contract> = import("hesperia/aeolia").ImportedApi<C>;
type HesperiaCheckedAeoliaApi<C extends import("aeolia").Contract> = import("aeolia").ContractApi<C>;
type HesperiaCheckedStoreOptions<T> = import("aeolia").StoreOptions<T>;
type HesperiaCheckedMutationOptions = import("aeolia").MutationOptions;
type HesperiaCheckedQueryOptions = typeof import("aeolia").queryOptions;
`;
}
