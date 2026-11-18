import { expect, test } from "bun:test";
import { createGraph, defineContract, observeQueryProgress } from "aeolia";
import { ApolloLink } from "@apollo/client/link";
import type { TypedDocumentNode } from "@apollo/client";
import { parse } from "graphql";
import { Observable } from "rxjs";
import { createGraphQLClient } from "../../packages/graphql/src/index.ts";

type Board = { board: { id: string; detail: string } };
const document = parse(`query Board { board { id ... @defer { detail } } }`) as TypedDocumentNode<
  Board,
  Record<string, never>
>;

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
          pending: [{ id: "detail", path: ["board"] }],
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
      await streaming;
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
            pending: [{ id: "detail", path: ["board"] }],
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
