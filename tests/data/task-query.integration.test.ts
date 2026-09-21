import { afterEach, describe, expect, jest, test } from "bun:test";
import {
  affects,
  createGraph,
  createMutation,
  createQuery,
  defineContract,
  type QueryStore,
} from "aeolia";
import { Window } from "happy-dom";
import { createContractApi } from "../../src/data/contract.ts";
import { createQueryView, createTask } from "../../src/data/index.ts";
import { Owner, type RuntimeContext } from "../../src/runtime/owner.ts";

const windows: Window[] = [];
const owners: Owner[] = [];

afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
  for (const window of windows.splice(0)) window.close();
  try {
    jest.clearAllTimers();
    jest.useRealTimers();
  } catch {
    // The test did not enable fake timers.
  }
});

function owner(): Owner {
  const window = new Window();
  windows.push(window);
  const document = window.document;
  const context = {
    document,
    container: document.body,
    onError: (error: unknown) => {
      throw error;
    },
    warn: () => undefined,
    nextGeneration: 0,
    scheduler: undefined,
  } as unknown as RuntimeContext;
  const result = new Owner(context, null, "data-test");
  result.commit();
  owners.push(result);
  return result;
}

describe("owner-bound data primitives", () => {
  test("task creates a fresh signal per run and publishes only the latest outcome", async () => {
    const current = owner();
    const calls: AbortSignal[] = [];
    const deferred: Array<(value: string) => void> = [];
    const task = createTask(current, ({ signal }) => {
      calls.push(signal);
      return (input: string) =>
        new Promise<string>((resolve) => deferred.push(() => resolve(input)));
    });

    const first = task.run("first");
    const second = task.run("second");
    expect(task.status()).toBe("pending");
    expect(task.pending()).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]!).not.toBe(calls[1]!);
    expect(calls[0]!.aborted).toBe(true);
    await expect(first).rejects.toBe(calls[0]!.reason);

    deferred[0]!("first");
    deferred[1]!("second");
    await expect(second).resolves.toBe("second");
    expect(task.status()).toBe("success");
    expect(task.value()).toBe("second");
    expect(task.error()).toBeUndefined();
    expect("then" in task).toBe(false);
  });

  test("task failures and fire-and-forget runs retain an awaitable rejection", async () => {
    const current = owner();
    const failure = new Error("nope");
    const task = createTask(current, () => () => Promise.reject(failure));
    const handle = task.run();
    await expect(handle).rejects.toBe(failure);
    expect(task.status()).toBe("failure");
    expect(task.error()).toBe(failure);
  });

  test("a synchronous factory failure is a failed run, not a dispatch throw", async () => {
    const current = owner();
    const failure = new Error("factory failed");
    const task = createTask(current, () => {
      throw failure;
    });
    const handle = task.run();
    expect(task.status()).toBe("failure");
    expect(task.pending()).toBe(false);
    await expect(handle).rejects.toBe(failure);
    expect(task.error()).toBe(failure);
  });

  test("a reentrant run from supersession keeps the newest invocation primary", async () => {
    const current = owner();
    const deferred: Array<(value: string) => void> = [];
    let task!: ReturnType<typeof createTask<string, string>>;
    let factoryRuns = 0;
    task = createTask(current, ({ signal }) => {
      factoryRuns += 1;
      if (factoryRuns === 1)
        signal.addEventListener("abort", () => {
          void task.run("reentrant");
        });
      return (input: string) =>
        new Promise<string>((resolve) => deferred.push(() => resolve(input)));
    });
    const first = task.run("first");
    const second = task.run("second");
    expect(factoryRuns).toBe(2);
    expect(task.status()).toBe("pending");
    expect(deferred).toHaveLength(2);
    await expect(first).rejects.toBe(first.signal.reason);
    await expect(second).rejects.toBe(second.signal.reason);
    deferred[1]!("reentrant");
    await new Promise((resolve) => queueMicrotask(resolve));
    expect(task.status()).toBe("success");
    expect(task.value()).toBe("reentrant");
  });

  test("task dispatch is rejected during a component body and owner disposal cancels a run", async () => {
    const current = owner();
    current.executingBody = true;
    const task = createTask(
      current,
      ({ signal }) =>
        () =>
          new Promise<string>((resolve) => {
            signal.addEventListener("abort", () => resolve("ignored"));
          }),
    );
    expect(() => task.run()).toThrow("component body");
    current.executingBody = false;
    const handle = task.run();
    const reason = new Error("removed");
    current.dispose(reason);
    await expect(handle).rejects.toBe(reason);
  });

  test("explicit task cancellation settles as cancellation and ignores a late result", async () => {
    const current = owner();
    let resolve!: (value: string) => void;
    const task = createTask(current, ({ signal }) => {
      return () =>
        new Promise<string>((done) => {
          resolve = done;
          signal.addEventListener("abort", () => undefined);
        });
    });

    const run = task.run();
    const reason = new Error("cancelled by caller");
    run.cancel(reason);
    await expect(run).rejects.toBe(reason);
    expect(task.status()).toBe("cancelled");
    expect(task.pending()).toBe(false);
    expect(task.value()).toBeUndefined();
    expect(task.error()).toBeUndefined();

    resolve("late");
    await Promise.resolve();
    expect(task.status()).toBe("cancelled");
    expect(task.value()).toBeUndefined();
  });

  test("query await resolves for committed undefined and keeps the query store ready untouched", async () => {
    const current = owner();
    let resolve!: (value: undefined) => void;
    const query = createQuery({
      name: "data.undefined",
      key: () => "data/undefined",
      fetch: () =>
        new Promise<undefined>((done) => {
          resolve = done;
        }),
    });
    const graph = createGraph({
      contract: defineContract({ namespace: "data", operations: { query } }),
    });
    const store = graph.api.query(undefined);
    const view = createQueryView(current, store as QueryStore<undefined>, () => undefined);
    const waiting = Promise.resolve(view);
    expect(store.ready).not.toBe(waiting);
    resolve(undefined);
    const accessor = await waiting;
    expect(accessor()).toBeUndefined();
    expect(view.status()).toBe("ready");
    graph.dispose();
  });

  test("query owner cancellation rejects only its wait and leaves the shared request alive", async () => {
    const current = owner();
    let resolve!: (value: string) => void;
    const query = createQuery({
      name: "data.cancel",
      key: () => "data/cancel",
      fetch: () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
    });
    const graph = createGraph({
      contract: defineContract({ namespace: "data", operations: { query } }),
    });
    const store = graph.api.query(undefined);
    const view = createQueryView(current, store as QueryStore<string>, () => undefined);
    const waiting = Promise.resolve(view);
    const reason = new Error("component removed");
    current.dispose(reason);
    await expect(waiting).rejects.toBe(reason);
    resolve("survives");
    await store.ready;
    expect(store.value.get()).toBe("survives");
    graph.dispose();
  });

  test("a query with committed data resolves during revalidation and its accessor dies with the owner", async () => {
    const current = owner();
    const responses: Array<(value: string) => void> = [];
    const query = createQuery({
      name: "data.stale",
      key: () => "data/stale",
      fetch: () =>
        new Promise<string>((resolve) => {
          responses.push(resolve);
        }),
    });
    const graph = createGraph({
      contract: defineContract({ namespace: "data", operations: { query } }),
    });
    const store = graph.api.query(undefined);
    responses[0]!("first");
    await store.ready;
    const view = createQueryView(current, store as QueryStore<string>, () => undefined);
    const refresh = store.revalidate();
    expect(store.pending.get()).toBe(true);
    const accessor = await view;
    expect(accessor()).toBe("first");
    expect(typeof accessor).toBe("function");
    expect("then" in accessor).toBe(false);
    current.dispose();
    expect(() => accessor()).toThrow("destroyed");
    responses[1]!("second");
    await refresh;
    graph.dispose();
  });

  test("awaiting an idle ready query starts a refresh while returning its current accessor", async () => {
    const current = owner();
    const responses: Array<(value: string) => void> = [];
    const query = createQuery({
      name: "data.ready-refresh",
      key: () => "data/ready-refresh",
      fetch: () =>
        new Promise<string>((resolve) => {
          responses.push(resolve);
        }),
    });
    const graph = createGraph({
      contract: defineContract({ namespace: "data", operations: { query } }),
    });
    const store = graph.api.query(undefined);
    responses[0]!("first");
    await store.ready;
    const view = createQueryView(current, store as QueryStore<string>, () => undefined);
    const accessor = await view;
    expect(responses).toHaveLength(2);
    expect(accessor()).toBe("first");
    responses[1]!("second");
    await store.ready;
    expect(store.value.get()).toBe("second");
    graph.dispose();
  });

  test("an initial query failure without committed data rejects the Hesperia wait", async () => {
    const current = owner();
    let reject!: (reason: unknown) => void;
    const failure = new Error("query failed");
    const query = createQuery({
      name: "data.failure",
      key: () => "data/failure",
      fetch: () => new Promise<string>((_resolve, fail) => (reject = fail)),
    });
    const graph = createGraph({
      contract: defineContract({ namespace: "data", operations: { query } }),
    });
    const store = graph.api.query(undefined);
    const view = createQueryView(current, store as QueryStore<string>, () => undefined);
    const waiting = Promise.resolve(view);
    reject(failure);
    await expect(waiting).rejects.toBe(failure);
    graph.dispose();
  });

  test("failed query waits settle before invoking synchronous recovery callbacks", async () => {
    const current = owner();
    let reject!: (reason: unknown) => void;
    const failure = new Error("query failed");
    const query = createQuery({
      name: "data.recovery-order",
      key: () => "data/recovery-order",
      fetch: () => new Promise<string>((_resolve, fail) => (reject = fail)),
    });
    const graph = createGraph({
      contract: defineContract({ namespace: "data", operations: { query } }),
    });
    const store = graph.api.query(undefined);
    const view = createQueryView(current, store as QueryStore<string>, () => undefined);
    const waiting = Promise.resolve(view);
    reject(failure);
    await expect(waiting).rejects.toBe(failure);
    const failedView = createQueryView(current, store as QueryStore<string>, () => {
      expect(store.status.get()).toBe("failed");
      store.set("recovered synchronously");
    });
    await expect(Promise.resolve(failedView)).rejects.toStrictEqual({
      status: "failed",
      error: failure,
    });
    expect(store.status.get()).toBe("ready");
    expect(store.value.get()).toBe("recovered synchronously");
    graph.dispose();
  });

  test("an existing failed query rejects immediately, shares one recovery, and requires explicit retry after exhaustion", async () => {
    const current = owner();
    const requests: Array<{ resolve(value: string): void; reject(reason: unknown): void }> = [];
    const query = createQuery({
      name: "data.recovery",
      key: () => "data/recovery",
      fetch: () => new Promise<string>((resolve, reject) => requests.push({ resolve, reject })),
    });
    const contract = defineContract({ namespace: "data", operations: { query } });
    const graph = createGraph({ contract });
    const view = createContractApi(current, graph, contract).query(undefined);
    const initialFailure = new Error("initial failure");
    const initialCompletion = view.ready.catch(() => undefined);
    requests[0]!.reject(initialFailure);
    await initialCompletion;
    expect(view.status()).toBe("failed");

    const firstFailedWait = Promise.resolve(view);
    await expect(firstFailedWait).rejects.toStrictEqual({
      status: "failed",
      error: initialFailure,
    });
    expect(requests).toHaveLength(2);

    const recoveryFailure = new Error("recovery failure");
    const recoveryCompletion = view.ready.catch(() => undefined);
    requests[1]!.reject(recoveryFailure);
    await recoveryCompletion;
    const exhaustedWait = Promise.resolve(view);
    await expect(exhaustedWait).rejects.toStrictEqual({
      status: "failed",
      error: recoveryFailure,
    });
    expect(requests).toHaveLength(2);

    const retry = view.revalidate();
    expect(requests).toHaveLength(3);
    requests[2]!.resolve("recovered");
    await retry;
    expect(view.status()).toBe("ready");
    expect(view.value()).toBe("recovered");
    graph.dispose();
  });

  test("a prediction followed by query failure does not satisfy the committed-data wait", async () => {
    const current = owner();
    let rejectQuery!: (reason: unknown) => void;
    let rejectMutation!: (reason: unknown) => void;
    const queryFailure = new Error("query failed after prediction");
    const mutationFailure = new Error("mutation failed");
    const query = createQuery({
      name: "data.prediction-query",
      key: () => "data/prediction-query",
      fetch: () => new Promise<string>((_resolve, reject) => (rejectQuery = reject)),
    });
    const mutation = createMutation({
      name: "data.prediction-mutation",
      run: () => new Promise<void>((_resolve, reject) => (rejectMutation = reject)),
      affects: [
        affects(query, {
          select: () => undefined,
          on: "invalidate",
          optimistic: () => "optimistic",
        }),
      ],
    });
    const graph = createGraph({
      contract: defineContract({ namespace: "data", operations: { query, mutation } }),
    });
    const store = graph.api.query(undefined);
    const view = createQueryView(current, store as QueryStore<string>, () => undefined);
    const waiting = Promise.resolve(view);
    const pendingMutation = graph.api.mutation(undefined);
    expect(view.value()).toBe("optimistic");
    rejectMutation(mutationFailure);
    await expect(pendingMutation).rejects.toBe(mutationFailure);
    rejectQuery(queryFailure);
    await expect(waiting).rejects.toBe(queryFailure);
    graph.dispose();
  });

  test("an awaited accessor retains its resolved value after unobserved store collection", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    const current = owner();
    let requestCount = 0;
    let rejectRefresh!: (reason: unknown) => void;
    const refreshFailure = new Error("refresh failed");
    const query = createQuery({
      name: "data.retained",
      key: () => "data/retained",
      fetch: () => {
        requestCount += 1;
        if (requestCount === 1) return Promise.resolve("retained");
        return new Promise<string>((_resolve, reject) => (rejectRefresh = reject));
      },
    });
    const graph = createGraph({
      contract: defineContract({ namespace: "data", operations: { query } }),
      idleMs: 5,
    });
    const store = graph.api.query(undefined);
    const view = createQueryView(current, store as QueryStore<string>, () => undefined);
    const accessor = await view;
    expect(accessor()).toBe("retained");
    jest.advanceTimersByTime(6);
    expect(accessor()).toBe("retained");
    const refresh = store.revalidate();
    rejectRefresh(refreshFailure);
    await refresh;
    expect(accessor()).toBe("retained");
    graph.dispose();
  });
});
