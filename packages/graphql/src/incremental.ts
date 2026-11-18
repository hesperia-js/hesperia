import type {
  ApolloClient,
  DefaultContext,
  ErrorPolicy,
  OperationVariables,
  TypedDocumentNode,
} from "@apollo/client";
import { CombinedGraphQLErrors } from "@apollo/client/errors";

import { createGraphQLResultError } from "./response.ts";
import type { GraphQLResponseCapture } from "./response.ts";
import type { GraphQLProgress, GraphQLResult } from "./types.ts";

export interface IncrementalQueryOptions<TData, TVariables extends OperationVariables> {
  readonly client: ApolloClient;
  readonly document: TypedDocumentNode<TData, TVariables>;
  readonly variables: TVariables;
  readonly context: DefaultContext;
  readonly abortSignal: AbortSignal;
  readonly errorPolicy: ErrorPolicy;
  readonly fetchPolicy: "no-cache";
  readonly capture: GraphQLResponseCapture<TData>;
  readonly reportProgress: (value: GraphQLProgress<TData>) => void;
}

/**
 * Run one retained Apollo execution and report its public watch results.
 *
 * The original reobserve promise supplies data and errors. After it fulfills,
 * the same no-cache ObservableQuery supplies Apollo's actual final data state.
 */
export async function executeIncrementalQuery<TData, TVariables extends OperationVariables>(
  options: IncrementalQueryOptions<TData, TVariables>,
): Promise<GraphQLResult<TData>> {
  const observableQuery = options.client.watchQuery<TData, TVariables>({
    query: options.document,
    variables: options.variables,
    context: options.context,
    fetchPolicy: "standby",
    errorPolicy: options.errorPolicy,
    notifyOnNetworkStatusChange: true,
  });
  let dispatchStarted = false;
  let observationFailed = false;
  let observationError: unknown;
  let progressSubscription: ReturnType<typeof observableQuery.subscribe> | undefined;
  const detachProgress = () => progressSubscription?.unsubscribe();

  try {
    progressSubscription = observableQuery.subscribe({
      next(result) {
        if (!dispatchStarted || options.abortSignal.aborted) return;

        if (result.dataState === "streaming") {
          if (result.data === undefined) return;

          options.reportProgress({
            ...metadataForPolicy(options.capture, options.errorPolicy),
            dataState: "streaming",
            data: result.data,
          });

          return;
        }
      },
      error(error) {
        observationFailed = true;
        observationError = error;
      },
    });
    options.abortSignal.addEventListener("abort", detachProgress, { once: true });
    options.abortSignal.throwIfAborted();

    dispatchStarted = true;
    const resultPromise = observableQuery.reobserve({
      context: options.context,
      errorPolicy: options.errorPolicy,
      fetchPolicy: options.fetchPolicy,
    });
    let retainFailed = false;
    let retainFailure: unknown;

    try {
      resultPromise.retain();
    } catch (cause) {
      retainFailed = true;
      retainFailure = cause;
    }

    let nativeResult: Awaited<typeof resultPromise>;

    try {
      nativeResult = await resultPromise;
    } catch (cause) {
      if (retainFailed) {
        throw new AggregateError(
          [retainFailure, cause],
          "Apollo's incremental operation and retained observer both failed",
        );
      }

      throw cause;
    }

    if (retainFailed) throw retainFailure;

    options.abortSignal.throwIfAborted();

    const captured = options.capture.getResult();
    const linkState = options.capture.getLinkState();
    const hasCombinedErrors = CombinedGraphQLErrors.is(nativeResult.error);
    const resolvedData: unknown = nativeResult.data;
    // The reobserve promise drops dataState and loading. The same no-cache watch
    // retains Apollo's public final result.
    const finalResult = observableQuery.getCurrentResult();
    const finalData: unknown = finalResult.data;

    if (linkState.status === "error") {
      if (options.errorPolicy === "ignore") {
        throw createGraphQLResultError(
          "The incremental GraphQL operation did not produce a complete result",
          undefined,
          linkState.error,
        );
      }

      throw linkState.error;
    }

    if (observationFailed) throw observationError;

    if (nativeResult.error && !hasCombinedErrors) throw nativeResult.error;

    if (linkState.invocationCount > 1) {
      throw createGraphQLResultError(
        "The incremental GraphQL operation reused its Link capture",
        undefined,
        nativeResult.error,
      );
    }

    if (
      linkState.status !== "complete" ||
      captured === undefined ||
      (linkState.hasNextPresent && linkState.hasNext !== false)
    ) {
      throw createGraphQLResultError(
        "The incremental GraphQL operation did not produce a complete result",
        undefined,
        nativeResult.error,
      );
    }

    if (finalResult.loading) {
      throw createGraphQLResultError(
        "The incremental GraphQL operation did not produce a complete result",
        undefined,
        nativeResult.error,
      );
    }

    if (hasCombinedErrors && nativeResult.data === undefined) throw nativeResult.error;

    const metadata = metadataForPolicy(options.capture, options.errorPolicy);

    if (finalResult.dataState === "empty") {
      if (resolvedData !== null || finalData !== null) {
        throw createGraphQLResultError(
          "The incremental GraphQL operation did not produce a complete result",
          undefined,
          nativeResult.error,
        );
      }

      if (options.errorPolicy === "none" && (metadata.errors?.length ?? 0) > 0) {
        throw createGraphQLResultError(
          "The incremental GraphQL operation did not produce a complete result",
          { data: null, ...metadata },
          nativeResult.error,
        );
      }

      const envelope: GraphQLResult<TData> = { data: null, ...metadata };
      const progress: GraphQLProgress<TData> = {
        ...metadata,
        dataState: "empty",
        data: null,
      };

      options.reportProgress(progress);

      return envelope;
    }

    if (finalResult.dataState === "streaming") {
      const hasPermittedDeferredCompletionError =
        linkState.hasCompletedErrors &&
        ((options.errorPolicy === "all" && hasCombinedErrors) || options.errorPolicy === "ignore");

      if (
        !hasPermittedDeferredCompletionError ||
        !linkState.hasNextPresent ||
        linkState.hasNext !== false ||
        nativeResult.data === undefined ||
        finalResult.data === undefined ||
        (resolvedData === null) !== (finalData === null)
      ) {
        throw createGraphQLResultError(
          "The incremental GraphQL operation did not produce a complete result",
          undefined,
          nativeResult.error,
        );
      }

      const envelope: GraphQLResult<TData> = { data: nativeResult.data, ...metadata };

      options.reportProgress({
        ...metadata,
        dataState: "streaming",
        data: finalResult.data,
      });

      return envelope;
    }

    if (
      finalResult.dataState !== "complete" ||
      nativeResult.data === undefined ||
      nativeResult.data === null ||
      finalResult.data === undefined ||
      finalResult.data === null
    ) {
      throw createGraphQLResultError(
        "The incremental GraphQL operation did not produce a complete result",
        undefined,
        nativeResult.error,
      );
    }

    const envelope: GraphQLResult<TData> = { data: nativeResult.data, ...metadata };

    options.reportProgress({
      ...metadata,
      dataState: "complete",
      data: finalResult.data,
    });

    return envelope;
  } catch (cause) {
    options.abortSignal.throwIfAborted();

    if (CombinedGraphQLErrors.is(cause)) {
      const metadata = metadataForPolicy(options.capture, options.errorPolicy);
      const available: GraphQLResult<unknown> =
        options.errorPolicy === "ignore"
          ? metadata
          : {
              ...(cause.data === undefined ? {} : { data: cause.data }),
              ...metadata,
              errors: metadata.errors ?? cause.errors,
            };

      throw createGraphQLResultError(cause.message, available, cause);
    }

    throw cause;
  } finally {
    options.abortSignal.removeEventListener("abort", detachProgress);
    progressSubscription?.unsubscribe();
  }
}

function metadataForPolicy<TData>(
  capture: GraphQLResponseCapture<TData>,
  errorPolicy: ErrorPolicy,
): Pick<GraphQLResult<TData>, "errors" | "extensions"> {
  const metadata = capture.getIncrementalMetadata();

  if (errorPolicy !== "ignore") return metadata;

  const { errors: _ignored, ...available } = metadata;

  return available;
}
