import type { GraphQLFormattedError } from "graphql";
import type { DeepPartial } from "@apollo/client/utilities";

/**
 * The fields available on a GraphQL response envelope.
 *
 * @remarks
 * `data` is absent when a request fails before GraphQL execution and is `null`
 * when execution completes without producing data. Field errors may accompany
 * partial data. Transport, decoding, and cancellation failures do not have a
 * response envelope.
 *
 * Subscription `Next` events follow the selected native subscription policy.
 * An errorful event is nonterminal; `none` omits its data while retaining its
 * available errors and extensions. Protocol and transport failures terminate
 * the source instead of producing a successful envelope.
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
 * One cumulative result emitted by an explicitly enabled incremental query.
 *
 * @remarks
 * `dataState` is Apollo's public assembly state from the same no-cache
 * ObservableQuery. Intermediate observer emissions, including `streaming`
 * states, can be reported while the retained `reobserve()` promise is pending.
 * After that promise fulfills, Hesperia reads `getCurrentResult()` from the same
 * query to determine its final assembly state. The promise returns data and
 * errors but does not expose `dataState` or `loading`.
 * Streaming data is `DeepPartial<TData> | TData`: deferred fields and streamed
 * items may still be missing, and Apollo can type a streaming emission as
 * `TData` before assembly completes. The `streaming` discriminator means
 * Apollo's observer retains streaming assembly state. A terminal streaming
 * value also requires an error-bearing `completed` entry in the same
 * captured Link and an explicit terminal `hasNext: false`. Under `all`,
 * the promise exposes CombinedGraphQLErrors. Under `ignore`, the capture
 * retains raw error evidence while the result omits it. The adapter does not
 * correlate completed IDs with pending IDs.
 * Query progress remains active until the same native fetch and any bound
 * output validation succeed.
 *
 * When the selected error policy permits them, `errors` contains errors captured
 * from response frames once each. The `ignore` policy omits them.
 * `extensions` contains the latest top-level extension value received from a
 * response frame. It does not merge nested incremental extension values.
 *
 * @typeParam TData - The document's complete data shape.
 */
export type GraphQLProgress<TData = unknown> =
  | (Omit<GraphQLResult<DeepPartial<TData>>, "data"> & {
      /** Apollo reports a cumulative result with streaming assembly state. */
      readonly dataState: "streaming";
      /** Full or partial data from Apollo's current observer result. */
      readonly data: TData | DeepPartial<TData> | null;
    })
  | (Omit<GraphQLResult<TData>, "data"> & {
      /** Apollo reports empty state for the terminal null execution result. */
      readonly dataState: "empty";
      /** Strict null from the promise and same-query final observation. */
      readonly data: null;
    })
  | (Omit<GraphQLResult<TData>, "data"> & {
      /** Apollo reports complete assembly for this observer result. */
      readonly dataState: "complete";
      /** Complete data from Apollo's final observer result. */
      readonly data: TData | null;
    });

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
