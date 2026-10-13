import { subscribe } from "aeolia";
import type { Graph, QueryStore, StoreStatus } from "aeolia";
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
import type { Accessor, QueryView } from "./types.ts";

type RecoverQuery = () => void;

/** Admit data reads to the actual render owner without enrolling callback-only reads. */
function admitQueryRead<T>(
  owner: Owner,
  graph: Graph,
  store: QueryStore<T>,
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

/** Adapt an Aeolia query store to Hesperia's owner-bound callable view. */
export function createQueryView<T>(
  owner: Owner,
  graph: Graph,
  store: QueryStore<T>,
  recover: RecoverQuery,
): QueryView<T> {
  owner.assertActive();

  const read = <V>(kind: QueryReadKind, run: () => V): V => {
    admitQueryRead(owner, graph, store, kind);

    return run();
  };

  const value: Accessor<T | undefined> = () => read("value", () => store.value.get());

  const pending: Accessor<boolean> = () => read("metadata", () => store.pending.get());

  const error: Accessor<unknown> = () => read("metadata", () => store.error.get());

  const status: Accessor<StoreStatus> = () => read("metadata", () => store.status.get());

  const view: QueryView<T> = {
    key: store.key,
    graph: store.graph,
    value,
    pending,
    error,
    status,

    get source() {
      owner.assertReadable();

      return store;
    },

    get ready() {
      owner.assertReadable();

      return store.ready;
    },

    set(next) {
      owner.assertActive();

      store.set(next);
    },

    update(next) {
      owner.assertActive();

      store.update(next);
    },

    revalidate(options) {
      owner.assertActive();

      return store.revalidate(options);
    },

    // Hesperia query views intentionally implement PromiseLike for direct `await query` syntax.
    // oxlint-disable-next-line unicorn/no-thenable
    then(onfulfilled, onrejected) {
      return waitForCommitted(owner, graph, store, recover).then(onfulfilled, onrejected);
    },
  };

  return registerFrameworkAwaitable(
    Object.freeze(view),
    owner,
    "query",
    (awaitingOwner) => {
      owner.assertReadable();

      return waitForCommitted(awaitingOwner, graph, store, recover);
    },
    (awaitingOwner) => {
      owner.assertReadable();

      awaitingOwner.asyncBoundary?.consumeQuery(awaitingOwner, graph, store, "value");
    },
  );
}

function waitForCommitted<T>(
  owner: Owner,
  graph: Graph,
  store: QueryStore<T>,
  recover: RecoverQuery,
): Promise<Accessor<T>> {
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

function startRefresh<T>(owner: Owner, store: QueryStore<T>): void {
  try {
    void store.revalidate().catch((error: unknown) => reportFault(owner, error));
  } catch (error) {
    reportFault(owner, error);
  }
}

export type { Accessor, QueryView } from "./types.ts";
