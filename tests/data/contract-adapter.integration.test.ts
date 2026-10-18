import { afterEach, expect, test } from "bun:test";
import {
  createGraph,
  createMutation,
  createStore,
  createStream,
  defineContract,
  subscribe,
} from "aeolia";
import { testBackend } from "aeolia/testing";
import { bindImported, markImportedApi } from "../../packages/hesperia/src/data/api.ts";
import { reset, withAeolia } from "../../packages/hesperia/src/aeolia/index.ts";
import { createContractApi } from "../../packages/hesperia/src/data/contract.ts";
import { createClient } from "../../packages/hesperia/src/client.ts";
import { Owner, type RuntimeContext } from "../../packages/hesperia/src/runtime/owner.ts";

const owners: Owner[] = [];

afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});

function makeOwner(): Owner {
  const context = {
    document: {} as Document,
    container: {} as Element,
    onError: (error: unknown) => {
      throw error;
    },
    warn: () => undefined,
    nextGeneration: 0,
    scheduler: undefined,
  } as unknown as RuntimeContext;
  const owner = new Owner(context, null, "adapter-test");

  owners.push(owner);

  return owner;
}

test("contract members become owner views and mutations stay dormant in a body", async () => {
  const backend = testBackend();
  const mutate = createMutation({
    name: "adapter.mutate",
    run: backend.perform<string, string>("adapter.mutate"),
    affects: [],
  });
  const cell = createStore({ name: "adapter.cell", initial: 1 });
  const contract = defineContract({
    namespace: "adapter",
    operations: { mutate, cell },
  });
  const graph = createGraph({ contract });
  const owner = makeOwner();
  const api = createContractApi(owner, graph, contract);

  const dormant = api.mutate();

  expect(backend.calls).toHaveLength(0);

  expect(dormant.status()).toBe("idle");

  expect(() => dormant.run("first")).toThrow("component body");

  expect(backend.calls).toHaveLength(0);

  const local = api.cell();

  expect(local()).toBe(1);

  local.set(2);

  expect(local()).toBe(2);

  owner.commit();

  const run = dormant.run("second");

  expect(backend.calls).toHaveLength(1);

  expect(backend.calls[0]?.input).toBe("second");

  backend.resolve(backend.calls[0]!, "done");

  await expect(run).resolves.toBe("done");

  owner.dispose();

  expect(() => local()).toThrow("destroyed");

  graph.dispose();
});

test("a direct imported API is cached per owner and remains isolated after one owner is disposed", () => {
  const cell = createStore({ name: "adapter.imported-cell", initial: 1 });
  const contract = defineContract({ namespace: "adapter-imported", operations: { cell } });
  const graph = createGraph({ contract });
  const imported = withAeolia(graph, contract);
  const first = makeOwner();
  const second = makeOwner();

  first.commit();

  second.commit();

  const firstApi = bindImported(first, imported) as typeof imported;
  const secondApi = bindImported(second, imported) as typeof imported;

  expect(bindImported(first, imported)).toBe(firstApi);

  expect(secondApi).not.toBe(firstApi);

  expect(firstApi.cell()()).toBe(1);

  expect(secondApi.cell()()).toBe(1);

  first.dispose();

  expect(() => bindImported(first, imported)).toThrow("no longer active");

  expect(() => firstApi.cell()).toThrow("no longer active");

  const helper = () => "ordinary import";

  expect(bindImported(first, helper)).toBe(helper);

  expect(secondApi.cell()()).toBe(1);

  graph.dispose();
});

