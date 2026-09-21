import { afterEach, describe, expect, jest, test } from "bun:test";
import { computed, createGraph, createStream, defineContract, subscribe } from "aeolia";
import type { Readable, StreamStore } from "aeolia";
import { testBackend } from "aeolia/testing";
import { Window } from "happy-dom";
import { createFeed } from "../../src/data/feed.ts";
import { Owner, type RuntimeContext } from "../../src/runtime/owner.ts";
import { Scheduler } from "../../src/runtime/scheduler.ts";

const windows: Window[] = [];
const owners: Owner[] = [];

afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
  for (const window of windows.splice(0)) window.close();
  try {
    jest.clearAllTimers();
    jest.useRealTimers();
  } catch {
    // This test did not enable fake timers.
  }
});

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function waitFor<T>(source: Readable<T>, predicate: (value: T) => boolean): Promise<T> {
  return new Promise((resolve) => {
    let done = false;
    let stop: (() => void) | undefined;
    const observer = (value: T): void => {
      if (done || !predicate(value)) return;
      done = true;
      if (stop === undefined) queueMicrotask(() => stop?.());
      else stop();
      resolve(value);
    };
    stop = subscribe(source, observer);
  });
}

function makeOwner(
  commit = false,
  onError: (error: unknown) => void = (error) => {
    throw error;
  },
): Owner {
  const window = new Window();
  windows.push(window);
  const context = {
    document: window.document,
    container: window.document.body,
    onError,
    warn: () => undefined,
    nextGeneration: 0,
    scheduler: undefined,
  } as unknown as RuntimeContext;
  const result = new Owner(context, null, "feed-test");
  owners.push(result);
  if (commit) result.commit();
  return result;
}

function streamGraph(name: string, backend: ReturnType<typeof testBackend>) {
  const stream = createStream({
    name,
    key: () => `${name}/shared`,
    open: backend.stream<void, number>(name),
  });
  return createGraph({
    contract: defineContract({ namespace: "feed-tests", operations: { stream } }),
    idleMs: 5,
  });
}

