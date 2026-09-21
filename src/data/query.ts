import { subscribe } from "aeolia";
import type { QueryStore, StoreStatus } from "aeolia";
import { RenderFault, type Owner, reportFault } from "../runtime/owner.ts";
import { registerFrameworkAwaitable } from "./protocol.ts";
import type { Accessor, QueryView } from "./types.ts";

type RecoverQuery = () => void;

/** Adapt an Aeolia query store to Hesperia's owner-bound callable view. */
export function createQueryView<T>(
  owner: Owner,
  store: QueryStore<T>,
  recover: RecoverQuery,
): QueryView<T> {
  owner.assertActive();

  const read = <V>(run: () => V): V => {
    owner.assertReadable();
    return run();
  };
  const value: Accessor<T | undefined> = () => read(() => store.value.get());
  const pending: Accessor<boolean> = () => read(() => store.pending.get());
  const error: Accessor<unknown> = () => read(() => store.error.get());
  const status: Accessor<StoreStatus> = () => read(() => store.status.get());

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
      return waitForCommitted(owner, store, recover).then(onfulfilled, onrejected);
    },
  };
  return registerFrameworkAwaitable(Object.freeze(view), owner, "query", (awaitingOwner) =>
    waitForCommitted(awaitingOwner, store, recover),
  );
}

function waitForCommitted<T>(
  owner: Owner,
  store: QueryStore<T>,
  recover: RecoverQuery,
): Promise<Accessor<T>> {
  if (owner.state === "cleaning" || owner.state === "destroyed") {
    return Promise.reject(owner.signal.reason ?? new RenderFault("cancelled", "Owner disposed"));
  }

  let settled = false;
  let stopStatus: (() => void) | undefined;
  const finish = (complete: () => void): void => {
    if (settled) return;
    settled = true;
    stopStatus?.();
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
  let cachedValue!: T;
  const accessor: Accessor<T> = () => {
    owner.assertReadable();
    const currentStatus = store.status.get();
    const currentValue = store.value.get() as T;
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

  owner.signal.addEventListener("abort", abort, { once: true });
  try {
    const subscription = subscribe(store.status, observeStatus);
    if (settled) subscription();
    else stopStatus = subscription;

    if (!settled && initialStatus === "failed") {
      const failure = store.error.get();
      finish(() => rejectPromise({ status: "failed", error: failure }));
      try {
        recover();
      } catch (error) {
        reportFault(owner, error);
      }
    } else if (
      !settled &&
      (initialStatus === "ready" || initialStatus === "stale" || initialStatus === "revalidating")
    ) {
      cachedValue = store.value.get() as T;
      hasCachedValue = true;
      finish(() => resolvePromise(accessor));
      if (!initialPending) startRefresh(owner, store);
    } else if (!settled && initialStatus === "empty" && !initialPending) {
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
