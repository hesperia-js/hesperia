import { Signal, withoutWrites } from "aeolia";
import type { Graph, QueryStore } from "aeolia";
import { retireDataBindingRoot } from "../data/environment.ts";
import type { Scheduler } from "./scheduler.ts";

/** Lifecycle phases distinguish cleanup access from final destruction. */
export type OwnerState = "building" | "mounted" | "suspended" | "cleaning" | "destroyed";

let bodyDepth = 0;
let cleanupDepth = 0;

const nativePromiseConstructor = Promise;
const nativePromiseThen = Promise.prototype.then;
const nativeReflectApply = Reflect.apply;

interface RenderExecution {
  readonly owner: Owner;
  readonly scheduled: boolean;
}

const renderOwners: RenderExecution[] = [];

/** Identify synchronous body execution, including opaque calls into another owner's binding. */
export function isExecutingBody(): boolean {
  return bodyDepth > 0;
}

/** Identify user cleanup, which may read but must not acquire render dependencies. */
export function isExecutingCleanup(): boolean {
  return cleanupDepth > 0;
}

/** Scope only the synchronous body stack; asynchronous ownership remains explicit. */
export function runComponentBody<T>(run: () => T): T {
  bodyDepth++;

  try {
    return run();
  } finally {
    bodyDepth--;
  }
}

/** Scope synchronous reads performed by a component render or scheduled render task. */
export function runRenderContext<T>(owner: Owner, run: () => T): T {
  owner.assertActive();

  renderOwners.push({ owner, scheduled: false });

  try {
    return run();
  } finally {
    renderOwners.pop();
  }
}

/** Scope a scheduler render task even when it runs during another component setup. */
export function runScheduledRenderContext<T>(owner: Owner, run: () => T): T {
  owner.assertActive();

  renderOwners.push({ owner, scheduled: true });

  try {
    return run();
  } finally {
    renderOwners.pop();
  }
}

/** Current render owner, if a body or scheduler render is executing. */
export function currentRenderOwner(): Owner | undefined {
  return renderOwners[renderOwners.length - 1]?.owner;
}

/** Identify a scheduler render pass that can suspend on reset-unavailable data. */
export function isScheduledRender(owner: Owner): boolean {
  const current = renderOwners[renderOwners.length - 1];
  return current?.owner === owner && current.scheduled;
}

/** A rendering contract violation, routed through the owning component's boundary. */
export class RenderFault extends Error {
  /** Stable category suitable for tests and diagnostic presentation. */
  readonly kind: string;

  /** Create a rendering fault with a human-readable explanation. */
  constructor(kind: string, message: string) {
    super(message);

    this.name = "RenderFault";
    this.kind = kind;
  }
}

/** Internal control-flow signal after a boundary routes a stale render to loading. */
export class ResetRenderSuspension extends Error {
  constructor() {
    super("A query source is unavailable while its reset recovery is pending");

    this.name = "ResetRenderSuspension";
  }
}

/** Document-scoped services shared by a mounted tree. */
export interface RuntimeContext {
  /** Document used for native node construction; no ambient document is required. */
  readonly document: Document;
  /** Delivers faults that no component boundary handled. */
  readonly onError: (error: unknown) => void;
  /** Delivers development diagnostics. */
  readonly warn: (message: string) => void;
  /** Executes DOM updates and ordered effects. */
  scheduler: Scheduler;
  /** Monotonically increasing instance generation within this tree. */
  nextGeneration: number;
  /** Root whose containment defines a permitted bound-element move. */
  readonly container: Element | Document;
}

type CleanupSlotState = "pending" | "fulfilled" | "rejected";

interface CleanupFailureSlot {
  asynchronous: boolean;
  incomplete: boolean;
  state: CleanupSlotState;
  reason?: unknown;
  causes?: readonly unknown[];
  reportable?: boolean;
}

type OwnerRetirementMode = "sync" | "join";

interface OwnerRetirementOperation {
  readonly initiator: Owner;
  readonly mode: OwnerRetirementMode;
  readonly reportSynchronous: boolean;
  readonly failures: CleanupFailureSlot[];
  readonly synchronousFailures: unknown[];
  readonly promise: Promise<void>;
  readonly dependencies: Set<OwnerRetirementOperation>;
  readonly dependencySlots: Map<OwnerRetirementOperation, CleanupFailureSlot>;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
  pending: number;
  teardownFinished: boolean;
  incomplete: boolean;
  settled: boolean;
  synchronousReported: boolean;
  asynchronousReported: boolean;
  reporterFault?: unknown;
}

