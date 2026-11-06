import type { GraphQLFormattedError } from "graphql";

/**
 * The fields available on a GraphQL response envelope.
 *
 * @remarks
 * `data` is absent when a request fails before GraphQL execution and is `null`
 * when execution completes without producing data. Field errors may accompany
 * partial data. Transport, decoding, and cancellation failures do not have a
 * response envelope.
 *
 * @typeParam TData - The declared data shape for the operation.
 */
export interface GraphQLResult<TData = unknown> {
  /** Data produced by GraphQL execution, `null`, or absent before execution. */
  data?: TData | null;

  /** Formatted GraphQL request or execution errors returned by the server. */
  errors?: readonly GraphQLFormattedError[];

  /** Additional response metadata returned by the server. */
  extensions?: Record<string, unknown>;
}

/**
 * A standard `Error` annotated with the GraphQL response details available to
 * the operation and its native failure cause.
 *
 * @remarks
 * This remains an ordinary `Error` and does not define an Aeolia outcome
 * category. `result` omits fields that the selected native error policy
 * deliberately discarded and is absent when no response remains available.
 * The inherited `cause` property contains the native error when one is
 * available.
 *
 * @typeParam TData - The declared data shape for the operation.
 */
export type GraphQLResultError<TData = unknown> = Error & {
  /** The available response envelope, if the selected policy permits it. */
  readonly result?: GraphQLResult<TData>;
  /** The native failure that caused this adapter error, when available. */
  readonly cause?: unknown;
};
