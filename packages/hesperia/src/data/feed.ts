import { Fault, project, signal, subscribe, type Projection } from "aeolia";
import type { AccumulatePolicy, ReducePolicy, StreamStore, StreamStatus } from "aeolia";
import { RenderFault, type Owner, reportFault } from "../runtime/owner.ts";
import { isNonNullObject } from "../utils.ts";
import type { Accessor, Feed, FeedPolicy, FeedProjection } from "./types.ts";

type FeedSource<T> = StreamStore<T> | (() => StreamStore<T>);

interface FeedLifecycle {
  suspend(): void;

  resume(): void;

  release(): void;
}

const lifecycles = new WeakMap<Owner, Set<FeedLifecycle>>();

/** @internal Pause owner-bound stream listeners while an owner is cached. */
export function suspendFeeds(owner: Owner): void {
  for (const lifecycle of lifecycles.get(owner) ?? []) lifecycle.suspend();
}

/** @internal Reattach owner-bound stream listeners when a cached owner returns. */
export function resumeFeeds(owner: Owner): void {
  for (const lifecycle of lifecycles.get(owner) ?? []) lifecycle.resume();
}

/** Create a dormant, owner-bound view over a shared Aeolia stream session. */
export function createFeed<T>(owner: Owner, source: FeedSource<T>): Feed<T>;

/** Create a dormant, owner-bound view with an Aeolia-backed projection policy. */
export function createFeed<T, V>(
  owner: Owner,
  source: FeedSource<T>,
  policy: FeedPolicy<T, V>,
): FeedProjection<T, V>;