describe("owner-bound shared feeds", () => {
  test("does not open a deferred stream before owner commit", () => {
    const backend = testBackend();
    const graph = streamGraph("dormant", backend);
    const current = makeOwner();
    const feed = createFeed(current, () => graph.api.stream(undefined) as StreamStore<number>);
    expect(backend.calls).toHaveLength(0);
    expect(feed.status()).toBe("empty");
    expect(feed.pending()).toBe(false);
    expect(() => feed.source).toThrow("not active");
    current.dispose();
    expect(backend.calls).toHaveLength(0);
    graph.dispose();
  });

  test("commit publishes activation to value, pending, status, and error readers", async () => {
    const backend = testBackend();
    const graph = streamGraph("activation-readers", backend);
    const current = makeOwner();
    const feed = createFeed(current, () => graph.api.stream(undefined) as StreamStore<number>);
    const value = computed(() => feed.value(), { label: "feed-test:activation-value" });
    const pending = computed(() => feed.pending(), { label: "feed-test:activation-pending" });
    const status = computed(() => feed.status(), { label: "feed-test:activation-status" });
    const error = computed(() => feed.error(), { label: "feed-test:activation-error" });
    expect(value.get()).toBeUndefined();
    expect(pending.get()).toBe(false);
    expect(status.get()).toBe("empty");
    expect(error.get()).toBeUndefined();
    const opening = waitFor(status, (value) => value === "opening");
    const openingPending = waitFor(pending, (value) => value);

    current.commit();
    expect(await opening).toBe("opening");
    expect(await openingPending).toBe(true);

    const live = waitFor(status, (value) => value === "live");
    const liveValue = waitFor(value, (value) => value === 1);
    const settledPending = waitFor(pending, (value) => !value);
    backend.emit("activation-readers", 1);
    expect(await live).toBe("live");
    expect(await liveValue).toBe(1);
    expect(await settledPending).toBe(false);

    const failure = new Error("activation reader stream failed");
    const failedStatus = waitFor(status, (value) => value === "failed");
    const failedError = waitFor(error, (value) => value === failure);
    backend.end("activation-readers", failure);
    expect(await failedStatus).toBe("failed");
    expect(await failedError).toBe(failure);
    graph.dispose();
  });

  test("activation failure publishes error and status before reporting the fault", async () => {
    const reason = new Error("feed source failed");
    const current = makeOwner();
    const feed = createFeed(current, () => {
      throw reason;
    });
    const status = computed(() => feed.status(), { label: "feed-test:activation-failure-status" });
    const error = computed(() => feed.error(), { label: "feed-test:activation-failure-error" });
    status.get();
    error.get();
    let observedDuringFailure: unknown = Symbol("not-observed");
    const stopStatus = subscribe(status, (value) => {
      if (value === "failed") observedDuringFailure = feed.error();
    });
    const failedStatus = waitFor(status, (value) => value === "failed");
    const failedError = waitFor(error, (value) => value === reason);

    expect(() => current.commit()).toThrow(reason);
    expect(await failedStatus).toBe("failed");
    expect(await failedError).toBe(reason);
    expect(observedDuringFailure).toBe(reason);
    stopStatus();
  });

  test("an undefined activation fault still publishes failed status", () => {
    let reported: unknown = Symbol("not-reported");
    const current = makeOwner(false, (error) => {
      reported = error;
    });
    const feed = createFeed(current, () => {
      throw undefined;
    });
    const status = computed(() => feed.status(), { label: "feed-test:undefined-failure-status" });
    status.get();

    current.commit();

    expect(reported).toBeUndefined();
    expect(status.get()).toBe("failed");
    expect(feed.error()).toBeUndefined();
  });

  test("two committed consumers share one source and each projection sees equal emissions", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    const backend = testBackend();
    const graph = streamGraph("shared", backend);
    const firstOwner = makeOwner();
    const secondOwner = makeOwner();
    const first = createFeed(firstOwner, () => graph.api.stream(undefined) as StreamStore<number>);
    const history = createFeed<number, readonly number[]>(
      secondOwner,
      () => graph.api.stream(undefined) as StreamStore<number>,
      { kind: "accumulate", max: 4 },
    );
    expect(backend.calls).toHaveLength(0);
    firstOwner.commit();
    secondOwner.commit();
    expect(backend.calls).toHaveLength(1);

    backend.emit("shared", 1);
    backend.emit("shared", 1);
    await flush();
    expect(first.value()).toBe(1);
    expect(history.value()).toStrictEqual([1, 1]);
    expect(first.status()).toBe("live");
    expect(history.status()).toBe("live");

    firstOwner.dispose();
    backend.emit("shared", 2);
    await flush();
    expect(history.value()).toStrictEqual([1, 1, 2]);
    expect(backend.calls[0]!.aborted).toBe(false);
    secondOwner.dispose();
    jest.advanceTimersByTime(6);
    await flush();
    expect(backend.calls[0]!.aborted).toBe(true);
    graph.dispose();
  });

  test("a latest feed projects independently without opening another source", async () => {
    const backend = testBackend();
    const graph = streamGraph("public-project", backend);
    const current = makeOwner();
    const latest = createFeed(current, () => graph.api.stream(undefined) as StreamStore<number>);
    const history = latest.project({ kind: "accumulate", max: 3 });
    const total = latest.project({
      kind: "reduce",
      initial: 0,
      step: (sum, item) => sum + item,
    });

    expect(latest.status()).toBe("empty");
    expect(history.status()).toBe("empty");
    expect(history.value()).toStrictEqual([]);
    expect(total.value()).toBe(0);
    current.commit();
    expect(backend.calls).toHaveLength(1);
    expect(history.value()).toStrictEqual([]);
    expect(total.value()).toBe(0);

    const completed = waitFor(
      computed(() => total.value()),
      (value) => value === 4,
    );
    backend.emit("public-project", 2);
    backend.emit("public-project", 2);
    await completed;

    expect(latest.value()).toBe(2);
    expect(history.value()).toStrictEqual([2, 2]);
    expect(total.value()).toBe(4);
    expect((history as { project?: unknown }).project).toBeUndefined();
    current.dispose();
    graph.dispose();
  });

  test("projection overflow fails by default and keeps an explicit drop-oldest window", async () => {
    const backend = testBackend();
    const graph = streamGraph("public-overflow", backend);
    const current = makeOwner();
    const latest = createFeed(current, () => graph.api.stream(undefined) as StreamStore<number>);
    const failed = latest.project({ kind: "accumulate", max: 2 });
    const window = latest.project({ kind: "accumulate", max: 2, onOverflow: "drop-oldest" });
    const undefinedFailure = latest.project({
      kind: "reduce",
      initial: 0,
      step: () => {
        throw undefined;
      },
    });
    const undefinedStatus = computed(() => undefinedFailure.status(), {
      label: "feed-test:undefined-projection-status",
    });
    const undefinedError = computed(() => undefinedFailure.error(), {
      label: "feed-test:undefined-projection-error",
    });
    undefinedStatus.get();
    undefinedError.get();
    let errorAtFailedStatus: unknown = Symbol("not-observed");
    const stopUndefinedStatus = subscribe(undefinedStatus, (status) => {
      if (status === "failed") errorAtFailedStatus = undefinedError.get();
    });
    current.commit();

    const completed = waitFor(
      computed(() => window.value()),
      (value) => value.length === 2 && value[1] === 3,
    );
    backend.emit("public-overflow", 1);
    backend.emit("public-overflow", 2);
    backend.emit("public-overflow", 3);
    await completed;

    expect(failed.status()).toBe("failed");
    expect(failed.value()).toStrictEqual([1, 2]);
    expect(failed.error()).toBeInstanceOf(Error);
    expect(window.status()).toBe("live");
    expect(window.value()).toStrictEqual([2, 3]);
    expect(undefinedFailure.status()).toBe("failed");
    expect(undefinedFailure.error()).toBeUndefined();
    expect(errorAtFailedStatus).toBeUndefined();
    stopUndefinedStatus();
    current.dispose();
    graph.dispose();
  });

  test("an invalid accumulation bound fails the projected view at activation", () => {
    let reported: unknown;
    const backend = testBackend();
    const graph = streamGraph("invalid-bound", backend);
    const current = makeOwner(false, (error) => {
      reported = error;
    });
    const latest = createFeed(current, () => graph.api.stream(undefined) as StreamStore<number>);
    const invalid = latest.project({ kind: "accumulate", max: 0 });

    current.commit();

    expect(invalid.status()).toBe("failed");
    expect(invalid.error()).toBe(reported);
    expect(reported).toMatchObject({ name: "Fault", kind: "contract" });
    graph.dispose();
  });

  test("cached feed projections release their source listener and resubscribe with retained state", async () => {
    const backend = testBackend();
    const graph = streamGraph("suspended", backend);
    const current = makeOwner();
    current.context.scheduler = new Scheduler(current);
    const latest = createFeed(current, () => graph.api.stream(undefined) as StreamStore<number>);
    const history = latest.project({ kind: "accumulate", max: 4 });
    current.commit();
    expect(backend.calls).toHaveLength(1);

    backend.emit("suspended", 1);
    await flush();
    expect(history.value()).toStrictEqual([1]);

    current.suspend();
    backend.emit("suspended", 2);
    await flush();
    expect(history.value()).toStrictEqual([1]);

    current.resume();
    backend.emit("suspended", 3);
    await flush();
    expect(history.value()).toStrictEqual([1, 3]);
    graph.dispose();
  });

  test("a late projection reopens a collected factory source while its owner stays mounted", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    const backend = testBackend();
    const graph = streamGraph("late-project", backend);
    const current = makeOwner();
    const latest = createFeed(current, () => graph.api.stream(undefined) as StreamStore<number>);
    const latestStatus = computed(() => latest.status(), { label: "feed-test:late-status" });
    latestStatus.get();

    current.commit();
    expect(backend.calls).toHaveLength(1);
    jest.advanceTimersByTime(6);
    await waitFor(latestStatus, (status) => status === "empty");
    expect(backend.calls[0]!.aborted).toBe(true);
    expect(current.state).toBe("mounted");

    const late = latest.project({
      kind: "reduce",
      initial: 0,
      step: (sum, item) => sum + item,
    });
    const lateValue = computed(() => late.value(), { label: "feed-test:late-reducer" });
    lateValue.get();
    const secondValue = waitFor(lateValue, (value) => value === 2);
    backend.emit("late-project", 2);
    await secondValue;
    expect(late.status()).toBe("live");
    expect(backend.calls).toHaveLength(2);
    graph.dispose();
  });

  test("a direct source ends with its collected session while a factory source reopens it", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    const backend = testBackend();
    const graph = streamGraph("direct-collected", backend);
    const current = makeOwner();
    current.context.scheduler = new Scheduler(current);
    const source = graph.api.stream(undefined) as StreamStore<number>;
    const history = createFeed(current, source, { kind: "accumulate", max: 4 });

    current.commit();
    backend.emit("direct-collected", 1);
    await flush();
    expect(history.value()).toStrictEqual([1]);

    current.suspend();
    jest.advanceTimersByTime(6);
    await flush();
    expect(backend.calls[0]!.aborted).toBe(true);

    current.resume();
    backend.emit("direct-collected", 2);
    await flush();
    expect(history.value()).toStrictEqual([1]);
    expect(backend.calls).toHaveLength(1);
    expect(history.status()).toBe("empty");
    graph.dispose();

    const factoryBackend = testBackend();
    const factoryGraph = streamGraph("factory-collected", factoryBackend);
    const factoryOwner = makeOwner();
    factoryOwner.context.scheduler = new Scheduler(factoryOwner);
    const factoryHistory = createFeed(
      factoryOwner,
      () => factoryGraph.api.stream(undefined) as StreamStore<number>,
      { kind: "accumulate", max: 4 },
    );

    factoryOwner.commit();
    factoryBackend.emit("factory-collected", 1);
    await flush();
    expect(factoryHistory.value()).toStrictEqual([1]);

    factoryOwner.suspend();
    jest.advanceTimersByTime(6);
    await flush();
    expect(factoryBackend.calls[0]!.aborted).toBe(true);

    factoryOwner.resume();
    expect(factoryBackend.calls).toHaveLength(2);
    factoryBackend.emit("factory-collected", 2);
    await flush();
    expect(factoryHistory.value()).toStrictEqual([1, 2]);
    factoryGraph.dispose();
  });

  test("resume publishes a newly materialized source to every feed reader", async () => {
    const firstBackend = testBackend();
    const firstGraph = streamGraph("resume-first", firstBackend);
    const secondBackend = testBackend();
    const secondGraph = streamGraph("resume-second", secondBackend);
    const current = makeOwner();
    current.context.scheduler = new Scheduler(current);
    let useSecond = false;
    const history = createFeed<number, readonly number[]>(
      current,
      () =>
        (useSecond
          ? secondGraph.api.stream(undefined)
          : firstGraph.api.stream(undefined)) as StreamStore<number>,
      { kind: "accumulate", max: 4 },
    );
    const value = computed(() => history.value(), { label: "feed-test:resume-value" });
    const pending = computed(() => history.pending(), { label: "feed-test:resume-pending" });
    const status = computed(() => history.status(), { label: "feed-test:resume-status" });
    const error = computed(() => history.error(), { label: "feed-test:resume-error" });
    value.get();
    pending.get();
    status.get();
    error.get();
    const firstOpening = waitFor(status, (value) => value === "opening");
    const firstPending = waitFor(pending, (value) => value);
    current.commit();
    await firstOpening;
    await firstPending;
    const firstLive = waitFor(status, (value) => value === "live");
    const firstValue = waitFor(value, (value) => value?.[0] === 1);
    const firstSettled = waitFor(pending, (value) => !value);
    firstBackend.emit("resume-first", 1);
    expect(await firstLive).toBe("live");
    expect(await firstValue).toStrictEqual([1]);
    expect(await firstSettled).toBe(false);

    current.suspend();
    useSecond = true;
    const secondOpening = waitFor(status, (value) => value === "opening");
    const secondPending = waitFor(pending, (value) => value);
    current.resume();
    expect(await secondOpening).toBe("opening");
    expect(await secondPending).toBe(true);
    expect(value.get()).toStrictEqual([1]);
    expect(error.get()).toBeUndefined();

    const secondLive = waitFor(status, (value) => value === "live");
    const secondValue = waitFor(value, (value) => value?.[1] === 2);
    const secondSettled = waitFor(pending, (value) => !value);
    secondBackend.emit("resume-second", 2);
    expect(await secondLive).toBe("live");
    expect(await secondValue).toStrictEqual([1, 2]);
    expect(await secondSettled).toBe(false);

    const failure = new Error("resume reader stream failed");
    const failedStatus = waitFor(status, (value) => value === "failed");
    const failedError = waitFor(error, (value) => value === failure);
    secondBackend.end("resume-second", failure);
    expect(await failedStatus).toBe("failed");
    expect(await failedError).toBe(failure);
    firstGraph.dispose();
    secondGraph.dispose();
  });

  test("an owner removed before commit never opens its stream", () => {
    const backend = testBackend();
    const graph = streamGraph("removed", backend);
    const current = makeOwner();
    createFeed(current, () => graph.api.stream(undefined) as StreamStore<number>);
    current.dispose(new Error("removed before activation"));
    expect(backend.calls).toHaveLength(0);
    graph.dispose();
  });

  test("a terminal source error reaches the feed and does not fabricate a value", async () => {
    const backend = testBackend();
    const graph = streamGraph("failed", backend);
    const current = makeOwner();
    const feed = createFeed(current, () => graph.api.stream(undefined) as StreamStore<number>);

    current.commit();
    expect(backend.calls).toHaveLength(1);
    const failure = new Error("stream failed");
    let stop!: () => void;
    const failed = new Promise<void>((resolve) => {
      stop = subscribe(feed.source.status, (status) => {
        if (status === "failed") resolve();
      });
    });
    backend.end("failed", failure);
    await failed;
    stop();

    expect(feed.status()).toBe("failed");
    expect(feed.pending()).toBe(false);
    expect(feed.value()).toBeUndefined();
    expect(feed.error()).toBe(failure);

    current.dispose();
    expect(() => feed.value()).toThrow("destroyed");
    graph.dispose();
  });
});
