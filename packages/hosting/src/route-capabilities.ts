/** Concrete route output that an owned target may support. */
export type ConcreteRoutePlan =
  | {
      /** Browser rendering produces the route without server markup. */
      readonly producer: "csr";
      /** Browser rendering mounts a new tree. */
      readonly activation: "mount";
      /** The complete startup document is available before delivery. */
      readonly delivery: "complete";
      /** The renderer's explicit mismatch policy, never an inferred default. */
      readonly hydrationMismatch: "client-remount" | "fatal";
    }
  | {
      /** The route is produced for each server request. */
      readonly producer: "ssr";
      /** Server markup is hydrated or remains inactive in the browser. */
      readonly activation: "hydrate" | "none";
      /** The route's resolved complete or progressive delivery contract. */
      readonly delivery: "complete" | "progressive";
      /** The renderer's explicit mismatch policy. */
      readonly hydrationMismatch: "client-remount" | "fatal";
    }
  | {
      /** The route is produced during static generation. */
      readonly producer: "ssg";
      /** Static markup is hydrated or remains inactive in the browser. */
      readonly activation: "hydrate" | "none";
      /** Static output is delivered as a complete document. */
      readonly delivery: "complete";
      /** The renderer's explicit mismatch policy. */
      readonly hydrationMismatch: "client-remount" | "fatal";
    };

/** Capability facts supplied by an implemented target, rather than project configuration. */
export interface RoutePlanCapabilitiesV1 {
  /** Capability contract version accepted by the route resolver. */
  readonly version: 1;
  /** Stable identity of the owned capability declaration. */
  readonly identity: string;
  /** Source reference supporting these renderer, host and loader facts. */
  readonly provenance: string;
  /** Whether this target can render route UI in the browser. */
  readonly clientRender: boolean;
  /** The complete concrete tuples the implementation can produce. */
  readonly supportedPlans: readonly ConcreteRoutePlan[];
}