class CleanupObservationFault extends Error {
  readonly kind = "cleanup-observation";
  readonly incomplete = true;
  readonly cause: unknown;

  constructor(cause: unknown) {
    super("Cleanup observation failed; retirement is incomplete");

    this.name = "CleanupObservationFault";
    this.cause = cause;
  }
}

class CleanupRetirementCycleFault extends Error {
  readonly kind = "cleanup-retirement-cycle";
  readonly incomplete = true;

  constructor() {
    super("Cleanup cannot wait for its own retirement operation");

    this.name = "CleanupRetirementCycleFault";
  }
}

const ownerRetirementOperations = new WeakMap<RuntimeContext, Set<OwnerRetirementOperation>>();
const ownerRetirementByPromise = new WeakMap<Promise<void>, OwnerRetirementOperation>();
const ownerRetirementByOwner = new WeakMap<Owner, OwnerRetirementOperation>();
const ownerRetirementAliasesByOwner = new WeakMap<Owner, Set<Promise<void>>>();
const actualOwnerInstances = new WeakSet<Owner>();

function bindOwnerRetirementAliases(owner: Owner, operation: OwnerRetirementOperation): void {
  ownerRetirementByOwner.set(owner, operation);

  const aliases = ownerRetirementAliasesByOwner.get(owner);

  if (!aliases) return;

  for (const alias of aliases) ownerRetirementByPromise.set(alias, operation);

  ownerRetirementAliasesByOwner.delete(owner);
}

function observeSyncRetirementPromise(operation: OwnerRetirementOperation): void {
  nativeReflectApply(nativePromiseThen, operation.promise, [undefined, () => undefined]);
}

function cleanupFailureAggregate(
  failures: readonly CleanupFailureSlot[],
  message: string,
): AggregateError | undefined {
  const reasons = failures
    .filter((failure) => failure.state === "rejected")
    .flatMap((failure) => failure.causes ?? [failure.reason]);

  return reasons.length ? new AggregateError(reasons, message) : undefined;
}

function reportRetirementFailures(
  operation: OwnerRetirementOperation,
  failures: readonly CleanupFailureSlot[],
): { readonly threw: boolean; readonly reason?: unknown } {
  const aggregate = cleanupFailureAggregate(failures, "Component cleanup failed");

  if (!aggregate) return { threw: false };

  try {
    reportFault(operation.initiator, aggregate);

    return { threw: false };
  } catch (reason) {
    if (!Object.hasOwn(operation, "reporterFault")) operation.reporterFault = reason;

    return { threw: true, reason };
  }
}

function finishOwnerRetirement(operation: OwnerRetirementOperation): void {
  if (operation.settled || !operation.teardownFinished || operation.pending !== 0) return;

  operation.settled = true;
  const aggregate = cleanupFailureAggregate(operation.failures, "Component cleanup failed");
  const active = ownerRetirementOperations.get(operation.initiator.context);

  active?.delete(operation);

  if (active?.size === 0) ownerRetirementOperations.delete(operation.initiator.context);
  operation.dependencies.clear();
  operation.dependencySlots.clear();

  if (aggregate) operation.reject(aggregate);
  else operation.resolve();

  if (operation.mode !== "sync" || operation.asynchronousReported) return;

  const asynchronousFailures = operation.failures.filter(
    (failure) => failure.asynchronous && failure.reportable !== false,
  );

  if (asynchronousFailures.length) {
    operation.asynchronousReported = true;
    reportRetirementFailures(operation, asynchronousFailures);
  }
}

function retirementDependsOn(
  operation: OwnerRetirementOperation,
  target: OwnerRetirementOperation,
  visited = new Set<OwnerRetirementOperation>(),
): boolean {
  if (operation === target) return true;
  if (visited.has(operation)) return false;

  visited.add(operation);

  for (const dependency of operation.dependencies)
    if (retirementDependsOn(dependency, target, visited)) return true;

  return false;
}

