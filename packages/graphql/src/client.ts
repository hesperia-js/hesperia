import { ApolloClient, InMemoryCache } from "@apollo/client";
import type {
  DefaultContext,
  ErrorPolicy,
  OperationVariables,
  TypedDocumentNode,
} from "@apollo/client";
import { CombinedGraphQLErrors } from "@apollo/client/errors";
import { ApolloLink } from "@apollo/client/link";
import { createMutation, createQuery, createStream } from "aeolia";
import type {
  CreateMutationInput,
  CreateQueryInput,
  CreateStreamInput,
  MutationDefinition,
  QueryDefinition,
  StreamDefinition,
} from "aeolia";
import {
  createGraphQLResultError,
  createResponseCaptureLink,
  isGraphQLExecutionResult,
} from "./response.ts";
import type { GraphQLResult } from "./types.ts";
import { createSubscriptionLink, openGraphQLSubscription } from "./subscription.ts";

/** Configuration for a GraphQL operation-definition factory. */
export interface GraphQLClientOptions {
  /** Native Apollo transport chain. This factory does not change the supplied link. */
  readonly link: ApolloLink;
  /**
   * Native context for this factory's security and representation scope.
   * Keep response-relevant values stable while a graph can reuse its queries.
   * Rebuild or reset that graph when its authority changes. Request cancellation
   * and capture metadata override the corresponding native context fields.
   */
  readonly context?: DefaultContext;
  /** Default native query error policy. Defaults to `all`. */
  readonly queryErrorPolicy?: ErrorPolicy;
  /** Default native mutation error policy. Defaults to `none`. */
  readonly mutationErrorPolicy?: ErrorPolicy;
  /** Default native subscription error policy. Defaults to `none`. */
  readonly subscriptionErrorPolicy?: ErrorPolicy;
}

/**
 * A typed GraphQL query declaration with Aeolia's ordinary key, freshness,
 * snapshot and equality options. The key must include every response-relevant
 * input dimension within the factory's fixed context scope.
 * @typeParam TData - The document's result data.
 * @typeParam TVariables - The document's native variables.
 * @typeParam TKey - The nonempty Aeolia key returned for those variables.
 */
export type GraphQLQueryOptions<
  TData,
  TVariables extends OperationVariables,
  TKey extends string = string,
> = Omit<CreateQueryInput<TVariables, GraphQLResult<TData>, TKey>, "fetch"> & {
  /** Typed native query document. Variables are borrowed under ordinary query rules. */
  readonly document: TypedDocumentNode<TData, TVariables>;
  /** Explicit native error policy for this declaration, overriding the factory default. */
  readonly errorPolicy?: ErrorPolicy;
};

/**
 * A typed GraphQL mutation declaration. Its ordinary Aeolia `affects` array
 * declares the selected query effects and predictions; none are inferred.
 * @typeParam TData - The document's result data.
 * @typeParam TVariables - The document's native variables.
 */
export type GraphQLMutationOptions<TData, TVariables extends OperationVariables> = Omit<
  CreateMutationInput<TVariables, GraphQLResult<TData>>,
  "run"
> & {
  /** Typed native mutation document. */
  readonly document: TypedDocumentNode<TData, TVariables>;
  /** Explicit native error policy for this declaration, overriding the factory default. */
  readonly errorPolicy?: ErrorPolicy;
};

/**
 * A typed incoming subscription with an ordinary Aeolia key and value options.
 * The supplied native link owns transport configuration; each opened keyed
 * stream owns one native subscription, independently of the shared socket.
 * @typeParam TData - The document's result data.
 * @typeParam TVariables - The document's native variables.
 * @typeParam TKey - The nonempty stream key derived from those variables.
 */
export type GraphQLSubscriptionOptions<
  TData,
  TVariables extends OperationVariables,
  TKey extends string = string,
> = Omit<CreateStreamInput<TVariables, GraphQLResult<TData>, TKey>, "open"> & {
  /** Typed native subscription document. */
  readonly document: TypedDocumentNode<TData, TVariables>;
  /** Native event error policy, overriding the factory's subscription default. */
  readonly errorPolicy?: ErrorPolicy;
};

