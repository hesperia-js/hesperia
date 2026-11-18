import { expect, test } from "bun:test";
import { createGraph, defineContract, observeQueryProgress } from "aeolia";
import { ApolloLink } from "@apollo/client/link";
import { HttpLink } from "@apollo/client/link/http";
import type { TypedDocumentNode } from "@apollo/client";
import {
  buildSchema,
  experimentalExecuteIncrementally,
  GraphQLDeferDirective,
  GraphQLSchema,
  GraphQLStreamDirective,
  isObjectType,
  parse,
} from "graphql";
import { Observable } from "rxjs";
import { createGraphQLClient } from "../../packages/graphql/src/index.ts";

type Board = { board: { __typename?: "Board"; id: string; detail: string } };
const document = parse(
  `query Board { board { id ... @defer(label: "detail") { detail } } }`,
) as TypedDocumentNode<Board, Record<string, never>>;

test("incremental query reports a partial result before its real terminal result", async () => {
  const gate: { release?: () => void } = {};
  let calls = 0;
  const link = new ApolloLink(
    () =>
      new Observable<ApolloLink.Result>((observer) => {
        calls += 1;
        gate.release = () => {
          observer.next({
            incremental: [{ id: "detail", data: { detail: "arrived" } }],
            completed: [{ id: "detail" }],
            hasNext: false,
          } as unknown as ApolloLink.Result);
          observer.complete();
        };
        observer.next({
          data: { board: { id: "one" } },
          pending: [{ id: "detail", path: ["board"], label: "detail" }],
          hasNext: true,
        } as unknown as ApolloLink.Result);
      }),
  );
  const client = createGraphQLClient({
    link,
    experimentalIncremental: { profile: "graphql17-v0.2" },
  });
  const query = client.query({ name: "incremental-board", document, key: () => "board" });
  const graph = createGraph({
    contract: defineContract({ namespace: "incremental", operations: { query } }),
  });

  try {
    const store = graph.api.query({});
    const observation = observeQueryProgress(store);
    let notifyStreaming!: () => void;
    const streaming = new Promise<void>((resolve) => {
      notifyStreaming = resolve;
    });
    const stop = observation.subscribe(({ snapshot }) => {
      if (snapshot.value?.dataState === "streaming") notifyStreaming();
    });
    let settled = false;
    const ready = store.ready.then((value) => {
      settled = true;
      return value;
    });

    try {
      await Promise.race([
        streaming,
        ready.then(() => {
          throw new Error("The query settled before reporting streaming progress");
        }),
      ]);
      expect(settled).toBe(false);
      expect(observation.capture().value?.dataState).toBe("streaming");
      if (!gate.release) throw new Error("The native Link did not start");
      gate.release();
      expect((await ready).data).toEqual({ board: { id: "one", detail: "arrived" } });
      expect(observation.capture().status).toBe("complete");
      expect(observation.capture().value?.dataState).toBe("complete");
      expect(calls).toBe(1);
    } finally {
      stop();
    }
  } finally {
    graph.dispose();
    client.stop();
  }
});

test("an incomplete incremental response does not become a successful query result", async () => {
  const client = createGraphQLClient({
    experimentalIncremental: { profile: "graphql17-v0.2" },
    link: new ApolloLink(
      () =>
        new Observable<ApolloLink.Result>((observer) => {
          observer.next({
            data: { board: { id: "one" } },
            pending: [{ id: "detail", path: ["board"], label: "detail" }],
            hasNext: true,
          } as unknown as ApolloLink.Result);
          observer.complete();
        }),
    ),
  });
  const query = client.query({ name: "truncated-board", document, key: () => "board" });
  const graph = createGraph({
    contract: defineContract({ namespace: "truncated", operations: { query } }),
  });

  try {
    const store = graph.api.query({});
    await expect(store.ready).rejects.toBeInstanceOf(Error);
    expect(observeQueryProgress(store).capture().status).toBe("failed");
  } finally {
    graph.dispose();
    client.stop();
  }
});

