import type { AppRouteFact } from "./route-facts.ts";

/** Private project module supplying checked, browser-safe effect declarations. */
export const appEffectsModuleId = "hesperia:plugin/elysia/app-effects";

/** Request fields presented to a checked native effect selector. */
export interface EffectRequest {
  /** Captured native path parameters for this mutation invocation. */
  readonly params?: Readonly<Record<string, string | number>>;
  /** Authored mutation body, retaining the invocation's reference. */
  readonly body?: unknown;
  /** Authored query fields, retaining the invocation's reference. */
  readonly query?: unknown;
  /** Explicit per-call headers, retaining the invocation's reference. */
  readonly headers?: unknown;
}

/** Erased compiler-validated effect used only inside the optional integration. */
export interface AppEffectFact {
  /** Configured native mutation route triggering the effect. */
  readonly source: AppRouteFact;
  /** Configured native query route selected for the effect. */
  readonly target: AppRouteFact;
  /** Synchronous mapping evaluated by Aeolia before invocation and after success. */
  readonly select: (input: EffectRequest) => unknown;
  /** Effect applied to an existing selected query store after mutation success. */
  readonly on: "invalidate" | "revalidate";
}
