import type {
  ApolloClient,
  DefaultContext,
  ErrorPolicy,
  OperationVariables,
  TypedDocumentNode,
} from "@apollo/client";
import { CombinedGraphQLErrors } from "@apollo/client/errors";
import { ApolloLink } from "@apollo/client/link";
import { Observable, type Subscription } from "rxjs";
import {
  createGraphQLResultError,
  isGraphQLExecutionResult,
  snapshotGraphQLResult,
} from "./response.ts";
import type { GraphQLResult } from "./types.ts";

const contextKey = "__hesperia_graphql_subscription__";

type NativeResult = { readonly data?: unknown; readonly error?: unknown };

type Frame<T> =
  | {
      readonly kind: "next";
      readonly result: GraphQLResult<T>;
      native?: NativeResult;
      completed?: boolean;
    }
  | { readonly kind: "error"; readonly cause: unknown }
  | { readonly kind: "complete" };

type Terminal = { readonly kind: "closed" } | { readonly kind: "failed"; readonly cause: unknown };

type Reader<T> = {
  readonly resolve: (result: IteratorResult<T>) => void;
  readonly reject: (cause: unknown) => void;
};

/** @internal Capture Link callbacks before Apollo normalizes or filters them. */
export function createSubscriptionLink(): ApolloLink {
  return new ApolloLink((operation, forward) => {
    const candidate: unknown = operation.getContext()[contextKey];

    if (!(candidate instanceof SubscriptionOperation)) return forward(operation);

    return new Observable<ApolloLink.Result>((observer) =>
      forward(operation).subscribe({
        next(result) {
          candidate.dispatch({ kind: "next", result: snapshotGraphQLResult(result) }, () =>
            observer.next(result),
          );
        },
        error(cause: unknown) {
          candidate.dispatch({ kind: "error", cause }, () => observer.error(cause));
        },
        complete() {
          candidate.dispatch({ kind: "complete" }, () => observer.complete());
        },
      }),
    );
  });
}

/** @internal One native operation and its ordered async-iterator delivery. */
class SubscriptionOperation<T> implements AsyncIterableIterator<GraphQLResult<T>> {
  readonly context: DefaultContext = { [contextKey]: this };

  #values: GraphQLResult<T>[] = [];
  #readers: Reader<GraphQLResult<T>>[] = [];
  #terminal: Terminal | undefined;
  #frame: Frame<T> | undefined;
  #subscription: Subscription | undefined;
  #released = false;
  #policy: ErrorPolicy;
  #signal: AbortSignal;
  #terminations: Set<() => void>;

  constructor(policy: ErrorPolicy, signal: AbortSignal, terminations: Set<() => void>) {
    this.#policy = policy;
    this.#signal = signal;
    this.#terminations = terminations;

    terminations.add(this.stop);
    signal.addEventListener("abort", this.abort, { once: true });
  }

  attach(subscription: Subscription): void {
    if (!this.#released) {
      this.#subscription = subscription;

      return;
    }

    try {
      subscription.unsubscribe();
    } catch (cause) {
      this.#terminal = { kind: "failed", cause };

      this.flush();
    }
  }

