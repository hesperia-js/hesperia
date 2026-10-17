/** Internal status carried from route presentation to Navigation.finished. */
export interface RouteRenderFailure {
  readonly error: unknown;
}

/** Read the transaction's route render failure after effects have settled. */
export type RouteRenderFailureReader = () => RouteRenderFailure | undefined;