test("namespace binding adapts frozen reexports without probing ordinary imports", () => {
  const cell = createStore({ name: "adapter.namespace-cell", initial: 3 });
  const contract = defineContract({ namespace: "adapter-namespace", operations: { cell } });
  const graph = createGraph({ contract });
  const imported = withAeolia(graph, contract);
  const owner = makeOwner();

  owner.commit();

  let reads = 0;
  const ordinary = new Proxy(
    { value: 1 },
    {
      get(target, property, receiver) {
        reads++;
        return Reflect.get(target, property, receiver);
      },
    },
  );

  expect(bindImported(owner, ordinary)).toBe(ordinary);

  expect(reads).toBe(0);

  const frozen = Object.freeze({ api: imported, ordinary });
  const namespace = bindImported(owner, frozen, "namespace") as {
    readonly api: typeof imported;
    readonly ordinary: typeof ordinary;
  };

  expect(namespace).not.toBe(frozen);

  expect(namespace.api.cell()()).toBe(3);

  expect(namespace.ordinary).toBe(ordinary);

  const ordinaryNamespace = Object.freeze({ ordinary });

  expect(bindImported(owner, ordinaryNamespace, "namespace")).toBe(ordinaryNamespace);

  const liveNamespace = { api: ordinary as unknown };

  expect(bindImported(owner, liveNamespace, "namespace")).toBe(liveNamespace);

  liveNamespace.api = imported;
  const boundLiveNamespace = bindImported(owner, liveNamespace, "namespace") as {
    readonly api: typeof imported;
  };

  expect((boundLiveNamespace.api as typeof imported).cell()()).toBe(3);

  owner.dispose();

  expect(() => bindImported(owner, frozen, "namespace")).toThrow("no longer active");

  expect(bindImported(owner, ordinaryNamespace, "namespace")).toBe(ordinaryNamespace);

  graph.dispose();
});

test("a task controller cancellation aborts the adapted Aeolia mutation run", () => {
  const backend = testBackend();
  const mutate = createMutation({
    name: "adapter.cancel",
    run: backend.perform<void, void>("adapter.cancel"),
    affects: [],
  });
  const contract = defineContract({ namespace: "adapter-cancel", operations: { mutate } });
  const graph = createGraph({ contract });
  const owner = makeOwner();

  owner.commit();

  const run = createContractApi(owner, graph, contract).mutate().run(undefined);

  expect(backend.calls).toHaveLength(1);

  run.cancel();

  expect(backend.calls[0]?.aborted).toBe(true);

  graph.dispose();
});

test("a caller abort cancels the adapted task without publishing a failure", async () => {
  const backend = testBackend();
  const mutate = createMutation({
    name: "adapter.caller-cancel",
    run: backend.perform<void, void>("adapter.caller-cancel"),
    affects: [],
  });
  const contract = defineContract({ namespace: "adapter-caller-cancel", operations: { mutate } });
  const graph = createGraph({ contract });
  const owner = makeOwner();

  owner.commit();

  const caller = new AbortController();
  const task = createContractApi(owner, graph, contract).mutate();
  const run = task.run(undefined, { abortSignal: caller.signal });

  caller.abort(new DOMException("caller stopped", "AbortError"));

  await expect(run).rejects.toHaveProperty("name", "AbortError");

  expect(task.status()).toBe("cancelled");

  expect(task.error()).toBeUndefined();

  expect(backend.calls[0]?.aborted).toBe(true);

  graph.dispose();
});

test("one adapted mutation task reuses fresh payloads and publishes only its latest result", async () => {
  const backend = testBackend();
  const mutate = createMutation({
    name: "adapter.latest",
    run: backend.perform<string, string>("adapter.latest"),
    affects: [],
  });
  const contract = defineContract({ namespace: "adapter-latest", operations: { mutate } });
  const graph = createGraph({ contract });
  const owner = makeOwner();

  owner.commit();

  const task = createContractApi(owner, graph, contract).mutate();
  const first = task.run("first");
  const second = task.run("second");

  expect(backend.calls.map((call) => call.input)).toStrictEqual(["first", "second"]);

  expect(backend.calls[0]?.aborted).toBe(true);

  await expect(first).rejects.toHaveProperty("name", "AbortError");

  const failure = new Error("latest mutation failed");

  backend.reject(backend.calls[1]!, failure);

  await expect(second).rejects.toBe(failure);

  expect(task.status()).toBe("failure");

  expect(task.error()).toBe(failure);

  expect(task.value()).toBeUndefined();

  graph.dispose();
});

