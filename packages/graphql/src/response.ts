import { ApolloLink } from "@apollo/client/link";
import { tap } from "rxjs";

import type { GraphQLResult, GraphQLResultError } from "./types.ts";

const captureContextKey = "__hesperia_graphql_response_capture__";

/**
 * A single operation's raw response capture.
 *
 * @remarks
 * Merge `context` into exactly one native Apollo call. Read the result after
 * that call settles, then call `dispose()` in a `finally` block. Apollo query
 * deduplication must be disabled for managed calls so each call reaches this
 * capture link with its own context token.
 *
 * @typeParam TData - The declared data shape for the operation.
 */
export interface GraphQLResponseCapture<TData = unknown> {
  /** Private per-call context metadata for the corresponding Apollo operation. */
  readonly context: ApolloLink.OperationContext;

  /**
   * Returns the latest response envelope received by the link.
   *
   * @returns A shallow response snapshot, or `undefined` before a response is
   * received or after this capture is disposed.
   */
  getResult(): GraphQLResult<TData> | undefined;

  /**
   * Stops recording and releases the stored response reference.
   *
   * This does not cancel the native Apollo operation.
   */
  dispose(): void;
}

/**
 * An Apollo response-capture link and its per-operation capture factory.
 */
export interface GraphQLResponseCaptureLink {
  /** Middleware to place before the supplied native Apollo link. */
  readonly link: ApolloLink;

  /**
   * Creates capture state scoped to one Apollo operation.
   *
   * @typeParam TData - The declared data shape for the operation.
   * @returns A fresh capture whose `context` must be passed to that operation.
   */
  createCapture<TData = unknown>(): GraphQLResponseCapture<TData>;
}

class ResponseCapture<TData> implements GraphQLResponseCapture<TData> {
  readonly context: ApolloLink.OperationContext;

  #disposed = false;
  #result: GraphQLResult<TData> | undefined;

  constructor() {
    this.context = { [captureContextKey]: this };
  }

  getResult(): GraphQLResult<TData> | undefined {
    return this.#result;
  }

  dispose(): void {
    this.#disposed = true;
    this.#result = undefined;
  }

  record(result: ApolloLink.Result): void {
    if (this.#disposed) {
      return;
    }

    this.#result = snapshotGraphQLResult<TData>(result);
  }
}

/**
 * Creates a public Apollo Link middleware that snapshots each operation's raw
 * response before Apollo Client applies its query result and error policies.
 *
 * @returns The link and a factory for per-call response capture state.
 */
export function createResponseCaptureLink(): GraphQLResponseCaptureLink {
  const link = new ApolloLink((operation, forward) => {
    const context = operation.getContext() as ApolloLink.OperationContext & {
      [captureContextKey]?: unknown;
    };
    const candidate = context[captureContextKey];
    const capture = candidate instanceof ResponseCapture ? candidate : undefined;

    return forward(operation).pipe(
      tap((result) => {
        capture?.record(result);
      }),
    );
  });

  return {
    link,
    createCapture<TData = unknown>() {
      return new ResponseCapture<TData>();
    },
  };
}

/**
 * Checks whether a response contains the `data` field produced by GraphQL
 * execution.
 *
 * @param result - The response envelope to inspect.
 * @returns `true` when the response has a defined own `data` field, including
 * when that field is `null`.
 */
export function isGraphQLExecutionResult<TData>(
  result: GraphQLResult<TData>,
): result is GraphQLResult<TData> & { data: TData | null } {
  return Object.prototype.hasOwnProperty.call(result, "data") && result.data !== undefined;
}

/**
 * Creates a plain `Error` carrying the response details and native cause
 * available for a failed operation.
 *
 * @typeParam TData - The declared data shape for the operation.
 * @param message - The failure message to expose to callers.
 * @param result - The response envelope, if it may be exposed under the
 * selected native error policy.
 * @param cause - The native failure to preserve as the `Error.cause` value.
 * @returns An ordinary `Error` instance with the supplied result and cause.
 */
export function createGraphQLResultError<TData = unknown>(
  message: string,
  result?: GraphQLResult<TData>,
  cause?: unknown,
): GraphQLResultError<TData> {
  const error = (
    cause === undefined ? new Error(message) : new Error(message, { cause })
  ) as GraphQLResultError<TData>;

  if (result !== undefined) {
    Object.defineProperty(error, "result", {
      configurable: false,
      enumerable: true,
      value: result,
      writable: false,
    });
  }

  return error;
}

/** @internal Copy the available envelope before native processing mutates it. */
export function snapshotGraphQLResult<TData>(result: ApolloLink.Result): GraphQLResult<TData> {
  const source = result as GraphQLResult<TData>;
  const snapshot: GraphQLResult<TData> = {};

  if (Object.prototype.hasOwnProperty.call(source, "data")) {
    snapshot.data = source.data;
  }

  if (Object.prototype.hasOwnProperty.call(source, "errors")) {
    snapshot.errors = source.errors === undefined ? undefined : [...source.errors];
  }

  if (Object.prototype.hasOwnProperty.call(source, "extensions")) {
    snapshot.extensions = source.extensions === undefined ? undefined : { ...source.extensions };
  }

  return snapshot;
}
