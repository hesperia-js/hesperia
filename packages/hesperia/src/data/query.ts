import { observeQueryProgress, signal, subscribe } from "aeolia";
import type {
  AccumulatePolicy,
  Graph,
  QueryProgressCohortEntry,
  QueryProgressObservation,
  QueryStore,
  ReducePolicy,
  StoreStatus,
} from "aeolia";
import {
  currentRenderOwner,
  isExecutingCleanup,
  registerOwnerResourceLifecycle,
  RenderFault,
  type Owner,
  type QueryReadKind,
  reportFault,
} from "../runtime/owner.ts";
import { consumeFrameworkQueryFresh, registerFrameworkAwaitable } from "./protocol.ts";
import type { Accessor, ObservationIssue, QueryView, ValidationQueryView } from "./types.ts";
import {
  createQueryProgressView,
  prepareQueryProgressView,
  prepareQueryProgressPolicy,
  type PreparedQueryProgressPolicy,
  type QueryProgressProject,
  type QueryProgressView,
} from "./query-progress.ts";
import type { ValidationWorkTracker } from "../validation/standard-schema.ts";

type RecoverQuery = () => void;

/** The real query store acquired after input preparation succeeds. */
export interface PreparedQuerySource<T, P = never> {
  readonly store: QueryStore<T, P>;
  readonly recover: RecoverQuery;
  readonly release?: () => void;
  readonly assertCurrent?: () => void;
  readonly observationIssue?: () => ObservationIssue | undefined;
}

/** Admit data reads to the actual render owner without enrolling callback-only reads. */
function admitQueryRead<T, P = never>(
  owner: Owner,
  graph: Graph,
  store: QueryStore<T, P>,
  kind: QueryReadKind,
): boolean {
  owner.assertReadable();

  if (isExecutingCleanup()) return true;

  const renderingOwner = currentRenderOwner();
  const consumer = renderingOwner ?? owner;

  consumer.assertReadable();

  const boundary = renderingOwner ? renderingOwner.asyncBoundary : owner.asyncBoundary;

  if (renderingOwner) boundary?.consumeQuery(renderingOwner, graph, store, kind);

  boundary?.assertQueryReadable(consumer, graph, store);

  return false;
}

function createQueryProgressForStore<T, P>(
  owner: Owner,
  graph: Graph,
  store: QueryStore<T, P>,
  policy: PreparedQueryProgressPolicy<P, any>,
  assertSourceCurrent?: () => void,
): QueryProgressView<unknown> {
  const observation = observeQueryProgress(store);
  const guard = (): void => {
    assertSourceCurrent?.();
    owner.assertReadable();

    if (!isExecutingCleanup()) {
      const renderingOwner = currentRenderOwner();
      const consumer = renderingOwner ?? owner;
      consumer.assertReadable();
      const boundary = renderingOwner ? renderingOwner.asyncBoundary : owner.asyncBoundary;
      boundary?.assertQueryReadable(consumer, graph, store);
    }

    observation.capture();
  };

  if (policy === undefined) return createQueryProgressView(owner, observation, undefined, guard);
  if (policy.kind === "accumulate")
    return createQueryProgressView(owner, observation, policy, guard);
  return createQueryProgressView(owner, observation, policy, guard);
}

