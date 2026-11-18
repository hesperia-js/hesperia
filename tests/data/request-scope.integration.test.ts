import { expect, test } from "bun:test";
import { createGraph, createQuery, defineContract } from "aeolia";
import {
  createRecordedAeoliaGraph,
  createRequestApiScope,
  type RequestApiPair,
} from "../../packages/hesperia/src/data/api.ts";

test("a request scope rejects same-source graph reentry without blocking another source", async () => {
  const query = createQuery({
    name: "adapter.request-scope-reentry",
    key: (input: string) => `request-scope/${input}`,
    fetch: async (input: string) => `ready:${input}`,
  });
  const contract = defineContract({
    namespace: "adapter-request-scope-reentry",
    operations: { query },
  });
  const rootController = new AbortController();
  const sourceController = new AbortController();
  const otherSourceController = new AbortController();
  const scope = createRequestApiScope(rootController.signal);
  const sourceSignal = sourceController.signal;
  const originalAdd = sourceSignal.addEventListener;
  const originalDescriptor = Object.getOwnPropertyDescriptor(sourceSignal, "addEventListener");
  const createRecordedGraph = (abortSignal: AbortSignal) =>
    createRecordedAeoliaGraph(createGraph, { contract, abortSignal });
  let sourceGraph: ReturnType<typeof createRecordedGraph> | undefined;
  let otherSourceGraph: ReturnType<typeof createRecordedGraph> | undefined;
  let sameSourcePair: RequestApiPair<typeof contract> | undefined;
  let sameSourceFailure: unknown;
  let otherSourcePair: RequestApiPair<typeof contract> | undefined;
  let otherSourceFailure: unknown;
  let listenerRegistrations = 0;
  let sourceListenerRegistrations = 0;
  let armed = false;
  let reentered = false;

  Object.defineProperty(sourceSignal, "addEventListener", {
    configurable: true,
    value: (...args: Parameters<AbortSignal["addEventListener"]>) => {
      const [type, listener] = args;
      const result = Reflect.apply(originalAdd, sourceSignal, args);

      if (type === "abort" && listener) {
        listenerRegistrations++;

        if (armed) {
          armed = false;
          reentered = true;

          try {
            sameSourcePair = scope.select(sourceGraph!, contract);
          } catch (error) {
            sameSourceFailure = error;
          }

          try {
            otherSourcePair = scope.select(otherSourceGraph!, contract);
          } catch (error) {
            otherSourceFailure = error;
          }
        }
      }

      return result;
    },
  });

  try {
    sourceGraph = createRecordedGraph(sourceSignal);
    sourceListenerRegistrations = listenerRegistrations;
    otherSourceGraph = createRecordedGraph(otherSourceController.signal);
    armed = true;

    const sourcePair = scope.select(sourceGraph, contract);

    armed = false;

    expect(reentered).toBe(true);
    expect(sameSourcePair).toBeUndefined();
    expect(sameSourceFailure).toBeInstanceOf(TypeError);
    expect(otherSourceFailure).toBeUndefined();
    expect(otherSourcePair).toBeDefined();

    if (!otherSourcePair) throw new Error("A separate source must receive its request API pair");

    expect(sourceListenerRegistrations).toBeGreaterThan(0);
    expect(listenerRegistrations).toBe(sourceListenerRegistrations + 1);
    expect(scope.select(sourceGraph, contract)).toBe(sourcePair);
    expect(scope.select(otherSourceGraph, contract)).toBe(otherSourcePair);
    expect(otherSourcePair.graph).not.toBe(sourcePair.graph);
    expect(sourcePair.contract).toBe(contract);
    expect(otherSourcePair.contract).toBe(contract);

    await expect(sourcePair.graph.api.query("source").ready).resolves.toBe("ready:source");
    await expect(otherSourcePair.graph.api.query("other").ready).resolves.toBe("ready:other");
  } finally {
    armed = false;

    try {
      scope.dispose();
    } finally {
      try {
        sourceGraph?.dispose();
      } finally {
        try {
          otherSourceGraph?.dispose();
        } finally {
          if (originalDescriptor === undefined)
            Reflect.deleteProperty(sourceSignal, "addEventListener");
          else Object.defineProperty(sourceSignal, "addEventListener", originalDescriptor);
        }
      }
    }
  }
});

test("request scopes isolate recorded graphs and reject invalid selections", () => {
  const contract = defineContract({ namespace: "request-scope", operations: {} });
  const otherContract = defineContract({ namespace: "other-request-scope", operations: {} });
  const graph = createRecordedAeoliaGraph(createGraph, { contract });
  const unrecorded = createGraph({ contract });
  const firstRoot = new AbortController();
  const secondRoot = new AbortController();
  const first = createRequestApiScope(firstRoot.signal);
  const second = createRequestApiScope(secondRoot.signal);

  try {
    expect(() => first.select(unrecorded, contract)).toThrow();
    expect(() => first.select(graph, otherContract)).toThrow();

    const firstPair = first.select(graph, contract);
    const secondPair = second.select(graph, contract);

    expect(first.select(graph, contract)).toBe(firstPair);
    expect(firstPair.graph).not.toBe(graph);
    expect(secondPair.graph).not.toBe(graph);
    expect(firstPair.graph).not.toBe(secondPair.graph);
    expect(firstPair.contract).toBe(contract);

    firstRoot.abort();

    expect(() => first.select(graph, contract)).toThrow();
    expect(second.select(graph, contract)).toBe(secondPair);
  } finally {
    first.dispose();
    second.dispose();
    graph.dispose();
    unrecorded.dispose();
  }
});
