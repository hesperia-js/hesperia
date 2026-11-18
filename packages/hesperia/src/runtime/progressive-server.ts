import { subscribe } from "aeolia";
import { deliverProgressivePublication } from "./progressive-source.ts";
import type { Graph, QueryStore } from "aeolia";
import type { Rendered } from "./dom.ts";
import type { AsyncBoundaryHost, Owner, QueryReadKind } from "./owner.ts";
import { RenderFault, reportFault } from "./owner.ts";
import type {
  ProgressiveByteAdmissionV1,
  ProgressiveByteReservationV1,
  ProgressiveEncodingResultV1,
  ResolvedProgressivePolicyV1,
  ProgressiveProducerV1,
} from "./progressive-source.ts";
import type { AsyncBoundaryHostRecordV1 } from "./async-boundary-record.ts";
import type { ServerErrorProjection } from "./server-error-contract.ts";

const nativePromiseThen = Promise.prototype.then;
const nativeReflectApply = Reflect.apply;

/** One response-scoped async boundary occurrence in the server render. */
export interface ServerProgressiveBoundaryDescriptor {
  readonly ownerId: string;
  readonly slot: string;
  readonly key: string;
}

/** Actual loading and content Owners behind one declared async range. */
export interface ServerProgressiveBoundaryHost {
  readonly boundary: ServerProgressiveBoundaryDescriptor;
  readonly loadingOwnerId: string;
  readonly contentOwnerId: string;
}

/** Actual host state selected by a successfully settled complete server render. */
export type ServerSettledAsyncBoundaryHost = AsyncBoundaryHostRecordV1;

/** A selected route error range is real response authority, not a waiting occurrence. */
export type ServerProgressiveErrorBoundaryState =
  | {
      readonly boundary: ServerProgressiveBoundaryDescriptor;
      readonly kind: "content";
      readonly contentOwnerId: string;
    }
  | {
      readonly boundary: ServerProgressiveBoundaryDescriptor;
      readonly kind: "error";
      readonly viewOwnerId: string;
    };

/** The actual fallback selected by one enclosing route error boundary. */
export interface ServerProgressiveErrorView {
  readonly boundary: ServerProgressiveBoundaryDescriptor;
  readonly viewOwnerId: string;
  readonly output: Rendered;
  readonly projectedFailure: ServerErrorProjection;
  readonly declaredBoundaries: readonly ServerProgressiveBoundaryDescriptor[];
  readonly asyncBoundaries?: readonly AsyncBoundaryHostRecordV1[];
}

export type ServerProgressiveErrorSelection =
  | { readonly kind: "selected"; readonly view: ServerProgressiveErrorView }
  | { readonly kind: "forward"; readonly reason: unknown }
  | { readonly kind: "already-selected" };

/** One actual route error owner and its framework-owned fallback selector. */
export interface ServerProgressiveErrorBoundaryRegistration {
  readonly descriptor: ServerProgressiveBoundaryDescriptor;
  state(): ServerProgressiveErrorBoundaryState;
  select(
    cause: ServerProgressiveBoundaryDescriptor | undefined,
    reason: unknown,
  ): ServerProgressiveErrorSelection;
}

/** A fulfilled, failed, or cancelled actual server boundary. */
export interface ServerProgressiveBoundaryEvent {
  readonly kind: "boundary-terminal";
  readonly version: 1;
  readonly responseIdentity: string;
  readonly boundary: ServerProgressiveBoundaryDescriptor;
  readonly outcome: "fulfilled" | "failed" | "cancelled" | "client-deferred";
  readonly declaredBoundaries: readonly ServerProgressiveBoundaryDescriptor[];
  readonly asyncBoundaries?: readonly AsyncBoundaryHostRecordV1[];
  readonly output?: Rendered;
  /** Original rejection value, present as an own field for every failed terminal (including undefined). */
  readonly failure?: unknown;
  readonly errorView?: ServerProgressiveErrorView;
}

/** Original async failures inspected after successful complete settlement. */
export interface ServerSettledBoundaryFailure {
  readonly boundary: ServerProgressiveBoundaryDescriptor;
  readonly failure: unknown;
  readonly handled: boolean;
  readonly rootUnhandled: boolean;
  readonly errorView?: ServerProgressiveErrorView;
}

/** Final counts for one finite progressive render. Tooling adds wire sequence and digest. */
export interface ServerProgressiveCompleteEvent {
  readonly kind: "complete";
  readonly version: 1;
  readonly responseIdentity: string;
  readonly registeredCount: number;
  readonly terminalCount: number;
  readonly fulfilledCount: number;
  readonly failedCount: number;
  readonly cancelledCount: number;
  readonly clientDeferredCount: number;
}

/** Semantic events emitted after the synchronous shell has been encoded. */
export type ServerProgressiveEvent =
  | ServerProgressiveBoundaryEvent
  | ServerProgressiveCompleteEvent;

/** The genuine native shell and its already-admitted root boundary inventory. */
export interface ServerProgressiveShell {
  readonly responseIdentity: string;
  readonly output: Rendered;
  readonly boundaries: readonly ServerProgressiveBoundaryDescriptor[];
  readonly boundaryHosts: readonly ServerProgressiveBoundaryHost[];
  readonly asyncBoundaries: readonly AsyncBoundaryHostRecordV1[];
  readonly errorBoundaries: readonly ServerProgressiveErrorBoundaryState[];
}

/** Per-boundary and queued byte budgets are supplied by the resolved producer plan. */
export interface ServerProgressiveBoundaryRegistration {
  readonly descriptor: ServerProgressiveBoundaryDescriptor;
  readonly host: AsyncBoundaryHost;
  readonly ready: Promise<void>;
  bindOwners(loadingOwner: Owner, contentOwner: Owner): void;
  selectLoading(output: Rendered): boolean;
  /** Resolve actual content; true means it won and the caller must retire the loading Owner. */
  complete(
    output: Rendered,
    reachableBoundaries: readonly ServerProgressiveBoundaryDescriptor[],
  ): boolean;
  fail(reason: unknown): ServerProgressiveErrorSelection;
}

export interface ServerProgressiveController {
  readonly producer?: ProgressiveProducerV1<ServerProgressiveEvent>;
  readonly settled: Promise<void>;
  boundaryLimit(): number;
  waitForShellSelection(boundaries: readonly ServerProgressiveBoundaryDescriptor[]): Promise<void>;
  registeredBoundaries(): readonly ServerProgressiveBoundaryDescriptor[];
  registeredBoundaryHosts(): readonly ServerProgressiveBoundaryHost[];
  asyncBoundaryHostRecords(): readonly AsyncBoundaryHostRecordV1[];
  settledAsyncBoundaryHosts(): readonly ServerSettledAsyncBoundaryHost[];
  settledBoundaryFailures(): readonly ServerSettledBoundaryFailure[];
  registerBoundary(
    owner: Owner,
    slot: string,
    key: string,
    replaceCompleteOutput?: (output: Rendered) => void,
  ): ServerProgressiveBoundaryRegistration;
  registerErrorBoundary(
    owner: Owner,
    slot: string,
    key: string,
    registration: ServerProgressiveErrorBoundaryRegistration,
  ): void;
  runSelectedErrorFallback<T>(
    boundaryOwner: Owner,
    cause: ServerProgressiveBoundaryDescriptor | undefined,
    viewOwner: Owner,
    render: () => T,
  ): T;
  registeredErrorBoundaries(): readonly ServerProgressiveErrorBoundaryRegistration[];
  selectErrorView(
    owner: Owner,
    cause: ServerProgressiveBoundaryDescriptor | undefined,
    reason: unknown,
  ): {
    readonly view?: ServerProgressiveErrorView;
    readonly forwarded: boolean;
    readonly rootUnhandled: boolean;
    readonly reason?: unknown;
    readonly attempted: boolean;
  };
  setRootOutput(output: Rendered | Promise<Rendered>): void;
  sealShell(
    asyncBoundaries: readonly AsyncBoundaryHostRecordV1[],
    errorBoundaries: readonly ServerProgressiveErrorBoundaryState[],
  ): ServerProgressiveShell;
  settleBoundaries(
    visibleBoundaries: () => readonly ServerProgressiveBoundaryDescriptor[],
  ): Promise<void>;
  retainOriginal(owner: Owner, promise: unknown): void;
  cancel(reason?: unknown): void;
}