/** Adapt an Aeolia query store to Hesperia's owner-bound callable view. */
export function createQueryView<T, P = never>(
  owner: Owner,
  graph: Graph,
  store: QueryStore<T, P>,
  recover: RecoverQuery,
  observationIssue?: () => ObservationIssue | undefined,
  assertCurrent?: () => void,
): QueryView<T, P> {
  owner.assertActive();

  const read = <V>(kind: QueryReadKind, run: () => V): V => {
    assertCurrent?.();
    admitQueryRead(owner, graph, store, kind);

    return run();
  };

  const value: Accessor<T | undefined> = () => read("value", () => store.value.get());

  const pending: Accessor<boolean> = () => read("metadata", () => store.pending.get());

  const error: Accessor<unknown> = () => read("metadata", () => store.error.get());

  const status: Accessor<StoreStatus> = () => read("metadata", () => store.status.get());

  const project = ((policy?: AccumulatePolicy | ReducePolicy<P, any>) => {
    owner.assertActive();
    assertCurrent?.();
    const selected = prepareQueryProgressPolicy<P, any>(policy);
    return createQueryProgressForStore(owner, graph, store, selected, assertCurrent);
  }) as QueryProgressProject<P>;

  const view: QueryView<T, P> = {
    observationIssue: () => read("metadata", () => observationIssue?.()),
    key: store.key,
    graph: store.graph,
    value,
    pending,
    error,
    status,
    project,

    get source() {
      owner.assertReadable();
      assertCurrent?.();

      return store;
    },

    get ready() {
      owner.assertReadable();
      assertCurrent?.();

      return store.ready;
    },

    set(next) {
      owner.assertActive();
      assertCurrent?.();

      store.set(next);
    },

    update(next) {
      owner.assertActive();
      assertCurrent?.();

      store.update(next);
    },

    revalidate(options) {
      owner.assertActive();
      assertCurrent?.();

      return store.revalidate(options);
    },

    // Hesperia query views intentionally implement PromiseLike for direct `await query` syntax.
    // oxlint-disable-next-line unicorn/no-thenable
    then(onfulfilled, onrejected) {
      return waitForCommitted(owner, graph, store, recover, assertCurrent).then(
        onfulfilled,
        onrejected,
      );
    },
  } as QueryView<T, P>;

  Object.freeze(view);

  return registerFrameworkAwaitable(
    view,
    owner,
    "query",
    (awaitingOwner) => {
      owner.assertReadable();
      assertCurrent?.();

      return waitForCommitted(awaitingOwner, graph, store, recover, assertCurrent);
    },
    (awaitingOwner) => {
      owner.assertReadable();

      awaitingOwner.asyncBoundary?.consumeQuery(awaitingOwner, graph, store, "value");
    },
  );
}

/**
 * Prepare one actual query input, then expose the acquired source through the ordinary query view.
 * @internal
 */