test("graph reset cancels adapted mutation runs and retains only the last settled value", async () => {
  const backend = testBackend();
  const backendMutationPromises: Promise<string>[] = [];
  const backendMutate = backend.perform<string, string>("adapter.reset-mutation");
  const mutate = createMutation({
    name: "adapter.reset-mutation",
    run: (input: string, options) => {
      const promise = backendMutate(input, options);

      backendMutationPromises.push(promise);

      return promise;
    },
    affects: [],
  });
  const contract = defineContract({ namespace: "adapter-reset-mutation", operations: { mutate } });
  const graph = createGraph({ contract });
  const owner = makeOwner();

  owner.commit();

  const adapted = createContractApi(owner, graph, contract).mutate();

  const settled = adapted.run("settled");

  backend.resolve(backend.calls[0]!, "warm value");

  await expect(settled).resolves.toBe("warm value");

  expect(adapted.value()).toBe("warm value");

  let resolveGeneric!: (value: string) => void;
  let genericSignal: AbortSignal | undefined;
  const generic = createClient(owner).task<void, string>(({ signal }) => {
    genericSignal = signal;
    return () =>
      new Promise<string>((resolve) => {
        resolveGeneric = resolve;
      });
  });
  const genericRun = generic.run(undefined);
  const previousVersion = graph.resetVersion.get();
  const oldRun = adapted.run("held old run");
  const oldCall = backend.calls[1]!;

  await graph.reset();

  expect(graph.resetVersion.get()).toBe(previousVersion + 1);

  expect(oldRun.signal.aborted).toBe(true);

  expect(oldCall.aborted).toBe(true);

  await expect(oldRun).rejects.toHaveProperty("name", "AbortError");

  expect(adapted.status()).toBe("cancelled");

  expect(adapted.pending()).toBe(false);

  expect(adapted.error()).toBeUndefined();

  expect(adapted.value()).toBe("warm value");

  expect(await settled).toBe("warm value");

  expect(genericSignal?.aborted).toBe(false);

  backend.resolve(oldCall, "late old value");

  await expect(backendMutationPromises[1]).resolves.toBe("late old value");

  expect(adapted.status()).toBe("cancelled");

  expect(adapted.value()).toBe("warm value");

  const freshRun = adapted.run("fresh run");
  const freshCall = backend.calls[2]!;

  expect(freshCall.input).toBe("fresh run");

  expect(adapted.status()).toBe("pending");

  expect(adapted.pending()).toBe(true);

  expect(adapted.value()).toBeUndefined();

  backend.resolve(freshCall, "fresh value");

  await expect(freshRun).resolves.toBe("fresh value");

  expect(adapted.status()).toBe("success");

  expect(adapted.value()).toBe("fresh value");

  resolveGeneric("generic result");

  await expect(genericRun).resolves.toBe("generic result");

  expect(genericSignal?.aborted).toBe(false);

  const reentrantOldRun = adapted.run("reentrant old run");
  const reentrantOldCall = backend.calls[3]!;
  let reentrantNewRun: ReturnType<typeof adapted.run> | undefined;

  reentrantOldRun.signal.addEventListener(
    "abort",
    () => {
      reentrantNewRun = adapted.run("reentrant new run");
    },
    { once: true },
  );

  await graph.reset();

  expect(reentrantNewRun).toBeDefined();

  expect(reentrantOldRun.signal.aborted).toBe(true);

  await expect(reentrantOldRun).rejects.toHaveProperty("name", "AbortError");

  expect(backend.calls[4]?.input).toBe("reentrant new run");

  expect(reentrantNewRun?.signal.aborted).toBe(false);

  expect(adapted.status()).toBe("pending");

  expect(adapted.pending()).toBe(true);

  expect(adapted.value()).toBeUndefined();

  backend.resolve(reentrantOldCall, "late reentrant old value");

  await expect(backendMutationPromises[3]).resolves.toBe("late reentrant old value");

  expect(adapted.status()).toBe("pending");

  expect(adapted.value()).toBeUndefined();

  backend.resolve(backend.calls[4]!, "reentrant fresh value");

  await expect(reentrantNewRun!).resolves.toBe("reentrant fresh value");

  expect(adapted.status()).toBe("success");

  expect(adapted.value()).toBe("reentrant fresh value");

  graph.dispose();
});

test("an adapted stream stays dormant until its owner commits", () => {
  const backend = testBackend();
  const stream = createStream({
    name: "adapter.stream",
    key: () => "adapter/stream",
    open: backend.stream<void, number>("adapter.stream"),
  });
  const contract = defineContract({
    namespace: "adapter-stream",
    operations: { stream },
  });
  const graph = createGraph({ contract, idleMs: 5 });
  const owner = makeOwner();
  const feed = createContractApi(owner, graph, contract).stream(undefined);

  expect(backend.calls).toHaveLength(0);

  expect(feed.status()).toBe("empty");

  owner.dispose();

  expect(backend.calls).toHaveLength(0);

  graph.dispose();
});

