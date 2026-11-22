import type {
  CapturedBrowserBuild,
  CapturedPublicBuild,
  CapturedServerBuild,
  HostingRecordV1,
  HostingRecordV2,
  HostingRecordV3,
} from "./index.ts";
import type {
  BrowserStaticBinding,
  CapturedProductionTargetV1,
  ServerTargetBinding,
  WorkerdBinding,
} from "./target.ts";

/** Data that can be retained in the serialized control representation. */
type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;

/** Serialized configuration data; plugin functions do not belong in this record. */
interface JsonObject {
  /** An existing serialized option or projected plugin-name list. */
  readonly [key: string]: JsonValue;
}

interface SourceDigest {
  /** Producer-recorded path; closure provenance may preserve an external absolute path. */
  readonly filename: string;
  /** Existing producer digest, including its recorded prefix convention. */
  readonly digest: string;
}

interface ResolutionEdge {
  /** Recorded importer path. */
  readonly from: string;
  /** Authored import text. */
  readonly specifier: string;
  /** Whether this request selected a source or a structured failure. */
  readonly outcome: "resolved" | "failed";
  /** Selected path when resolution succeeded. */
  readonly resolvedFilename?: string;
  /** Package condition keys selected while resolving the request. */
  readonly conditionPath?: readonly string[];
  /** Existing resolver failure class when resolution failed. */
  readonly failureCode?:
    | "HOST_IMPORT"
    | "PACKAGE_IMPORT_UNSUPPORTED"
    | "MODULE_NOT_FOUND"
    | "PACKAGE_NOT_FOUND"
    | "INVALID_PACKAGE"
    | "INVALID_PACKAGE_TARGET"
    | "EXPORTS_NO_MATCH"
    | "EXPORTS_BLOCKED";
}

interface GeneratedSource {
  /** Generated source's existing recorded path. */
  readonly filename: string;
  /** Producer semantic label. */
  readonly semantic: string;
  /** Identity of the generated semantic input. */
  readonly semanticHash: string;
  /** Corresponding authored source when supplied by the producer. */
  readonly authoredFilename?: string;
  /** Captured-source digest, absent when no matching captured source exists. */
  readonly digest?: string;
  /** Identity of the generated source map when present. */
  readonly sourceMapDigest?: string;
}

interface BrowserResolutionProvenance {
  /** Browser resolver mode, independent of the server target's conditions. */
  readonly mode: "development" | "production";
  /** Exact active browser package conditions. */
  readonly activeConditions: readonly string[];
  /** Existing nested browser import replacements. */
  readonly overrides: { readonly browser: Readonly<Record<string, string>> };
  /** Pinned runtime-key registry descriptor retained by the producer. */
  readonly runtimeKeyRegistry: {
    /** Canonical source for this registry revision. */
    readonly source: string;
    /** Immutable registry revision. */
    readonly revision: string;
    /** Digest of the pinned registry bytes. */
    readonly digest: string;
  };
  /** Captured browser source identities, without their source bytes. */
  readonly capturedSources: readonly SourceDigest[];
  /** Captured package manifest identities, without their source bytes. */
  readonly capturedManifests: readonly SourceDigest[];
  /** Resolution outcomes and selected-condition paths. */
  readonly edges: readonly ResolutionEdge[];
  /** Generated-source semantic, byte and source-map provenance. */
  readonly generatedSources: readonly GeneratedSource[];
}

/** Existing browser control provenance, retained independently of the deployment target. */
export interface BrowserControlProvenanceV1 {
  /** Historical compilation marker; this is not a deployment declaration. */
  readonly target: "browser";
  /** Browser closure provenance; it does not attest server resolution. */
  readonly resolution: BrowserResolutionProvenance;
  /** Sorted checking-input identities retained by the producer. */
  readonly checkingInputs: readonly SourceDigest[];
  /** Normalized serialized configuration, with plugin names rather than closures. */
  readonly configuration: JsonObject;
  /** Project-relative slash-normalized module paths and their source digests. */
  readonly modules: readonly SourceDigest[];
  /** Relative authored route paths mapped to their emitted guard URLs. */
  readonly routeGuards: Readonly<Record<string, string>>;
  /** Emitted route-table asset URL. */
  readonly routeTable: string;
}

/** In-memory production browser control, without persisted capture directories. */
export type BrowserControlV3<
  Hosting extends HostingRecordV1 | HostingRecordV2,
  Target extends CapturedProductionTargetV1 = CapturedProductionTargetV1,
> = BrowserControlProvenanceV1 & {
  /** Outer control version, independent of the inner hosting version. */
  readonly version: 3;
  /** Browser control branch. */
  readonly kind: "browser";
  /** Explicit deployment binding, separate from the compilation marker. */
  readonly productionTarget: Target;
  /** Exact production hosting inventory selected for this branch. */
  readonly hosting: Hosting & { readonly mode: "production" };
};

