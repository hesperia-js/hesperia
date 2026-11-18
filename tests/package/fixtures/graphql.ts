import { affects, createGraph, defineContract } from "aeolia";
import type { QueryDefinition, StreamDefinition } from "aeolia";
import type { TypedDocumentNode } from "@apollo/client";
import type { HttpLink } from "@apollo/client/link/http";
import { parse } from "graphql";
import {
  createGraphQLClient,
  type GraphQLClientOptions,
  type GraphQLProgress,
  type GraphQLResult,
  type GraphQLResultError,
  type GraphQLSubscriptionOptions,
} from "@hesperia/graphql/client";
import { withAeolia } from "hesperia/aeolia";
import type { Feed, FeedProjection } from "hesperia/aeolia";

type EchoVariables = { readonly value: string };

type EchoData = { readonly echo: string };

type ProductVariables = { readonly id: string };
type ProductData = {
  readonly product: {
    readonly id: string;
    readonly details: { readonly description: string };
  } | null;
};

type WriteVariables = { readonly value: string };

type WriteData = {
  readonly writeThenFail: { readonly value: string; readonly failure: string | null } | null;
};

type MessageVariables = { readonly channel: string };

type MessageData = {
  readonly messageAdded: { readonly id: string; readonly text: string } | null;
};

type WrongMessageData = { readonly messageAdded: string };

type WrongMessageKeyDefinition = StreamDefinition<
  MessageVariables,
  GraphQLResult<MessageData>,
  `room/${string}`
>;

type WrongWriteResult = GraphQLResult<{ readonly writeThenFail: string }>;

const echoDocument = parse(`
  query Echo($value: String!) {
    echo(value: $value)
  }
`) as TypedDocumentNode<EchoData, EchoVariables>;

const productDocument = parse(`
  query IncrementalProduct($id: ID!) {
    product(id: $id) {
      id
      ... @defer(label: "details") { details { description } }
    }
  }
`) as TypedDocumentNode<ProductData, ProductVariables>;

const writeDocument = parse(`
  mutation WriteThenFail($value: String!) {
    writeThenFail(value: $value) {
      value
      failure
    }
  }
`) as TypedDocumentNode<WriteData, WriteVariables>;

const messageDocument = parse(`
  subscription MessageAdded($channel: String!) {
    messageAdded(channel: $channel) {
      id
      text
    }
  }
`) as TypedDocumentNode<MessageData, MessageVariables>;

