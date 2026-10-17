import type { HesperiaNavigation } from "../../../../packages/hesperia/src/navigation.ts";
import type {
  NavigationResult,
  Router,
} from "../../../../packages/hesperia/src/routing/navigation.ts";
import type { CoverageFile } from "../../../../scripts/ci/coverage-collector.ts";
import type { WorkerCoverageBuildRecord } from "../../../../scripts/ci/coverage-worker-build.ts";

export type BrowserEngineName = string;

export type BrowserPageRole = "main" | "startup" | "supersession";

export interface BrowserPageCoverageConfig {
  readonly coverageVariable: string;
  readonly runId: string;
  readonly ownerId: string;
  readonly platform: string;
  readonly populationFingerprint: string;
  readonly builds: readonly WorkerCoverageBuildRecord[];
  readonly receiptPath: string;
}

export interface RoutingPublicFlowsRuntimeConfig {
  readonly playwrightModuleUrl: string;
  readonly serverUrl: string;
  readonly browserCoverage?: BrowserPageCoverageConfig | null;
}

export interface BrowserPageCoverageContext {
  readonly runId: string;
  readonly ownerId: string;
  readonly platform: string;
  readonly populationFingerprint: string;
  readonly engine: BrowserEngineName;
  readonly browserVersion: string;
  readonly pageRole: BrowserPageRole;
  readonly documentOrdinal: number;
  readonly captureId: string;
  readonly captureProcessId: number;
  readonly documentTimeOrigin?: number;
}

export interface BrowserPageCoverageCapture extends BrowserPageCoverageContext {
  readonly format: "hesperia-browser-page-coverage";
  readonly capturePhase: "pagehide" | "final";
  readonly href: string;
  readonly timeOrigin: number;
  readonly coverage: Record<string, CoverageFile>;
}

export interface BrowserReloadStateObservation {
  readonly timeOrigin?: number;
  readonly app?: string | null;
  readonly layout?: string | null | undefined;
  readonly page?: string | null | undefined;
  readonly states?: readonly (string | null | undefined)[];
  readonly trace?: readonly string[];
  readonly timeline?: readonly string[];
  readonly persisted?: {
    readonly trace?: readonly string[];
    readonly timeline?: readonly string[];
  } | null;
  readonly captureError?: string;
  readonly initialCaptureError?: string;
}

export type ReloadAttemptOutcome =
  | { readonly kind: "navigation-completed" }
  | { readonly kind: "navigation-failed"; readonly message: string };

export type ReloadActionResult =
  | { readonly kind: "requested" }
  | { readonly kind: "threw"; readonly message: string };

export type ReloadActionOutcome =
  | { readonly kind: "action-returned"; readonly result: ReloadActionResult }
  | { readonly kind: "evaluation-rejected"; readonly message: string };

export type ReloadDepartureOutcome =
  | { readonly kind: "departures" }
  | { readonly kind: "document-changed" };

export type ReloadSignal =
  | ReloadAttemptOutcome
  | ReloadActionOutcome
  | ReloadDepartureOutcome
  | { readonly kind: "action-failed"; readonly message: string };

export interface BrowserNavigationReloadResult {
  readonly committed: Promise<unknown>;
  readonly finished: Promise<unknown>;
}

export interface RoutingPublicFixture {
  readonly beforeLeaveChecks: number;
  readonly blockedBodies: number;
  readonly redirectBodies: number;
  readonly sharedUpdateDone: boolean;
  readonly navigationResults: readonly NavigationResult[];
  readonly navigation: HesperiaNavigation;
  readonly router?: Pick<Router, "updateQuery">;
  readonly renderFailure?: Error;
  readonly reloadNative: boolean;
  reloadEnabled: boolean;
  reloadAllowed: boolean;
  reloadHoldLayout: boolean;
  readonly reloadTrace: string[];
  readonly reloadTimeline: string[];
  reloadObserverReady: boolean;
  reloadOutcome: string | undefined;
  reloadCommittedOutcome: string | undefined;
  reloadFinishedOutcome: string | undefined;
  releaseReload: (() => void) | undefined;
  startReload: (() => void) | undefined;
  reloadReferences:
    | {
        readonly document: Document;
        readonly html: Element;
        readonly layout: Element | null;
        readonly page: Element | null;
      }
    | undefined;
}

declare global {
  var routingPublicFixture: RoutingPublicFixture;

  var __hesperiaCoverageDocumentCapture: BrowserPageCoverageContext | undefined;
}

export type { CoverageFile, WorkerCoverageBuildRecord };