export function createPreparedQueryView<Input, T, P = never>(
  owner: Owner,
  graph: Graph,
  prepare: (track: ValidationWorkTracker) => Input | PromiseLike<Input>,
  acquire: (
    input: Input,
    preparationReceipt: object,
    progressEntries: readonly QueryProgressCohortEntry<T, P>[],
    assertCurrent: () => void,
  ) => PreparedQuerySource<T, P>,
  callerSignal?: AbortSignal,
  assertAuthority: () => void = () => {},
): ValidationQueryView<T, P> {
  owner.assertActive();

  const context = owner.context;
  const version = graph.resetVersion.get();
  const phase = signal<"validating" | "failed" | "acquired">("validating");
  let acquired: (PreparedQuerySource<T, P> & { readonly view: QueryView<T, P> }) | undefined;
  let failure: unknown;
  let finished = false;
  let readyRequested = false;
  let stopReset: (() => void) | undefined;
  let cohortStore: QueryStore<T, P> | undefined;
  let cohortObservation: QueryProgressObservation<P> | undefined;
  let returnedSource: PreparedQuerySource<T, P> | undefined;

  const createPendingProjection = (policy: PreparedQueryProgressPolicy<P, any>) => ({
    policy,
    current: signal<QueryProgressView<unknown> | undefined>(undefined),
    localFailure: signal<{ readonly error: unknown } | undefined>(undefined),
    preparedView: undefined as QueryProgressView<unknown> | undefined,
    joined: false,
    released: false,
  });
  const progressProjections: ReturnType<typeof createPendingProjection>[] = [];

  const preparationReceipt = Object.freeze(Object.create(null)) as object;
  let resolvePreparation!: () => void;
  let preparationSettled = false;
  const preparationCompletion = new Promise<void>((resolve) => {
    resolvePreparation = resolve;
  });
  void preparationCompletion.catch(() => undefined);

  const settlePreparation = (): void => {
    if (preparationSettled) return;

    preparationSettled = true;
    resolvePreparation();
  };

  let resolveAcquisition!: (
    source: PreparedQuerySource<T, P> & { readonly view: QueryView<T, P> },
  ) => void;
  let rejectAcquisition!: (reason: unknown) => void;
  const acquisition = new Promise<PreparedQuerySource<T, P> & { readonly view: QueryView<T, P> }>(
    (resolve, reject) => {
      resolveAcquisition = resolve;
      rejectAcquisition = reject;
    },
  );
  let resolveReady!: (storeReady: Promise<T>) => void;
  let rejectReady!: (reason?: unknown) => void;
  const ready = new Promise<T>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  void acquisition.catch(() => undefined);
  void ready.catch(() => undefined);

  const stop = (): void => {
    stopReset?.();
    stopReset = undefined;

    owner.signal.removeEventListener("abort", onOwnerAbort);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  };

  const fail = (reason: unknown): void => {
    if (finished) return;

    finished = true;
    failure = reason;
    rejectReady(reason);

    stop();
    rejectAcquisition(reason);
    phase.set("failed");
  };

  const onOwnerAbort = (): void => {
    fail(owner.signal.reason ?? new RenderFault("cancelled", "Owner disposed"));
  };

  const onCallerAbort = (): void => {
    fail(callerSignal?.reason ?? new DOMException("Query validation cancelled", "AbortError"));
  };

  const assertCurrent = (): void => {
    owner.assertActive();
    assertAuthority();

    if (owner.signal.aborted)
      throw owner.signal.reason ?? new RenderFault("cancelled", "Owner disposed");

    if (callerSignal?.aborted)
      throw callerSignal.reason ?? new DOMException("Query validation cancelled", "AbortError");

    if (owner.context !== context || graph.resetVersion.get() !== version)
      throw new RenderFault("query-reset-expired", "Query input validation was superseded");
  };

  const assertProgressStoreCurrent = (store: QueryStore<T, P>): void => {
    if (finished && acquired === undefined) throw failure;
    if (cohortStore !== undefined && cohortStore !== store)
      throw new TypeError("Query progress cohort changed its source Store");

    if (acquired !== undefined) {
      owner.assertReadable();
      assertAuthority();
      if (acquired.store !== store)
        throw new TypeError("Query progress cohort did not retain its acquired Store");
      acquired.assertCurrent?.();
      return;
    }

    assertCurrent();
    if (returnedSource !== undefined && returnedSource.store !== store)
      throw new TypeError("Query progress cohort did not retain its acquired Store");
    returnedSource?.assertCurrent?.();
  };

  const assertProgressReadCurrent = (): void => {
    const store = cohortStore ?? acquired?.store ?? returnedSource?.store;
    if (store === undefined) {
      assertCurrent();
      return;
    }
    assertProgressStoreCurrent(store);
    (cohortObservation ?? observeQueryProgress(store)).capture();
  };

  const accept = (input: Input): void => {
    if (finished) return;

    let source: PreparedQuerySource<T, P> | undefined;
    let released = false;
    const release = (): void => {
      if (released || source === undefined) return;

      released = true;
      source.release?.();
    };

    try {
      assertCurrent();
      const progressEntries: QueryProgressCohortEntry<T, P>[] = [];
      for (const projection of progressProjections.slice()) {
        if (projection.released) continue;
        assertCurrent();
        const prepared = prepareQueryProgressView<T, P>(
          owner,
          projection.policy,
          assertProgressReadCurrent,
          (store, observation) => {
            if (finished && acquired === undefined) throw failure;
            if (cohortStore !== undefined && cohortStore !== store)
              throw new TypeError("Query progress cohort changed its source Store");
            if (returnedSource !== undefined && returnedSource.store !== store)
              throw new TypeError("Query progress cohort did not retain its acquired Store");
            cohortStore = store;
            cohortObservation = observation;
            assertProgressStoreCurrent(store);
            projection.current.set(projection.preparedView);
            assertProgressStoreCurrent(store);
          },
        );
        projection.preparedView = prepared.view;
        projection.joined = true;
        progressEntries.push(prepared.entry);
        assertCurrent();
      }
      source = acquire(input, preparationReceipt, Object.freeze(progressEntries), assertCurrent);
      returnedSource = source;
      if (cohortStore !== undefined && source.store !== cohortStore)
        throw new TypeError("Query progress cohort did not retain its acquired Store");

      if (finished) {
        release();

        return;
      }

      assertCurrent();
      source.assertCurrent?.();
      const view = createQueryView(
        owner,
        graph,
        source.store,
        source.recover,
        source.observationIssue,
        source.assertCurrent,
      );
      assertCurrent();
      source.assertCurrent?.();

      acquired = { ...source, view };
      finished = true;
      stop();
      resolveAcquisition(acquired);
      if (readyRequested) resolveReady(acquired.store.ready);
      phase.set("acquired");
    } catch (reason) {
      try {
        release();
      } catch (cleanup) {
        fail(
          new AggregateError([reason, cleanup], "Query acquisition cleanup failed", {
            cause: reason,
          }),
        );

        return;
      }

      fail(reason);
    }
  };

  const readPhase = (): "validating" | "failed" | "acquired" => {
    owner.assertReadable();
    assertAuthority();
    currentRenderOwner()?.assertReadable();

    return phase.get();
  };

  const requireView = (): QueryView<T, P> => {
    owner.assertActive();

    if (acquired === undefined)
      throw new TypeError(
        "Query store methods require successful input validation and acquisition",
      );

    acquired.assertCurrent?.();

    return acquired.view;
  };

  const project = ((policy?: AccumulatePolicy | ReducePolicy<P, any>) => {
    owner.assertActive();
    assertAuthority();
    acquired?.assertCurrent?.();
    const selected = prepareQueryProgressPolicy<P, any>(policy);
    const initial =
      selected === undefined ? undefined : selected.kind === "reduce" ? selected.initial : [];
    const store = cohortStore ?? acquired?.store ?? returnedSource?.store;
    if (store !== undefined && !(finished && acquired === undefined)) {
      assertProgressStoreCurrent(store);
      return createQueryProgressForStore(owner, graph, store, selected, () =>
        assertProgressStoreCurrent(store),
      );
    }

    const projection = createPendingProjection(selected);
    progressProjections.push(projection);
    owner.onRelease(() => {
      projection.released = true;
    });

    void acquisition.then(
      (source) => {
        if (projection.released || projection.joined) return;
        try {
          const current = createQueryProgressForStore(
            owner,
            graph,
            source.store,
            selected,
            source.assertCurrent,
          );
          source.assertCurrent?.();
          projection.current.set(current);
        } catch (error) {
          projection.localFailure.set({ error });
        }
      },
      () => undefined,
    );

    return Object.freeze({
      value: () => {
        const currentPhase = readPhase();
        const current = projection.current.get();
        if (currentPhase === "failed" || projection.localFailure.get() !== undefined)
          return initial;
        return current === undefined ? initial : current.value();
      },
      pending: () => {
        const currentPhase = readPhase();
        if (currentPhase === "failed" || projection.localFailure.get() !== undefined) return false;
        return projection.current.get()?.pending() ?? true;
      },
      error: () => {
        if (readPhase() === "failed") return failure;
        const local = projection.localFailure.get();
        return local === undefined ? projection.current.get()?.error() : local.error;
      },
      status: () => {
        const currentPhase = readPhase();
        if (currentPhase === "failed" || projection.localFailure.get() !== undefined)
          return "failed";
        return projection.current.get()?.status() ?? "pending";
      },
    });
  }) as QueryProgressProject<P>;

  const wait = (consumer: Owner, consumeAfterAcquisition: boolean): Promise<Accessor<T>> => {
    assertAuthority();

    if (consumer.signal.aborted || consumer.state === "cleaning" || consumer.state === "destroyed")
      return Promise.reject(
        consumer.signal.reason ?? new RenderFault("cancelled", "Owner disposed"),
      );

    if (acquired !== undefined) {
      acquired.assertCurrent?.();

      return waitForCommitted(
        consumer,
        graph,
        acquired.store,
        acquired.recover,
        acquired.assertCurrent,
      );
    }

    const waiting = new Promise<PreparedQuerySource<T, P> & { readonly view: QueryView<T, P> }>(
      (resolve, reject) => {
        let settled = false;

        const finish = (complete: () => void): void => {
          if (settled) return;

          settled = true;
          consumer.signal.removeEventListener("abort", abort);
          complete();
        };

        const abort = (): void => {
          finish(() =>
            reject(consumer.signal.reason ?? new RenderFault("cancelled", "Owner disposed")),
          );
        };

        consumer.signal.addEventListener("abort", abort, { once: true });

        void acquisition.then(
          (source) => finish(() => resolve(source)),
          (reason: unknown) => finish(() => reject(reason)),
        );

        if (consumer.signal.aborted) abort();
      },
    );

    return waiting.then((source) => {
      const { store, recover } = source;
      consumer.assertActive();
      assertAuthority();
      source.assertCurrent?.();

      if (consumeAfterAcquisition)
        consumer.asyncBoundary?.consumeQuery(consumer, graph, store, "value");

      return waitForCommitted(consumer, graph, store, recover, source.assertCurrent);
    });
  };

  const view: ValidationQueryView<T, P> = {
    graph: graph.id,
    project,

    get key() {
      owner.assertReadable();
      assertAuthority();
      acquired?.assertCurrent?.();

      const store = acquired?.store ?? (finished ? undefined : cohortStore);
      if (store !== undefined && acquired === undefined) assertProgressStoreCurrent(store);
      return store?.key;
    },

    get source() {
      owner.assertReadable();
      assertAuthority();
      acquired?.assertCurrent?.();

      const store = acquired?.store ?? (finished ? undefined : cohortStore);
      if (store !== undefined && acquired === undefined) assertProgressStoreCurrent(store);
      return store;
    },

    get ready() {
      owner.assertReadable();
      assertAuthority();
      acquired?.assertCurrent?.();

      if (acquired !== undefined) return acquired.store.ready;

      readyRequested = true;

      return ready;
    },

    value: () => {
      readPhase();

      return acquired?.view.value();
    },
    observationIssue: () => {
      readPhase();

      return acquired?.view.observationIssue();
    },
    pending: () => readPhase() === "validating" || (acquired?.view.pending() ?? false),
    error: () => (readPhase() === "failed" ? failure : acquired?.view.error()),
    status: () => {
      const current = readPhase();

      return current === "acquired" ? acquired!.view.status() : current;
    },
    set: (next) => requireView().set(next),
    update: (next) => requireView().update(next),
    revalidate: (options) => requireView().revalidate(options),

    // Hesperia query views intentionally implement PromiseLike for direct `await query` syntax.
    // oxlint-disable-next-line unicorn/no-thenable
    then(onfulfilled, onrejected) {
      return wait(owner, false).then(onfulfilled, onrejected);
    },
  } as ValidationQueryView<T, P>;
  Object.freeze(view);

  registerFrameworkAwaitable(
    view,
    owner,
    "query",
    (awaitingOwner) => {
      owner.assertReadable();

      return wait(awaitingOwner, true);
    },
    (awaitingOwner) => {
      owner.assertReadable();

      if (acquired !== undefined)
        awaitingOwner.asyncBoundary?.consumeQuery(awaitingOwner, graph, acquired.store, "value");
    },
  );

  owner.signal.addEventListener("abort", onOwnerAbort, { once: true });
  callerSignal?.addEventListener("abort", onCallerAbort, { once: true });

  if (!finished) {
    try {
      const unsubscribe = subscribe(graph.resetVersion, (current) => {
        if (current !== version)
          fail(new RenderFault("query-reset-expired", "Query input validation was superseded"));
      });

      if (finished) unsubscribe();
      else stopReset = unsubscribe;

      assertCurrent();
      owner.onRelease(() => preparationCompletion);
      assertCurrent();

      const prepared = prepare((completion) => owner.onRelease(() => completion));

      if (isPreparedPromise(prepared)) {
        const completion = Promise.resolve(prepared);

        void completion.then(
          (input) => {
            settlePreparation();

            try {
              accept(input);
            } catch (reason) {
              fail(reason);
            }
          },
          (reason: unknown) => {
            settlePreparation();
            fail(reason);
          },
        );
      } else {
        settlePreparation();
        accept(prepared);
      }
    } catch (reason) {
      settlePreparation();
      fail(reason);
    }
  } else {
    settlePreparation();
  }

  return view;
}