test("an adapted stream exposes independent public projections", async () => {
  const backend = testBackend();
  const stream = createStream({
    name: "adapter.stream-project",
    key: () => "adapter/stream-project",
    open: backend.stream<void, number>("adapter.stream-project"),
  });
  const contract = defineContract({
    namespace: "adapter-stream-project",
    operations: { stream },
  });
  const graph = createGraph({ contract });
  const owner = makeOwner();
  const latest = createContractApi(owner, graph, contract).stream(undefined);
  const history = latest.project({ kind: "accumulate", max: 4 });
  const sum = latest.project({ kind: "reduce", initial: 0, step: (total, item) => total + item });

  expect(backend.calls).toHaveLength(0);

  owner.commit();

  expect(backend.calls).toHaveLength(1);

  backend.emit("adapter.stream-project", 3);

  backend.emit("adapter.stream-project", 3);

  await Promise.resolve();

  await Promise.resolve();

  expect(latest.value()).toBe(3);

  expect(history.value()).toStrictEqual([3, 3]);

  expect(sum.value()).toBe(6);

  graph.dispose();
});

test("an adapted stream forwards terminal errors through its feed view", async () => {
  const backend = testBackend();
  const stream = createStream({
    name: "adapter.stream-error",
    key: () => "adapter/stream-error",
    open: backend.stream<void, number>("adapter.stream-error"),
  });
  const contract = defineContract({
    namespace: "adapter-stream-error",
    operations: { stream },
  });
  const graph = createGraph({ contract });
  const owner = makeOwner();
  const feed = createContractApi(owner, graph, contract).stream(undefined);

  owner.commit();

  const failure = new Error("adapted stream failed");
  let stop!: () => void;
  const failed = new Promise<void>((resolve) => {
    stop = subscribe(feed.source.status, (status) => {
      if (status === "failed") resolve();
    });
  });

  backend.end("adapter.stream-error", failure);

  await failed;

  stop();

  expect(feed.status()).toBe("failed");

  expect(feed.pending()).toBe(false);

  expect(feed.value()).toBeUndefined();

  expect(feed.error()).toBe(failure);

  expect(feed.source.status.get()).toBe("failed");

  graph.dispose();
});

test("reset forwards the graph promise for marker, bound, and projected APIs", async () => {
  const cell = createStore({ name: "adapter.reset-cell", initial: 4 });
  const contract = defineContract({ namespace: "adapter-reset", operations: { cell } });
  const graph = createGraph({ contract });
  const graphResetVersion = Reflect.get(graph, "resetVersion") as { get(): number };
  const forwarded: Promise<void>[] = [];
  const observedGraph = new Proxy(graph, {
    get(target, property) {
      const value = Reflect.get(target, property, target);

      if (property !== "reset") return value;

      if (typeof value !== "function") throw new Error("Aeolia Graph.reset is unavailable");

      return () => {
        const promise = Reflect.apply(value, target, []) as Promise<void>;

        forwarded.push(promise);

        return promise;
      };
    },
  });
  const imported = withAeolia(observedGraph, contract);
  const owner = makeOwner();

  owner.commit();

  const bound = bindImported(owner, imported) as typeof imported;
  const projectedMarker = markImportedApi(observedGraph, contract, (api) =>
    Object.freeze({ api, provider: "adapter" }),
  );
  const projected = bindImported(owner, projectedMarker) as typeof projectedMarker;

  expect(projected.provider).toBe("adapter");

  expect(projected.api.cell()()).toBe(4);

  const callableMarker = markImportedApi(observedGraph, contract, (api) => () => api.cell()());
  const callable = bindImported(owner, callableMarker) as typeof callableMarker;

  expect(callable()).toBe(4);

  const assertForwardedReset = async (api: object): Promise<void> => {
    const previousVersion = graphResetVersion.get();
    const promise = reset(api);

    expect(forwarded.at(-1)).toBe(promise);

    expect(graphResetVersion.get()).toBe(previousVersion + 1);

    await expect(promise).resolves.toBeUndefined();
  };

  try {
    await assertForwardedReset(imported);

    await assertForwardedReset(bound);

    await assertForwardedReset(projected);

    await assertForwardedReset(callable);

    expect(projected.api.cell()()).toBe(4);

    expect(callable()).toBe(4);
  } finally {
    owner.dispose();

    graph.dispose();
  }
});
