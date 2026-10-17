export const browserCssCoverageOwnerIds = {
  server: "browser-css-server",
  page: "browser-css-page",
  document: "browser-css-document",
  asyncAwaited: "browser-async-awaited-child",
  asyncRequiredBinding: "browser-async-required-binding",
  asyncRecovery: "browser-async-reset-recovery",
  routeHostRetainedLayouts: "browser-route-host-retained-layouts",
  routeHostRecoveredLayout: "browser-route-host-recovered-layout",
  routeHostCancelledPreparation: "browser-route-host-cancelled-preparation",
  importedMarkup: "browser-imported-markup",
  documentFailure: "browser-css-document-failure",
  elementFailure: "browser-css-element-failure",
} as const;

export type BrowserCssCoverageOwnerId =
  (typeof browserCssCoverageOwnerIds)[keyof typeof browserCssCoverageOwnerIds];

export const browserCssCoveragePageOwnerIds = [
  browserCssCoverageOwnerIds.page,
  browserCssCoverageOwnerIds.document,
  browserCssCoverageOwnerIds.asyncAwaited,
  browserCssCoverageOwnerIds.asyncRequiredBinding,
  browserCssCoverageOwnerIds.asyncRecovery,
  browserCssCoverageOwnerIds.routeHostRetainedLayouts,
  browserCssCoverageOwnerIds.routeHostRecoveredLayout,
  browserCssCoverageOwnerIds.routeHostCancelledPreparation,
  browserCssCoverageOwnerIds.importedMarkup,
  browserCssCoverageOwnerIds.documentFailure,
  browserCssCoverageOwnerIds.elementFailure,
] as const;

export type BrowserCssCoveragePageOwnerId = (typeof browserCssCoveragePageOwnerIds)[number];

export function isBrowserCssCoveragePageOwnerId(
  value: unknown,
): value is BrowserCssCoveragePageOwnerId {
  return browserCssCoveragePageOwnerIds.some((ownerId) => ownerId === value);
}

export interface BrowserCssCoverageScenario {
  readonly spec: string;
  readonly title: string;
}

export const browserCssCoverageReceiptNames = {
  [browserCssCoverageOwnerIds.server]: "server-receipt.json",
  [browserCssCoverageOwnerIds.page]: "page-receipt.json",
  [browserCssCoverageOwnerIds.document]: "document-receipt.json",
  [browserCssCoverageOwnerIds.asyncAwaited]: "async-awaited-receipt.json",
  [browserCssCoverageOwnerIds.asyncRequiredBinding]: "async-required-binding-receipt.json",
  [browserCssCoverageOwnerIds.asyncRecovery]: "async-recovery-receipt.json",
  [browserCssCoverageOwnerIds.routeHostRetainedLayouts]: "route-host-retained-layouts-receipt.json",
  [browserCssCoverageOwnerIds.routeHostRecoveredLayout]: "route-host-recovered-layout-receipt.json",
  [browserCssCoverageOwnerIds.routeHostCancelledPreparation]:
    "route-host-cancelled-preparation-receipt.json",
  [browserCssCoverageOwnerIds.importedMarkup]: "imported-markup-receipt.json",
  [browserCssCoverageOwnerIds.documentFailure]: "document-failure-receipt.json",
  [browserCssCoverageOwnerIds.elementFailure]: "element-failure-receipt.json",
} as const satisfies Record<BrowserCssCoverageOwnerId, string>;

