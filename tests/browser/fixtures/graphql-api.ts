import { GraphQLWsLink } from "@apollo/client/link/subscriptions";
import type { TypedDocumentNode } from "@apollo/client";
import { createClient } from "graphql-ws";
import { parse } from "graphql";
import { createGraph, defineContract } from "aeolia";
import { createGraphQLClient } from "@hesperia/graphql/client";
import { withAeolia } from "hesperia/aeolia";

type NativeEventsData = {
  readonly events: {
    readonly sequence: number;
    readonly value: string;
    readonly broken: string | null;
    readonly fatal: string;
  };
};

type NativeEventsVariables = { readonly id: string };

const session = new URLSearchParams(globalThis.location.search).get("session");

if (!session) throw new Error("The GraphQL browser fixture requires a session query parameter");

const nativeEventsDocument = parse(`
  subscription NativeEvents($id: ID!) {
    events(id: $id) {
      sequence
      value
      broken
      fatal
    }
  }
`) as TypedDocumentNode<NativeEventsData, NativeEventsVariables>;

const subscriptionWsUrl = new URLSearchParams(globalThis.location.search).get("subscription-ws");
if (!subscriptionWsUrl)
  throw new Error("The GraphQL subscription fixture requires a WebSocket URL");
const subscriptionSocket = createClient({
  url: subscriptionWsUrl,
  connectionParams: { session },
  lazy: false,
});
const graphql = createGraphQLClient({ link: new GraphQLWsLink(subscriptionSocket) });

const browserEventsNone = graphql.subscription({
  name: "browser.graphql.events.none",
  document: nativeEventsDocument,
  key: ({ id }) => `browser-events/none/${id}`,
});

const browserEventsAll = graphql.subscription({
  name: "browser.graphql.events.all",
  document: nativeEventsDocument,
  key: ({ id }) => `browser-events/all/${id}`,
  errorPolicy: "all",
});

const browserEventsIgnore = graphql.subscription({
  name: "browser.graphql.events.ignore",
  document: nativeEventsDocument,
  key: ({ id }) => `browser-events/ignore/${id}`,
  errorPolicy: "ignore",
});

const contract = defineContract({
  namespace: "browser-graphql-native",
  operations: { browserEventsNone, browserEventsAll, browserEventsIgnore },
});
const graph = createGraph({ contract });
export const api = withAeolia(graph, contract);

export function disposeGraphQL(): void {
  graph.dispose();
  graphql.stop();
}

export async function resetGraphQLGraph(): Promise<void> {
  await graph.reset();
}

export function disposeGraphQLGraph(): void {
  graph.dispose();
}

let subscriptionSocketDisposal: Promise<void> | undefined;
export function disposeGraphQLSocket(): Promise<void> {
  subscriptionSocketDisposal ??= subscriptionSocket.dispose();
  return subscriptionSocketDisposal;
}