export function createFeed<T, V = T>(
  owner: Owner,
  sourceOrFactory: FeedSource<T>,
  policy?: FeedPolicy<T, V>,
): Feed<T> | FeedProjection<T, V> {
  owner.assertActive();

  const failure = signal<{ readonly error: unknown } | undefined>(undefined, {
    label: "feed:failure",
  });
  const sourceCell = signal<StreamStore<T> | undefined>(undefined, { label: "feed:source" });
  let source: StreamStore<T> | undefined;
  const projectedValue =
    policy === undefined
      ? undefined
      : signal<V>(policy.kind === "reduce" ? policy.initial : ([] as unknown as V), {
          label: "feed:value",
        });
  const projectionFailure =
    policy === undefined
      ? undefined
      : signal<{ readonly error: unknown } | undefined>(undefined, { label: "feed:error" });
  let projection: Projection<V> | undefined;
  let stopProjection: (() => void) | undefined;
  let released = false;

  const setSource = (candidate: StreamStore<T>): void => {
    source = candidate;

    sourceCell.set(candidate);
  };

  const lifecycle: FeedLifecycle = {
    suspend() {
      stopProjection?.();

      stopProjection = undefined;
    },

    resume() {
      if (released || failure.peek() !== undefined || projectionFailure?.get() !== undefined)
        return;

      try {
        const candidate =
          typeof sourceOrFactory === "function" ? sourceOrFactory() : sourceOrFactory;

        if (!isNonNullObject(candidate))
          throw new TypeError("Feed source must be an Aeolia StreamStore");

        setSource(candidate);

        connectProjection();
      } catch (error) {
        failure.set({ error });

        reportFault(owner, error);
      }
    },

    release() {
      released = true;

      stopProjection?.();

      stopProjection = undefined;
      source = undefined;

      sourceCell.set(undefined);
    },
  };

  const ownerLifecycles = lifecycles.get(owner) ?? new Set<FeedLifecycle>();

  ownerLifecycles.add(lifecycle);

  lifecycles.set(owner, ownerLifecycles);

  const failProjection = (error: unknown): void => {
    if (projectionFailure?.get() !== undefined) return;

    stopProjection?.();

    stopProjection = undefined;

    projectionFailure?.set({ error });
  };

  function connectProjection(): void {
    if (source === undefined || policy === undefined || stopProjection !== undefined) return;

    try {
      const resumeValue = projectedValue!.peek() as V;

      if (policy.kind === "reduce") {
        projection = project(source, {
          kind: "reduce",
          initial: resumeValue,
          step: policy.step,
        }) as Projection<V>;
      } else {
        if (!(Number.isFinite(policy.max) && policy.max >= 1 && Number.isInteger(policy.max)))
          throw new Fault("contract", ["max"]);

        projection = project(source, {
          kind: "reduce",
          initial: resumeValue as unknown as readonly T[],
          step: (current: readonly T[], item: T): readonly T[] => {
            if (current.length >= policy.max) {
              if ((policy.onOverflow ?? "fail") === "fail")
                throw new Error("Aeolia projection accumulation exceeded max");

              return [...current.slice(1), item];
            }

            return [...current, item];
          },
        }) as unknown as Projection<V>;
      }

      const stopValue = subscribe(projection, (value) => projectedValue!.set(value));
      const stopStatus = subscribe(projection.status, (status) => {
        if (status === "failed") failProjection(projection!.error.get());
      });
      stopProjection = () => {
        stopValue();

        stopStatus();

        projection?.close();

        projection = undefined;
      };
    } catch (error) {
      failProjection(error);

      reportFault(owner, error);
    }
  }

  const activate = (): void => {
    if (released || failure.peek() !== undefined || source !== undefined) return;

    try {
      const candidate = typeof sourceOrFactory === "function" ? sourceOrFactory() : sourceOrFactory;

      if (!isNonNullObject(candidate))
        throw new TypeError("Feed source must be an Aeolia StreamStore");

      setSource(candidate);

      connectProjection();
    } catch (error) {
      failure.set({ error });

      reportFault(owner, error);
    }
  };

  owner.onCommit(activate);

  owner.onRelease(() => {
    lifecycle.release();

    ownerLifecycles.delete(lifecycle);
  });

  const read = <R>(run: () => R): R => {
    owner.assertReadable();

    return run();
  };

  const latestValue: Accessor<T | undefined> = () =>
    read(() => {
      const currentSource = sourceCell.get();
      return currentSource === undefined ? undefined : currentSource.value.get();
    });

  const projectedRead: Accessor<V> = () => read(() => projectedValue!.get());

  const pending: Accessor<boolean> = () => read(() => sourceCell.get()?.pending.get() ?? false);

  const error: Accessor<unknown> = () =>
    read(() => {
      const activationFailure = failure.get();

      if (activationFailure !== undefined) return activationFailure.error;

      const projectionError = projectionFailure?.get();

      if (projectionError !== undefined) return projectionError.error;

      return sourceCell.get()?.error.get();
    });

  const status: Accessor<StreamStatus> = () =>
    read(() => {
      if (failure.get() !== undefined) return "failed";

      const currentSource = sourceCell.get();

      if (currentSource === undefined) return "empty";

      if (projectionFailure?.get() !== undefined) return "failed";

      return currentSource.status.get();
    });

  const state = {
    pending,
    error,
    status,

    get source() {
      owner.assertReadable();

      if (source === undefined)
        throw new RenderFault("feed-dormant", "Feed source is not active until owner commit");

      return source;
    },
  };

  if (policy === undefined) {
    function projectFeed(nextPolicy: AccumulatePolicy): FeedProjection<T, readonly T[]>;

    function projectFeed<Next>(nextPolicy: ReducePolicy<T, Next>): FeedProjection<T, Next>;

    function projectFeed<Next>(nextPolicy: FeedPolicy<T, Next>): FeedProjection<T, Next> {
      return createFeed(owner, sourceOrFactory, nextPolicy) as FeedProjection<T, Next>;
    }

    Object.defineProperty(state, "value", {
      configurable: false,
      enumerable: true,
      value: latestValue,
      writable: false,
    });

    Object.defineProperty(state, "project", {
      configurable: false,
      enumerable: true,
      value: projectFeed,
      writable: false,
    });

    return Object.freeze(state) as Feed<T>;
  }

  Object.defineProperty(state, "value", {
    configurable: false,
    enumerable: true,
    value: projectedRead,
    writable: false,
  });

  return Object.freeze(state) as FeedProjection<T, V>;
}

export type { Feed, FeedPolicy, FeedProjection } from "./types.ts";