/**
 * Builds ordinary Aeolia definitions over one owned, uncached native client.
 * Declaring an operation performs no request. Put definitions in a public
 * Aeolia contract/graph and adapt that same pair with `hesperia/aeolia`.
 */
export interface GraphQLClient {
  /**
   * Declare a finite query whose value is the available execution envelope.
   * Field errors resolve by default; errors before execution reject. Explicit
   * native error policies retain their meanings. Transport/decode/cancellation
   * failures remain failures and do not commit a new query value.
   * @param options - Typed document and ordinary query declaration options.
   * @returns A dormant public Aeolia query definition.
   */
  query<TData, TVariables extends OperationVariables, TKey extends string>(
    options: GraphQLQueryOptions<TData, TVariables, TKey>,
  ): QueryDefinition<TVariables, GraphQLResult<TData>, TKey>;
  /**
   * Declare a finite mutation. Execution errors reject by default, preserving
   * the available envelope on an ordinary Error and the native error as cause.
   * Failed mutations use Aeolia's existing prediction/effect failure rules;
   * rejection does not mean a backend write was rolled back.
   * @param options - Typed document and explicitly declared effects.
   * @returns A dormant public Aeolia mutation definition.
   */
  mutation<TData, TVariables extends OperationVariables>(
    options: GraphQLMutationOptions<TData, TVariables>,
  ): MutationDefinition<TVariables, GraphQLResult<TData>>;
  /**
   * Declare an incoming subscription. Declaration does not open an operation.
   * A graph opens one native subscription for each shared keyed stream session.
   * Execution-error events remain nonterminal: `none` omits their data, `all`
   * retains partial data and errors, and `ignore` omits execution errors.
   * A protocol or transport error fails the source under every policy.
   * Returning its iterator or aborting that session unsubscribes the operation.
   * The caller owns socket configuration and disposal.
   * @param options - Typed document, shared key and native event error policy.
   * @returns A dormant public Aeolia stream definition.
   */
  subscription<TData, TVariables extends OperationVariables, TKey extends string>(
    options: GraphQLSubscriptionOptions<TData, TVariables, TKey>,
  ): StreamDefinition<TVariables, GraphQLResult<TData>, TKey>;
  /**
   * Stop the owned Apollo client after its graphs have been disposed.
   * Repeated calls are harmless. Later definition callbacks reject without
   * starting native work. This is not proof of remote rollback or cancellation.
   */
  stop(): void;
}

/**
 * Create typed GraphQL definitions using an adapter-owned Apollo Client.
 *
 * Aeolia owns result caching, predictions and declared mutation effects. Native
 * calls use no-cache and independent request dispatch; the supplied link and
 * context are never installed into or copied from an opaque existing client.
 * The response link retains successful query extensions before native result
 * transformation. Different authority contexts require correctly scoped graphs.
 *
 * @param options - Native link, explicit fixed context and error-policy defaults.
 * @returns A dormant definition factory. Dispose its graphs before calling `stop`.
 * @throws A TypeError for an unsupported error policy.
 */