function ownerAncestorDistance(ancestor: Owner, descendant: Owner): number | undefined {
  let distance = 0;

  for (let current: Owner | null = descendant; current; current = current.parent) {
    if (current === ancestor) return distance;

    distance++;
  }

  return undefined;
}

function storeSynchronousIncompleteFailure(
  operation: OwnerRetirementOperation,
  slot: CleanupFailureSlot,
  reason: unknown,
): void {
  let synchronousIndex = 0;

  for (const current of operation.failures) {
    if (current === slot) break;
    if (!current.asynchronous && current.state === "rejected") synchronousIndex++;
  }

  slot.asynchronous = false;
  slot.incomplete = true;
  slot.state = "rejected";
  slot.reason = reason;
  operation.synchronousFailures.splice(synchronousIndex, 0, reason);
  operation.incomplete = true;
}

function dependOnOwnerRetirement(
  operation: OwnerRetirementOperation,
  dependency: OwnerRetirementOperation,
  dependencySlot?: CleanupFailureSlot,
): void {
  if (operation.settled || operation.dependencies.has(dependency)) return;

  const slot: CleanupFailureSlot = dependencySlot ?? {
    asynchronous: false,
    incomplete: false,
    state: "pending",
  };

  if (!dependencySlot) operation.failures.push(slot);

  if (operation === dependency || retirementDependsOn(dependency, operation)) {
    storeSynchronousIncompleteFailure(operation, slot, new CleanupRetirementCycleFault());

    return;
  }

  slot.asynchronous = true;
  slot.incomplete = dependency.incomplete;
  slot.reportable = dependency.mode !== "sync";
  operation.incomplete ||= dependency.incomplete;
  operation.dependencies.add(dependency);
  operation.dependencySlots.set(dependency, slot);
  operation.pending++;

  try {
    nativeReflectApply(nativePromiseThen, dependency.promise, [
      () => {
        slot.state = "fulfilled";
        operation.pending--;
        finishOwnerRetirement(operation);
      },
      (reason: unknown) => {
        slot.state = "rejected";
        slot.reason = reason;
        slot.incomplete = dependency.incomplete;
        slot.causes =
          reason instanceof AggregateError && reason.message === "Component cleanup failed"
            ? [...reason.errors]
            : [reason];
        operation.incomplete ||= dependency.incomplete;
        operation.pending--;
        finishOwnerRetirement(operation);
      },
    ]);
  } catch (reason) {
    operation.pending--;
    storeSynchronousIncompleteFailure(operation, slot, new CleanupObservationFault(reason));
  }
}

function registerOwnerRetirement(operation: OwnerRetirementOperation): void {
  const active =
    ownerRetirementOperations.get(operation.initiator.context) ??
    new Set<OwnerRetirementOperation>();
  const pending = [...active].filter((candidate) => !candidate.settled);
  const ancestors = pending
    .map((candidate) => ({
      operation: candidate,
      distance: ownerAncestorDistance(candidate.initiator, operation.initiator),
    }))
    .filter(
      (candidate): candidate is { operation: OwnerRetirementOperation; distance: number } =>
        candidate.distance !== undefined,
    )
    .sort((left, right) => left.distance - right.distance);

  active.add(operation);
  ownerRetirementOperations.set(operation.initiator.context, active);

  if (ancestors.length) {
    dependOnOwnerRetirement(ancestors[0]!.operation, operation);

    return;
  }

  for (const candidate of pending) {
    if (ownerAncestorDistance(operation.initiator, candidate.initiator) === undefined) continue;

    const hasIntermediateOperation = pending.some(
      (intermediate) =>
        intermediate !== candidate &&
        ownerAncestorDistance(operation.initiator, intermediate.initiator) !== undefined &&
        ownerAncestorDistance(intermediate.initiator, candidate.initiator) !== undefined,
    );

    if (!hasIntermediateOperation) dependOnOwnerRetirement(operation, candidate);
  }
}