export function checkPublishedGraphQLTypes(link: HttpLink): void {
  const graphql = createGraphQLClient({ link, subscriptionErrorPolicy: "none" });
  const incrementalGraphql = createGraphQLClient({
    link,
    experimentalIncremental: { profile: "graphql17-v0.2" },
  });
  const broadOptions: GraphQLClientOptions = {
    link,
    experimentalIncremental: { profile: "graphql17-v0.2" },
  };
  const broadGraphql = createGraphQLClient(broadOptions);
  const echo = graphql.query({
    name: "consumer.echo",
    document: echoDocument,
    key: ({ value }) => value,
  });
  const write = graphql.mutation({
    name: "consumer.write",
    document: writeDocument,
    affects: [
      affects(echo, {
        select: ({ value }) => ({ value }),
        on: "revalidate",
      }),
    ],
  });
  const messageOptions: GraphQLSubscriptionOptions<
    MessageData,
    MessageVariables,
    `channel/${string}`
  > = {
    name: "consumer.messageAdded",
    document: messageDocument,
    key: ({ channel }) => `channel/${channel}`,
    errorPolicy: "all",
    equals: (left, right) =>
      left.data?.messageAdded?.id === right.data?.messageAdded?.id &&
      left.errors?.length === right.errors?.length &&
      left.extensions?.cursor === right.extensions?.cursor,
  };
  const messages = graphql.subscription(messageOptions);
  const messageDefinition: StreamDefinition<
    MessageVariables,
    GraphQLResult<MessageData>,
    `channel/${string}`
  > = messages;
  // @ts-expect-error a subscription key retains its declared literal pattern
  const wrongMessageKey: WrongMessageKeyDefinition = messages;
  const contract = defineContract({
    namespace: "consumer",
    operations: { echo, write, messages },
  });
  const graph = createGraph({ contract });
  const api = withAeolia(graph, contract);
  const queryView = api.echo({ value: "Ada" });
  const result: GraphQLResult<EchoData> | undefined = queryView.value();
  // @ts-expect-error finite queries do not expose progress projections
  queryView.project();

  const broadProduct = broadGraphql.query({
    name: "consumer.broad-product",
    document: productDocument,
    key: ({ id }) => `product/${id}` as const,
  });
  const broadContract = defineContract({
    namespace: "consumer-broad",
    operations: { broadProduct },
  });
  const broadGraph = createGraph({ contract: broadContract });
  const broadApi = withAeolia(broadGraph, broadContract);
  // @ts-expect-error a broadly typed factory does not promise incremental progress
  broadApi.broadProduct({ id: "p-1" }).project();

  const incrementalProduct = incrementalGraphql.query({
    name: "consumer.incremental-product",
    document: productDocument,
    key: ({ id }) => `product/${id}` as const,
  });
  const incrementalDefinition: QueryDefinition<
    ProductVariables,
    GraphQLResult<ProductData>,
    `product/${string}`,
    GraphQLProgress<ProductData>
  > = incrementalProduct;
  const incrementalContract = defineContract({
    namespace: "consumer-incremental",
    operations: { incrementalProduct },
  });
  const incrementalGraph = createGraph({ contract: incrementalContract });
  const incrementalApi = withAeolia(incrementalGraph, incrementalContract);
  const incrementalView = incrementalApi.incrementalProduct({ id: "p-1" });
  const progress = incrementalView.project();
  const latest: GraphQLProgress<ProductData> | undefined = progress.value();
  const progressHistory: readonly GraphQLProgress<ProductData>[] = incrementalView
    .project({ kind: "accumulate", max: 3 })
    .value();
  const reduced: string = incrementalView
    .project({
      kind: "reduce",
      initial: "",
      step(previous, value) {
        switch (value.dataState) {
          case "streaming": {
            const partial: string | undefined = value.data?.product?.details?.description;
            return previous + (partial ?? "");
          }
          case "complete": {
            const full: string | undefined = value.data?.product?.details.description;
            return previous + (full ?? "");
          }
          case "empty": {
            const empty: null = value.data;
            return previous + String(empty);
          }
        }
      },
    })
    .value();
  // @ts-expect-error partial progress is not a complete query result
  const invalidResult: GraphQLResult<ProductData> | undefined = latest;
  // @ts-expect-error progress views are not awaitable query handles
  const invalidAwait: PromiseLike<GraphQLProgress<ProductData>> = progress;
  // @ts-expect-error progress views do not expose promise chaining
  progress.then(() => undefined);
  // @ts-expect-error projections have no writer
  progress.set(latest);
  // @ts-expect-error projections have no updater
  progress.update(() => latest);
  // @ts-expect-error progress views cannot create chained projections
  progress.project();
  const rawMessages = graph.api.messages({ channel: "native" });
  const rawMessage: GraphQLResult<MessageData> | undefined = rawMessages.value.get();
  const messageFeed: Feed<GraphQLResult<MessageData>> = api.messages({ channel: "native" });
  const feedMessage: GraphQLResult<MessageData> | undefined = messageFeed.value();
  const messageHistory = messageFeed.project({ kind: "accumulate", max: 3 });
  const typedMessageHistory: FeedProjection<
    GraphQLResult<MessageData>,
    readonly GraphQLResult<MessageData>[]
  > = messageHistory;
  const latestHistoryMessage: GraphQLResult<MessageData> | undefined =
    typedMessageHistory.value()[0];
  const task = api.write();
  const mutationResult: PromiseLike<GraphQLResult<WriteData>> = task.run({ value: "Ada" });

  // @ts-expect-error the GraphQL document requires its variables
  api.echo();

  // @ts-expect-error GraphQL variable types come from the typed document
  api.echo({ value: 42 });

  // @ts-expect-error the mutation document requires its variables
  task.run();

  // @ts-expect-error mutation variable types come from the typed document
  task.run({ value: 42 });

  // @ts-expect-error the subscription document requires its variables
  api.messages({});

  // @ts-expect-error subscription variables come from the typed document
  api.messages({ channel: 42 });

  // @ts-expect-error the Hesperia feed retains the complete subscription envelope type
  const wrongMessageResult: GraphQLResult<WrongMessageData> | undefined = messageFeed.value();

  // @ts-expect-error the mutation result retains its complete data shape
  const wrongMutationResult: PromiseLike<WrongWriteResult> = task.run({ value: "Ada" });

  const failureResult = (
    error: GraphQLResultError<WriteData>,
  ): GraphQLResult<WriteData> | undefined => error.result;

  void [
    messageDefinition,
    wrongMessageKey,
    rawMessage,
    feedMessage,
    latestHistoryMessage,
    result,
    incrementalDefinition,
    progressHistory,
    reduced,
    invalidResult,
    invalidAwait,
    mutationResult,
    wrongMessageResult,
    wrongMutationResult,
    failureResult,
  ];

  graph.dispose();
  broadGraph.dispose();
  incrementalGraph.dispose();
  graphql.stop();
  broadGraphql.stop();
  incrementalGraphql.stop();
}
