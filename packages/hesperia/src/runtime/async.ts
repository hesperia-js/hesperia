import { subscribe } from "aeolia";
import type { Graph, QueryStore } from "aeolia";
import {
  frameworkAwaitRegistration,
  markFrameworkQueryFresh,
  registerFrameworkAwaitable,
} from "../data/protocol.ts";
import {
  instantiateComponent,
  prepareComponent,
  type CallerProps,
  type Component,
} from "./components.ts";
import type { Rendered } from "./dom.ts";
import {
  Owner,
  registerOwnerResourceLifecycle,
  RenderFault,
  reportFault,
  runComponentBody,
  runCleanup,
  runRenderContext,
  isScheduledRender,
  ResetRenderSuspension,
  type AsyncBoundaryHost,
  type QueryReadKind,
} from "./owner.ts";

/** Authored waiting-boundary props. The compiler lowers both trees lazily with their owners. */
export interface AsyncBoundaryProps {
  /** Native loading view while any contained component is waiting. */
  readonly fallback: Rendered;
  /** Content tree whose asynchronous descendants share this waiting boundary. */
  readonly children?: Rendered;
}

/** Authoring marker for the compiler's explicit asynchronous waiting boundary. */
export function AsyncBoundary(_props: AsyncBoundaryProps): never {
  throw new RenderFault("compiler-required", "AsyncBoundary requires Hesperia compilation");
}

function append(parent: Node, value: Rendered, owner: Owner): void {
  if (value == null || typeof value === "boolean") return;

  if (Array.isArray(value)) {
    for (const child of value) append(parent, child, owner);
  } else if (typeof value === "string" || typeof value === "number") {
    const node = owner.context.document.createTextNode(String(value));

    owner.nodes.add(node);

    parent.appendChild(node);
  } else if (typeof value === "object" && "nodeType" in value) parent.appendChild(value as Node);
  else
    throw new RenderFault(
      "render-value",
      "A boundary view must return native nodes or primitive children",
    );
}

interface QuerySource {
  readonly graph: Graph;
  readonly identity: object;
  store: QueryStore<unknown>;
  freshVersion: number | undefined;
  freshFailure: unknown;
  freshFailed: boolean;
}

interface QueryLease {
  upgradeToValue(): void;

  stop(): void;
}

interface QueryLeaseRegistration {
  mode: QueryReadKind;
  lease: QueryLease | undefined;
}

interface AsyncBoundaryRecoveryRecord {
  dependsOn(graph: Graph): boolean;

  sourcesFor(graph: Graph): Set<QuerySource>;

  hasFreshSource(graph: Graph, source: QuerySource): boolean;
}

interface AsyncBoundaryRecoveryTarget {
  readonly version: number;
  readonly stores: Set<QuerySource>;
  readonly refreshOnActivation: Set<QuerySource>;
  readonly freshSources: Set<QuerySource>;
}

const asyncBoundaryRecoveryRecords = new WeakMap<Owner, AsyncBoundaryRecoveryRecord>();
const querySourcesByGraph = new WeakMap<Graph, WeakMap<object, QuerySource>>();
const activeQueryConsumers = new WeakMap<QuerySource, Set<Owner>>();
const activeQueryGates = new WeakMap<QuerySource, Set<Owner>>();

function holdQueryGate(source: QuerySource, owner: Owner): () => void {
  const gates = activeQueryGates.get(source) ?? new Set<Owner>();

  gates.add(owner);

  activeQueryGates.set(source, gates);

  return () => {
    gates.delete(owner);

    if (!gates.size) activeQueryGates.delete(source);
  };
}

function querySourceFor<T>(graph: Graph, store: QueryStore<T>): QuerySource {
  const identity = store.value as unknown as object;
  let graphSources = querySourcesByGraph.get(graph);

  if (!graphSources) {
    graphSources = new WeakMap();

    querySourcesByGraph.set(graph, graphSources);
  }

  let source = graphSources.get(identity);

  if (!source) {
    source = {
      graph,
      identity,
      store: store as QueryStore<unknown>,
      freshVersion: undefined,
      freshFailure: undefined,
      freshFailed: false,
    };

    graphSources.set(identity, source);
  } else {
    source.store = store as QueryStore<unknown>;
  }

  return source;
}

/**
 * Generated waiting boundary. The complete content tree remains detached and
 * uncommitted until its consumed query sources are ready for the current graph
 * reset versions and all async child renders settle.
 */