interface BoundaryRecord {
  readonly owner: Owner;
  readonly descriptor: ServerProgressiveBoundaryDescriptor;
  readonly parent: BoundaryRecord | undefined;
  readonly children: Set<BoundaryRecord>;
  readonly host: AsyncBoundaryHost;
  pending: number;
  pendingHostSelections: number;
  failureWorkRevoked: boolean;
  loadingRevoked: boolean;
  exposed: boolean;
  readyOrder: number | undefined;
  output: Rendered | undefined;
  outputSet: boolean;
  failure: unknown;
  hasFailure: boolean;
  handledFailure: boolean;
  rootUnhandled: boolean;
  cancelled: boolean;
  rendered: boolean;
  readonly replaceCompleteOutput: ((output: Rendered) => void) | undefined;
  loadingOwner: Owner | undefined;
  contentOwner: Owner | undefined;
  selected: "loading" | "content" | undefined;
  readonly lateFailures: { readonly reason: unknown }[];
  readonly ready: Promise<void>;
  readonly resolveReady: () => void;
  readonly rejectReady: (reason: unknown) => void;
  readonly pendingPromises: Map<unknown, PendingOriginalRecord>;
  readonly queryVersions: Map<Graph, number>;
  readonly queryFailures: Map<Graph, unknown>;
  readonly queryStops: Map<Graph, () => void>;
  readonly queryLeases: Map<
    Owner,
    Map<QueryStore<unknown, unknown>, { mode: QueryReadKind; stops: (() => void)[]; stop(): void }>
  >;
  reachableBoundaries: readonly ServerProgressiveBoundaryDescriptor[];
  errorView: ServerProgressiveErrorView | undefined;
  admitted: boolean;
  declaredBy: BoundaryRecord | undefined;
  declared: boolean;
  publicationRevoked: boolean;
  published: boolean;
  publishedOutcome: ServerProgressiveBoundaryEvent["outcome"] | undefined;
  readonly shellReady: Promise<void>;
  readonly resolveShellReady: () => void;
  readonly rejectShellReady: (reason: unknown) => void;
  shellSelectionSettled: boolean;
  readonly semanticReady: Promise<void>;
  resolveSemanticReady: () => void;
}

interface PendingOriginalRecord {
  failureSensitive: boolean;
  failureRevoked: boolean;
  lane: "loading" | "content";
  workOwner: Owner;
  wireRelevant: boolean;
  contentCounted: boolean;
}

const controllersByContext = new WeakMap<object, ServerProgressiveController>();
const progressiveShells = new WeakMap<
  object,
  { readonly controller: ServerProgressiveController; readonly responseIdentity: string }
>();
const progressiveBoundaryEvents = new WeakMap<
  object,
  {
    readonly controller: ServerProgressiveController;
    readonly record: BoundaryRecord;
    readonly responseIdentity: string;
  }
>();

function validLimit(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0;
}

function assertSynchronousRootOutput(
  output: Rendered | Promise<Rendered>,
): asserts output is Rendered {
  if (output && typeof output === "object" && "then" in output)
    throw new RenderFault(
      "server-progressive-shell",
      "Progressive server composition requires a synchronous shell",
    );
}

const resolvedPolicyKeys = Object.freeze([
  "version",
  "identity",
  "revision",
  "maxBoundaryCount",
  "maxBoundaryBytes",
  "maxQueuedBytes",
  "maxQueuedEvents",
  "maxFrameBytes",
  "maxRegionNodes",
  "maxRegionTextBytes",
]);

function matchesResolvedPolicy(
  actual: ResolvedProgressivePolicyV1,
  expected: ResolvedProgressivePolicyV1,
): boolean {
  if (typeof actual !== "object" || actual === null) return false;
  const keys = Reflect.ownKeys(actual);

  if (
    keys.length !== resolvedPolicyKeys.length ||
    keys.some((key) => typeof key !== "string" || !resolvedPolicyKeys.includes(key))
  )
    return false;

  for (const key of resolvedPolicyKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(actual, key);

    if (
      !descriptor ||
      !("value" in descriptor) ||
      descriptor.value !== expected[key as keyof ResolvedProgressivePolicyV1]
    )
      return false;
  }

  return true;
}

