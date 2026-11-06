import { affects, createGraph, defineContract } from "aeolia";
import type { TypedDocumentNode } from "@apollo/client";
import type { HttpLink } from "@apollo/client/link/http";
import { parse } from "graphql";
import {
  createGraphQLClient,
  type GraphQLResult,
  type GraphQLResultError,
} from "@hesperia/graphql/client";
import { withAeolia } from "hesperia/aeolia";

type EchoVariables = { readonly value: string };

type EchoData = { readonly echo: string };

type WriteVariables = { readonly value: string };

type WriteData = {
  readonly writeThenFail: { readonly value: string; readonly failure: string | null } | null;
};

type WrongWriteResult = GraphQLResult<{ readonly writeThenFail: string }>;

const echoDocument = parse(`
  query Echo($value: String!) {
    echo(value: $value)
  }
`) as TypedDocumentNode<EchoData, EchoVariables>;

const writeDocument = parse(`
  mutation WriteThenFail($value: String!) {
    writeThenFail(value: $value) {
      value
      failure
    }
  }
`) as TypedDocumentNode<WriteData, WriteVariables>;

export function checkPublishedGraphQLTypes(link: HttpLink): void {
  const graphql = createGraphQLClient({ link });
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
  const contract = defineContract({
    namespace: "consumer",
    operations: { echo, write },
  });
  const graph = createGraph({ contract });
  const api = withAeolia(graph, contract);
  const queryView = api.echo({ value: "Ada" });
  const result: GraphQLResult<EchoData> | undefined = queryView.value();
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

  // @ts-expect-error the mutation result retains its complete data shape
  const wrongMutationResult: PromiseLike<WrongWriteResult> = task.run({ value: "Ada" });

  const failureResult = (
    error: GraphQLResultError<WriteData>,
  ): GraphQLResult<WriteData> | undefined => error.result;

  void [result, mutationResult, wrongMutationResult, failureResult];

  graph.dispose();
  graphql.stop();
}