function isPreparedPromise<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof Reflect.get(value, "then") === "function"
  );
}

function waitForCommitted<T, P = never>(
  owner: Owner,
  graph: Graph,
  store: QueryStore<T, P>,
  recover: RecoverQuery,
  assertCurrent: () => void = () => {},
): Promise<Accessor<T>> {
  try {
    assertCurrent();
  } catch (reason) {
    return Promise.reject(reason);
  }

  if (owner.state === "cleaning" || owner.state === "destroyed") {
    return Promise.reject(owner.signal.reason ?? new RenderFault("cancelled", "Owner disposed"));
  }

  const resetVersion = graph.resetVersion.get();
  let accessorVersion = resetVersion;
  let settled = false;
  let stopStatus: (() => void) | undefined;
  let stopReset: (() => void) | undefined;
  let unregisterLifecycle: (() => void) | undefined;

  const finish = (complete: () => void): void => {
    if (settled) return;

    settled = true;

    unregisterLifecycle?.();

    unregisterLifecycle = undefined;

    stopStatus?.();

    stopReset?.();

    owner.signal.removeEventListener("abort", abort);

    complete();
  };

  let resolvePromise!: (value: Accessor<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<Accessor<T>>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  let hasCachedValue = false;
  let hasFreshCommittedValue = false;
  let cachedValue!: T;

  const accessor: Accessor<T> = () => {
    assertCurrent();

    if (admitQueryRead(owner, graph, store, "value")) return store.value.get() as T;

    const currentVersion = graph.resetVersion.get();

    if (currentVersion !== accessorVersion) {
      accessorVersion = currentVersion;
      hasCachedValue = false;
      hasFreshCommittedValue = false;
    }

    const currentStatus = store.status.get();
    const currentValue = store.value.get() as T;

    if (currentVersion !== resetVersion && !hasFreshCommittedValue) {
      if (currentStatus === "failed") throw store.error.get();

      if (currentStatus === "ready") hasFreshCommittedValue = true;
      else {
        throw new RenderFault(
          "query-reset-unavailable",
          "The awaited query has no fresh committed value for its current graph reset",
        );
      }
    }

    if (currentStatus === "failed" || currentStatus === "empty" || currentStatus === "fetching")
      return hasCachedValue ? cachedValue : currentValue;

    cachedValue = currentValue;
    hasCachedValue = true;
    return currentValue;
  };

  const abort = (): void => {
    finish(() =>
      rejectPromise(owner.signal.reason ?? new RenderFault("cancelled", "Owner disposed")),
    );
  };

  const initialStatus = store.status.get();
  const initialPending = store.pending.get();
  const waitingForInitialRequest = initialStatus === "empty" || initialStatus === "fetching";

  const observeStatus = (current: StoreStatus): void => {
    if (settled) return;

    try {
      assertCurrent();
    } catch (reason) {
      finish(() => rejectPromise(reason));

      return;
    }

    if (current === "ready" && waitingForInitialRequest) {
      cachedValue = store.value.get() as T;
      hasCachedValue = true;

      finish(() => resolvePromise(accessor));
    } else if (current === "failed" && waitingForInitialRequest) {
      finish(() => rejectPromise(store.error.get()));
    }
  };

  const attachStatus = (): void => {
    if (settled || stopStatus) return;

    const subscription = subscribe(store.status, observeStatus);

    if (settled) subscription();
    else stopStatus = subscription;

    observeStatus(store.status.get());
  };

  const detachStatus = (): void => {
    const stop = stopStatus;
    stopStatus = undefined;

    stop?.();
  };

  const onResetVersion = (current: number): void => {
    if (current === resetVersion) return;

    finish(() =>
      rejectPromise(
        new RenderFault("query-reset-expired", "The awaited query was superseded by a graph reset"),
      ),
    );
  };

  owner.signal.addEventListener("abort", abort, { once: true });

  try {
    const resetSubscription = subscribe(graph.resetVersion, onResetVersion);

    if (settled) resetSubscription();
    else stopReset = resetSubscription;

    attachStatus();

    const unregister = registerOwnerResourceLifecycle(owner, {
      suspended: detachStatus,
      resumed: attachStatus,
    });

    if (settled) unregister();
    else unregisterLifecycle = unregister;

    if (!settled && initialStatus === "failed") {
      const failure = store.error.get();
      const freshFailure = consumeFrameworkQueryFresh(owner, store.value as object);

      finish(() => rejectPromise(freshFailure ? failure : { status: "failed", error: failure }));

      if (!freshFailure) {
        try {
          recover();
        } catch (error) {
          reportFault(owner, error);
        }
      }
    } else if (
      !settled &&
      (initialStatus === "ready" || initialStatus === "stale" || initialStatus === "revalidating")
    ) {
      cachedValue = store.value.get() as T;
      hasCachedValue = true;

      finish(() => resolvePromise(accessor));

      if (!initialPending && !consumeFrameworkQueryFresh(owner, store.value as object))
        startRefresh(owner, store);
    } else if (!settled && initialStatus === "empty" && !initialPending) {
      if (owner.state === "suspended") return promise;

      try {
        void store.revalidate().catch((error: unknown) => reportFault(owner, error));
      } catch (error) {
        finish(() => rejectPromise(error));
      }
    }
  } catch (error) {
    finish(() => rejectPromise(error));
  }

  return promise;
}

function startRefresh<T, P = never>(owner: Owner, store: QueryStore<T, P>): void {
  try {
    void store.revalidate().catch((error: unknown) => reportFault(owner, error));
  } catch (error) {
    reportFault(owner, error);
  }
}

export type { Accessor, QueryView } from "./types.ts";