/** In-memory production server control; server source provenance remains a separate producer obligation. */
export interface ServerControlV3<Target extends ServerTargetBinding = ServerTargetBinding> {
  /** Outer control version. */
  readonly version: 3;
  /** Request-time server control branch. */
  readonly kind: "server";
  /** Server-capable binding; browser/static cannot inhabit this branch. */
  readonly productionTarget: Target;
  /** Production managed/public/private inventories and page plans. */
  readonly hosting: HostingRecordV3 & { readonly mode: "production" };
}

/** Exact in-memory control variants used before capture directory publication. */
export type TargetedControlRecordV3 =
  | BrowserControlV3<HostingRecordV1>
  | BrowserControlV3<HostingRecordV2>
  | ServerControlV3;

/** Persisted browser control; inner V1 has no public directory. */
export type PersistedBrowserV3 =
  | (BrowserControlV3<HostingRecordV1> & {
      /** Same-capture managed asset directory. */
      readonly assetDirectory: string;
      /** A public directory is absent in the V1 branch. */
      readonly publicDirectory?: never;
      /** Browser controls have no private server directory. */
      readonly serverDirectory?: never;
    })
  | (BrowserControlV3<HostingRecordV2> & {
      /** Same-capture managed asset directory. */
      readonly assetDirectory: string;
      /** Same-capture public directory, including an explicitly empty inventory. */
      readonly publicDirectory: string;
      /** Browser controls have no private server directory. */
      readonly serverDirectory?: never;
    });

/** Persisted server control with three separate same-capture directories. */
export type PersistedServerV3 = ServerControlV3 & {
  /** Managed asset directory. */
  readonly assetDirectory: string;
  /** Public directory, required even when its inventory is empty. */
  readonly publicDirectory: string;
  /** Private non-servable server-module directory. */
  readonly serverDirectory: string;
};

/** The new outer completed-record variants, independent of legacy formats. */
export type PersistedTargetedBuildV3 = PersistedBrowserV3 | PersistedServerV3;

/** Source-free target wrapper; runtime validation must prove control/inventory correspondence. */
export type TargetedCapturedBuild<
  Target extends CapturedProductionTargetV1 = CapturedProductionTargetV1,
> =
  | {
      /** Browser control whose inner hosting version is one. */
      readonly control: BrowserControlV3<HostingRecordV1, Target>;
      /** Strict legacy inventory, with no public or private byte map. */
      readonly inventory: CapturedBrowserBuild;
    }
  | {
      /** Browser control whose inner hosting version is two. */
      readonly control: BrowserControlV3<HostingRecordV2, Target>;
      /** Strict managed/public byte inventories. */
      readonly inventory: CapturedPublicBuild;
    }
  | {
      /** Server control excluding browser/static. */
      readonly control: ServerControlV3<Exclude<Target, BrowserStaticBinding>>;
      /** Strict managed/public/private byte inventories. */
      readonly inventory: CapturedServerBuild;
    };

/** Targeted inputs admitted by the future in-process host resource, excluding workerd. */
export type InProcessTargetedCapturedBuild = TargetedCapturedBuild<
  Exclude<CapturedProductionTargetV1, WorkerdBinding>
>;

/** Generated worker data; this type alone verifies neither bytes nor module registration. */
export interface WorkerCaptureDataV1 {
  /** Owned data-carrier format version. */
  readonly version: 1;
  /** Exact module-worker binding. */
  readonly productionTarget: WorkerdBinding;
  /** The production browser/public/server hosting branch selected for this package. */
  readonly hosting: (HostingRecordV1 | HostingRecordV2 | HostingRecordV3) & {
    readonly mode: "production";
  };
  /** Canonical effective mount snapshotted before reading captured bytes. */
  readonly selectedMountPath: string;
  /** Exact managed inventory encoded without a binary-to-text content conversion. */
  readonly managed: readonly {
    /** Logical managed asset key. */
    readonly path: string;
    /** Recorded response media type. */
    readonly contentType: string;
    /** Expected byte SHA-256. */
    readonly sha256: string;
    /** Canonical padded base64; an empty string represents real empty bytes. */
    readonly bytesBase64: string;
  }[];
  /** Exact public inventory; empty for V1, whose runtime has no public map. */
  readonly public: readonly {
    /** Canonical public application URL key. */
    readonly urlPath: string;
    /** Recorded response media type. */
    readonly contentType: string;
    /** Expected byte SHA-256. */
    readonly sha256: string;
    /** Canonical padded base64 of the exact public bytes. */
    readonly bytesBase64: string;
  }[];
  /** Private application module correspondence; empty for browser-only hosting. */
  readonly serverModules: readonly {
    /** Original private server-artifact path. */
    readonly path: string;
    /** Exact native registered module name. */
    readonly moduleName: string;
    /** Digest shared by the captured source and its registered module. */
    readonly sha256: string;
  }[];
}
