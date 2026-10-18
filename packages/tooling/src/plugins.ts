import type { NodeHandle, Project } from "typescript/unstable/async";

/** A source map from a plugin result to its captured input. */
export interface PluginSourceMap {
  /** Source Map version. */
  readonly version: 3;
  /** Input source names. */
  readonly sources: readonly string[];
  /** Optional symbol names. */
  readonly names: readonly string[];
  /** Encoded generated-to-original positions. */
  readonly mappings: string;
  /** Captured source text when available. */
  readonly sourcesContent?: readonly (string | null)[];
}

/** Authored span responsible for a plugin result or diagnostic. */
export interface PluginOrigin {
  /** Absolute source filename. */
  readonly filename: string;
  /** Start offset in the authored source. */
  readonly start: number;
  /** End offset in the authored source. */
  readonly end: number;
}

/** A diagnostic can identify a contributing file when its exact source span is unavailable. */
export type PluginDiagnosticOrigin =
  | PluginOrigin
  | { readonly filename: string; readonly start?: never; readonly end?: never };

/** A file or directory input whose change invalidates a project revision. */
export type PluginWatch =
  | { readonly kind: "file"; readonly file: string }
  | { readonly kind: "directory"; readonly dir: string; readonly glob?: string };

/** Diagnostic returned by a configured plugin. */
export interface PluginDiagnostic {
  /** Whether the finding prevents publication. */
  readonly severity: "error" | "warning";
  /** Human-readable cause. */
  readonly message: string;
  /** Exact authored span or contributing filename to display. */
  readonly origin: PluginDiagnosticOrigin;
}

/** Additional inputs and diagnostics produced by one hook. */
export interface PluginEvidence {
  /** Authored diagnostics. */
  readonly diagnostics?: readonly PluginDiagnostic[];
  /** Files or directories to watch for a new revision. */
  readonly watch?: readonly PluginWatch[];
}

/** One immutable file snapshot shared by all import interpretations in a revision. */
export interface CapturedPluginFile {
  /** Absolute source filename. */
  readonly filename: string;
  /** SHA-256 digest of the captured bytes. */
  readonly digest: string;
  /** Native immutable Blob containing the captured bytes. */
  readonly blob: Blob;
}

/** A declaration or browser module with its authored provenance. */
export interface PluginModuleText {
  /** Complete module source. */
  readonly code: string;
  /** Authored file or import site responsible for the module. */
  readonly origin: PluginOrigin;
  /** Map to the authored input when generated spans can be mapped. */
  readonly map?: PluginSourceMap;
}

/** A custom import request at one authored call site. */
export interface PluginImportInput {
  /** Absolute importer filename. */
  readonly importer: string;
  /** Exact authored import span. */
  readonly importSpan: PluginOrigin;
  /** Authored module specifier. */
  readonly specifier: string;
  /** Explicit `with { type: ... }` value. */
  readonly type: string;
  /** Captured target bytes. */
  readonly file: CapturedPluginFile;
}

/** Checker and browser interpretations of one custom import. */
export interface PluginImportResult extends PluginEvidence {
  /** TypeScript declaration exposed to the checker and editor. */
  readonly declaration: PluginModuleText;
  /** Executable browser module, checked for browser capabilities before bundling. */
  readonly browser: PluginModuleText;
}

/** Source captured before and after earlier configured transforms. */
export interface PluginSourceInput {
  /** Absolute project root supplied by the active build or editor revision. */
  readonly projectRoot: string;
  /** Absolute authored filename. */
  readonly filename: string;
  /** Original authored text, unchanged throughout the revision. */
  readonly authored: string;
  /** Current text at this stage. */
  readonly current: string;
  /** Map from current text to authored text when an earlier stage changed positions. */
  readonly map?: PluginSourceMap;
}

/** Exact text captured for a TypeScript project root or transitive checker input. */
export interface CapturedProjectSource {
  /** Canonical absolute filename. */
  readonly filename: string;
  /** Exact text from this project's first capture of the file. */
  readonly source: string;
  /** SHA-256 digest of the captured text, prefixed with `sha256-`. */
  readonly digest: string;
}

/** Authored and transformed checker views of one compiler input. */
export interface PluginCheckingSource {
  /** Absolute filename used by the retained checker snapshot. */
  readonly filename: string;
  /** Exact authored text before import interpretation and source transforms. */
  readonly authored: string;
  /** Text currently checked and passed to compiler analysis. */
  readonly checking: string;
  /** Map from checking positions back to authored positions, when any transform changed them. */
  readonly map?: PluginSourceMap;
}

/** Queries borrowed from one retained native TypeScript project while a hook is running. */
export interface ProjectTypeQueries {
  /** The project's checker. Access is rejected after the `analyzeProject` hook settles. */
  readonly checker: NonNullable<Project["checker"]>;

  /** Look up a captured source file by absolute or project-relative filename. */
  sourceFile(filename: string): ReturnType<Project["program"]["getSourceFile"]>;

  /** Resolve a native node handle without exposing the owning project. */
  resolveDeclaration(handle: NodeHandle): ReturnType<NodeHandle["resolve"]>;
}

/** Checker roots, pinned authored captures, and declarations visible during project analysis. */
export interface PluginProjectInput {
  /** Absolute project root for this revision. */
  readonly root: string;
  /** Authored and transformed views indexed by canonical absolute filename. */
  readonly checkingSources: ReadonlyMap<string, PluginCheckingSource>;
  /** First-captured authored inputs indexed by canonical absolute filename. */
  readonly capturedSources: ReadonlyMap<string, CapturedProjectSource>;
  /** Bounded native TypeScript queries valid only until this hook settles. */
  readonly types: ProjectTypeQueries;
}

