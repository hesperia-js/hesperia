import { ApolloLink } from "@apollo/client/link";
import { tap } from "rxjs";

import type { GraphQLFormattedError } from "graphql";

import type { GraphQLResult, GraphQLResultError } from "./types.ts";

const captureContextKey = Symbol("hesperia graphql response capture");

interface ResponseCaptureLinkState {
  readonly callerContextValue: unknown;
  isActive(): boolean;
  record(result: ApolloLink.Result): void;
  recordLinkStart(): void;
  recordLinkFailure(error: unknown): void;
  recordLinkComplete(): void;
}

/**
 * A single operation's raw response capture.
 *
 * @remarks
 * Pass this capture's context to its native Apollo call. The outer capture
 * link consumes its private Symbol value and restores the caller's previous
 * value under that Symbol before forwarding. Apollo's merge-only context setter
 * can leave an own Symbol property with `undefined` when the caller had no
 * value. Read the result after the call settles, then call `dispose()` in a
 * `finally` block. Query deduplication must stay disabled for managed calls.
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
   * Returns metadata accumulated from every raw response frame.
   *
   * GraphQL errors retain frame order. Extensions come from the latest frame
   * with a top-level `extensions` field.
   */
  getIncrementalMetadata(): Pick<GraphQLResult<TData>, "errors" | "extensions">;

  /** @internal Returns raw frames, terminal state, Link-entry count and completion-error evidence. */
  getLinkState():
    | {
        readonly status: "not-started" | "pending" | "complete";
        readonly hasNextPresent: boolean;
        readonly hasNext?: unknown;
        readonly invocationCount: number;
        readonly hasCompletedErrors: boolean;
      }
    | {
        readonly status: "error";
        readonly error: unknown;
        readonly hasNextPresent: boolean;
        readonly hasNext?: unknown;
        readonly invocationCount: number;
        readonly hasCompletedErrors: boolean;
      };

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
   * @param callerContext - The caller's configured context, whose value under
   * the private capture Symbol is restored before forwarding.
   * @typeParam TData - The declared data shape for the operation.
   * @returns A fresh capture whose `context` must be passed to that operation.
   */
  createCapture<TData = unknown>(
    callerContext?: ApolloLink.OperationContext,
  ): GraphQLResponseCapture<TData>;
}

class ResponseCapture<TData> implements GraphQLResponseCapture<TData>, ResponseCaptureLinkState {
  readonly context: ApolloLink.OperationContext;
  readonly callerContextValue: unknown;

  #disposed = false;
  #result: GraphQLResult<TData> | undefined;
  #linkFailure: { readonly error: unknown } | undefined;
  #linkStarted = false;
  #linkComplete = false;
  #linkInvocationCount = 0;
  #hasCompletedErrors = false;
  #hasNextPresent = false;
  #hasNext: unknown;
  #hasErrors = false;
  #errors: GraphQLFormattedError[] = [];
  #hasExtensions = false;
  #extensions: Record<string, unknown> | undefined;

  constructor(callerContext?: ApolloLink.OperationContext) {
    this.callerContextValue =
      callerContext === undefined ? undefined : Reflect.get(callerContext, captureContextKey);
    const captureContext: ApolloLink.OperationContext = {};
    Reflect.set(captureContext, captureContextKey, this);
    this.context = captureContext;
  }

  isActive(): boolean {
    return !this.#disposed;
  }

  getResult(): GraphQLResult<TData> | undefined {
    return this.#result;
  }