test("incremental multipart frames reach query progress over HTTP", async () => {
  const gate: { release?: () => void } = {};
  const requests: string[] = [];
  const encoder = new TextEncoder();
  const boundary = "graphql";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      requests.push(request.headers.get("accept") ?? "");
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const initial = {
            data: { board: { id: "http" } },
            pending: [{ id: "detail", path: ["board"], label: "detail" }],
            hasNext: true,
          };
          controller.enqueue(
            encoder.encode(
              `--${boundary}\r\nContent-Type: application/json; charset=utf-8\r\n\r\n${JSON.stringify(initial)}\r\n--${boundary}\r\n`,
            ),
          );
          gate.release = () => {
            const final = {
              incremental: [{ id: "detail", data: { detail: "from-http" } }],
              completed: [{ id: "detail" }],
              hasNext: false,
            };
            controller.enqueue(
              encoder.encode(
                `Content-Type: application/json; charset=utf-8\r\n\r\n${JSON.stringify(final)}\r\n--${boundary}--\r\n`,
              ),
            );
            controller.close();
          };
        },
      });
      return new Response(body, {
        headers: {
          "content-type": `multipart/mixed; boundary="${boundary}"; incrementalSpec=v0.2`,
        },
      });
    },
  });
  const client = createGraphQLClient({
    link: new HttpLink({ uri: `http://127.0.0.1:${server.port}/graphql` }),
    experimentalIncremental: { profile: "graphql17-v0.2" },
  });
  const query = client.query({ name: "http-incremental-board", document, key: () => "board" });
  const graph = createGraph({
    contract: defineContract({ namespace: "http-incremental", operations: { query } }),
  });

  try {
    const store = graph.api.query({});
    const observation = observeQueryProgress(store);
    let notifyStreaming!: () => void;
    const streaming = new Promise<void>((resolve) => {
      notifyStreaming = resolve;
    });
    const stop = observation.subscribe(({ snapshot }) => {
      if (snapshot.value?.dataState === "streaming") notifyStreaming();
    });
    const ready = store.ready;

    try {
      await Promise.race([
        streaming,
        ready.then(() => {
          throw new Error("The HTTP query settled before streaming");
        }),
      ]);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toContain("incrementalSpec=v0.2");
      if (!gate.release) throw new Error("The HTTP response did not start");
      gate.release();
      expect((await ready).data).toEqual({ board: { id: "http", detail: "from-http" } });
      expect(observation.capture().status).toBe("complete");
    } finally {
      stop();
    }
  } finally {
    graph.dispose();
    client.stop();
    server.stop(true);
  }
});

test("a real deferred GraphQL resolver streams before query completion", async () => {
  const baseSchema = buildSchema(`
    type Query { board: Board! }
    type Board { id: ID!, detail: String! }
  `);
  const schema = new GraphQLSchema({
    ...baseSchema.toConfig(),
    directives: [...baseSchema.getDirectives(), GraphQLDeferDirective, GraphQLStreamDirective],
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let queries = 0;
  let details = 0;
  const board = schema.getType("Board");
  if (!isObjectType(board)) throw new Error("Expected the fixture Board type");
  schema.getQueryType()!.getFields().board!.resolve = () => {
    queries += 1;
    return { id: "real" };
  };
  board.getFields().detail!.resolve = async () => {
    details += 1;
    await gate;
    return "resolved";
  };
  const boundary = "graphql";
  const encoder = new TextEncoder();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const input = (await request.json()) as { query: string };
      const result = await experimentalExecuteIncrementally({
        schema,
        document: parse(input.query),
      });
      if (!("initialResult" in result)) return Response.json(result);

      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            controller.enqueue(
              encoder.encode(
                `--${boundary}\r\nContent-Type: application/json; charset=utf-8\r\n\r\n${JSON.stringify(result.initialResult)}\r\n--${boundary}\r\n`,
              ),
            );
            for await (const next of result.subsequentResults) {
              controller.enqueue(
                encoder.encode(
                  `Content-Type: application/json; charset=utf-8\r\n\r\n${JSON.stringify(next)}\r\n--${boundary}${next.hasNext ? "\r\n" : "--\r\n"}`,
                ),
              );
            }
            controller.close();
          } catch (cause) {
            controller.error(cause);
          }
        },
      });
      return new Response(body, {
        headers: {
          "content-type": `multipart/mixed; boundary="${boundary}"; incrementalSpec=v0.2`,
        },
      });
    },
  });
  const client = createGraphQLClient({
    link: new HttpLink({ uri: `http://127.0.0.1:${server.port}/graphql` }),
    experimentalIncremental: { profile: "graphql17-v0.2" },
  });
  const query = client.query({ name: "resolver-board", document, key: () => "board" });
  const graph = createGraph({
    contract: defineContract({ namespace: "resolver-incremental", operations: { query } }),
  });

  try {
    const store = graph.api.query({});
    const observation = observeQueryProgress(store);
    let notifyStreaming!: () => void;
    const streaming = new Promise<void>((resolve) => {
      notifyStreaming = resolve;
    });
    const stop = observation.subscribe(({ snapshot }) => {
      if (snapshot.value?.dataState === "streaming") notifyStreaming();
    });
    const ready = store.ready;

    try {
      await Promise.race([
        streaming,
        ready.then(() => {
          throw new Error("The query settled before the deferred resolver");
        }),
      ]);
      expect(queries).toBe(1);
      expect(details).toBe(1);
      release();
      expect((await ready).data).toEqual({
        board: { __typename: "Board", id: "real", detail: "resolved" },
      });
      expect(observation.capture().status).toBe("complete");
    } finally {
      stop();
    }
  } finally {
    release();
    graph.dispose();
    client.stop();
    server.stop(true);
  }
});