function makeOwnerRetirementOperation(
  initiator: Owner,
  mode: OwnerRetirementMode,
  reportSynchronous: boolean,
): OwnerRetirementOperation {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new nativePromiseConstructor<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  const operation: OwnerRetirementOperation = {
    initiator,
    mode,
    reportSynchronous,
    failures: [],
    synchronousFailures: [],
    promise,
    dependencies: new Set(),
    dependencySlots: new Map(),
    resolve: resolve!,
    reject: reject!,
    pending: 0,
    teardownFinished: false,
    incomplete: false,
    settled: false,
    synchronousReported: false,
    asynchronousReported: false,
  };

  ownerRetirementByPromise.set(promise, operation);

  return operation;
}

function recordCleanupFailure(operation: OwnerRetirementOperation, reason: unknown): void {
  const slot: CleanupFailureSlot = {
    asynchronous: false,
    incomplete: false,
    state: "rejected",
    reason,
  };

  operation.failures.push(slot);
  operation.synchronousFailures.push(reason);
}

function recordCleanupFailureAtSlot(
  operation: OwnerRetirementOperation,
  slot: CleanupFailureSlot,
  reason: unknown,
): void {
  let synchronousIndex = 0;

  for (const current of operation.failures) {
    if (current === slot) break;
    if (!current.asynchronous && current.state === "rejected") synchronousIndex++;
  }

  slot.asynchronous = false;
  slot.state = "rejected";
  slot.reason = reason;
  operation.synchronousFailures.splice(synchronousIndex, 0, reason);
}

function storeCleanupObservationFault(
  operation: OwnerRetirementOperation,
  slot: CleanupFailureSlot,
  reason: unknown,
): void {
  storeSynchronousIncompleteFailure(operation, slot, new CleanupObservationFault(reason));
}

function observeCleanupReturn(
  operation: OwnerRetirementOperation,
  slot: CleanupFailureSlot,
  value: unknown,
): void {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    slot.state = "fulfilled";

    return;
  }

  const dependency = ownerRetirementByPromise.get(value as Promise<void>);

  if (dependency) {
    const dependencySlot = operation.dependencySlots.get(dependency);

    if (dependencySlot) {
      dependencySlot.asynchronous = true;
      dependencySlot.incomplete = dependency.incomplete;
      dependencySlot.reportable = dependency.mode !== "sync";
      operation.incomplete ||= dependency.incomplete;
      const callbackIndex = operation.failures.indexOf(slot);
      const dependencyIndex = operation.failures.indexOf(dependencySlot);

      if (callbackIndex >= 0 && dependencyIndex >= 0 && callbackIndex < dependencyIndex) {
        operation.failures.splice(dependencyIndex, 1);
        operation.failures.splice(callbackIndex, 1, dependencySlot);
      } else if (callbackIndex >= 0) {
        operation.failures.splice(callbackIndex, 1);
      }

      return;
    }

    dependOnOwnerRetirement(operation, dependency, slot);

    return;
  }

  slot.asynchronous = true;
  operation.pending++;

  try {
    nativeReflectApply(nativePromiseThen, value, [
      () => {
        slot.state = "fulfilled";
        operation.pending--;
        finishOwnerRetirement(operation);
      },
      (reason: unknown) => {
        slot.state = "rejected";
        slot.reason = reason;
        operation.pending--;
        finishOwnerRetirement(operation);
      },
    ]);
  } catch (reason) {
    operation.pending--;
    storeCleanupObservationFault(operation, slot, reason);
  }
}

export type QueryReadKind = "metadata" | "value";

/** Waiting-state capability inherited by descendants of an explicit async boundary. */
export interface AsyncBoundaryHost {
  /** Lifetime whose waiting view owns pending descendants. */
  readonly owner: Owner;

  /** Keep content uncommitted until an owned render wait completes. */
  capture(owner: Owner, promise: Promise<void>): void;

  /** Retain a source and observe value only when the owner consumes its value or awaits it. */
  consumeQuery<T>(
    owner: Owner,
    graph: Graph,
    store: QueryStore<T, unknown>,
    kind: QueryReadKind,
  ): void;

  /** Route reset-unavailable scheduled reads to loading; reject callback reads clearly. */
  assertQueryReadable<T>(owner: Owner, graph: Graph, store: QueryStore<T, unknown>): void;
}

/** Internal style activation follows the same Owner transitions as effects. */
export interface OwnerStyleLifecycle {
  /** Activate this Owner's direct stylesheet references after DOM commit. */
  committed(owner: Owner, ownerId: string): void;