  getLinkState():
    | {
        readonly status: "not-started" | "pending" | "complete";
        readonly hasNextPresent: boolean;
        readonly hasNext?: unknown;
        readonly invocationCount: number;
        readonly hasCompletedErrors: boolean;
      }
    | {
        readonly status: "error";
        readonly error: unknown;
        readonly hasNextPresent: boolean;
        readonly hasNext?: unknown;
        readonly invocationCount: number;
        readonly hasCompletedErrors: boolean;
      } {
    const incremental = this.#hasNextPresent
      ? { hasNextPresent: true, hasNext: this.#hasNext }
      : { hasNextPresent: false };

    if (this.#linkFailure !== undefined) {
      return {
        status: "error",
        error: this.#linkFailure.error,
        invocationCount: this.#linkInvocationCount,
        hasCompletedErrors: this.#hasCompletedErrors,
        ...incremental,
      };
    }

    return {
      status: this.#linkComplete ? "complete" : this.#linkStarted ? "pending" : "not-started",
      invocationCount: this.#linkInvocationCount,
      hasCompletedErrors: this.#hasCompletedErrors,
      ...incremental,
    };
  }

  getIncrementalMetadata(): Pick<GraphQLResult<TData>, "errors" | "extensions"> {
    const metadata: Pick<GraphQLResult<TData>, "errors" | "extensions"> = {};

    if (this.#hasErrors) metadata.errors = this.#errors.length > 0 ? [...this.#errors] : undefined;

    if (this.#hasExtensions) {
      metadata.extensions = this.#extensions === undefined ? undefined : { ...this.#extensions };
    }

    return metadata;
  }

  dispose(): void {
    this.#disposed = true;
    this.#result = undefined;
    this.#linkFailure = undefined;
    this.#linkStarted = false;
    this.#linkComplete = false;
    this.#linkInvocationCount = 0;
    this.#hasCompletedErrors = false;
    this.#hasNextPresent = false;
    this.#hasNext = undefined;
    this.#hasErrors = false;
    this.#errors.length = 0;
    this.#hasExtensions = false;
    this.#extensions = undefined;
  }

  record(result: ApolloLink.Result): void {
    if (this.#disposed) {
      return;
    }

    this.#result = snapshotGraphQLResult<TData>(result);

    const incremental = result as ApolloLink.Result & {
      readonly hasNext?: unknown;
      readonly completed?: readonly { readonly errors?: readonly GraphQLFormattedError[] }[];
      readonly incremental?: readonly { readonly errors?: readonly GraphQLFormattedError[] }[];
      readonly errors?: readonly GraphQLFormattedError[];
      readonly extensions?: Record<string, unknown>;
    };

    if (Object.prototype.hasOwnProperty.call(incremental, "hasNext")) {
      this.#hasNextPresent = true;
      this.#hasNext = incremental.hasNext;
    }

    this.captureErrors(incremental);

    for (const patch of incremental.incremental ?? []) this.captureErrors(patch);

    for (const completion of incremental.completed ?? []) {
      this.captureErrors(completion);
      if ((completion.errors?.length ?? 0) > 0) this.#hasCompletedErrors = true;
    }

    if (Object.prototype.hasOwnProperty.call(incremental, "extensions")) {
      this.#hasExtensions = true;
      this.#extensions =
        incremental.extensions === undefined ? undefined : { ...incremental.extensions };
    }
  }

  /** @internal Record entry into this operation's Link chain. */
  recordLinkStart(): void {
    if (this.#disposed) return;

    this.#linkStarted = true;
    this.#linkInvocationCount += 1;
  }

  /** @internal Record the original terminal error from the Link chain. */
  recordLinkFailure(error: unknown): void {
    if (this.#disposed) return;

    this.#linkFailure = { error };
  }

  /** @internal Record completion of this operation's Link chain. */
  recordLinkComplete(): void {
    if (this.#disposed) return;

    this.#linkComplete = true;
  }

  private captureErrors(source: { readonly errors?: readonly GraphQLFormattedError[] }): void {
    if (!Object.prototype.hasOwnProperty.call(source, "errors")) return;

    this.#hasErrors = true;

    if (source.errors) this.#errors.push(...source.errors);
  }
}

/**
 * Creates a public Apollo Link middleware that snapshots each operation's raw
 * response before Apollo Client applies its query result and error policies.
 *
 * @returns The link and a factory for per-call response capture state.
 */
export function createResponseCaptureLink(): GraphQLResponseCaptureLink {
  const captures = new WeakMap<object, ResponseCaptureLinkState>();
  const link = new ApolloLink((operation, forward) => {
    const candidate = Reflect.get(operation.getContext(), captureContextKey);
    const issuedCapture =
      typeof candidate === "object" && candidate !== null ? captures.get(candidate) : undefined;
    const capture = issuedCapture?.isActive() ? issuedCapture : undefined;
    capture?.recordLinkStart();

    const downstream = (() => {
      try {
        if (capture !== undefined) {
          operation.setContext((previous) => {
            const forwardedContext = { ...previous };
            Reflect.set(forwardedContext, captureContextKey, capture.callerContextValue);
            return forwardedContext;
          });
        }

        return forward(operation);
      } catch (error) {
        capture?.recordLinkFailure(error);
        throw error;
      }
    })();

    return downstream.pipe(
      tap({
        next(result) {
          capture?.record(result);
        },
        error(error: unknown) {
          capture?.recordLinkFailure(error);
        },
        complete() {
          capture?.recordLinkComplete();
        },
      }),
    );
  });

  return {
    link,
    createCapture<TData = unknown>(callerContext?: ApolloLink.OperationContext) {
      const capture = new ResponseCapture<TData>(callerContext);
      captures.set(capture, capture);
      return capture;
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