export function createGraphQLClient(options: GraphQLClientOptions): GraphQLClient {
  const captureLink = createResponseCaptureLink();
  const context = { ...options.context };
  const queryPolicy = checkPolicy(options.queryErrorPolicy ?? "all");
  const mutationPolicy = checkPolicy(options.mutationErrorPolicy ?? "none");
  const subscriptionPolicy = checkPolicy(options.subscriptionErrorPolicy ?? "none");
  const terminations = new Set<() => void>();
  const native = new ApolloClient({
    link: ApolloLink.from([captureLink.link, createSubscriptionLink(), options.link]),
    cache: new InMemoryCache(),
    queryDeduplication: false,
    devtools: { enabled: false },
  });
  let stopped = false;

  async function request<TData, TVariables extends OperationVariables>(
    kind: "query" | "mutation",
    document: TypedDocumentNode<TData, TVariables>,
    variables: TVariables,
    abortSignal: AbortSignal,
    policy: ErrorPolicy,
  ): Promise<GraphQLResult<TData>> {
    if (stopped) throw new Error("The GraphQL client has been stopped");

    abortSignal.throwIfAborted();

    const capture = captureLink.createCapture<TData>();
    const requestContext: DefaultContext = {
      ...context,
      ...capture.context,
      queryDeduplication: false,
      fetchOptions: { ...context.fetchOptions, signal: abortSignal },
    };

    try {
      const result =
        kind === "query"
          ? await native.query<TData, TVariables>({
              query: document,
              variables,
              context: requestContext,
              fetchPolicy: "no-cache",
              errorPolicy: policy,
            })
          : await native.mutate<TData, TVariables>({
              mutation: document,
              variables,
              context: requestContext,
              fetchPolicy: "no-cache",
              errorPolicy: policy,
            });

      abortSignal.throwIfAborted();

      if (result.error && !CombinedGraphQLErrors.is(result.error)) throw result.error;

      const captured = capture.getResult();
      const envelope = captured && applyPolicy(captured, policy);

      if (!envelope || !isGraphQLExecutionResult(envelope)) {
        throw createGraphQLResultError(
          "The GraphQL request did not produce an execution result",
          envelope,
          policy === "ignore" ? undefined : result.error,
        );
      }

      return envelope;
    } catch (cause) {
      abortSignal.throwIfAborted();

      if (CombinedGraphQLErrors.is(cause)) {
        const available = capture.getResult() ?? {
          ...(cause.data === undefined ? {} : { data: cause.data as TData | null }),
          errors: cause.errors,
          extensions: cause.extensions,
        };

        throw createGraphQLResultError(cause.message, applyPolicy(available, policy), cause);
      }

      throw cause;
    } finally {
      capture.dispose();
    }
  }

  const client: GraphQLClient = {
    query(input) {
      const { document, errorPolicy = queryPolicy, ...definition } = input;
      const policy = checkPolicy(errorPolicy);

      return createQuery({
        ...definition,
        fetch: (variables, { abortSignal }) =>
          request("query", document, variables, abortSignal, policy),
      });
    },
    mutation(input) {
      const { document, errorPolicy = mutationPolicy, ...definition } = input;
      const policy = checkPolicy(errorPolicy);

      return createMutation({
        ...definition,
        run: (variables, { abortSignal }) =>
          request("mutation", document, variables, abortSignal, policy),
      });
    },
    subscription<TData, TVariables extends OperationVariables, TKey extends string>(
      input: GraphQLSubscriptionOptions<TData, TVariables, TKey>,
    ): StreamDefinition<TVariables, GraphQLResult<TData>, TKey> {
      const { document, errorPolicy = subscriptionPolicy, ...definition } = input;
      const policy = checkPolicy(errorPolicy);

      return createStream<TVariables, GraphQLResult<TData>, TKey>({
        ...definition,
        open(variables, { abortSignal }) {
          if (stopped) throw new Error("The GraphQL client has been stopped");

          return openGraphQLSubscription(
            native,
            document,
            variables,
            abortSignal,
            policy,
            context,
            terminations,
          );
        },
      });
    },
    stop() {
      if (stopped) return;

      stopped = true;
      const failures: unknown[] = [];

      for (const terminate of terminations) {
        try {
          terminate();
        } catch (cause) {
          failures.push(cause);
        }
      }

      try {
        native.stop();
      } catch (cause) {
        if (failures.length === 0) throw cause;
        failures.push(cause);
      }

      if (failures.length > 0)
        throw new AggregateError(
          failures,
          "The GraphQL client could not release every native resource",
        );
    },
  };

  return client;
}

function checkPolicy(policy: ErrorPolicy): ErrorPolicy {
  if (policy !== "all" && policy !== "none" && policy !== "ignore") {
    throw new TypeError(`Unsupported GraphQL error policy: ${String(policy)}`);
  }

  return policy;
}

function applyPolicy<TData>(
  result: GraphQLResult<TData>,
  policy: ErrorPolicy,
): GraphQLResult<TData> {
  if (policy !== "ignore") return result;

  const { errors: _ignored, ...available } = result;

  return available;
}

export type { GraphQLResult, GraphQLResultError } from "./types.ts";