/** @internal Install one producer on the actual server session context. */
export function createServerProgressiveController(
  root: Owner,
  identity: string,
  maxBoundaryCount: number | undefined,
  progressivePolicy: ResolvedProgressivePolicyV1 | undefined,
): ServerProgressiveController {
  const progressiveEnabled = progressivePolicy !== undefined;
  if (maxBoundaryCount !== undefined && !validLimit(maxBoundaryCount))
    throw new RenderFault(
      "server-progressive-limit",
      "A boundary limit must be a positive safe integer",
    );
  if (progressivePolicy && maxBoundaryCount !== progressivePolicy.maxBoundaryCount)
    throw new RenderFault(
      "server-progressive-policy",
      "The boundary count must match the captured progressive policy",
    );
  const context = root.context as object;
  if (controllersByContext.has(context))
    throw new RenderFault(
      "server-progressive",
      "A server context already owns a progressive producer",
    );

  const boundaries = new Map<string, BoundaryRecord>();
  const errorBoundaries = new Map<string, ServerProgressiveErrorBoundaryRegistration>();
  const activeErrorSelections: {
    readonly boundaryOwner: Owner;
    readonly cause: ServerProgressiveBoundaryDescriptor | undefined;
    readonly causeRecord: BoundaryRecord | undefined;
    fallbackOwner: Owner | undefined;
  }[] = [];
  let rootOutput: Rendered | undefined;
  let rootOutputSet = false;
  let shellSealed = false;
  let cancelled = false;
  let cancelReason: unknown;
  let originalWorkCount = 0;
  let wireWorkCount = 0;
  const wireWorkWaiters: (() => void)[] = [];
  let readySequence = 0;
  let admission: ProgressiveByteAdmissionV1 | undefined;
  let encode: ((event: ServerProgressiveEvent) => ProgressiveEncodingResultV1) | undefined;
  let publicationFailed = false;
  let publicationFailureReason: unknown;
  let completePublished = false;
  let completeSettlementDone = false;
  let pumpRunning = false;
  let pumpRequested = false;
  let bufferedCompleteRequested = false;
  let resolveSettled!: () => void;
  let rejectSettled!: (reason: unknown) => void;
  let settledState: "pending" | "resolved" | "rejected" = "pending";

  const settled = new Promise<void>((resolve, reject) => {
    resolveSettled = resolve;
    rejectSettled = reject;
  });
  void settled.catch(() => undefined);

  const findParentBoundary = (owner: Owner): BoundaryRecord | undefined => {
    const enclosingOwner = owner.asyncBoundary?.owner;
    const enclosing = enclosingOwner ? boundaries.get(enclosingOwner.identity) : undefined;

    if (enclosing && enclosing.owner.context === owner.context) return enclosing;

    for (let current = owner.parent; current; current = current.parent) {
      const record = boundaries.get(current.identity);
      if (record) return record;
    }

    return undefined;
  };

  const ownerDescendsFrom = (owner: Owner, ancestor: Owner): boolean => {
    for (let current: Owner | null = owner; current; current = current.parent)
      if (current === ancestor) return true;

    return false;
  };

  const ownerForIdentity = (identity: string): Owner | undefined => {
    const pending = [root];

    while (pending.length) {
      const current = pending.pop()!;

      if (current.identity === identity) return current;

      pending.push(...current.children);
    }

    return undefined;
  };

  const selectedFallbackFor = (owner: Owner) => {
    const selection = activeErrorSelections.at(-1);

    return selection?.fallbackOwner && ownerDescendsFrom(owner, selection.fallbackOwner)
      ? selection
      : undefined;
  };

  const hasActiveBoundaryWork = (record: BoundaryRecord | undefined): boolean =>
    Boolean(
      record &&
      (record.pending > 0 ||
        [...record.pendingPromises.values()].some((pending) => pending.wireRelevant)),
    );

  const maybeResolveSettled = (): void => {
    if (!(shellSealed || cancelled) || originalWorkCount !== 0 || pumpRunning) return;
    if (settledState !== "pending") return;

    if (
      !progressiveEnabled ||
      bufferedCompleteRequested ||
      cancelled ||
      publicationFailed ||
      completePublished
    ) {
      settledState = "resolved";
      resolveSettled();
    }
  };

  const maybeSettleOriginalWork = (): void => {
    if (shellSealed || cancelled) {
      flushReady();
      maybeResolveSettled();
    }
  };

  const settleShellReady = (record: BoundaryRecord, failure?: unknown, rejected = false): void => {
    if (record.shellSelectionSettled) return;
    record.shellSelectionSettled = true;

    if (rejected) record.rejectShellReady(failure);
    else record.resolveShellReady();
  };

  const notifyWireWork = (): void => {
    if (wireWorkCount !== 0) return;

    while (wireWorkWaiters.length) wireWorkWaiters.shift()!();
  };

  const waitForWireWork = (): Promise<void> =>
    wireWorkCount === 0
      ? Promise.resolve()
      : new Promise((resolve) => wireWorkWaiters.push(resolve));

  const revokeLoadingWork = (record: BoundaryRecord): void => {
    if (record.loadingRevoked) return;
    record.loadingRevoked = true;

    for (const pending of record.pendingPromises.values()) {
      if (pending.lane !== "loading" || pending.contentCounted || !pending.wireRelevant) continue;

      pending.wireRelevant = false;
      wireWorkCount--;
    }

    notifyWireWork();
    maybeSettleOriginalWork();
  };

  const revokeBoundaryWork = (record: BoundaryRecord): void => {
    for (const pending of record.pendingPromises.values()) {
      if (!pending.wireRelevant) continue;

      pending.wireRelevant = false;
      wireWorkCount--;
    }

    notifyWireWork();
    maybeSettleOriginalWork();
  };

  const revokeUnexposedDescendants = (record: BoundaryRecord): void => {
    for (const child of record.children) {
      if (child.exposed || child.admitted || child.declared) continue;

      child.publicationRevoked = true;
      child.cancelled = true;
      child.rendered = true;
      revokeBoundaryWork(child);
      recordReady(child);
      revokeUnexposedDescendants(child);
    }
  };

  const revokeLoadingDescendants = (record: BoundaryRecord): void => {
    const loadingOwner = record.loadingOwner;

    if (!loadingOwner) return;

    const visit = (parent: BoundaryRecord): void => {
      for (const child of parent.children) {
        if (!ownerDescendsFrom(child.owner, loadingOwner)) continue;

        if (!child.admitted && !child.exposed && !child.declared) child.publicationRevoked = true;
        child.cancelled = true;
        child.rendered = true;
        revokeBoundaryWork(child);
        recordReady(child);
        visit(child);
      }
    };

    visit(record);
  };

  const revokeFailedBoundaryWork = (record: BoundaryRecord): void => {
    if (record.failureWorkRevoked) return;

    revokeLoadingWork(record);
    record.failureWorkRevoked = true;

    for (const pending of record.pendingPromises.values()) {
      pending.failureRevoked = true;

      if (pending.contentCounted) {
        pending.contentCounted = false;
        record.pending--;
      }

      if (pending.wireRelevant) {
        pending.wireRelevant = false;
        wireWorkCount--;
      }
    }

    const losingOwners = [record.contentOwner, record.loadingOwner].filter(
      (owner): owner is Owner => Boolean(owner),
    );
    const fallbackOwner = record.errorView && ownerForIdentity(record.errorView.viewOwnerId);
    const revokeChildren = (parent: BoundaryRecord): void => {
      for (const child of parent.children) {
        if (fallbackOwner && ownerDescendsFrom(child.owner, fallbackOwner)) continue;
        if (!losingOwners.some((owner) => ownerDescendsFrom(child.owner, owner))) continue;

        if (!child.admitted && !child.exposed && !child.declared) child.publicationRevoked = true;
        if (!child.hasFailure) {
          child.cancelled = true;
          child.rendered = true;
          settleShellReady(
            child,
            new RenderFault("cancelled", "The failed boundary removed this output"),
            true,
          );
          revokeBoundaryWork(child);
          recordReady(child);
        }

        revokeChildren(child);
      }
    };

    revokeChildren(record);
    notifyWireWork();
    recordReady(record);
    maybeSettleOriginalWork();
  };

  const recordReady = (record: BoundaryRecord): void => {
    if (
      !record.rendered ||
      record.readyOrder !== undefined ||
      record.pendingHostSelections !== 0 ||
      (record.pending !== 0 && !record.cancelled)
    )
      return;

    record.readyOrder = readySequence++;
    record.resolveSemanticReady();
    if (record.hasFailure) record.rejectReady(record.failure);
    else if (record.cancelled)
      record.rejectReady(new RenderFault("cancelled", "Server boundary was cancelled"));
    else record.resolveReady();

    flushReady();
    maybeSettleOriginalWork();
  };

  const asyncBoundaryRecordsFor = (
    descriptors: readonly ServerProgressiveBoundaryDescriptor[],
  ): readonly AsyncBoundaryHostRecordV1[] =>
    Object.freeze(
      descriptors.map((descriptor) => {
        const boundary = boundaries.get(descriptor.ownerId);
        const parentOwner = boundary?.owner.parent;

        if (
          !boundary ||
          boundary.descriptor !== descriptor ||
          !parentOwner ||
          !boundary.loadingOwner ||
          !boundary.contentOwner ||
          !boundary.selected ||
          !boundary.shellSelectionSettled
        )
          throw new RenderFault(
            "server-progressive-boundary",
            "A delivered output has an unselected async host",
          );

        return Object.freeze({
          boundary: descriptor,
          parentOwnerId: parentOwner.identity,
          loadingOwnerId: boundary.loadingOwner.identity,
          contentOwnerId: boundary.contentOwner.identity,
          selected: boundary.selected,
        });
      }),
    );

  const pendingDescriptors = (
    asyncBoundaries: readonly AsyncBoundaryHostRecordV1[],
  ): readonly ServerProgressiveBoundaryDescriptor[] =>
    Object.freeze(
      asyncBoundaries.flatMap((host) => {
        const child = boundaries.get(host.boundary.ownerId);

        return host.selected === "loading" &&
          child &&
          !child.exposed &&
          !child.declared &&
          !child.publicationRevoked
          ? [host.boundary]
          : [];
      }),
    );

  const makeEvent = (record: BoundaryRecord): ServerProgressiveBoundaryEvent => {
    const outcome = record.hasFailure ? "failed" : record.cancelled ? "cancelled" : "fulfilled";
    const asyncBoundaries =
      outcome === "fulfilled" && record.outputSet
        ? asyncBoundaryRecordsFor(record.reachableBoundaries)
        : undefined;
    const errorView =
      outcome === "failed" && record.errorView
        ? (() => {
            const visible = asyncBoundaryRecordsFor(record.errorView!.declaredBoundaries);

            return Object.freeze({
              ...record.errorView,
              declaredBoundaries: pendingDescriptors(visible),
              asyncBoundaries: visible,
            });
          })()
        : undefined;
    const declaredBoundaries = Object.freeze(
      asyncBoundaries ? pendingDescriptors(asyncBoundaries) : [],
    );

    const event: ServerProgressiveBoundaryEvent = Object.freeze({
      kind: "boundary-terminal",
      version: 1,
      responseIdentity: identity,
      boundary: record.descriptor,
      outcome,
      declaredBoundaries,
      ...(asyncBoundaries ? { asyncBoundaries } : {}),
      ...(outcome === "fulfilled" && record.outputSet ? { output: record.output } : {}),
      ...(outcome === "failed" ? { failure: record.failure } : {}),
      ...(errorView ? { errorView } : {}),
    });

    progressiveBoundaryEvents.set(event, { controller, record, responseIdentity: identity });

    return event;
  };

  const selectErrorView = (
    source: Owner,
    cause: ServerProgressiveBoundaryDescriptor | undefined,
    reason: unknown,
  ): {
    readonly view?: ServerProgressiveErrorView;
    readonly forwarded: boolean;
    readonly rootUnhandled: boolean;
    readonly reason?: unknown;
    readonly attempted: boolean;
  } => {
    let failure = reason;
    let attempted = false;

    for (let current: Owner | null = source; current; current = current.parent) {
      const boundary = errorBoundaries.get(current.identity);

      if (!boundary) continue;
      attempted = true;
      const activeSelection = {
        boundaryOwner: current,
        cause,
        causeRecord: cause ? boundaries.get(cause.ownerId) : undefined,
        fallbackOwner: undefined,
      };
      activeErrorSelections.push(activeSelection);
      let outcome:
        | { readonly kind: "selected"; readonly selection: ServerProgressiveErrorSelection }
        | { readonly kind: "threw"; readonly reason: unknown };

      try {
        outcome = { kind: "selected", selection: boundary.select(cause, failure) };
      } catch (reason: unknown) {
        outcome = { kind: "threw", reason };
      }

      const scopeCorrupted = activeErrorSelections.pop() !== activeSelection;

      if (scopeCorrupted) {
        const cleanupFailure = new RenderFault(
          "server-progressive-error",
          "The selected error fallback scope was corrupted",
        );

        if (outcome.kind === "threw")
          throw new AggregateError(
            [outcome.reason, cleanupFailure],
            "Server error selection and scope cleanup failed",
            { cause: outcome.reason },
          );

        throw cleanupFailure;
      }

      if (outcome.kind === "threw") throw outcome.reason;

      const selection = outcome.selection;

      if (selection.kind === "selected")
        return { view: selection.view, forwarded: false, rootUnhandled: false, attempted: true };
      if (selection.kind === "already-selected") continue;

      failure = selection.reason;
    }

    let report: ReturnType<typeof reportFault>;
    try {
      report = reportFault(source, failure);
    } catch (forwarded) {
      return { forwarded: true, rootUnhandled: true, reason: forwarded, attempted };
    }

    return {
      forwarded: report.kind === "root",
      rootUnhandled: report.kind === "root",
      reason: report.failure,
      attempted,
    };
  };

  const failPublication = (reason: unknown): void => {
    if (publicationFailed) return;

    publicationFailed = true;
    publicationFailureReason = reason;
    admission?.fail(reason);
    maybeResolveSettled();
  };

  function trackOriginal(
    record: BoundaryRecord,
    workOwner: Owner,
    promise: unknown,
    failureSensitive: boolean,
  ): void {
    workOwner.assertActive();
    const lane =
      record.loadingOwner && ownerDescendsFrom(workOwner, record.loadingOwner)
        ? "loading"
        : "content";
    const existing = record.pendingPromises.get(promise);

    if (existing) {
      existing.failureSensitive ||= failureSensitive;
      existing.failureRevoked ||= record.failureWorkRevoked;

      if (lane === "content" && existing.lane === "loading") {
        existing.lane = "content";
        existing.workOwner = workOwner;

        if (!record.failureWorkRevoked && !existing.contentCounted) {
          existing.contentCounted = true;
          record.pending++;
        }

        if (!record.failureWorkRevoked && !existing.wireRelevant) {
          existing.wireRelevant = true;
          wireWorkCount++;
        }
      }

      return;
    }

    const pending: PendingOriginalRecord = {
      failureSensitive,
      failureRevoked: record.failureWorkRevoked,
      lane,
      workOwner,
      wireRelevant: !record.failureWorkRevoked && (lane === "content" || !record.loadingRevoked),
      contentCounted: !record.failureWorkRevoked && lane === "content",
    };

    record.pendingPromises.set(promise, pending);
    originalWorkCount++;
    if (pending.contentCounted) record.pending++;
    if (pending.wireRelevant) wireWorkCount++;

    let observed = false;
    const settle = (
      result:
        | { readonly fulfilled: true }
        | { readonly fulfilled: false; readonly reason: unknown },
    ): void => {
      if (observed) return;

      observed = true;
      record.pendingPromises.delete(promise);
      originalWorkCount--;

      if (pending.contentCounted) record.pending--;
      if (pending.wireRelevant) {
        wireWorkCount--;
        notifyWireWork();
      }

      if (
        !result.fulfilled &&
        (record.cancelled ||
          pending.failureRevoked ||
          (pending.lane === "loading" && record.loadingRevoked))
      ) {
        record.lateFailures.push({ reason: result.reason });
      } else if (!result.fulfilled && pending.failureSensitive && !record.hasFailure) {
        record.hasFailure = true;
        record.failure = result.reason;
        if (!record.published && !record.publicationRevoked) {
          const selection = selectErrorView(pending.workOwner, record.descriptor, result.reason);

          if (selection.view) record.errorView = selection.view;
          else if (selection.rootUnhandled) {
            record.rootUnhandled = true;
            failPublication(selection.reason);
          } else record.handledFailure = true;

          if (record.selected === undefined) {
            if (selection.view || record.handledFailure) settleShellReady(record);
            else settleShellReady(record, selection.reason ?? result.reason, true);
          }

          revokeFailedBoundaryWork(record);
        }
      }

      recordReady(record);
      maybeSettleOriginalWork();
    };

    try {
      nativeReflectApply(nativePromiseThen, promise, [
        () => settle({ fulfilled: true }),
        (reason: unknown) => settle({ fulfilled: false, reason }),
      ]);
    } catch (error) {
      const unacknowledged = new Error("Server original-work observation is unacknowledged", {
        cause: error,
      });
      unacknowledged.name = "ServerOriginalWorkUnacknowledgedError";
      record.rejectReady(unacknowledged);
      settleShellReady(record, unacknowledged, true);

      if (settledState === "pending") {
        settledState = "rejected";
        rejectSettled(unacknowledged);
      }

      failPublication(unacknowledged);
    }
  }

  const nextReadyBoundary = (): BoundaryRecord | undefined =>
    [...boundaries.values()]
      .filter(
        (record) =>
          record.admitted &&
          record.readyOrder !== undefined &&
          !record.published &&
          (!record.declaredBy || record.declaredBy.published),
      )
      .sort((left, right) => left.readyOrder! - right.readyOrder!)[0];

  const admitChildren = (
    record: BoundaryRecord,
    descriptors: readonly ServerProgressiveBoundaryDescriptor[],
  ): void => {
    const seen = new Set<string>();
    const children = descriptors.map((descriptor) => {
      const child = boundaries.get(descriptor.ownerId);

      if (
        !child ||
        child.descriptor !== descriptor ||
        child.declared ||
        child.publicationRevoked ||
        seen.has(descriptor.ownerId)
      )
        throw new RenderFault(
          "server-progressive-admission",
          "A terminal declared an unknown or already admitted boundary",
        );

      seen.add(descriptor.ownerId);

      return child;
    });

    for (const child of children) {
      child.admitted = true;
      child.declared = true;
      child.declaredBy = record;
    }
  };

  const admitTerminal = (record: BoundaryRecord, event: ServerProgressiveBoundaryEvent): void => {
    if (event.outcome === "fulfilled") admitChildren(record, event.declaredBoundaries);
    if (event.errorView) admitChildren(record, event.errorView.declaredBoundaries);

    const exposedHosts =
      event.outcome === "fulfilled" ? event.asyncBoundaries : event.errorView?.asyncBoundaries;

    if (event.outcome === "fulfilled" && !exposedHosts)
      throw new RenderFault(
        "server-progressive-admission",
        "A fulfilled terminal has no selected host inventory",
      );

    for (const host of exposedHosts ?? []) {
      const child = boundaries.get(host.boundary.ownerId);
      const parentOwner = child?.owner.parent;

      if (
        !child ||
        child.descriptor !== host.boundary ||
        !parentOwner ||
        host.parentOwnerId !== parentOwner.identity ||
        host.loadingOwnerId !== child.loadingOwner?.identity ||
        host.contentOwnerId !== child.contentOwner?.identity ||
        host.selected !== child.selected ||
        !child.shellSelectionSettled
      )
        throw new RenderFault(
          "server-progressive-admission",
          "A delivered region has foreign async host state",
        );

      child.exposed = true;

      if (host.selected === "content") {
        if (!child.outputSet)
          throw new RenderFault(
            "server-progressive-admission",
            "A content-selected nested host has no actual output",
          );

        child.selected = "content";
        revokeLoadingWork(child);
      } else if (
        host.selected === "loading" &&
        !event.declaredBoundaries.includes(host.boundary) &&
        !event.errorView?.declaredBoundaries.includes(host.boundary)
      )
        throw new RenderFault(
          "server-progressive-admission",
          "A pending nested host has no terminal declaration",
        );
    }

    record.published = true;
    record.publishedOutcome = event.outcome;
    record.output = undefined;

    if (event.outcome === "fulfilled") record.selected = "content";

    const revokeSubtree = (hidden: BoundaryRecord): void => {
      if (hidden.declared || hidden.admitted || hidden.exposed) return;

      hidden.publicationRevoked = true;
      for (const child of hidden.children) revokeSubtree(child);
    };

    for (const child of record.children) revokeSubtree(child);
  };

  const makeCompleteEvent = (): ServerProgressiveCompleteEvent => {
    const admitted = [...boundaries.values()].filter((record) => record.admitted);
    const count = (outcome: ServerProgressiveBoundaryEvent["outcome"]): number =>
      admitted.filter((record) => record.published && record.publishedOutcome === outcome).length;

    return Object.freeze({
      kind: "complete",
      version: 1,
      responseIdentity: identity,
      registeredCount: admitted.length,
      terminalCount: admitted.filter((record) => record.published).length,
      fulfilledCount: count("fulfilled"),
      failedCount: count("failed"),
      cancelledCount: count("cancelled"),
      clientDeferredCount: 0,
    });
  };

  async function pumpReady(): Promise<void> {
    if (
      !shellSealed ||
      cancelled ||
      publicationFailed ||
      bufferedCompleteRequested ||
      !encode ||
      !admission
    )
      return;

    const eventEncoder = encode;
    const byteAdmission = admission;

    const publishEncoded = (
      event: ServerProgressiveEvent,
      reservation: ProgressiveByteReservationV1,
    ): boolean => {
      const encoded = eventEncoder(event);
      if (!encoded || typeof encoded !== "object")
        throw new RenderFault(
          "server-progressive-encoding",
          "The Hosting encoder returned no frame result",
        );

      const transaction = encoded.transaction;
      let commitmentStarted = false;
      let discarded = false;
      const discardPending = (): void => {
        if (commitmentStarted || discarded || !transaction) return;
        discarded = true;
        transaction.discard();
      };

      try {
        if (
          transaction !== undefined &&
          (transaction === null ||
            typeof transaction !== "object" ||
            typeof transaction.commit !== "function" ||
            typeof transaction.discard !== "function")
        )
          throw new RenderFault(
            "server-progressive-encoding",
            "The frame has no actual capture transaction",
          );
        if (event.kind === "boundary-terminal" && !transaction)
          throw new RenderFault(
            "server-progressive-encoding",
            "A boundary frame requires its actual capture transaction",
          );

        if (encoded.kind === "boundary-overflow") {
          if (event.kind !== "boundary-terminal" || event.outcome !== "fulfilled")
            throw new RenderFault(
              "server-progressive-encoding",
              "Only fulfilled output can select boundary overflow recovery",
            );

          discardPending();
          reservation.release();
          return false;
        }
        if (encoded.kind !== "frame")
          throw new RenderFault(
            "server-progressive-encoding",
            "The Hosting encoder returned an unknown frame result",
          );

        const bytes = encoded.bytes;
        const checked = reservation.check(bytes);
        if (!checked.accepted) {
          discardPending();
          reservation.release();
          if (
            checked.reason === "boundary-bytes" &&
            event.kind === "boundary-terminal" &&
            event.outcome === "fulfilled"
          )
            return false;

          throw new RenderFault("server-progressive-limit", checked.reason);
        }

        const queue = reservation.prepare(bytes);
        const prepared = transaction?.preparePublication?.();
        const recheck = prepared?.recheck;
        const seal = prepared?.seal;
        const publish = prepared?.publish;
        const notify = prepared?.notify;
        const queueRecheck = queue.recheck;
        const queuePublish = queue.publish;
        const queueNotify = queue.notify;
        const commit = transaction?.commit;

        if (
          prepared &&
          (typeof recheck !== "function" ||
            typeof publish !== "function" ||
            typeof notify !== "function")
        )
          throw new RenderFault(
            "server-progressive-encoding",
            "The capture has no fixed prepared publication",
          );

        if (recheck) nativeReflectApply(recheck, prepared, []);

        queueRecheck();

        const nativeCommit = seal
          ? (nativeReflectApply(seal, prepared, []) as ReturnType<NonNullable<typeof seal>>)
          : undefined;

        if (seal && !nativeCommit)
          throw new RenderFault(
            "server-progressive-encoding",
            "The native capture became stale before publication",
          );

        if (nativeCommit) nativeCommit.publish();
        if (publish) nativeReflectApply(publish, prepared, []);
        else if (commit) nativeReflectApply(commit, transaction, []);

        queuePublish();
        commitmentStarted = true;

        deliverProgressivePublication(nativeCommit, notify, prepared, queueNotify);

        return true;
      } catch (reason) {
        try {
          discardPending();
        } catch {
          // Preserve the encoding or admission failure.
        }
        throw reason;
      }
    };

    while (!cancelled && !publicationFailed) {
      const record = nextReadyBoundary();

      if (!record) break;

      let reservation: ProgressiveByteReservationV1 | undefined;
      try {
        // Failed and cancelled terminals use total-frame capacity; maxBoundaryBytes gates fulfilled output.
        reservation = await byteAdmission.reserve(
          record.hasFailure || record.cancelled ? "control" : "boundary",
        );

        if (cancelled || publicationFailed) {
          reservation.release();
          reservation = undefined;
          return;
        }

        let event = makeEvent(record);
        const published = publishEncoded(event, reservation);

        reservation = undefined;

        if (!published) {
          const failure = Object.freeze({
            kind: "progressive-resource-failure" as const,
            code: "boundary-bytes" as const,
            message: "A progressive boundary exceeded its resolved byte limit",
          });

          record.hasFailure = true;
          record.failure = failure;
          record.output = undefined;
          record.outputSet = false;
          const selection = selectErrorView(record.owner, record.descriptor, failure);

          if (selection.view) record.errorView = selection.view;
          else if (selection.rootUnhandled) {
            record.rootUnhandled = true;
            failPublication(selection.reason);
            return;
          } else record.handledFailure = true;

          revokeFailedBoundaryWork(record);

          reservation = await byteAdmission.reserve("control");

          if (cancelled || publicationFailed) {
            reservation.release();
            reservation = undefined;
            return;
          }

          event = makeEvent(record);
          const recovered = publishEncoded(event, reservation);
          reservation = undefined;

          if (!recovered)
            throw new RenderFault(
              "server-progressive-encoding",
              "A required failure frame cannot retry boundary overflow",
            );
        }

        admitTerminal(record, event);
      } finally {
        reservation?.release();
      }
    }

    if (cancelled || publicationFailed || wireWorkCount !== 0 || completePublished) return;

    const admitted = [...boundaries.values()].filter((record) => record.admitted);

    if (!admitted.every((record) => record.published)) return;

    let reservation: ProgressiveByteReservationV1 | undefined;
    try {
      reservation = await byteAdmission.reserve("control");

      if (cancelled || publicationFailed) {
        reservation.release();
        reservation = undefined;
        return;
      }

      const event = makeCompleteEvent();
      const published = publishEncoded(event, reservation);
      reservation = undefined;

      if (!published)
        throw new RenderFault(
          "server-progressive-encoding",
          "A complete frame cannot select boundary overflow recovery",
        );

      byteAdmission.finish();
      completePublished = true;
    } finally {
      reservation?.release();
    }
  }

  function flushReady(): void {
    if (pumpRunning) {
      pumpRequested = true;

      return;
    }

    if (
      !shellSealed ||
      cancelled ||
      publicationFailed ||
      bufferedCompleteRequested ||
      !encode ||
      !admission
    ) {
      maybeResolveSettled();

      return;
    }

    pumpRunning = true;
    void pumpReady()
      .catch((reason: unknown) => {
        if (!cancelled && !publicationFailed) failPublication(reason);
      })
      .finally(() => {
        pumpRunning = false;
        const requested = pumpRequested;

        pumpRequested = false;

        if (requested) flushReady();
        maybeResolveSettled();
      });
  }

  const controller: ServerProgressiveController = {
    ...(progressivePolicy
      ? {
          producer: {
            policy: progressivePolicy,
            settled,
            cancel(reason) {
              controller.cancel(reason);
            },
            bind(encodeEvent, limits: ResolvedProgressivePolicyV1, byteAdmission): void {
              if (!shellSealed || cancelled)
                throw new RenderFault(
                  "server-progressive",
                  "The real shell must be sealed before source claim",
                );
              if (bufferedCompleteRequested)
                throw new RenderFault(
                  "server-progressive",
                  "A complete render already owns this session",
                );
              if (encode || admission)
                throw new RenderFault(
                  "server-progressive",
                  "A progressive source may be bound only once",
                );
              if (
                !matchesResolvedPolicy(limits, progressivePolicy) ||
                !validLimit(limits.maxBoundaryCount) ||
                !validLimit(limits.maxBoundaryBytes) ||
                !validLimit(limits.maxQueuedBytes) ||
                !validLimit(limits.maxQueuedEvents) ||
                !validLimit(limits.maxFrameBytes) ||
                !validLimit(limits.maxRegionNodes) ||
                !validLimit(limits.maxRegionTextBytes)
              )
                throw new RenderFault(
                  "server-progressive-policy",
                  "The producer policy must match the captured finite plan",
                );

              encode = encodeEvent;
              admission = byteAdmission;
              if (publicationFailed) admission.fail(publicationFailureReason);
              flushReady();
            },
          },
        }
      : {}),
    settled,

    boundaryLimit() {
      if (!validLimit(maxBoundaryCount))
        throw new RenderFault(
          "server-progressive-limit",
          "A resolved finite server boundary limit is required",
        );

      return maxBoundaryCount;
    },

    registeredBoundaries() {
      return Object.freeze([...boundaries.values()].map((record) => record.descriptor));
    },

    registeredBoundaryHosts() {
      return Object.freeze(
        [...boundaries.values()].flatMap((record) => {
          if (!record.loadingOwner || !record.contentOwner) return [];

          return [
            Object.freeze({
              boundary: record.descriptor,
              loadingOwnerId: record.loadingOwner.identity,
              contentOwnerId: record.contentOwner.identity,
            }),
          ];
        }),
      );
    },

    asyncBoundaryHostRecords() {
      return Object.freeze(
        [...boundaries.values()].flatMap((record) => {
          const parentOwner = record.owner.parent;

          if (!parentOwner || !record.loadingOwner || !record.contentOwner || !record.selected)
            return [];

          return [
            Object.freeze({
              boundary: record.descriptor,
              parentOwnerId: parentOwner.identity,
              loadingOwnerId: record.loadingOwner.identity,
              contentOwnerId: record.contentOwner.identity,
              selected: record.selected,
            }),
          ];
        }),
      );
    },

    waitForShellSelection(descriptors) {
      const records = descriptors.map((descriptor) => {
        const record = boundaries.get(descriptor.ownerId);

        if (!record || record.descriptor !== descriptor)
          throw new RenderFault(
            "server-progressive-shell",
            "A shell readiness request has an unknown boundary",
          );

        return record.shellReady;
      });

      return Promise.all(records).then(() => undefined);
    },

    settledAsyncBoundaryHosts() {
      if (!completeSettlementDone || (progressiveEnabled && !bufferedCompleteRequested))
        throw new RenderFault(
          "server-progressive-settlement",
          "Complete boundary state requires a successful complete settlement",
        );

      return Object.freeze(
        [...boundaries.values()]
          .filter((record) => record.admitted && record.selected !== undefined)
          .map((record) => {
            const parentOwner = record.owner.parent;

            if (!parentOwner || !record.loadingOwner || !record.contentOwner || !record.selected)
              throw new RenderFault(
                "server-progressive-settlement",
                "A settled async host has incomplete actual Owner selection state",
              );

            return Object.freeze({
              boundary: record.descriptor,
              parentOwnerId: parentOwner.identity,
              loadingOwnerId: record.loadingOwner.identity,
              contentOwnerId: record.contentOwner.identity,
              selected: record.selected,
            });
          }),
      );
    },

    settledBoundaryFailures() {
      if (!completeSettlementDone || (progressiveEnabled && !bufferedCompleteRequested))
        throw new RenderFault(
          "server-progressive-settlement",
          "Complete failure state requires a successful complete settlement",
        );

      return Object.freeze(
        [...boundaries.values()]
          .filter((record) => record.admitted && record.hasFailure)
          .map((record) =>
            Object.freeze({
              boundary: record.descriptor,
              failure: record.failure,
              handled: record.handledFailure || record.errorView !== undefined,
              rootUnhandled: record.rootUnhandled,
              ...(record.errorView ? { errorView: record.errorView } : {}),
            }),
          ),
      );
    },

    registerErrorBoundary(owner, slot, key, registration) {
      owner.assertActive();

      if (
        !slot ||
        !key ||
        registration.descriptor.ownerId !== owner.identity ||
        registration.descriptor.slot !== slot ||
        registration.descriptor.key !== key ||
        errorBoundaries.has(owner.identity)
      )
        throw new RenderFault(
          "server-progressive-error",
          "A route error range needs its exact Owner and keyed occurrence",
        );

      if (shellSealed) {
        const fallback = selectedFallbackFor(owner);
        const parent = fallback?.causeRecord ?? findParentBoundary(owner);
        const selectedFallback =
          fallback?.causeRecord !== undefined &&
          fallback.causeRecord === parent &&
          !fallback.causeRecord.published;

        if (!hasActiveBoundaryWork(parent) && !selectedFallback)
          throw new RenderFault(
            "server-progressive-admission",
            "An error range created after shell sealing must descend from active render work",
          );
      }

      errorBoundaries.set(owner.identity, registration);
    },

    registeredErrorBoundaries() {
      return Object.freeze([...errorBoundaries.values()]);
    },

    selectErrorView,

    runSelectedErrorFallback(boundaryOwner, cause, viewOwner, render) {
      const selection = activeErrorSelections.at(-1);
      const causeRecord = selection?.causeRecord;

      if (
        !selection ||
        selection.boundaryOwner !== boundaryOwner ||
        selection.cause !== cause ||
        selection.fallbackOwner ||
        viewOwner.parent !== boundaryOwner ||
        viewOwner.context !== boundaryOwner.context ||
        (cause && (!causeRecord || causeRecord.descriptor !== cause || causeRecord.published))
      )
        throw new RenderFault(
          "server-progressive-error",
          "Only the selected actual error view can register late ranges",
        );

      selection.fallbackOwner = viewOwner;

      try {
        return render();
      } finally {
        selection.fallbackOwner = undefined;
      }
    },

    registerBoundary(owner, slot, key, replaceCompleteOutput) {
      owner.assertActive();

      if (cancelled)
        throw (
          cancelReason ?? new RenderFault("cancelled", "Progressive server rendering was cancelled")
        );
      if (!validLimit(maxBoundaryCount))
        throw new RenderFault(
          "server-progressive-limit",
          "A resolved finite server boundary limit is required",
        );
      if (boundaries.size >= maxBoundaryCount)
        throw new RenderFault(
          "server-progressive-limit",
          "The resolved server boundary limit was exceeded",
        );

      const fallback = selectedFallbackFor(owner);
      const parent = fallback?.causeRecord ?? findParentBoundary(owner);
      const selectedFallback =
        fallback?.causeRecord !== undefined &&
        fallback.causeRecord === parent &&
        !fallback.causeRecord.published;
      if (shellSealed && !hasActiveBoundaryWork(parent) && !selectedFallback)
        throw new RenderFault(
          "server-progressive-admission",
          "A boundary created after shell sealing must descend from active admitted render work",
        );

      const descriptor = Object.freeze({ ownerId: owner.identity, slot, key });
      if (!slot || !key || boundaries.has(owner.identity))
        throw new RenderFault(
          "server-progressive",
          "A boundary requires one unique actual owner and key",
        );

      let resolveReady!: () => void;
      let rejectReady!: (reason: unknown) => void;
      const ready = new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });

      void ready.catch(() => undefined);

      let resolveShellReady!: () => void;
      let rejectShellReady!: (reason: unknown) => void;
      const shellReady = new Promise<void>((resolve, reject) => {
        resolveShellReady = resolve;
        rejectShellReady = reject;
      });

      void shellReady.catch(() => undefined);

      let resolveSemanticReady!: () => void;
      const semanticReady = new Promise<void>((resolve) => {
        resolveSemanticReady = resolve;
      });

      let host: AsyncBoundaryHost | undefined;
      const record: BoundaryRecord = {
        owner,
        descriptor,
        parent,
        children: new Set(),
        get host() {
          if (!host)
            throw new RenderFault(
              "server-progressive",
              "A boundary host was read before its registration completed",
            );

          return host;
        },
        pending: 0,
        pendingHostSelections: 0,
        failureWorkRevoked: false,
        loadingRevoked: false,
        exposed: false,
        readyOrder: undefined,
        output: undefined,
        outputSet: false,
        failure: undefined,
        hasFailure: false,
        handledFailure: false,
        rootUnhandled: false,
        cancelled: false,
        rendered: false,
        replaceCompleteOutput,
        loadingOwner: undefined,
        contentOwner: undefined,
        ready,
        resolveReady,
        rejectReady,
        pendingPromises: new Map(),
        queryVersions: new Map(),
        queryFailures: new Map(),
        queryStops: new Map(),
        queryLeases: new Map(),
        reachableBoundaries: Object.freeze([]),
        errorView: undefined,
        admitted: false,
        declaredBy: undefined,
        declared: false,
        publicationRevoked: parent?.publicationRevoked ?? false,
        published: false,
        publishedOutcome: undefined,
        selected: undefined,
        lateFailures: [],
        shellReady,
        resolveShellReady,
        rejectShellReady,
        shellSelectionSettled: false,
        semanticReady,
        resolveSemanticReady,
      };

      if (shellSealed && (!progressiveEnabled || bufferedCompleteRequested)) {
        record.admitted = true;
        record.declared = true;
      }

      const failQueryReset = (consumer: Owner, graph: Graph, failure: RenderFault): void => {
        if (record.published || record.cancelled || cancelled || record.publicationRevoked) return;

        record.queryFailures.set(graph, failure);

        if (!record.hasFailure) {
          record.hasFailure = true;
          record.failure = failure;
          const selection = selectErrorView(consumer, record.descriptor, failure);

          if (selection.view) record.errorView = selection.view;
          else if (selection.rootUnhandled) {
            record.rootUnhandled = true;
            failPublication(selection.reason);
          } else record.handledFailure = true;

          revokeFailedBoundaryWork(record);
        }

        recordReady(record);
        maybeSettleOriginalWork();
      };

      host = {
        owner,
        capture(workOwner, promise) {
          trackOriginal(record, workOwner, promise, true);
        },
        consumeQuery(consumer, graph, store, kind: QueryReadKind) {
          observeQuery(consumer, graph, store, kind);
        },
        assertQueryReadable(consumer, graph) {
          consumer.assertReadable();
          const version = graph.resetVersion.get();
          const observed = record.queryVersions.get(graph);

          if (observed !== undefined && observed !== version) {
            const failure = new RenderFault(
              "query-reset",
              "A server boundary query changed its graph reset epoch",
            );

            failQueryReset(consumer, graph, failure);

            throw failure;
          }

          const failure = record.queryFailures.get(graph);

          if (failure !== undefined || record.queryFailures.has(graph)) throw failure;
        },
      };

      const observeQuery = <T>(
        consumer: Owner,
        graph: Graph,
        store: QueryStore<T, unknown>,
        kind: QueryReadKind,
      ): void => {
        consumer.assertReadable();
        const version = graph.resetVersion.get();
        const observed = record.queryVersions.get(graph);

        if (observed !== undefined && observed !== version) {
          const failure = new RenderFault(
            "query-reset",
            "A server boundary query changed its graph reset epoch",
          );

          failQueryReset(consumer, graph, failure);

          throw failure;
        }

        if (observed === undefined) {
          record.queryVersions.set(graph, version);
          const stop = subscribe(graph.resetVersion, (nextVersion) => {
            if (nextVersion === version) return;

            const failure = new RenderFault(
              "query-reset",
              "A server boundary query changed its graph reset epoch",
            );

            failQueryReset(consumer, graph, failure);
          });

          record.queryStops.set(graph, stop);
          owner.onRelease(stop);
        }

        const leases =
          record.queryLeases.get(consumer) ??
          new Map<
            QueryStore<unknown, unknown>,
            { mode: QueryReadKind; stops: (() => void)[]; stop(): void }
          >();
        const key = store as QueryStore<unknown, unknown>;
        const existing = leases.get(key);

        if (existing) {
          if (kind === "value" && existing.mode !== "value") {
            existing.stops.push(subscribe(store.value, () => undefined));
            existing.mode = "value";
          }

          return;
        }

        const stops: (() => void)[] = [];
        let stopped = false;

        try {
          stops.push(subscribe(store.pending, () => undefined));
          stops.push(subscribe(store.status, () => undefined));
          if (kind === "value") stops.push(subscribe(store.value, () => undefined));

          const lease = {
            mode: kind,
            stops,
            stop() {
              if (stopped) return;

              stopped = true;
              for (const unsubscribe of stops) unsubscribe();
              leases.delete(key);
              if (!leases.size) record.queryLeases.delete(consumer);
            },
          };

          leases.set(key, lease);
          record.queryLeases.set(consumer, leases);
          consumer.onRelease(() => lease.stop());
        } catch (error) {
          for (const unsubscribe of stops) unsubscribe();

          throw error;
        }
      };

      boundaries.set(owner.identity, record);
      parent?.children.add(record);
      owner.signal.addEventListener(
        "abort",
        () => {
          if (cancelled || record.published || record.hasFailure) return;
          record.cancelled = true;
          record.rendered = true;
          settleShellReady(
            record,
            owner.signal.reason ?? new RenderFault("cancelled", "Server boundary was cancelled"),
            true,
          );
          if (!record.admitted && !record.exposed) record.publicationRevoked = true;
          revokeBoundaryWork(record);
          revokeUnexposedDescendants(record);
          recordReady(record);
        },
        { once: true },
      );

      return {
        descriptor,
        host,
        ready,
        bindOwners(loadingOwner, contentOwner) {
          if (
            record.loadingOwner ||
            record.contentOwner ||
            loadingOwner.parent !== owner ||
            contentOwner.parent !== owner ||
            loadingOwner === contentOwner ||
            loadingOwner.context !== owner.context ||
            contentOwner.context !== owner.context
          )
            throw new RenderFault(
              "server-progressive",
              "An async range needs its actual loading and content Owners",
            );

          record.loadingOwner = loadingOwner;
          record.contentOwner = contentOwner;
        },
        selectLoading(output) {
          if (!record.loadingOwner || !record.contentOwner)
            throw new RenderFault(
              "server-progressive-selection",
              "The actual loading host needs its bound Owners",
            );
          if (record.loadingRevoked || record.selected === "content") return false;
          if (record.selected === "loading") return false;

          record.selected = "loading";
          if (!record.exposed) record.replaceCompleteOutput?.(output);
          settleShellReady(record);

          return true;
        },
        complete(output, reachableBoundaries) {
          if (record.readyOrder !== undefined || record.hasFailure || record.cancelled)
            return false;

          const reachable = new Set<string>();
          const descriptors: ServerProgressiveBoundaryDescriptor[] = [];

          for (const descriptor of reachableBoundaries) {
            const child = boundaries.get(descriptor.ownerId);

            if (!child || child.descriptor !== descriptor || child === record)
              throw new RenderFault(
                "server-progressive-admission",
                "A terminal references an unregistered boundary anchor",
              );

            let ancestor = child.parent;

            while (ancestor && ancestor !== record) ancestor = ancestor.parent;
            if (ancestor !== record)
              throw new RenderFault(
                "server-progressive-admission",
                "A terminal references an unrelated boundary anchor",
              );

            if (reachable.has(descriptor.ownerId))
              throw new RenderFault(
                "server-progressive-admission",
                "A terminal repeats a boundary anchor",
              );

            reachable.add(descriptor.ownerId);
            descriptors.push(descriptor);
          }

          record.reachableBoundaries = Object.freeze(descriptors);
          record.output = output;
          record.outputSet = true;
          record.rendered = true;
          revokeLoadingWork(record);
          revokeLoadingDescendants(record);

          const pendingChildren = descriptors
            .map((descriptor) => boundaries.get(descriptor.ownerId)!)
            .filter((child) => !child.shellSelectionSettled);
          record.pendingHostSelections = pendingChildren.length;

          for (const child of pendingChildren) {
            void child.shellReady
              .then(
                () => {
                  record.pendingHostSelections--;
                  recordReady(record);
                },
                (reason: unknown) => {
                  if (!record.hasFailure && !record.cancelled) {
                    record.hasFailure = true;
                    record.failure = reason;
                    const selection = selectErrorView(record.owner, record.descriptor, reason);

                    if (selection.view) record.errorView = selection.view;
                    else if (selection.rootUnhandled) {
                      record.rootUnhandled = true;
                      failPublication(selection.reason);
                    } else record.handledFailure = true;

                    revokeFailedBoundaryWork(record);
                  }

                  record.pendingHostSelections--;
                  recordReady(record);
                },
              )
              .catch((reason: unknown) => failPublication(reason));
          }

          if (!record.exposed) {
            record.replaceCompleteOutput?.(output);
            record.selected = "content";
            settleShellReady(record);
          }

          recordReady(record);

          return true;
        },
        fail(reason) {
          if (
            record.readyOrder !== undefined ||
            record.cancelled ||
            cancelled ||
            record.publicationRevoked
          ) {
            record.lateFailures.push({ reason });
            return { kind: "already-selected" };
          }
          record.hasFailure = true;
          record.failure = reason;
          const selection = selectErrorView(record.owner, record.descriptor, reason);

          if (selection.view) record.errorView = selection.view;
          else if (selection.rootUnhandled) {
            record.rootUnhandled = true;
            failPublication(selection.reason);
          } else record.handledFailure = true;

          revokeFailedBoundaryWork(record);

          if (record.selected === undefined) {
            if (selection.view) settleShellReady(record);
            else settleShellReady(record, selection.reason ?? reason, true);
          }

          record.rendered = true;
          recordReady(record);

          return selection.view
            ? { kind: "selected", view: selection.view }
            : selection.forwarded || selection.rootUnhandled
              ? { kind: "forward", reason: selection.reason ?? reason }
              : { kind: "already-selected" };
        },
      };
    },

    retainOriginal(workOwner, promise) {
      workOwner.assertActive();
      const boundaryOwner = workOwner.asyncBoundary?.owner;
      const record = boundaryOwner ? boundaries.get(boundaryOwner.identity) : undefined;

      if (!record || record.owner.context !== workOwner.context)
        throw new RenderFault(
          "server-progressive",
          "Original work has no actual enclosing server boundary",
        );

      trackOriginal(record, workOwner, promise, false);
    },

    setRootOutput(output) {
      if (shellSealed || rootOutputSet)
        throw new RenderFault(
          "server-progressive",
          "The server root output was recorded more than once",
        );

      assertSynchronousRootOutput(output);

      rootOutput = output;
      rootOutputSet = true;
    },

    sealShell(asyncBoundaries, errorBoundaryStates) {
      if (cancelled)
        throw (
          cancelReason ?? new RenderFault("cancelled", "Progressive server rendering was cancelled")
        );
      if (shellSealed || !rootOutputSet)
        throw new RenderFault(
          "server-progressive-shell",
          "A synchronous server root must exist before shell sealing",
        );

      const hosts = new Map(asyncBoundaries.map((entry) => [entry.boundary.ownerId, entry]));

      if (
        hosts.size !== asyncBoundaries.length ||
        asyncBoundaries.some((host) => {
          const descriptor = host.boundary;
          const record = boundaries.get(descriptor.ownerId);
          const parentOwner = record?.owner.parent;

          return (
            !record ||
            record.descriptor !== descriptor ||
            !parentOwner ||
            !record.shellSelectionSettled ||
            record.selected === undefined ||
            host.parentOwnerId !== parentOwner.identity ||
            host.loadingOwnerId !== record.loadingOwner?.identity ||
            host.contentOwnerId !== record.contentOwner?.identity ||
            host.selected !== record.selected
          );
        })
      )
        throw new RenderFault(
          "server-progressive-shell",
          "The shell async Owner inventory is not actual selected range state",
        );

      const reachableBoundaries = asyncBoundaries
        .filter((entry) => entry.selected === "loading")
        .map((entry) => entry.boundary);
      const boundaryHosts = asyncBoundaries
        .filter((entry) => entry.selected === "loading")
        .map((entry) =>
          Object.freeze({
            boundary: entry.boundary,
            loadingOwnerId: entry.loadingOwnerId,
            contentOwnerId: entry.contentOwnerId,
          }),
        );

      const errorStates = new Map(
        errorBoundaryStates.map((entry) => [entry.boundary.ownerId, entry]),
      );

      if (
        errorStates.size !== errorBoundaryStates.length ||
        errorStates.size !==
          [...errorBoundaries.values()].filter((entry) => errorStates.has(entry.descriptor.ownerId))
            .length ||
        errorBoundaryStates.some((entry) => {
          const registration = errorBoundaries.get(entry.boundary.ownerId);
          const actual = registration?.state();

          return (
            !registration ||
            registration.descriptor !== entry.boundary ||
            !actual ||
            actual.boundary !== entry.boundary ||
            actual.kind !== entry.kind ||
            (actual.kind === "content" &&
              entry.kind === "content" &&
              actual.contentOwnerId !== entry.contentOwnerId) ||
            (actual.kind === "error" &&
              entry.kind === "error" &&
              actual.viewOwnerId !== entry.viewOwnerId)
          );
        })
      )
        throw new RenderFault(
          "server-progressive-shell",
          "The shell error Owner sidecar is not its actual range inventory",
        );

      shellSealed = true;
      const inventory: BoundaryRecord[] = [];
      const seen = new Set<string>();

      for (const descriptor of reachableBoundaries) {
        const record = boundaries.get(descriptor.ownerId);

        if (!record || record.descriptor !== descriptor || seen.has(descriptor.ownerId))
          throw new RenderFault(
            "server-progressive-admission",
            "The shell contains an unregistered or repeated boundary anchor",
          );

        seen.add(descriptor.ownerId);
        record.admitted = true;
        record.declared = true;
        record.declaredBy = undefined;
        record.exposed = true;
        inventory.push(record);
      }

      for (const entry of asyncBoundaries) {
        const record = boundaries.get(entry.boundary.ownerId)!;
        record.exposed = true;

        if (entry.selected === "content" && !record.outputSet)
          throw new RenderFault(
            "server-progressive-shell",
            "A content-selected host has no actual rendered output",
          );
      }

      maybeSettleOriginalWork();
      flushReady();

      const shell = Object.freeze({
        responseIdentity: identity,
        output: rootOutput,
        boundaries: Object.freeze(inventory.map((record) => record.descriptor)),
        boundaryHosts: Object.freeze([...boundaryHosts]),
        asyncBoundaries: Object.freeze([...asyncBoundaries]),
        errorBoundaries: Object.freeze([...errorBoundaryStates]),
      });

      progressiveShells.set(shell, { controller, responseIdentity: identity });

      return shell;
    },

    async settleBoundaries(visibleBoundaries) {
      if (progressiveEnabled && !encode && !admission) bufferedCompleteRequested = true;

      if (!shellSealed) {
        if (progressiveEnabled)
          throw new RenderFault(
            "server-progressive-shell",
            "Seal the real root before settling progressive boundaries",
          );

        shellSealed = true;
        maybeSettleOriginalWork();
      }

      const visibleRecords = new Map<string, BoundaryRecord>();

      while (true) {
        const descriptors = visibleBoundaries();
        const records = descriptors.map((descriptor) => {
          const record = boundaries.get(descriptor.ownerId);

          if (!record || record.descriptor !== descriptor)
            throw new RenderFault(
              "server-progressive-settlement",
              "A visible complete boundary has no actual registration",
            );

          record.admitted = true;
          record.declared = true;
          visibleRecords.set(record.descriptor.ownerId, record);

          return record;
        });

        await Promise.all(records.map((record) => record.semanticReady));

        for (const record of records)
          if (!record.hasFailure && !record.cancelled && record.outputSet) {
            record.replaceCompleteOutput?.(record.output);
            if (record.replaceCompleteOutput) {
              record.selected = "content";
              record.exposed = true;
              revokeLoadingWork(record);
              settleShellReady(record);
            }
          }

        const next = visibleBoundaries();
        if (
          descriptors.length !== next.length ||
          descriptors.some((entry, index) => entry !== next[index])
        )
          continue;

        if (wireWorkCount !== 0) {
          await waitForWireWork();
          continue;
        }

        break;
      }

      const failures = [...visibleRecords.values()]
        .filter(
          (record) =>
            record.hasFailure &&
            (record.rootUnhandled || (!record.errorView && !record.handledFailure)),
        )
        .map((record) => record.failure);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "Server async boundaries failed");

      completeSettlementDone = true;
    },

    cancel(reason) {
      if (cancelled) return;
      cancelled = true;
      cancelReason = reason;
      admission?.fail(reason);
      maybeSettleOriginalWork();
    },
  };

  controllersByContext.set(context, controller);
  root.onRelease(() => {
    controllersByContext.delete(context);
  });

  return controller;
}