  /** Drop only this Owner's active stylesheet references while suspended. */
  suspended(owner: Owner, ownerId: string): void;

  /** Restore this Owner's stylesheet references when resumed. */
  resumed(owner: Owner, ownerId: string): void;

  /** Release this Owner's stylesheet binding after descendants are destroyed. */
  released(owner: Owner, ownerId: string): void;
}

/** Internal resources that must stop after subtree cleanup and restart before effects. */
export interface OwnerResourceLifecycle {
  /** Tear down a native resource after the complete subtree has suspended. */
  suspended(): void;

  /** Recreate a native resource after ordinary owner work has resumed. */
  resumed(): void;
}

const resourceLifecycles = new WeakMap<Owner, Set<OwnerResourceLifecycle>>();

/**
 * Explicit component lifetime. Compiler-generated continuations retain this
 * object rather than extending an ambient owner across an await.
 */
export class Owner {
  /** Runtime services shared with the owning root. */
  readonly context: RuntimeContext;
  /** Parent lifetime; null identifies the mounted application root. */
  private parentOwner: Owner | null;
  /** Logical tree slot, independent of this instance generation. */
  readonly identity: string;
  /** Unique instance generation used to reject stale capabilities. */
  readonly generation: number;
  /** Children in render order. */
  readonly children: Owner[] = [];
  /** Native nodes constructed by this component and removed at destruction. */
  readonly nodes = new Set<Node>();
  /** Required-reference checks run after the component's first effect pass. */
  readonly publicationChecks = new Set<() => void>();
  /** Current phase of this lifetime. */
  state: OwnerState = "building";
  /** True while the component body, including its async continuation, executes. */
  executingBody = true;
  /** Closest boundary at this owner, if one was installed. */
  errorHandler: ((error: unknown) => void) | undefined;
  /** Closest explicit async waiting boundary, inherited by newly created children. */
  asyncBoundary: AsyncBoundaryHost | undefined;
  /** Delay browser activation while this owner belongs to an incomplete async tree. */
  commitDeferred = false;
  /** Internal route-host preparation flag; authored trees retain eager structural setup. */
  deferStructural = false;
  private readonly controller = new AbortController();
  private readonly cleanups: (() => unknown)[] = [];
  private readonly releases: (() => unknown)[] = [];
  private readonly commits: (() => void)[] = [];
  private styleLifecycle:
    | { readonly lifecycle: OwnerStyleLifecycle; readonly ownerId: string }
    | undefined;

  /** Create a fresh lifetime attached to its parent's rendered child order. */
  constructor(context: RuntimeContext, parent: Owner | null, identity: string) {
    this.context = context;
    this.parentOwner = parent;
    this.identity = identity;
    this.generation = context.nextGeneration++;
    this.asyncBoundary = parent?.asyncBoundary;

    parent?.assertActive();

    parent?.children.push(this);
    actualOwnerInstances.add(this);
  }

  /** Parent lifetime; route hosts may reparent only a suspended retained subtree. */
  get parent(): Owner | null {
    return this.parentOwner;
  }

  /**
   * Move a suspended subtree under another owner in the same runtime tree.
   * This is an integration seam for retained route entries, not an authored API.
   */
  reparent(parent: Owner): void {
    if (this.state !== "suspended")
      throw new RenderFault("owner-state", "Only suspended owners can be reparented");

    parent.assertActive();

    if (parent.state !== "mounted")
      throw new RenderFault("owner-state", "A retained owner requires a mounted parent");

    if (parent.context !== this.context)
      throw new RenderFault("owner-parent", "Owners from different runtimes cannot be reparented");

    for (let current: Owner | null = parent; current; current = current.parent) {
      if (current === this)
        throw new RenderFault("owner-parent", "An owner cannot be reparented beneath its subtree");
    }

    if (this.parentOwner === parent) return;

    if (this.parentOwner) {
      const index = this.parentOwner.children.indexOf(this);

      if (index >= 0) this.parentOwner.children.splice(index, 1);
    }

    this.parentOwner = parent;

    parent.children.push(this);
  }

  /** Signal aborted immediately when teardown starts, with its cancellation reason. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Reject capabilities used after teardown started. */
  assertActive(): void {
    if (this.state === "cleaning" || this.state === "destroyed") {
      throw new RenderFault("disposed", `Component ${this.identity} is no longer active`);
    }
  }