export function asyncBoundary(
  parent: Owner,
  slot: string,
  loading: (owner: Owner) => Rendered,
  content: (owner: Owner) => Rendered,
  onReady?: (ready: Promise<void>) => void,
): DocumentFragment {
  parent.assertActive();

  const inheritedBoundary = parent.asyncBoundary;
  const owner = new Owner(parent.context, parent, parent.identity + "/" + slot);
  owner.executingBody = false;
  const document = parent.context.document;
  const fragment = document.createDocumentFragment();
  const end = document.createComment("/async");
  const start = document.createComment("async");

  owner.nodes.add(start);

  owner.nodes.add(end);

  fragment.append(start, end);

  const waiting = new Map<object, { readonly owner: Owner; readonly generation: number }>();
  const sourceOwners = new Map<QuerySource, Set<Owner>>();
  const ownerSources = new WeakMap<Owner, Map<QuerySource, QueryLeaseRegistration>>();
  const resetSubscriptions = new Map<Graph, () => void>();
  const observedVersions = new Map<Graph, number>();
  const recoveryTargets = new Map<Graph, AsyncBoundaryRecoveryTarget>();
  const gateSubscriptions = new Map<QuerySource, () => void>();

  let generation = 0;
  let initialized = false;
  let failed = false;
  let installed = false;
  let loadingOwner: Owner | undefined;
  let contentOwner: Owner | undefined;
  let contentNodes = document.createDocumentFragment();
  let readySettled = false;
  let readyNotified = false;
  let recoveryGateGeneration = 0;
  let scheduledBuildGeneration: number | undefined;
  let resolveReady!: () => void;

  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  const ownerIsUnavailable = (): boolean => {
    const state = owner.state;
    return state === "suspended" || state === "cleaning" || state === "destroyed";
  };

  const settleReady = (): void => {
    if (readySettled || !initialized || waiting.size) return;

    readySettled = true;

    resolveReady();
  };

  const currentStoresForGraph = (graph: Graph): Set<QuerySource> => {
    const stores = new Set<QuerySource>();

    for (const [store, consumers] of sourceOwners) {
      if (store.graph !== graph) continue;

      for (const consumer of consumers) {
        if (consumer.state !== "cleaning" && consumer.state !== "destroyed") {
          stores.add(store);

          break;
        }
      }
    }

    return stores;
  };

  const dependsOnGraph = (graph: Graph): boolean =>
    recoveryTargets.has(graph) || currentStoresForGraph(graph).size > 0;

  const pruneResetSubscriptions = (): void => {
    for (const [graph, stop] of resetSubscriptions) {
      if (dependsOnGraph(graph)) continue;

      stop();

      resetSubscriptions.delete(graph);

      observedVersions.delete(graph);
    }
  };

  const attachQueryLease = (
    consumer: Owner,
    source: QuerySource,
    mode: QueryReadKind,
  ): QueryLease => {
    let stopped = false;
    let stopValue: (() => void) | undefined;
    let stopPending: (() => void) | undefined;
    let stopStatus: (() => void) | undefined;

    try {
      stopPending = subscribe(source.store.pending, () => undefined);
      stopStatus = subscribe(source.store.status, () => undefined);

      if (mode === "value") stopValue = subscribe(source.store.value, () => undefined);
    } catch (error) {
      stopValue?.();

      stopStatus?.();

      stopPending?.();

      throw error;
    }

    const active = activeQueryConsumers.get(source) ?? new Set<Owner>();

    active.add(consumer);

    activeQueryConsumers.set(source, active);

    return {
      upgradeToValue() {
        if (stopped || stopValue) return;

        stopValue = subscribe(source.store.value, () => undefined);
      },

      stop() {
        if (stopped) return;

        stopped = true;

        stopValue?.();

        stopPending?.();

        stopStatus?.();

        const remaining = activeQueryConsumers.get(source);

        remaining?.delete(consumer);

        if (remaining?.size === 0) activeQueryConsumers.delete(source);
      },
    };
  };

  const revalidateForActivation = (consumer: Owner, source: QuerySource): void => {
    const { store } = source;

    if (store.pending.get()) return;

    try {
      void store.revalidate().catch((error: unknown) => reportFault(consumer, error));
    } catch (error) {
      reportFault(consumer, error);
    }
  };

  const ensureResetObservation = (graph: Graph): void => {
    if (resetSubscriptions.has(graph)) return;

    const version = graph.resetVersion.get();

    observedVersions.set(graph, version);

    const stop = subscribe(graph.resetVersion, (nextVersion) => {
      const previousVersion = observedVersions.get(graph);

      observedVersions.set(graph, nextVersion);

      if (previousVersion === undefined || nextVersion === previousVersion) return;

      onGraphReset(graph, nextVersion);
    });

    resetSubscriptions.set(graph, stop);
  };

  const hasCurrentRecoverySource = (graph: Graph, source: QuerySource): boolean => {
    for (let current: Owner | null = owner; current; current = current.parent) {
      if (asyncBoundaryRecoveryRecords.get(current)?.hasFreshSource(graph, source)) return true;
    }

    return false;
  };

  const markFreshQueryForOwner = <T>(consumer: Owner, graph: Graph, query: QueryStore<T>): void => {
    const source = querySourceFor(graph, query);

    if (
      hasCurrentRecoverySource(graph, source) &&
      source.freshVersion === graph.resetVersion.get() &&
      source.store.status.get() === "ready" &&
      !source.store.pending.get()
    )
      markFrameworkQueryFresh(consumer, source.identity);
  };

  const consumeQuery = <T>(
    consumer: Owner,
    graph: Graph,
    query: QueryStore<T>,
    kind: QueryReadKind,
  ): void => {
    consumer.assertActive();

    const store = querySourceFor(graph, query);
    const used = ownerSources.get(consumer) ?? new Map<QuerySource, QueryLeaseRegistration>();
    const existing = used.get(store);

    if (existing) {
      if (kind === "value" && existing.mode !== "value") {
        existing.lease?.upgradeToValue();

        existing.mode = "value";
      }

      markFreshQueryForOwner(consumer, graph, query);

      return;
    }

    const registration: QueryLeaseRegistration = { mode: kind, lease: undefined };

    used.set(store, registration);

    ownerSources.set(consumer, used);

    const consumers = sourceOwners.get(store) ?? new Set<Owner>();

    consumers.add(consumer);

    sourceOwners.set(store, consumers);

    const attach = (): void => {
      if (registration.lease) return;

      registration.lease = attachQueryLease(consumer, store, registration.mode);
    };

    const detach = (): void => {
      const lease = registration.lease;
      registration.lease = undefined;

      lease?.stop();
    };

    try {
      if (consumer.state !== "suspended") attach();

      registerOwnerResourceLifecycle(consumer, {
        suspended: detach,

        resumed() {
          attach();

          if (store.store.status.get() === "empty" && !store.store.pending.get())
            revalidateForActivation(consumer, store);
        },
      });

      consumer.onRelease(() => {
        detach();

        used.delete(store);

        const remaining = sourceOwners.get(store);

        remaining?.delete(consumer);

        if (remaining?.size === 0) sourceOwners.delete(store);

        pruneResetSubscriptions();
      });

      ensureResetObservation(graph);

      markFreshQueryForOwner(consumer, graph, query);
    } catch (error) {
      detach();

      used.delete(store);

      consumers.delete(consumer);

      if (consumers.size === 0) sourceOwners.delete(store);

      pruneResetSubscriptions();

      throw error;
    }
  };

  const stopRecoveryGate = (): void => {
    recoveryGateGeneration++;
    const stops = [...gateSubscriptions.values()];

    gateSubscriptions.clear();

    for (const stop of stops) stop();
  };

  const currentRecoveryStores = (): Set<QuerySource> => {
    const stores = new Set<QuerySource>();

    for (const target of recoveryTargets.values()) {
      for (const store of target.stores) stores.add(store);
    }

    return stores;
  };

  const scheduleFreshContent = (expectedGeneration: number): void => {
    if (scheduledBuildGeneration === expectedGeneration) return;

    scheduledBuildGeneration = expectedGeneration;

    queueMicrotask(() => {
      if (scheduledBuildGeneration === expectedGeneration) scheduledBuildGeneration = undefined;

      if (expectedGeneration !== generation || ownerIsUnavailable()) return;

      try {
        buildContent(expectedGeneration);
      } catch (error) {
        if (expectedGeneration !== generation) return;

        failed = true;

        reportFault(owner, error);
      }
    });
  };

  const recoverySourceReady = (source: QuerySource): boolean => {
    const graph = source.graph;
    const target = recoveryTargets.get(graph);

    if (
      !target ||
      !target.stores.has(source) ||
      !target.freshSources.has(source) ||
      graph.resetVersion.get() !== target.version
    )
      return false;

    const status = source.store.status.get();
    const ready = !source.store.pending.get() && (status === "ready" || status === "failed");

    if (ready) {
      source.freshVersion = target.version;
      source.freshFailed = status === "failed";
      source.freshFailure = status === "failed" ? source.store.error.get() : undefined;
    }

    return ready;
  };

  const startRecoveryGate = (expectedGeneration: number, activation: boolean): void => {
    if (expectedGeneration !== generation || ownerIsUnavailable()) return;

    stopRecoveryGate();

    if (expectedGeneration !== generation || ownerIsUnavailable()) return;

    const gateGeneration = recoveryGateGeneration;
    const pending = currentRecoveryStores();

    if (!pending.size) {
      scheduleFreshContent(expectedGeneration);

      return;
    }

    const unresolved = new Set(pending);
    const activationRefreshPending = new Set<QuerySource>();
    const requestFailures = new Map<QuerySource, unknown>();
    let installingGate = true;

    const gateIsCurrent = (): boolean =>
      gateGeneration === recoveryGateGeneration &&
      expectedGeneration === generation &&
      owner.state !== "suspended" &&
      owner.state !== "cleaning" &&
      owner.state !== "destroyed";

    const markFreshRequestStarted = (source: QuerySource): void => {
      if (!gateIsCurrent()) return;

      const target = recoveryTargets.get(source.graph);

      if (target?.stores.has(source) && source.graph.resetVersion.get() === target.version)
        target.freshSources.add(source);
    };

    const needsActivationRefresh = (source: QuerySource): boolean => {
      const target = recoveryTargets.get(source.graph);
      return Boolean(activation && target?.refreshOnActivation.has(source));
    };

    const finishSource = (source: QuerySource): void => {
      if (!gateIsCurrent()) return;

      if (!unresolved.delete(source)) return;

      activationRefreshPending.delete(source);

      const target = recoveryTargets.get(source.graph);

      if (target?.stores.has(source) && source.graph.resetVersion.get() === target.version) {
        const failedRequest = requestFailures.get(source);
        const failedStatus = source.store.status.get() === "failed";

        if (requestFailures.has(source) || failedStatus) {
          source.freshVersion = target.version;
          source.freshFailed = true;
          source.freshFailure = requestFailures.has(source)
            ? failedRequest
            : source.store.error.get();
        }
      }

      if (!unresolved.size && gateGeneration === recoveryGateGeneration) {
        const failures = [...pending].flatMap((candidate) => {
          if (requestFailures.has(candidate)) return [requestFailures.get(candidate)];

          if (candidate.store.status.get() === "failed") return [candidate.store.error.get()];

          return [];
        });

        if (failures.length) {
          stopRecoveryGate();

          if (expectedGeneration !== generation || owner.state === "destroyed") return;

          failed = true;
          initialized = true;

          try {
            reportFault(
              owner,
              failures.length === 1
                ? failures[0]
                : new AggregateError(failures, "Fresh query recovery failed"),
            );
          } finally {
            if (expectedGeneration === generation) settleReady();
          }
        } else scheduleFreshContent(expectedGeneration);
      }
    };

    const checkSource = (source: QuerySource): void => {
      if (installingGate || !gateIsCurrent()) return;

      if (activationRefreshPending.has(source) && !source.store.pending.get()) return;

      const status = source.store.status.get();

      if (source.store.pending.get() || status === "fetching" || status === "revalidating")
        markFreshRequestStarted(source);

      if (recoverySourceReady(source)) finishSource(source);
    };

    const requestActivationRefresh = (source: QuerySource): void => {
      const graph = source.graph;
      const target = recoveryTargets.get(graph);

      if (!target || !target.refreshOnActivation.delete(source)) return;

      activationRefreshPending.add(source);

      queueMicrotask(() => {
        if (
          gateGeneration !== recoveryGateGeneration ||
          expectedGeneration !== generation ||
          owner.state === "suspended" ||
          owner.state === "cleaning" ||
          owner.state === "destroyed"
        )
          return;

        if (source.store.pending.get()) {
          activationRefreshPending.delete(source);

          checkSource(source);

          return;
        }

        let request: Promise<unknown>;

        try {
          request = Promise.resolve(source.store.revalidate());
        } catch (error) {
          if (!gateIsCurrent()) return;

          activationRefreshPending.delete(source);

          requestFailures.set(source, error);

          markFreshRequestStarted(source);

          finishSource(source);

          return;
        }

        void request.then(
          () => {
            if (gateGeneration !== recoveryGateGeneration) return;

            markFreshRequestStarted(source);

            activationRefreshPending.delete(source);

            checkSource(source);
          },
          (error: unknown) => {
            if (gateGeneration !== recoveryGateGeneration) return;

            markFreshRequestStarted(source);

            activationRefreshPending.delete(source);

            requestFailures.set(source, error);

            finishSource(source);
          },
        );
      });
    };

    try {
      for (const source of pending) {
        if (!gateIsCurrent()) return;

        const stops: Array<() => void> = [];
        let gateActive = true;
        const releaseGateOwner = holdQueryGate(source, owner);

        const stopGate = (): void => {
          if (!gateActive) return;

          gateActive = false;

          for (const stop of stops.splice(0)) stop();

          releaseGateOwner();
        };

        gateSubscriptions.set(source, stopGate);

        const remember = (stop: () => void): void => {
          if (gateActive) stops.push(stop);
          else stop();
        };

        remember(subscribe(source.store.value, () => checkSource(source)));

        if (!gateIsCurrent()) return;

        remember(subscribe(source.store.pending, () => checkSource(source)));

        if (!gateIsCurrent()) return;

        remember(subscribe(source.store.status, () => checkSource(source)));

        if (!gateIsCurrent()) return;
      }
    } catch (error) {
      const current = gateIsCurrent();

      if (current) stopRecoveryGate();

      if (!current || expectedGeneration !== generation || ownerIsUnavailable()) return;

      throw error;
    }

    installingGate = false;

    for (const source of pending) {
      if (!gateIsCurrent()) return;

      const status = source.store.status.get();
      const requestActive =
        source.store.pending.get() || status === "fetching" || status === "revalidating";

      if (requestActive) markFreshRequestStarted(source);

      const mustRefresh =
        needsActivationRefresh(source) && !requestActive && !recoverySourceReady(source);

      if (!mustRefresh && recoverySourceReady(source)) {
        finishSource(source);

        continue;
      }

      if (needsActivationRefresh(source) && source.store.pending.get()) {
        markFreshRequestStarted(source);

        recoveryTargets.get(source.graph)?.refreshOnActivation.delete(source);
      } else if (mustRefresh) {
        requestActivationRefresh(source);
      }

      checkSource(source);
    }
  };

  const showLoading = (): void => {
    if (
      loadingOwner ||
      owner.signal.aborted ||
      owner.state === "suspended" ||
      owner.state === "cleaning" ||
      owner.state === "destroyed"
    )
      return;

    const expectedGeneration = generation;

    if (installed) {
      let node = start.nextSibling;

      while (node && node !== end) {
        const next = node.nextSibling;

        contentNodes.appendChild(node);

        if (expectedGeneration !== generation) return;

        node = next;
      }

      installed = false;

      if (contentOwner) contentOwner.commitDeferred = true;
    }

    const nextLoadingOwner = new Owner(parent.context, owner, owner.identity + "/loading");
    loadingOwner = nextLoadingOwner;
    nextLoadingOwner.asyncBoundary = inheritedBoundary;

    const replaceStaleLoading = (): void => {
      if (loadingOwner === nextLoadingOwner) loadingOwner = undefined;

      if (nextLoadingOwner.state !== "destroyed") nextLoadingOwner.dispose();

      if (
        expectedGeneration === generation ||
        loadingOwner ||
        (!waiting.size && !recoveryTargets.size) ||
        owner.state === "suspended" ||
        owner.state === "cleaning" ||
        owner.state === "destroyed"
      )
        return;

      queueMicrotask(() => {
        if (
          expectedGeneration !== generation &&
          !loadingOwner &&
          (waiting.size > 0 || recoveryTargets.size > 0) &&
          owner.state !== "suspended" &&
          owner.state !== "cleaning" &&
          owner.state !== "destroyed"
        ) {
          const retryGeneration = generation;

          try {
            showLoading();
          } catch (error) {
            if (retryGeneration === generation) reportFault(owner, error);
          }
        }
      });
    };

    try {
      const view = runRenderContext(nextLoadingOwner, () =>
        runComponentBody(() => loading(nextLoadingOwner)),
      );

      if (expectedGeneration !== generation) {
        replaceStaleLoading();

        return;
      }

      nextLoadingOwner.executingBody = false;
      const loadingNodes = document.createDocumentFragment();

      append(loadingNodes, view, nextLoadingOwner);

      if (expectedGeneration !== generation) {
        replaceStaleLoading();

        return;
      }

      end.parentNode?.insertBefore(loadingNodes, end);

      if (expectedGeneration !== generation) {
        replaceStaleLoading();

        return;
      }

      if (owner.state === "mounted") {
        nextLoadingOwner.commit();

        if (expectedGeneration !== generation) {
          replaceStaleLoading();

          return;
        }

        owner.context.scheduler.requestEffects();
      }
    } catch (error) {
      const current = expectedGeneration === generation;

      if (loadingOwner === nextLoadingOwner) loadingOwner = undefined;

      if (nextLoadingOwner.state !== "destroyed")
        nextLoadingOwner.dispose(current ? error : undefined);

      if (current && expectedGeneration === generation) throw error;

      replaceStaleLoading();
    }
  };

  const activate = (expectedGeneration: number): void => {
    if (
      expectedGeneration !== generation ||
      !initialized ||
      installed ||
      failed ||
      waiting.size ||
      owner.state === "suspended" ||
      owner.state === "cleaning" ||
      owner.state === "destroyed" ||
      !contentOwner
    )
      return;

    const nextContentOwner = contentOwner;
    const nextContentNodes = contentNodes;
    const oldLoadingOwner = loadingOwner;
    loadingOwner = undefined;

    oldLoadingOwner?.dispose();

    if (
      expectedGeneration !== generation ||
      contentOwner !== nextContentOwner ||
      ownerIsUnavailable()
    )
      return;

    installed = true;

    end.parentNode?.insertBefore(nextContentNodes, end);

    if (
      expectedGeneration !== generation ||
      contentOwner !== nextContentOwner ||
      ownerIsUnavailable()
    )
      return;

    nextContentOwner.commitDeferred = false;

    if (owner.state === "mounted") {
      nextContentOwner.commit();

      if (
        expectedGeneration !== generation ||
        contentOwner !== nextContentOwner ||
        owner.state !== "mounted"
      )
        return;

      owner.context.scheduler.requestEffects();
    }

    if (
      expectedGeneration !== generation ||
      !installed ||
      contentOwner !== nextContentOwner ||
      ownerIsUnavailable()
    )
      return;

    const completedTargets = [...recoveryTargets.entries()];

    if (completedTargets.length) stopRecoveryGate();

    if (expectedGeneration !== generation) return;

    for (const [graph, target] of completedTargets) {
      if (recoveryTargets.get(graph) === target) recoveryTargets.delete(graph);
    }

    pruneResetSubscriptions();
  };

  const host: AsyncBoundaryHost = {
    owner,
    consumeQuery,

    assertQueryReadable(consumer, graph, query) {
      const source = querySourceFor(graph, query);
      const version = graph.resetVersion.get();
      const observed = observedVersions.get(graph);

      if (observed !== undefined && observed !== version) {
        observedVersions.set(graph, version);

        onGraphReset(graph, version);
      }

      const target = recoveryTargets.get(graph);

      if (
        !target ||
        target.version !== version ||
        !target.stores.has(source) ||
        recoverySourceReady(source)
      ) {
        if (target?.version === version && target.stores.has(source)) {
          if (source.freshVersion === version && source.freshFailed) throw source.freshFailure;

          if (source.store.status.get() === "failed") throw source.store.error.get();
        }

        return;
      }

      if (isScheduledRender(consumer)) throw new ResetRenderSuspension();

      throw new RenderFault(
        "query-reset-unavailable",
        "This query source is unavailable while its reset recovery is pending",
      );
    },

    capture(waitOwner, promise) {
      owner.assertActive();

      const token = {};
      const tokenGeneration = generation;

      waiting.set(token, { owner: waitOwner, generation: tokenGeneration });

      if (initialized) showLoading();

      const release = (): void => {
        const captured = waiting.get(token);

        if (!captured) return;

        waiting.delete(token);

        waitOwner.signal.removeEventListener("abort", cancelled);

        if (captured.generation !== generation) return;

        activate(captured.generation);

        settleReady();
      };

      const cancelled = (): void => release();

      waitOwner.signal.addEventListener("abort", cancelled, { once: true });

      void promise.then(
        () => release(),
        (error: unknown) => {
          const captured = waiting.get(token);

          if (
            captured?.generation === generation &&
            !waitOwner.signal.aborted &&
            owner.state !== "destroyed" &&
            owner.state !== "cleaning"
          ) {
            failed = true;

            try {
              reportFault(waitOwner, error);
            } finally {
              waitOwner.dispose(error);
            }
          }

          release();
        },
      );
    },
  };

  const snapshotSources = (graph: Graph): Set<QuerySource> => {
    const stores = new Set(currentStoresForGraph(graph));
    const previous = recoveryTargets.get(graph);

    for (const store of previous?.stores ?? []) stores.add(store);

    const addDescendants = (structuralOwner: Owner): void => {
      for (const child of structuralOwner.children) {
        const record = asyncBoundaryRecoveryRecords.get(child);

        if (record) {
          for (const store of record.sourcesFor(graph)) stores.add(store);
        } else addDescendants(child);
      }
    };

    addDescendants(owner);

    return stores;
  };

  const ancestorOwnsGraph = (graph: Graph): boolean => {
    for (let ancestor = owner.parent; ancestor; ancestor = ancestor.parent) {
      const record = asyncBoundaryRecoveryRecords.get(ancestor);

      if (record?.dependsOn(graph)) return true;
    }

    return false;
  };

  const onGraphReset = (graph: Graph, version: number): void => {
    if (owner.state === "cleaning" || owner.state === "destroyed" || ancestorOwnsGraph(graph))
      return;

    // Transfer the consumed source membership before abort cleanup releases its
    // owner leases. Graph.reset() has already taken its own active-query snapshot.
    const stores = snapshotSources(graph);

    if (!stores.size) return;

    const refreshOnActivation = new Set(recoveryTargets.get(graph)?.refreshOnActivation ?? []);

    for (const store of stores) {
      const activeOwner = (activeQueryConsumers.get(store)?.size ?? 0) > 0;
      const activeGate = (activeQueryGates.get(store)?.size ?? 0) > 0;

      if (activeOwner || activeGate) refreshOnActivation.delete(store);
      else refreshOnActivation.add(store);

      store.freshVersion = undefined;
      store.freshFailure = undefined;
      store.freshFailed = false;
    }

    // Invalidate every old release/activation callback before clearing waits or
    // disposing content, since Owner.abort releases captures synchronously.
    generation++;
    const resetGeneration = generation;

    recoveryTargets.set(graph, {
      version,
      stores,
      refreshOnActivation,
      freshSources: new Set(),
    });

    stopRecoveryGate();

    if (resetGeneration !== generation) return;

    waiting.clear();

    initialized = false;
    failed = false;

    if (installed) {
      let node = start.nextSibling;

      while (node && node !== end) {
        const next = node.nextSibling;

        contentNodes.appendChild(node);

        if (resetGeneration !== generation) return;

        node = next;
      }
    }

    installed = false;
    const oldContentOwner = contentOwner;
    contentOwner = undefined;
    contentNodes = document.createDocumentFragment();

    oldContentOwner?.dispose(new RenderFault("query-reset", "Query content was invalidated"));

    if (resetGeneration !== generation) return;

    if (owner.state === "suspended") return;

    try {
      showLoading();

      if (resetGeneration === generation) startRecoveryGate(resetGeneration, true);
    } catch (error) {
      if (resetGeneration !== generation) return;

      failed = true;

      reportFault(owner, error);
    }
  };

  const buildContent = (expectedGeneration: number): void => {
    if (
      expectedGeneration !== generation ||
      owner.state === "suspended" ||
      owner.state === "cleaning" ||
      owner.state === "destroyed"
    )
      return;

    const nextOwner = new Owner(parent.context, owner, owner.identity + "/content");

    const nextOwnerIsDestroyed = (): boolean => nextOwner.state === "destroyed";

    const nextNodes = document.createDocumentFragment();
    nextOwner.commitDeferred = true;
    contentOwner = nextOwner;
    contentNodes = nextNodes;
    initialized = false;
    failed = false;

    try {
      const result = runRenderContext(nextOwner, () => runComponentBody(() => content(nextOwner)));
      nextOwner.executingBody = false;

      if (expectedGeneration !== generation || nextOwnerIsDestroyed()) return;

      append(nextNodes, result, nextOwner);

      if (expectedGeneration !== generation || nextOwnerIsDestroyed()) return;

      if (waiting.size) showLoading();

      if (expectedGeneration !== generation || nextOwnerIsDestroyed()) return;

      initialized = true;

      if (!readyNotified) {
        readyNotified = true;

        onReady?.(ready);
      }

      if (expectedGeneration !== generation || nextOwnerIsDestroyed()) return;

      activate(expectedGeneration);

      if (expectedGeneration !== generation) return;

      settleReady();
    } catch (error) {
      if (nextOwner.state !== "destroyed") nextOwner.dispose(error);

      if (expectedGeneration !== generation) return;

      if (expectedGeneration === 0 && !readyNotified) throw error;

      failed = true;

      reportFault(owner, error);
    }
  };

  const boundaryRecord: AsyncBoundaryRecoveryRecord = {
    dependsOn(graph) {
      return dependsOnGraph(graph);
    },

    sourcesFor(graph) {
      return snapshotSources(graph);
    },

    hasFreshSource(graph, source) {
      const target = recoveryTargets.get(graph);
      return Boolean(
        target &&
        target.version === graph.resetVersion.get() &&
        target.stores.has(source) &&
        target.freshSources.has(source) &&
        source.freshVersion === target.version &&
        source.store.status.get() === "ready" &&
        !source.store.pending.get(),
      );
    },
  };

  asyncBoundaryRecoveryRecords.set(owner, boundaryRecord);

  owner.asyncBoundary = host;

  registerOwnerResourceLifecycle(owner, {
    suspended() {
      for (const target of recoveryTargets.values())
        for (const source of target.stores) target.refreshOnActivation.add(source);

      stopRecoveryGate();
    },

    resumed() {
      if (recoveryTargets.size) {
        try {
          showLoading();

          startRecoveryGate(generation, true);
        } catch (error) {
          failed = true;

          reportFault(owner, error);
        }
      } else {
        activate(generation);
      }
    },
  });

  owner.onRelease(() => {
    stopRecoveryGate();

    for (const stop of resetSubscriptions.values()) stop();

    resetSubscriptions.clear();

    observedVersions.clear();

    recoveryTargets.clear();

    asyncBoundaryRecoveryRecords.delete(owner);
  });

  try {
    buildContent(generation);

    settleReady();

    return fragment;
  } catch (error) {
    owner.dispose(error);

    throw error;
  }
}