  dispatch(frame: Frame<T>, forward: () => void): void {
    if (this.#released) return;

    // Apollo filters some Next values and converts Link errors to next + complete.
    // Native outputs correlate only while this exact Link notification is forwarded.
    const previous = this.#frame;
    this.#frame = frame;

    try {
      forward();

      if (this.#released) return;

      if (frame.kind === "error") this.fail(frame.cause);
      else if (frame.kind === "complete") this.finish({ kind: "closed" });
      else this.receive(frame);
    } catch (cause) {
      this.fail(cause);
    } finally {
      this.#frame = previous;
    }
  }

  nativeNext = (result: NativeResult): void => {
    const frame = this.#frame;

    if (frame?.kind === "next") frame.native = result;
    else if (frame?.kind !== "error") {
      this.fail(
        result.error ?? new Error("The native subscription emitted without response provenance"),
      );
    }
  };

  nativeError = (cause: unknown): void => {
    this.fail(cause);
  };

  nativeComplete = (): void => {
    const frame = this.#frame;

    if (frame?.kind === "next") frame.completed = true;
    else if (frame === undefined)
      this.fail(new Error("The native subscription completed without a Link terminal event"));
  };

  next(): Promise<IteratorResult<GraphQLResult<T>>> {
    return new Promise((resolve, reject) => {
      this.#readers.push({ resolve, reject });

      this.flush();
    });
  }

  async return(): Promise<IteratorResult<GraphQLResult<T>>> {
    this.#values.length = 0;
    this.#terminal = { kind: "closed" };

    const terminal = this.finish(this.#terminal);

    if (terminal.kind === "failed") throw terminal.cause;

    return { done: true, value: undefined };
  }

  async throw(cause?: unknown): Promise<IteratorResult<GraphQLResult<T>>> {
    this.#values.length = 0;

    const terminal = this.finish({ kind: "failed", cause });

    throw terminal.kind === "failed" ? terminal.cause : cause;
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<GraphQLResult<T>> {
    return this;
  }

  private receive(frame: Extract<Frame<T>, { kind: "next" }>): void {
    const cause = frame.native?.error;

    if (cause !== undefined && !CombinedGraphQLErrors.is(cause)) {
      this.fail(cause);

      return;
    }

    let result = frame.result;
    const executionErrors = Boolean(result.errors?.length) || CombinedGraphQLErrors.is(cause);

    if (frame.completed) {
      this.fail(new Error("The native subscription completed without a Link terminal event"));

      return;
    }

    if (this.#policy === "ignore") {
      const { errors: _ignored, ...available } = result;
      result = available;

      if (executionErrors && !isGraphQLExecutionResult(result)) return;
    } else if (this.#policy === "none" && executionErrors) {
      const { data: _omitted, ...available } = result;
      result = available;
    }

    if (!isGraphQLExecutionResult(result) && !executionErrors) {
      this.fail(
        createGraphQLResultError(
          "The GraphQL subscription did not produce an execution result",
          result,
          cause,
        ),
      );

      return;
    }

    this.#values.push(result);

    this.flush();
  }

  private fail(cause: unknown): void {
    this.finish({ kind: "failed", cause });
  }

  private finish(terminal: Terminal): Terminal {
    if (!this.#released) {
      this.#released = true;
      this.#terminal = terminal;

      this.#signal.removeEventListener("abort", this.abort);
      this.#terminations.delete(this.stop);

      const subscription = this.#subscription;
      this.#subscription = undefined;

      try {
        subscription?.unsubscribe();
      } catch (cause) {
        this.#terminal = {
          kind: "failed",
          cause:
            terminal.kind === "failed"
              ? new AggregateError(
                  [terminal.cause, cause],
                  "The GraphQL subscription failed and could not release its native operation",
                )
              : cause,
        };
      }
    }

    this.flush();

    return this.#terminal ?? terminal;
  }

  private flush(): void {
    while (this.#readers.length > 0 && this.#values.length > 0) {
      this.#readers.shift()!.resolve({ done: false, value: this.#values.shift()! });
    }

    if (this.#terminal === undefined || this.#values.length > 0) return;

    for (const reader of this.#readers.splice(0)) {
      if (this.#terminal.kind === "failed") reader.reject(this.#terminal.cause);
      else reader.resolve({ done: true, value: undefined });
    }
  }

  private abort = (): void => {
    this.#values.length = 0;

    this.fail(this.#signal.reason);
  };

  private stop = (): void => {
    this.#values.length = 0;
    const cause = new Error("The GraphQL client has been stopped");

    const terminal = this.finish({ kind: "failed", cause });

    if (terminal.kind === "failed" && terminal.cause !== cause) throw terminal.cause;
  };
}

/** @internal Open one native subscription; the caller retains socket ownership. */
export function openGraphQLSubscription<TData, TVariables extends OperationVariables>(
  native: ApolloClient,
  document: TypedDocumentNode<TData, TVariables>,
  variables: TVariables,
  signal: AbortSignal,
  policy: ErrorPolicy,
  context: DefaultContext,
  terminations: Set<() => void>,
): AsyncIterable<GraphQLResult<TData>> {
  signal.throwIfAborted();

  const operation = new SubscriptionOperation<TData>(policy, signal, terminations);

  try {
    operation.attach(
      native
        .subscribe<TData, TVariables>({
          query: document,
          variables,
          errorPolicy: policy,
          fetchPolicy: "no-cache",
          context: {
            ...context,
            ...operation.context,
            queryDeduplication: false,
            fetchOptions: { ...context.fetchOptions, signal },
          },
        })
        .subscribe({
          next: operation.nativeNext,
          error: operation.nativeError,
          complete: operation.nativeComplete,
        }),
    );
  } catch (cause) {
    operation.nativeError(cause);
  }

  return operation;
}