/** @internal Resolve only the controller attached to an actual server owner. */
export function serverProgressiveControllerFor(owner: Owner): ServerProgressiveController {
  const controller = controllersByContext.get(owner.context as object);
  if (!controller)
    throw new RenderFault("server-progressive", "The owner has no actual server render session");

  return controller;
}

/** @internal Authenticate the only shell issued by this actual server producer. */
export function assertServerProgressiveShell(owner: Owner, shell: ServerProgressiveShell): void {
  const controller = serverProgressiveControllerFor(owner);
  const provenance = progressiveShells.get(shell);

  if (
    !provenance ||
    provenance.controller !== controller ||
    provenance.responseIdentity !== shell.responseIdentity
  )
    throw new RenderFault(
      "server-progressive-shell",
      "The shell has no actual response producer provenance",
    );
}

/** @internal Authenticate a terminal and its actual registered output before graph capture. */
export function assertServerProgressiveBoundaryEvent(
  owner: Owner,
  event: ServerProgressiveBoundaryEvent,
): void {
  const controller = serverProgressiveControllerFor(owner);
  const provenance = progressiveBoundaryEvents.get(event);

  if (
    !provenance ||
    provenance.controller !== controller ||
    provenance.record.descriptor !== event.boundary ||
    provenance.responseIdentity !== event.responseIdentity
  )
    throw new RenderFault(
      "server-progressive-boundary",
      "The terminal has no actual boundary output provenance",
    );

  if (
    event.outcome === "fulfilled" &&
    (!provenance.record.outputSet ||
      !Object.prototype.hasOwnProperty.call(event, "output") ||
      !Object.is(event.output, provenance.record.output))
  )
    throw new RenderFault(
      "server-progressive-boundary",
      "The fulfilled terminal lost its actual rendered output",
    );

  if (
    event.outcome === "failed" &&
    (!Object.prototype.hasOwnProperty.call(event, "failure") ||
      !Object.is(event.failure, provenance.record.failure))
  )
    throw new RenderFault(
      "server-progressive-boundary",
      "The failed terminal lost its original failure value",
    );

  if (event.outcome !== "failed" && Object.prototype.hasOwnProperty.call(event, "failure"))
    throw new RenderFault(
      "server-progressive-boundary",
      "A non-failed terminal cannot carry a failure value",
    );

  const suppliedView = Object.prototype.hasOwnProperty.call(event, "errorView")
    ? event.errorView
    : undefined;
  const actualView = provenance.record.errorView;

  if (
    suppliedView &&
    (event.outcome !== "failed" ||
      !actualView ||
      suppliedView.boundary !== actualView.boundary ||
      suppliedView.viewOwnerId !== actualView.viewOwnerId ||
      !Object.is(suppliedView.output, actualView.output) ||
      !Object.is(suppliedView.projectedFailure, actualView.projectedFailure))
  )
    throw new RenderFault(
      "server-progressive-boundary",
      "The failed terminal lost its actual selected error view",
    );

  if (actualView && !suppliedView)
    throw new RenderFault(
      "server-progressive-boundary",
      "The failed terminal omitted its actual selected error view",
    );
}

/** @internal Retain an actual registered async continuation value without treating a caught error as terminal. */
export function retainServerOriginalWork(owner: Owner, promise: unknown): void {
  serverProgressiveControllerFor(owner).retainOriginal(owner, promise);
}
