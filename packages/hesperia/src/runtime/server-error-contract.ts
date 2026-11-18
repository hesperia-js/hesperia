/** The plain failure value sent to a server-rendered error view and its resume graph. */
export interface ServerErrorProjection {
  readonly status: 500;
  readonly message: "Internal Server Error";
  readonly stack?: string;
}

/** Project an original server failure without exposing its message or cause. */
export type ServerErrorProjector = (cause: unknown) => ServerErrorProjection;

/** @internal The package-selected implementation; this declaration has no runtime body. */
export declare const projectServerError: ServerErrorProjector;