/**
 * Drive a compiled async body as explicit synchronous continuation segments.
 * Registered queries, child renders, and compiler-generated module imports may
 * suspend component work. Module imports share their Promise independently of
 * the owner; each continuation retains this owner's lifecycle.
 */
export function runAsyncBody(
  owner: Owner,
  create: () => Generator<unknown, Rendered, unknown>,
): Promise<Rendered> {
  owner.assertActive();

  if (!owner.asyncBoundary)
    throw new RenderFault("async-boundary", "Async component work requires an enclosing boundary");

  const iterator = create();
  let finished = false;
  let closed = false;
  let deferredContinuation:
    | { readonly method: "next" | "throw"; readonly value: unknown }
    | undefined;
  let step: ((method: "next" | "throw", value: unknown) => void) | undefined;
  let rejectWait!: (reason: unknown) => void;

  const abort = () => {
    if (finished) return;

    finished = true;
    deferredContinuation = undefined;

    rejectWait(owner.signal.reason);
  };

  owner.signal.addEventListener("abort", abort, { once: true });

  owner.onCleanup(() => {
    deferredContinuation = undefined;

    if (!closed) {
      closed = true;

      runCleanup(() => {
        iterator.return(undefined);
      });
    }
  });

  registerOwnerResourceLifecycle(owner, {
    suspended() {},

    resumed() {
      const continuation = deferredContinuation;
      deferredContinuation = undefined;

      if (!continuation) return;

      if (!step) {
        deferredContinuation = continuation;
        return;
      }

      queueMicrotask(() => step?.(continuation.method, continuation.value));
    },
  });

  const result = new Promise<Rendered>((resolve, reject) => {
    rejectWait = reject;

    const runStep = (method: "next" | "throw", value: unknown) => {
      if (finished) return;

      if (owner.state === "suspended") {
        deferredContinuation = { method, value };
        return;
      }

      try {
        owner.assertActive();

        const next = runRenderContext(owner, () => runComponentBody(() => iterator[method](value)));

        if (next.done) {
          closed = true;
          finished = true;

          owner.signal.removeEventListener("abort", abort);

          resolve(next.value);

          return;
        }

        const registered = frameworkAwaitRegistration(next.value);

        if (
          !registered ||
          registered.kind === "task" ||
          (registered.kind === "render" && registered.owner !== owner)
        ) {
          throw new RenderFault(
            "render-await",
            "Component bodies may await only a registered query, child render, or module import",
          );
        }

        if (registered.kind !== "import") registered.onConsume?.(owner);

        const waiting =
          registered.kind === "query" && registered.waitForOwner
            ? registered.waitForOwner(owner)
            : next.value;

        Promise.resolve(waiting).then(
          (value) => runStep("next", value),
          (error: unknown) => runStep("throw", error),
        );
      } catch (error) {
        finished = true;

        owner.signal.removeEventListener("abort", abort);

        reject(error);
      }
    };

    step = runStep;

    runStep("next", undefined);
  });
  return result;
}

/** Await a child's render result while retaining attachment and lifetime until the parent installs it. */
export function awaitComponent<P>(
  parent: Owner,
  definition: Component<P>,
  props: CallerProps<P>,
  slot: string,
): Promise<Rendered> {
  parent.assertActive();

  if (!parent.executingBody)
    throw new RenderFault("render-await", "Child composition awaits belong in a component body");

  const child = new Owner(parent.context, parent, `${parent.identity}/${slot}`);

  try {
    const instance = instantiateComponent(child, prepareComponent(definition, props), true);
    const result = Promise.resolve(instance.output).then((output) => {
      parent.assertActive();

      child.assertActive();

      return output;
    });

    void result.catch(() => undefined);

    return registerFrameworkAwaitable(result, parent, "render");
  } catch (error) {
    child.dispose(error);

    throw error;
  }
}