export const browserCssCoverageRequiredSources = {
  [browserCssCoverageOwnerIds.server]: [
    "packages/tooling/src/project.ts",
    "packages/tooling/src/builtin-assets.ts",
    "packages/tooling/src/plugin-pipeline.ts",
    "packages/compiler/src/project-compilation.ts",
  ],
  [browserCssCoverageOwnerIds.page]: ["packages/hesperia/src/runtime/style.ts"],
  [browserCssCoverageOwnerIds.document]: ["packages/hesperia/src/runtime/dom.ts"],
  [browserCssCoverageOwnerIds.asyncAwaited]: ["packages/hesperia/src/runtime/async.ts"],
  [browserCssCoverageOwnerIds.asyncRequiredBinding]: ["packages/hesperia/src/runtime/async.ts"],
  [browserCssCoverageOwnerIds.asyncRecovery]: ["packages/hesperia/src/runtime/async.ts"],
  [browserCssCoverageOwnerIds.routeHostRetainedLayouts]: [
    "packages/hesperia/src/routing/route-host.ts",
  ],
  [browserCssCoverageOwnerIds.routeHostRecoveredLayout]: [
    "packages/hesperia/src/routing/route-host.ts",
  ],
  [browserCssCoverageOwnerIds.routeHostCancelledPreparation]: [
    "packages/hesperia/src/routing/route-host.ts",
  ],
  [browserCssCoverageOwnerIds.importedMarkup]: ["packages/hesperia/src/runtime/style.ts"],
  [browserCssCoverageOwnerIds.documentFailure]: ["packages/hesperia/src/runtime/dom.ts"],
  [browserCssCoverageOwnerIds.elementFailure]: ["packages/hesperia/src/runtime/dom.ts"],
} as const satisfies Record<BrowserCssCoverageOwnerId, readonly string[]>;

export const browserCssCoverageScenariosByOwnerId = {
  [browserCssCoverageOwnerIds.page]: {
    spec: "tests/browser/css-runtime.spec.ts",
    title: "unready direct mounts reveal the same text and elements in their final host slots",
  },
  [browserCssCoverageOwnerIds.document]: {
    spec: "tests/browser/css-runtime.spec.ts",
    title: "Document mount waits on its installed head and releases preloaded old-head links",
  },
  [browserCssCoverageOwnerIds.asyncAwaited]: {
    spec: "tests/browser/async.spec.ts",
    title: "awaited child composition commits descendant effects before the parent",
  },
  [browserCssCoverageOwnerIds.asyncRequiredBinding]: {
    spec: "tests/browser/async.spec.ts",
    title: "an independently composed async child rejects a required binding before its body",
  },
  [browserCssCoverageOwnerIds.asyncRecovery]: {
    spec: "tests/browser/async.spec.ts",
    title: "reset recovers consumed async sources and leaves unrelated rendered owners live",
  },
  [browserCssCoverageOwnerIds.routeHostRetainedLayouts]: {
    spec: "tests/browser/route-host.spec.ts",
    title:
      "with page caching disabled, compiled layouts retain state while pages and query inputs change",
  },
  [browserCssCoverageOwnerIds.routeHostRecoveredLayout]: {
    spec: "tests/browser/route-host.spec.ts",
    title:
      "with page caching disabled, a damaged layout is recreated after cleanup while its intact ancestor survives",
  },
  [browserCssCoverageOwnerIds.routeHostCancelledPreparation]: {
    spec: "tests/browser/route-host.spec.ts",
    title: "a query update cancels detached route preparation without running its effects",
  },
  [browserCssCoverageOwnerIds.importedMarkup]: {
    spec: "tests/browser/imported-markup.spec.ts",
    title: "compiled imported markup keeps native root behavior, ownership, and cleanup",
  },
  [browserCssCoverageOwnerIds.documentFailure]: {
    spec: "tests/browser/css-runtime.spec.ts",
    title: "Document CSS failure keeps the shell hidden and rejects the same settled fault",
  },
  [browserCssCoverageOwnerIds.elementFailure]: {
    spec: "tests/browser/css-runtime.spec.ts",
    title:
      "CSS failure is reported once and rejects a later settled call without unhandled rejection",
  },
} as const satisfies Record<BrowserCssCoveragePageOwnerId, BrowserCssCoverageScenario>;

export interface CaptureReceipt {
  readonly format: "hesperia-browser-css-coverage-capture";
  readonly version: 2;
  readonly runId: string;
  readonly populationFingerprint: string;
  readonly ownerId: BrowserCssCoverageOwnerId;
  readonly scenario?: BrowserCssCoverageScenario;
  readonly seedArtifact: string;
  readonly hitArtifact: string;
  readonly positiveSources: readonly string[];
  readonly buildSubstitutions?: number;
  readonly buildSubstitutionPaths?: readonly {
    readonly path: string;
    readonly realPath: string;
  }[];
  readonly runtimeSubstitutionPaths?: readonly {
    readonly path: string;
    readonly realPath: string;
  }[];
}
