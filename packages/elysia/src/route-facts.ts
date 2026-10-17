/** Stable virtual module carrying checked Elysia HTTP route metadata. */
export const appRoutesModuleId = "hesperia:plugin/elysia/app-routes";

/** Browser-safe facts used to adapt one checked Elysia App through Eden. */
export interface AppRouteFact {
  /** Uppercase HTTP method exposed by Eden. */
  readonly method: string;
  /** Normalized route path exposed by Eden. */
  readonly path: string;
}