  /** Reject public reads after final destruction; cleanup reads remain permitted. */
  assertReadable(): void {
    if (this.state === "destroyed") {
      throw new RenderFault("disposed", `Component ${this.identity} was destroyed`);
    }
  }

  /** Whether this lifetime and every ancestor have installed their complete content. */
  isCommitted(): boolean {
    if (this.state !== "mounted" || this.commitDeferred) return false;

    let current: Owner | null = this.parent;

    while (current) {
      if (current.state !== "mounted" || current.commitDeferred) return false;

      current = current.parent;
    }

    return true;
  }

  /** Pause this lifetime and its descendants while retaining their DOM and state. */
  suspend(): void {
    if (this.state !== "mounted") return;

    this.context.scheduler.suspend(this);
  }

  /** Resume a suspended lifetime and refresh its DOM and effects without rerunning bodies. */
  resume(): void {
    if (this.state !== "suspended") return;

    this.context.scheduler.resume(this);
  }

  /** Register cleanup before descendants in reverse order; returned Promises join disposal. */
  onCleanup(cleanup: () => unknown): void {
    this.assertActive();

    this.cleanups.push(cleanup);
  }

  /** Register release after descendants; returned Promises join disposal. */
  onRelease(release: () => unknown): void {
    this.assertActive();

    this.releases.push(release);
  }

  /** Register activation work; runs once after this owner's complete DOM is installed. */
  onCommit(run: () => void): void {
    this.assertActive();

    if (this.state === "mounted") run();
    else this.commits.push(run);
  }

  /**
   * Bind one compiler-emitted style definition to this actual Owner instance.
   * Runtime-only seam; each Owner has at most one generated definition binding.
   */
  bindStyleLifecycle(lifecycle: OwnerStyleLifecycle, ownerId: string): void {
    this.assertActive();

    if (this.state !== "building")
      throw new RenderFault("style-owner-state", "Styles must bind while an Owner is building");

    const existing = this.styleLifecycle;

    if (existing) {
      if (existing.lifecycle === lifecycle && existing.ownerId === ownerId) return;

      throw new RenderFault(
        "style-owner-binding",
        "An Owner cannot bind multiple style definitions",
      );
    }

    this.styleLifecycle = { lifecycle, ownerId };
  }

  /** Notify the style runtime after Scheduler has suspended this Owner. */
  suspendStyles(): void {
    const binding = this.styleLifecycle;

    if (binding) binding.lifecycle.suspended(this, binding.ownerId);
  }

  /** Notify the style runtime after Scheduler has resumed this Owner. */
  resumeStyles(): void {
    const binding = this.styleLifecycle;

    if (binding) binding.lifecycle.resumed(this, binding.ownerId);
  }

  /** Mark installed DOM and all completed child bodies eligible for effects. */
  commit(): void {
    this.assertActive();

    if (this.commitDeferred) return;

    if (this.state === "mounted") {
      // A parent can have committed while a staged child was deliberately
      // deferred. Walk through mounted structural owners so a staged child
      // that has since become ready can commit; suspended retained subtrees
      // stay paused until an explicit resume handshake.
      for (const child of this.children) {
        if (child.state === "building" || child.state === "mounted") child.commit();
      }

      return;
    }

    this.executingBody = false;
    this.state = "mounted";

    if (this.styleLifecycle) {
      this.styleLifecycle.lifecycle.committed(this, this.styleLifecycle.ownerId);
    }

    for (const child of this.children) child.commit();

    for (const run of this.commits.splice(0)) run();
  }

  /**
   * Revoke synchronously, then join every cleanup Promise and descendant retirement.
   * @returns A Promise that rejects with ordered cleanup failures after retirement completes.
   */
  dispose(reason: unknown = new RenderFault("cancelled", "Component removed")): Promise<void> {
    return this.startRetirement("join", reason, false).promise;
  }

  /**
   * Revoke synchronously and report synchronous failures through the Owner route.
   * Async cleanup failures use the same route when they settle; call `dispose` to join them.
   */
  disposeSync(reason: unknown = new RenderFault("cancelled", "Component removed")): void {
    this.startRetirement("sync", reason, true);
  }

