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
import { bindImported } from "../../src/data/api.ts";
import { withAeolia } from "../../src/aeolia/index.ts";
import { createContractApi } from "../../src/data/contract.ts";
import { Owner, type RuntimeContext } from "../../src/runtime/owner.ts";

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