/** Stable virtual module ID and its ambient TypeScript declaration, available before transforms. */
export interface PluginProjectDeclaration extends PluginModuleText {
  /** Stable private import specifier used by transformed modules. */
  readonly id: string;
}

/** JavaScript module body returned for a declaration after the checking snapshot is available. */
export interface PluginProjectBrowserModule extends PluginModuleText {
  /** ID of the declaration whose import this body supplies. */
  readonly id: string;
}

/** Serializable project-analysis output produced while the retained checker lease is active. */
export interface PluginProjectResult extends PluginEvidence {
  /** Browser implementations for declared IDs; every returned body is validated. */
  readonly browserModules?: readonly PluginProjectBrowserModule[];
}

/** Transformed source and metadata private to its producing plugin. */
export interface PluginSourceResult<Data> extends PluginEvidence {
  /** Complete transformed source. */
  readonly code: string;
  /** Map from output to current input, required when changed positions matter. */
  readonly map?: PluginSourceMap;
  /** Metadata consumed only by this plugin's generateStyles hook. */
  readonly data?: Data;
}

/** One component identity discovered by the compiler after source transforms. */
export interface PluginComponent {
  /** Stable compiler-assigned component identity. */
  readonly id: string;
  /** Authored component location. */
  readonly origin: PluginOrigin;
}

/** One transformed source paired with the producing plugin's metadata. */
export interface PluginDiscoveredSource<Data> {
  /** Absolute authored filename. */
  readonly filename: string;
  /** Metadata returned by this plugin's source hook. */
  readonly data?: Data;
  /** Components discovered in the checked transformed source. */
  readonly components: readonly PluginComponent[];
}

/** The application or component that owns generated styles. */
export type PluginStyleOwner =
  | { readonly kind: "application" }
  | { readonly kind: "component"; readonly id: string };

/** Generated stylesheet with an explicit owner and authored provenance. */
export interface PluginStyleArtifact {
  /** Logical stylesheet identity. */
  readonly id: string;
  /** Component or application owner. */
  readonly owner: PluginStyleOwner;
  /** Generated CSS. */
  readonly css: string;
  /** Absolute synthetic CSS input path used to resolve relative imports and assets. */
  readonly inputFilename?: string;
  /** Generated-CSS asset paths and authored references used for missing-file diagnostics. */
  readonly assetReferences?: readonly PluginStyleAssetReference[];
  /** Authored source responsible for the CSS. */
  readonly origin: PluginOrigin;
  /** Map to exact authored lines when generated positions can be mapped. */
  readonly map?: PluginSourceMap;
}

/** One asset URL retained with the generated stylesheet that refers to it. */
export interface PluginStyleAssetReference {
  /** Canonical absolute asset path resolved before generated CSS hashing. */
  readonly filename: string;
  /** Authored source span that supplied the URL. */
  readonly origin: PluginOrigin;
}

/** CSS at one configured transform stage. */
export type PluginCssInput = {
  /** Logical stylesheet identity. */
  readonly id: string;
  /** Absolute path whose directory resolves this CSS stage's imports and assets. */
  readonly filename: string;
  /** Current CSS text. */
  readonly css: string;
  /** Authored provenance. */
  readonly origin: PluginOrigin;
  /** Map from current CSS to authored source. */
  readonly map?: PluginSourceMap;
} & (
  | { readonly kind: "import" }
  | { readonly kind: "generated"; readonly owner: PluginStyleOwner }
);

/** Result of a CSS transform. */
export interface PluginCssResult extends PluginEvidence {
  /** Complete transformed CSS. */
  readonly css: string;
  /** Map from output CSS to current input CSS. */
  readonly map?: PluginSourceMap;
}

/** Four ordered project plugin stages; hook functions remain in the project process. */
export interface Plugin<Data = unknown> {
  /** Stable name used in diagnostics. */
  readonly name: string;
  /**
   * Configured plugin names that must appear earlier in the array.
   * Missing, ambiguous, cyclic, or later references emit project errors that prevent compilation.
   */
  readonly dependsOn?: readonly string[];
  /** Explicit custom import type names and their interpretation handlers. */
  readonly importTypes?: Readonly<
    Record<string, (input: PluginImportInput) => PluginImportResult | Promise<PluginImportResult>>
  >;
  /** Additional server-side TypeScript roots, never treated as browser entries or emit targets. */
  readonly projectSources?: readonly string[];
  /** Stable private import IDs and declarations exposed before source transforms run. */
  readonly projectDeclarations?: readonly PluginProjectDeclaration[];
  /** Analyze transformed project types and return serializable browser module bodies. */
  readonly analyzeProject?: (
    input: PluginProjectInput,
  ) => PluginProjectResult | Promise<PluginProjectResult>;
  /** Transform one authored TS/TSX source before compiler checking and discovery. */
  readonly transformSource?: (
    input: PluginSourceInput,
  ) => PluginSourceResult<Data> | undefined | Promise<PluginSourceResult<Data> | undefined>;
  /** Generate owned styles from this plugin's metadata and compiler-discovered components. */
  readonly generateStyles?: (
    sources: readonly PluginDiscoveredSource<Data>[],
  ) =>
    | (PluginEvidence & { readonly styles: readonly PluginStyleArtifact[] })
    | Promise<PluginEvidence & { readonly styles: readonly PluginStyleArtifact[] }>;
  /** Transform CSS after generated styles, preserving its owner. */
  readonly transformCss?: (
    input: PluginCssInput,
  ) => PluginCssResult | undefined | Promise<PluginCssResult | undefined>;
}