  /** @internal Dispose synchronously while a host retains immediate failures. */
  disposeWithErrors(reason: unknown): readonly unknown[] {
    return this.startRetirement("sync", reason, false).synchronousFailures.slice();
  }

  private startRetirement(
    mode: OwnerRetirementMode,
    reason: unknown,
    reportSynchronous: boolean,
  ): OwnerRetirementOperation {
    const existing = ownerRetirementByOwner.get(this);

    if (existing) {
      if (this.parentOwner === null) this.retireDataBinding(existing, reason);

      return existing;
    }

    const operation = makeOwnerRetirementOperation(this, mode, reportSynchronous);
    bindOwnerRetirementAliases(this, operation);

    if (mode === "sync") observeSyncRetirementPromise(operation);

    registerOwnerRetirement(operation);

    this.destroy(reason, operation);
    operation.teardownFinished = true;

    if (
      operation.mode === "sync" &&
      operation.reportSynchronous &&
      !operation.synchronousReported &&
      operation.synchronousFailures.length
    ) {
      operation.synchronousReported = true;
      const report = reportRetirementFailures(
        operation,
        operation.failures.filter((failure) => !failure.asynchronous),
      );

      finishOwnerRetirement(operation);

      if (report.threw) throw report.reason;
    }

    finishOwnerRetirement(operation);

    return operation;
  }

  private destroy(reason: unknown, operation: OwnerRetirementOperation): void {
    const existing = ownerRetirementByOwner.get(this);
    const ownerOperation = existing ?? operation;
    const wasRetiring = this.state === "cleaning" || this.state === "destroyed";

    if (existing && existing !== operation) {
      if (this.parentOwner === null) this.retireDataBinding(ownerOperation, reason);

      bindOwnerRetirementAliases(this, existing);
      dependOnOwnerRetirement(operation, existing);

      return;
    }

    if (!wasRetiring) {
      bindOwnerRetirementAliases(this, operation);
      this.state = "cleaning";
    }

    if (this.parentOwner === null) this.retireDataBinding(ownerOperation, reason);

    if (wasRetiring) return;

    try {
      this.controller.abort(reason);
    } catch (error) {
      recordCleanupFailure(operation, error);
    }

    for (const cleanup of this.cleanups.splice(0).reverse()) this.invokeCleanup(cleanup, operation);

    for (const child of this.children.slice()) {
      try {
        child.destroy(reason, operation);
      } catch (error) {
        recordCleanupFailure(operation, error);
      }
    }

    for (const release of this.releases.splice(0).reverse()) this.invokeRelease(release, operation);

    if (this.styleLifecycle) {
      const binding = this.styleLifecycle;
      this.styleLifecycle = undefined;

      try {
        binding.lifecycle.released(this, binding.ownerId);
      } catch (error) {
        recordCleanupFailure(operation, error);
      }
    }

    for (const node of this.nodes) {
      try {
        node.parentNode?.removeChild(node);
      } catch (error) {
        recordCleanupFailure(operation, error);
      }
    }

    this.nodes.clear();
    this.publicationChecks.clear();
    this.commits.length = 0;
    resourceLifecycles.delete(this);
    this.state = "destroyed";

    if (this.parentOwner) {
      const index = this.parentOwner.children.indexOf(this);

      if (index >= 0) this.parentOwner.children.splice(index, 1);
    }
  }

  private invokeCleanup(cleanup: () => unknown, operation: OwnerRetirementOperation): void {
    const slot: CleanupFailureSlot = {
      asynchronous: false,
      incomplete: false,
      state: "pending",
    };

    operation.failures.push(slot);

    try {
      observeCleanupReturn(operation, slot, runCleanup(cleanup));
    } catch (reason) {
      recordCleanupFailureAtSlot(operation, slot, reason);
    }
  }

  private invokeRelease(release: () => unknown, operation: OwnerRetirementOperation): void {
    const slot: CleanupFailureSlot = {
      asynchronous: false,
      incomplete: false,
      state: "pending",
    };

    operation.failures.push(slot);

    try {
      observeCleanupReturn(operation, slot, release());
    } catch (reason) {
      recordCleanupFailureAtSlot(operation, slot, reason);
    }
  }

  private retireDataBinding(operation: OwnerRetirementOperation, reason: unknown): void {
    try {
      for (const error of retireDataBindingRoot(this, reason))
        recordCleanupFailure(operation, error);
    } catch (error) {
      recordCleanupFailure(operation, error);
    }
  }
}

/** @internal Associate a wrapper Promise with the Owner retirement it returns. */
export function registerOwnerDisposalPromiseAlias(owner: Owner, alias: Promise<void>): void {
  if (!actualOwnerInstances.has(owner))
    throw new TypeError("Owner disposal aliases require an actual Runtime Owner");

  if ((typeof alias !== "object" || alias === null) && typeof alias !== "function")
    throw new TypeError("Owner disposal aliases require a Promise object");

  const operation = ownerRetirementByOwner.get(owner);

  if (operation) {
    ownerRetirementByPromise.set(alias, operation);

    return;
  }

  const aliases = ownerRetirementAliasesByOwner.get(owner) ?? new Set<Promise<void>>();
  aliases.add(alias);
  ownerRetirementAliasesByOwner.set(owner, aliases);
}

/** @internal Retain an original failure when synchronous cleanup reporting also throws. */
export function disposeOwnerSyncPreservingFailure(owner: Owner, originalFailure: unknown): void {
  try {
    owner.disposeSync(originalFailure);
  } catch (cleanupFailure) {
    throw new AggregateError(
      [originalFailure, cleanupFailure],
      "Operation and synchronous cleanup reporting both failed",
    );
  }
}

/** @internal Register one resource hook while its Owner is being constructed. */
export function registerOwnerResourceLifecycle(
  owner: Owner,
  lifecycle: OwnerResourceLifecycle,
): () => void {
  owner.assertActive();

  if (owner.state !== "building" && owner.state !== "mounted" && owner.state !== "suspended")
    throw new RenderFault(
      "owner-resource-state",
      "Owner resources require a building, mounted, or suspended component",
    );

  const lifecycles = resourceLifecycles.get(owner) ?? new Set<OwnerResourceLifecycle>();

  lifecycles.add(lifecycle);

  resourceLifecycles.set(owner, lifecycles);

  let registered = true;

  const unregister = (): void => {
    if (!registered) return;

    registered = false;

    lifecycles.delete(lifecycle);

    if (lifecycles.size === 0 && resourceLifecycles.get(owner) === lifecycles)
      resourceLifecycles.delete(owner);
  };

  if (owner.state === "suspended") {
    try {
      lifecycle.suspended();
    } catch (error) {
      unregister();

      throw error;
    }
  }

  return unregister;
}

/** @internal Run every registered suspension hook, reporting failures after the pass. */
export function suspendOwnerResources(owner: Owner): void {
  const errors: unknown[] = [];

  for (const lifecycle of resourceLifecycles.get(owner) ?? []) {
    if (owner.state !== "suspended") break;

    try {
      lifecycle.suspended();
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length) throw new AggregateError(errors, "Owner resource suspension failed");
}

/** @internal Run every registered resume hook, reporting failures after the pass. */
export function resumeOwnerResources(owner: Owner): void {
  const errors: unknown[] = [];

  for (const lifecycle of resourceLifecycles.get(owner) ?? []) {
    if (owner.state !== "mounted") break;

    try {
      lifecycle.resumed();
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length) throw new AggregateError(errors, "Owner resource resumption failed");
}

/** Run cleanup without adding dependencies to a surrounding render or effect. */
export function runCleanup<T>(cleanup: () => T): T {
  const priorRenderOwners = renderOwners.splice(0);
  cleanupDepth++;

  try {
    return Signal.subtle.untrack(() => withoutWrites(cleanup));
  } finally {
    cleanupDepth--;

    renderOwners.push(...priorRenderOwners);
  }
}

/** Route a fault through nearest boundaries, forwarding a boundary's own failure upward. */
export function reportFault(owner: Owner, error: unknown): void {
  let current: Owner | null = owner;
  let failure = error;

  while (current) {
    if (current.errorHandler) {
      try {
        current.errorHandler(failure);

        return;
      } catch (error) {
        failure = error;
      }
    }

    current = current.parent;
  }

  owner.context.onError(failure);
}
