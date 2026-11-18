import { nativePromiseBrand } from "hesperia/internal/server-intrinsics";
import type { BindingContext, Graph } from "aeolia";
import type { Owner, RuntimeContext } from "./owner.ts";

type ConstructionState = "acquired" | "constructing" | "constructed" | "unacknowledged";

interface PhysicalOwnerFailureSlot {
  failure?: { readonly reason: unknown };
}

interface PhysicalOwnerRecord {
  readonly parent: PhysicalOwnerRecord | undefined;
  readonly queryPreparations: Set<PhysicalOwnerQueryPreparationRecord>;
  readonly taskInvocations: Set<PhysicalOwnerTaskRecord>;
  ownerRetirement?: PhysicalOwnerRetirementRecord;
  construction: ConstructionState;
  constructionFailure?: { readonly reason: unknown };
  closed: boolean;
  closeDepth: number;
}

interface PhysicalOwnerRetirementRecord {
  readonly original: Promise<void>;
  state: "pending" | "fulfilled" | "rejected" | "unacknowledged";
}

interface PhysicalOwnerTaskRecord {
  readonly lifetime: PhysicalServerLifetime;
  readonly owner: PhysicalOwnerRecord;
  state: "invoking" | "pending" | "fulfilled" | "rejected" | "unacknowledged";
  originalAssigned: boolean;
  original?: unknown;
  completionAssigned: boolean;
  completion?: Promise<unknown>;
  failure?: { readonly reason: unknown };
}

type PhysicalOwnerQueryPreparationState =
  | "invoking"
  | "pending"
  | "fulfilled"
  | "rejected"
  | "unacknowledged";

interface PhysicalOwnerQueryPreparationRecord {
  readonly lifetime: PhysicalServerLifetime;
  readonly owner: PhysicalOwnerRecord;
  state: PhysicalOwnerQueryPreparationState;
  originalAssigned: boolean;
  original?: unknown;
  completionAssigned: boolean;
  completion?: Promise<unknown>;
  pendingObservers: number;
  deliveryPending: boolean;
  rejected: boolean;
  failures: unknown[];
  observerInstalling: boolean;
}

interface PhysicalModuleImportRecord {
  readonly original: Promise<unknown>;
  state: "pending" | "fulfilled" | "rejected" | "unacknowledged";
  namespace?: unknown;
  failure?: { readonly reason: unknown };
}

/** @internal One immutable observation of an original import retained by a physical server lifetime. */
export interface PhysicalServerModuleImportSnapshot {
  /** Exact Promise returned by the original compiler-generated import expression. */
  readonly original: Promise<unknown>;
  /** Settlement of the original import observer installed by the physical lifetime. */
  readonly state: "pending" | "fulfilled" | "rejected" | "unacknowledged";
  /** Exact fulfilled namespace; present even when the fulfilled value is undefined. */
  readonly namespace?: unknown;
  /** Exact observer failure record, when the original import rejected or observation failed. */
  readonly failure?: { readonly reason: unknown };
}

interface PhysicalProgressiveControllerRecord {
  readonly original: Promise<void>;
  state: "pending" | "fulfilled" | "rejected" | "unacknowledged";
  failure?: { readonly reason: unknown };
}

const nativePromiseThen = Promise.prototype.then;
const NativePromise = Promise;
const nativeApply = Reflect.apply;

const contextLifetimes = new WeakMap<RuntimeContext, PhysicalServerLifetime>();
const physicalOwners = new WeakMap<
  Owner,
  {
    readonly lifetime: PhysicalServerLifetime;
    readonly record: PhysicalOwnerRecord;
  }
>();

/** @internal One constructor reservation issued by an actual native module or request ledger. */
export type PhysicalGraphConstruction = object;

/** @internal One native BindingContext constructor reserved under its actual Graph. */
export type PhysicalBindingContextConstruction = object;

/** @internal The pool's once-only context close and the original retirement completion. */
export interface NativeBindingContextRetirement {
  readonly tracked: boolean;
  readonly completion: Promise<void>;
  readonly original: unknown;
  retire(): void;
}

/** @internal One original operation reserved before invoking its provider. */
export type PhysicalNativeWork = object;

/** @internal One query input preparation retained under its actual Owner. */
export type PhysicalOwnerQueryPreparation = object;

/** @internal One task invocation retained under its actual Owner. */
export type PhysicalOwnerTaskInvocation = object;

type OriginalState =
  | "reserved"
  | "invoking"
  | "pending"
  | "fulfilled"
  | "rejected"
  | "unacknowledged";

interface NativeOriginalRecord {
  readonly scope: PhysicalNativeScope;
  readonly cleanup: boolean;
  readonly resource?: NativeResourceRecord;
  state: OriginalState;
  original?: Promise<unknown>;
  failure?: { readonly reason: unknown };
  cleanupFailures?: unknown[];
}

interface NativeResourceRecord {
  readonly scope: PhysicalNativeScope;
  readonly originatingRequest?: PhysicalNativeRequestLifetime;
  readonly originatingExecution?: PhysicalNativeExecutionLifetime;
  readonly parentGraph?: NativeResourceRecord;
  construction: "reserved" | "constructing" | "constructed" | "unacknowledged";
  checkedUse?: object;
  resource?: Graph | BindingContext;
  retire?: () => Promise<void>;
  retirement?: NativeOriginalRecord;
  retirementCompletion?: Promise<void>;
  resolveRetirementCompletion?: () => void;
  failure?: { readonly reason: unknown };
  cleanupFailures?: unknown[];
}

const graphConstructions = new WeakMap<PhysicalGraphConstruction, NativeResourceRecord>();
const contextConstructions = new WeakMap<
  PhysicalBindingContextConstruction,
  NativeResourceRecord
>();
const nativeGraphs = new WeakMap<Graph, NativeResourceRecord>();
const nativeWork = new WeakMap<PhysicalNativeWork, NativeOriginalRecord>();
const physicalOwnerQueryPreparations = new WeakMap<
  PhysicalOwnerQueryPreparation,
  PhysicalOwnerQueryPreparationRecord
>();
const physicalOwnerTaskInvocations = new WeakMap<
  PhysicalOwnerTaskInvocation,
  PhysicalOwnerTaskRecord
>();
const nativeRequests = new WeakMap<object, PhysicalNativeRequestLifetime>();
const nativeExecutions = new WeakMap<object, PhysicalNativeExecutionLifetime>();

function observeNativeOriginal(
  record: NativeOriginalRecord,
  original: unknown,
  onFailure?: (reason: unknown) => void,
  onSettled?: () => void,
): void {
  if (record.state !== "reserved" && record.state !== "invoking")
    throw new TypeError("A native original operation can be assigned only once");

  record.state = "pending";

  const reportFailure = (reason: unknown): void => {
    try {
      onFailure?.(reason);
    } catch {
      // Observation reporting cannot replace the native operation result.
    }
  };

  try {
    nativeApply(nativePromiseThen, original, [
      () => {
        record.state = "fulfilled";
        onSettled?.();

        if (!record.cleanupFailures?.length) record.scope.originals.delete(record);

        record.scope.finishRetirement();
      },
      (reason: unknown) => {
        record.state = "rejected";
        record.failure = { reason };
        onSettled?.();

        if (!record.cleanup && !record.cleanupFailures?.length)
          record.scope.originals.delete(record);

        reportFailure(reason);
        record.scope.finishRetirement();
      },
    ]);

    record.original = original as Promise<unknown>;
  } catch (reason) {
    record.state = "unacknowledged";
    record.failure = { reason };
    reportFailure(reason);
    onSettled?.();
  }

  record.scope.finishRetirement();
}

class PhysicalNativeScope {
  readonly retired: Promise<void>;
  readonly resources = new Set<NativeResourceRecord>();
  readonly originals = new Set<NativeOriginalRecord>();
  closing = false;
  admissionClosed = false;
  admissionFinished = false;
  private settled = false;
  private closeDepth = 0;
  private resolveRetired!: () => void;
  private rejectRetired!: (reason: unknown) => void;

  constructor(readonly module: PhysicalNativeModuleLifetime | undefined) {
    this.retired = new NativePromise<void>((resolve, reject) => {
      this.resolveRetired = resolve;
      this.rejectRetired = reject;
    });

    nativeApply(nativePromiseThen, this.retired, [undefined, () => undefined]);
  }

  assertAdmission(): void {
    if (this.admissionClosed) throw new TypeError("The native resource lifetime is closing");
  }

  fenceAdmission(): void {
    this.admissionClosed = true;
  }

  acquireGraphConstruction(): PhysicalGraphConstruction {
    this.assertAdmission();

    return this.reserveGraphConstruction();
  }

  protected reserveGraphConstruction(
    originatingRequest?: PhysicalNativeRequestLifetime,
    originatingExecution?: PhysicalNativeExecutionLifetime,
  ): PhysicalGraphConstruction {
    const ticket = Object.freeze({});
    const record: NativeResourceRecord = {
      scope: this,
      originatingRequest,
      originatingExecution,
      construction: "reserved",
    };

    this.resources.add(record);
    graphConstructions.set(ticket, record);

    return ticket;
  }

  assertResourceAdmission(resource: NativeResourceRecord): void {
    if (
      this.closing &&
      (resource.originatingRequest?.allowsModuleConstruction(this) ||
        resource.originatingExecution?.allowsModuleConstruction(this))
    )
      return;

    this.assertAdmission();
  }

  acquireOriginal(cleanup: boolean, resource: NativeResourceRecord): NativeOriginalRecord {
    this.assertResourceAdmission(resource);
    const record: NativeOriginalRecord = { scope: this, cleanup, state: "reserved" };

    this.originals.add(record);

    return record;
  }

  retireResource(record: NativeResourceRecord, explicitlyClosed = false): void {
    if (record.retirement || record.construction !== "constructed") return;
    if (
      !explicitlyClosed &&
      (record.originatingRequest?.holdsModuleResourcesOpen() ||
        record.originatingExecution?.holdsModuleResourcesOpen())
    )
      return;

    const original: NativeOriginalRecord = {
      scope: this,
      cleanup: true,
      resource: record,
      state: "invoking",
    };
    record.retirement = original;

    this.originals.add(original);

    try {
      observeNativeOriginal(original, record.retire!(), undefined, () =>
        record.resolveRetirementCompletion?.(),
      );
    } catch (reason) {
      original.state = "unacknowledged";
      original.failure = { reason };
      record.resolveRetirementCompletion?.();
    }

    this.finishRetirement();
  }

  beginClose(): void {
    if (this.closing) return;

    this.fenceAdmission();
    this.closing = true;
    this.closeDepth++;

    try {
      for (const record of this.resources) this.retireResource(record);
    } finally {
      this.closeDepth--;
    }

    this.finishRetirement();
  }

  finishAdmission(): void {
    if (!this.closing) throw new TypeError("Native admission finishes only after close begins");

    this.admissionFinished = true;

    for (const record of this.resources) {
      if (record.construction !== "reserved") continue;

      record.construction = "unacknowledged";
      record.failure = { reason: new Error("A native constructor reservation was never consumed") };
    }

    for (const record of this.originals) {
      if (record.state !== "reserved") continue;

      record.state = "unacknowledged";
      record.failure = { reason: new Error("A native operation supplied no original completion") };
    }

    this.finishRetirement();
  }

  protected childrenPending(): boolean {
    return false;
  }

  protected childFailures(): readonly unknown[] {
    return [];
  }

  finishRetirement(): void {
    if (
      !this.closing ||
      !this.admissionFinished ||
      this.settled ||
      this.closeDepth ||
      this.childrenPending() ||
      [...this.resources].some(
        (record) =>
          record.construction === "reserved" ||
          record.construction === "constructing" ||
          (record.construction === "constructed" && !record.retirement),
      ) ||
      [...this.originals].some(
        (record) =>
          record.state === "reserved" || record.state === "invoking" || record.state === "pending",
      )
    )
      return;

    const failures = [...this.childFailures()];

    for (const record of this.resources) {
      if (record.failure) failures.push(record.failure.reason);

      failures.push(...(record.cleanupFailures ?? []));
    }

    for (const record of this.originals) {
      failures.push(...(record.cleanupFailures ?? []));

      if (record.state === "unacknowledged") failures.push(record.failure?.reason);
      // Native Graph retirement already carries its child contexts' cleanup failures.
      else if (
        record.cleanup &&
        record.state === "rejected" &&
        record.resource?.parentGraph?.retirement?.state !== "rejected"
      )
        failures.push(record.failure?.reason);
    }

    this.settled = true;

    this.resources.clear();
    this.originals.clear();

    if (failures.length === 1) this.rejectRetired(failures[0]);
    else if (failures.length > 1)
      this.rejectRetired(new AggregateError(failures, "Native resource retirement failed"));
    else this.resolveRetired();
  }
}

/** @internal Native module resource ownership; the authentic parent retains this exact ledger. */
class PhysicalNativeModuleLifetime extends PhysicalNativeScope {
  private readonly requests = new Map<PhysicalNativeRequestLifetime, NativeOriginalRecord>();
  private readonly requestFailures: unknown[] = [];
  private readonly executions = new Map<PhysicalNativeExecutionLifetime, NativeOriginalRecord>();
  private readonly executionFailures: unknown[] = [];
  private retiringModuleResources = false;

  constructor() {
    super(undefined);
  }

  override acquireGraphConstruction(
    origin?: PhysicalNativeRequestLifetime | PhysicalNativeExecutionLifetime,
  ): PhysicalGraphConstruction {
    const request = origin === undefined ? undefined : nativeRequests.get(origin);
    const execution = origin === undefined ? undefined : nativeExecutions.get(origin);

    if (origin !== undefined && !request && !execution)
      throw new TypeError(
        "A module Graph continuation requires its original native execution owner",
      );

    if (request && !request.allowsModuleConstruction(this))
      throw new TypeError(
        "A module Graph continuation requires its original live request reservation",
      );

    if (execution && !execution.allowsModuleConstruction(this))
      throw new TypeError(
        "A module Graph continuation requires its original live execution reservation",
      );

    if (this.admissionFinished)
      throw new TypeError("The native module's original construction horizon has ended");

    if (origin === undefined) this.assertAdmission();

    return this.reserveGraphConstruction(request, execution);
  }

  /** Reserve during actual HTTP admission, before close; binding may occur after close. */
  acquireRequestLifetime(): PhysicalNativeRequestLifetime {
    this.assertAdmission();
    const request = new PhysicalNativeRequestLifetime(this);
    const original: NativeOriginalRecord = { scope: this, cleanup: true, state: "reserved" };

    this.requests.set(request, original);

    original.state = "pending";
    original.original = request.retired;

    try {
      nativeApply(nativePromiseThen, request.retired, [
        () => {
          this.requests.delete(request);

          this.finishRetirement();
        },
        (reason: unknown) => {
          this.requests.delete(request);
          this.requestFailures.push(reason);

          this.finishRetirement();
        },
      ]);
    } catch (reason) {
      this.requests.delete(request);
      this.requestFailures.push(reason);
    }

    return request;
  }

  /** Reserve one execution child before the static or independent producer calls out. */
  reserveExecutionChild(ownerKey: object): PhysicalNativeExecutionLifetime {
    this.assertAdmission();

    if (ownerKey === null || typeof ownerKey !== "object")
      throw new TypeError("A native execution child requires its exact opaque owner key");

    const execution = new PhysicalNativeExecutionLifetime(this, ownerKey);
    const original: NativeOriginalRecord = { scope: this, cleanup: true, state: "reserved" };

    this.executions.set(execution, original);

    original.state = "pending";
    original.original = execution.retired;

    try {
      nativeApply(nativePromiseThen, execution.retired, [
        () => {
          this.executions.delete(execution);

          this.finishRetirement();
        },
        (reason: unknown) => {
          this.executions.delete(execution);
          this.executionFailures.push(reason);

          this.finishRetirement();
        },
      ]);
    } catch (reason) {
      this.executions.delete(execution);
      this.executionFailures.push(reason);
    }

    return execution;
  }

  protected override childrenPending(): boolean {
    return (
      [...this.requests.values()].some((record) => record.state === "pending") ||
      [...this.executions.values()].some((record) => record.state === "pending")
    );
  }

  protected override childFailures(): readonly unknown[] {
    return [...this.requestFailures, ...this.executionFailures];
  }

  override retireResource(record: NativeResourceRecord, explicitlyClosed = false): void {
    if (
      record.originatingRequest === undefined &&
      record.originatingExecution === undefined &&
      this.childrenPending()
    )
      return;

    super.retireResource(record, explicitlyClosed);
  }

  override finishRetirement(): void {
    this.retireModuleResources();
    super.finishRetirement();
  }

  private retireModuleResources(): void {
    if (!this.closing || this.childrenPending() || this.retiringModuleResources) return;

    this.retiringModuleResources = true;

    try {
      for (const record of this.resources) {
        if (record.originatingRequest === undefined && record.originatingExecution === undefined)
          super.retireResource(record);
      }
    } finally {
      this.retiringModuleResources = false;
    }
  }

  retireRequestResources(request: PhysicalNativeRequestLifetime): void {
    if (!this.closing) return;

    for (const record of this.resources) {
      if (record.originatingRequest === request) this.retireResource(record);
    }

    this.finishRetirement();
  }

  retireExecutionResources(execution: PhysicalNativeExecutionLifetime): void {
    if (!this.closing) return;

    for (const record of this.resources) {
      if (record.originatingExecution === execution) this.retireResource(record);
    }

    this.finishRetirement();
  }
}

/** @internal A preadmitted HTTP use's inert, once-bindable request reservation. */
class PhysicalNativeRequestLifetime extends PhysicalNativeScope {
  private bound = false;
  private released = false;

  constructor(module: PhysicalNativeModuleLifetime) {
    super(module);

    nativeRequests.set(this, this);
  }

  bind(): void {
    if (!nativeRequests.has(this) || this.bound || this.released)
      throw new TypeError("A native request reservation binds one actual server lifetime");

    this.bound = true;
  }

  override assertAdmission(): void {
    if (!this.bound || this.released)
      throw new TypeError("Native request resources require the actual live bound session");

    super.assertAdmission();
  }

  allowsModuleConstruction(module: PhysicalNativeScope): boolean {
    return this.module === module && this.bound && !this.released && !this.admissionClosed;
  }

  holdsModuleResourcesOpen(): boolean {
    return this.bound && !this.closing;
  }

  override beginClose(): void {
    if (this.closing) return;

    super.beginClose();
    this.module!.retireRequestResources(this);
  }

  /** Actual HTTP retirement fences continuation admission; only never-bound reservations close. */
  releaseUnbound(): void {
    if (this.released) return;

    this.released = true;

    this.fenceAdmission();

    if (this.bound) return;

    this.beginClose();
    this.finishAdmission();
  }
}

class PhysicalNativeExecutionLifetime extends PhysicalNativeScope {
  private bound = false;
  private released = false;

  constructor(
    readonly module: PhysicalNativeModuleLifetime,
    readonly ownerKey: object,
  ) {
    super(module);

    nativeExecutions.set(this, this);
  }

  bind(): void {
    if (!nativeExecutions.has(this) || this.bound || this.released)
      throw new TypeError("A native execution reservation binds one actual server lifetime");

    this.bound = true;
  }

  override assertAdmission(): void {
    if (!this.bound || this.released)
      throw new TypeError("Native execution resources require the actual live bound session");

    super.assertAdmission();
  }

  allowsModuleConstruction(module: PhysicalNativeScope): boolean {
    return module === this.module && this.bound && !this.released && !this.admissionClosed;
  }

  allowsFreshExecution(): boolean {
    return (
      nativeExecutions.has(this) &&
      this.bound &&
      !this.released &&
      !this.admissionClosed &&
      !this.closing &&
      !this.admissionFinished
    );
  }

  holdsModuleResourcesOpen(): boolean {
    return this.bound && !this.closing;
  }

  closeAdmission(): void {
    this.fenceAdmission();
  }

  override beginClose(): void {
    if (this.closing) return;

    super.beginClose();
    this.module.retireExecutionResources(this);
  }

  releaseUnbound(): void {
    if (this.released) return;

    this.released = true;
    this.fenceAdmission();

    if (this.bound) return;

    this.beginClose();
    this.finishAdmission();
  }
}

export type {
  PhysicalNativeExecutionLifetime,
  PhysicalNativeModuleLifetime,
  PhysicalNativeRequestLifetime,
};

/** @internal Called by the genuine native parent before constructor or provider callouts. */
export function acquirePhysicalNativeModuleLifetime(): PhysicalNativeModuleLifetime {
  return new PhysicalNativeModuleLifetime();
}

/**
 * @internal Bind the exact checked-use object to its original Graph reservation
 * before constructor callouts.
 * @param ticket The genuine one-use Graph construction reservation.
 * @param checkedUse The exact opaque object that the caller has checked.
 * @throws {TypeError} If the ticket is foreign, no longer reserved, already bound,
 * or the use is not an object.
 */
export function bindPhysicalGraphConstructionUse(
  ticket: PhysicalGraphConstruction,
  checkedUse: object,
): void {
  const record = graphConstructions.get(ticket);

  if (
    !record ||
    record.construction !== "reserved" ||
    record.checkedUse !== undefined ||
    checkedUse === null ||
    typeof checkedUse !== "object"
  )
    throw new TypeError(
      "A checked native Graph use requires its unused original reservation and one object identity",
    );

  record.checkedUse = checkedUse;
}

/**
 * @internal Require the exact checked-use identity on its original Graph construction ticket.
 * With two arguments, this supports the pre-constructor check in reserved, constructing, or
 * constructed state. Supplying the actual Graph additionally requires that exact ticket to own
 * that exact constructed result.
 * @param ticket The genuine Graph construction reservation.
 * @param checkedUse The same opaque object previously bound to the ticket.
 * @param graph The optional actual Graph result to authenticate with the ticket and checked use.
 * @throws {TypeError} If the ticket, use, state, or supplied Graph identity does not match.
 */
export function assertPhysicalGraphConstructionUse(
  ticket: PhysicalGraphConstruction,
  checkedUse: object,
  graph?: Graph,
): void {
  const record = graphConstructions.get(ticket);

  if (
    !record ||
    checkedUse === null ||
    typeof checkedUse !== "object" ||
    record.checkedUse !== checkedUse ||
    (record.construction !== "reserved" &&
      record.construction !== "constructing" &&
      record.construction !== "constructed") ||
    (graph !== undefined &&
      (record.construction !== "constructed" ||
        record.resource !== graph ||
        nativeGraphs.get(graph) !== record))
  )
    throw new TypeError("A native Graph construction requires its exact checked use and result");
}

/** @internal Consume the actual compiler-issued reservation before its constructor callouts. */
export function beginPhysicalGraphConstruction(ticket: PhysicalGraphConstruction): void {
  const record = graphConstructions.get(ticket);

  if (!record || record.construction !== "reserved")
    throw new TypeError("A native Graph constructor requires its unused original reservation");

  record.construction = "constructing";
}

/** @internal Register the actual constructor result before recipe publication or escape. */
export function completePhysicalGraphConstruction(
  ticket: PhysicalGraphConstruction,
  graph: Graph,
): void {
  const record = graphConstructions.get(ticket);

  if (!record || record.construction !== "constructing" || nativeGraphs.has(graph))
    throw new TypeError("A native Graph must complete its original unique construction");

  record.resource = graph;
  const retire = graph.retire;

  if (typeof retire !== "function")
    throw new TypeError("The admitted native Graph lacks retirement");

  record.retire = () => nativeApply(retire, graph, []);
  record.construction = "constructed";

  nativeGraphs.set(graph, record);

  if (record.scope.closing) record.scope.retireResource(record);
}

/**
 * @internal Read checked-use provenance from the exact completed native Graph.
 * This historical identity does not establish current admission, liveness, or retirement authority.
 * @param graph The actual Graph returned by the admitted constructor.
 * @returns The original checked-use object, or undefined for an unrecorded or
 * unchecked Graph.
 */
export function readPhysicalGraphConstructionUse(graph: Graph): object | undefined {
  if (graph === null || typeof graph !== "object") return undefined;

  const record = nativeGraphs.get(graph);

  if (!record || record.construction !== "constructed" || record.resource !== graph)
    return undefined;

  return record.checkedUse;
}

/** @internal Preserve partial construction failure without discarding a returned native Graph. */
export function failPhysicalGraphConstruction(
  ticket: PhysicalGraphConstruction,
  reason: unknown,
): void {
  const record = graphConstructions.get(ticket);

  if (!record || record.construction === "constructed" || record.construction === "unacknowledged")
    return;

  record.construction = "unacknowledged";
  record.failure = { reason };

  record.scope.finishRetirement();
}

/** @internal Select the request's own Graph reservation only under the original module parent. */
/** @internal Reserve a local Graph from the same module-owned source Graph. */
export function acquirePhysicalExecutionGraphConstruction(
  execution: PhysicalNativeExecutionLifetime,
  sourceGraph: Graph,
): PhysicalGraphConstruction {
  const source = nativeGraphs.get(sourceGraph);

  if (!nativeExecutions.has(execution) || !source || source.scope !== execution.module)
    throw new TypeError("A native execution Graph requires its same-parent recorded source Graph");

  const ticket = execution.acquireGraphConstruction();

  if (source.checkedUse !== undefined) bindPhysicalGraphConstructionUse(ticket, source.checkedUse);

  return ticket;
}

export function acquirePhysicalRequestGraphConstruction(
  request: PhysicalNativeRequestLifetime,
  sourceGraph: Graph,
): PhysicalGraphConstruction {
  const source = nativeGraphs.get(sourceGraph);

  if (!nativeRequests.has(request) || !source || source.scope !== request.module)
    throw new TypeError("A native request Graph requires its same-parent recorded source Graph");

  const ticket = request.acquireGraphConstruction();

  if (source.checkedUse !== undefined) bindPhysicalGraphConstructionUse(ticket, source.checkedUse);

  return ticket;
}

/** @internal Reserve before invoking the actual BindingContext constructor. */
export function acquirePhysicalBindingContext(
  graph: Graph,
): PhysicalBindingContextConstruction | undefined {
  const parent = nativeGraphs.get(graph);

  if (!parent) return undefined;

  parent.scope.assertResourceAdmission(parent);
  const ticket = Object.freeze({});
  let resolveRetirementCompletion!: () => void;
  const retirementCompletion = new NativePromise<void>((resolve) => {
    resolveRetirementCompletion = resolve;
  });
  retirementCompletion.catch(() => undefined);
  const record: NativeResourceRecord = {
    scope: parent.scope,
    originatingRequest: parent.originatingRequest,
    parentGraph: parent,
    construction: "constructing",
    retirementCompletion,
    resolveRetirementCompletion,
  };

  parent.scope.resources.add(record);
  contextConstructions.set(ticket, record);

  return ticket;
}

/** @internal Retain the actual child context and its original retirement method before escape. */
export function completePhysicalBindingContext(
  ticket: PhysicalBindingContextConstruction | undefined,
  context: BindingContext,
): void {
  if (!ticket) return;

  const record = contextConstructions.get(ticket);

  if (!record || record.construction !== "constructing")
    throw new TypeError("A native BindingContext requires its original construction record");

  record.resource = context;
  const retire = context.retire;

  if (typeof retire !== "function")
    throw new TypeError("The admitted native context lacks retirement");

  record.retire = () => nativeApply(retire, context, []);
  record.construction = "constructed";

  if (record.scope.closing) record.scope.retireResource(record);
}

/** @internal Bind one pool to its actual captured context retirement. */
export function bindPhysicalBindingContextRetirement(
  ticket: PhysicalBindingContextConstruction | undefined,
  context: BindingContext,
): NativeBindingContextRetirement {
  if (ticket) {
    const record = contextConstructions.get(ticket);

    if (
      !record ||
      record.construction !== "constructed" ||
      record.resource !== context ||
      !record.retirementCompletion
    )
      throw new TypeError(
        "A physical BindingContext join requires its exact completed construction",
      );

    let requested = false;

    return Object.freeze({
      tracked: true,
      completion: record.retirementCompletion,
      get original() {
        return record.retirement?.original;
      },
      retire(): void {
        if (requested) return;

        requested = true;
        record.scope.retireResource(record, true);
      },
    });
  }

  const retire = context.retire;

  if (typeof retire !== "function")
    throw new TypeError("A pooled BindingContext lacks its actual retirement method");

  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  let state: "ready" | "invoking" | "settled" = "ready";
  let original: unknown;
  const completion = new NativePromise<void>((success, failure) => {
    resolve = success;
    reject = failure;
  });

  completion.catch(() => undefined);

  return Object.freeze({
    tracked: false,
    completion,
    get original() {
      return original;
    },
    retire(): void {
      if (state !== "ready") return;

      state = "invoking";

      try {
        original = nativeApply(retire, context, []);

        const promiseBrand = nativePromiseBrand;

        if (promiseBrand !== undefined && !promiseBrand(original))
          throw new TypeError("A BindingContext retirement must return its native Promise");

        // The captured native then method validates the receiver when the browser leaf lacks the Node brand helper.
        nativeApply(nativePromiseThen, original, [
          () => {
            state = "settled";
            resolve();
          },
          (reason: unknown) => {
            state = "settled";
            reject(reason);
          },
        ]);
      } catch (reason) {
        state = "settled";
        reject(reason);
      }
    },
  });
}

/** @internal Retain a partial context constructor's original failure. */
export function failPhysicalBindingContext(
  ticket: PhysicalBindingContextConstruction | undefined,
  reason: unknown,
): void {
  const record = ticket ? contextConstructions.get(ticket) : undefined;

  if (!record || record.construction === "constructed" || record.construction === "unacknowledged")
    return;

  record.construction = "unacknowledged";
  record.failure = { reason };
  record.resolveRetirementCompletion?.();

  record.scope.finishRetirement();
}

/** @internal Called at actual context closure, never at a temporary shared-lease zero. */
export function retirePhysicalBindingContext(
  ticket: PhysicalBindingContextConstruction | undefined,
): boolean {
  const record = ticket ? contextConstructions.get(ticket) : undefined;

  if (!record) return false;

  record.scope.retireResource(record, true);

  return true;
}

/** @internal Preserve adapter cleanup failures reported outside Aeolia's native cleanup calls. */
export function recordPhysicalBindingContextCleanupFailure(
  ticket: PhysicalBindingContextConstruction | undefined,
  reason: unknown,
): void {
  const record = ticket ? contextConstructions.get(ticket) : undefined;

  if (!record) return;

  (record.cleanupFailures ??= []).push(reason);

  record.scope.finishRetirement();
}

/** @internal Acquire before calling a provider; unregistered browser Graphs gain no native owner. */
export function acquirePhysicalNativeWork(
  graph: Graph,
  cleanup = false,
): PhysicalNativeWork | undefined {
  const parent = nativeGraphs.get(graph);

  if (!parent) return undefined;

  const ticket = Object.freeze({});

  const record = parent.scope.acquireOriginal(cleanup, parent);
  record.state = "invoking";

  nativeWork.set(ticket, record);

  return ticket;
}

/**
 * @internal Reserve one operation under its exact admitted request or execution child.
 * Use `cleanup: true` only for an operation-retirement original whose rejection reports actual
 * owned cleanup failure; a command result rejection remains on its separate result channel.
 */
export function acquirePhysicalNativeExecutionWork(
  lifetime: PhysicalNativeRequestLifetime | PhysicalNativeExecutionLifetime,
  cleanup = false,
): PhysicalNativeWork {
  const request = nativeRequests.get(lifetime);
  const execution = nativeExecutions.get(lifetime);

  if (request !== lifetime && execution !== lifetime)
    throw new TypeError(
      "A provider operation requires its exact native request or execution child",
    );

  lifetime.assertAdmission();

  const ticket = Object.freeze({});
  const record: NativeOriginalRecord = { scope: lifetime, cleanup, state: "reserved" };

  lifetime.originals.add(record);
  nativeWork.set(ticket, record);

  return ticket;
}

/**
 * @internal Mark an admitted native work reservation before its preparation callout.
 * The invoking record remains pending through reentrant admission close, so the actual original
 * can still be retained afterward. This does not assign a result or fabricate retirement.
 * @param ticket The reserved native work ticket for the exact request or execution lifetime.
 * @throws {TypeError} If the ticket is foreign or no longer reserved.
 */
export function beginPhysicalNativeWork(ticket: PhysicalNativeWork): void {
  const record = nativeWork.get(ticket);

  if (!record || record.state !== "reserved")
    throw new TypeError("A native work preparation requires its unused original reservation");

  record.state = "invoking";
}

/**
 * @internal Observe the actual native original without assimilating a replacement thenable.
 * A rejection or failure to install this observer is retained on its admitted native-work ticket.
 * @param onFailure Optional single diagnostic callback for the same original failure. Its throw is ignored.
 */
export function retainPhysicalNativeWork(
  ticket: PhysicalNativeWork | undefined,
  original: unknown,
  onFailure?: (reason: unknown) => void,
): void {
  const record = ticket ? nativeWork.get(ticket) : undefined;

  if (record) observeNativeOriginal(record, original, onFailure);
}

/** @internal A synchronous provider return acknowledges only that exact synchronous invocation. */
export function completePhysicalNativeWork(ticket: PhysicalNativeWork | undefined): void {
  const record = ticket ? nativeWork.get(ticket) : undefined;

  if (!record || (record.state !== "reserved" && record.state !== "invoking")) return;

  record.state = "fulfilled";

  if (!record.cleanupFailures?.length) record.scope.originals.delete(record);

  record.scope.finishRetirement();
}

/** @internal Missing original completion or partial invocation failure stays unacknowledged. */
export function failPhysicalNativeWork(
  ticket: PhysicalNativeWork | undefined,
  reason: unknown,
): void {
  const record = ticket ? nativeWork.get(ticket) : undefined;

  if (!record || (record.state !== "reserved" && record.state !== "invoking")) return;

  record.state = "unacknowledged";
  record.failure = { reason };

  record.scope.finishRetirement();
}

/** @internal Retain actual provider cleanup failures without acknowledging its missing work. */
export function recordPhysicalNativeWorkCleanupFailure(
  ticket: PhysicalNativeWork | undefined,
  reason: unknown,
): void {
  const record = ticket ? nativeWork.get(ticket) : undefined;

  if (!record) return;

  (record.cleanupFailures ??= []).push(reason);

  record.scope.finishRetirement();
}

function physicalOwnerQueryPreparationRecord(
  ticket: PhysicalOwnerQueryPreparation | undefined,
): PhysicalOwnerQueryPreparationRecord | undefined {
  if (ticket === undefined) return undefined;

  const record = physicalOwnerQueryPreparations.get(ticket);

  if (!record)
    throw new TypeError("A native query preparation requires its original issued ticket");

  return record;
}

/** @internal Reserve under the actual Owner immediately before input preparation. */
export function acquirePhysicalOwnerQueryPreparation(
  owner: Owner,
): PhysicalOwnerQueryPreparation | undefined {
  const physical = physicalOwners.get(owner);

  if (!physical || nativePromiseBrand === undefined) return undefined;

  if (
    physical.record.closed ||
    physical.record.construction !== "constructed" ||
    !physical.lifetime.isAdmissionOpen()
  )
    throw new TypeError("A native query preparation requires its actual live constructed Owner");

  const ticket: PhysicalOwnerQueryPreparation = Object.freeze({});
  const record: PhysicalOwnerQueryPreparationRecord = {
    lifetime: physical.lifetime,
    owner: physical.record,
    state: "invoking",
    originalAssigned: false,
    completionAssigned: false,
    pendingObservers: 0,
    deliveryPending: false,
    rejected: false,
    failures: [],
    observerInstalling: false,
  };

  physical.record.queryPreparations.add(record);
  physicalOwnerQueryPreparations.set(ticket, record);

  return ticket;
}

function finishPhysicalOwnerQueryPreparationObserver(
  record: PhysicalOwnerQueryPreparationRecord,
  rejected: boolean,
): void {
  if (record.state !== "pending") return;

  record.pendingObservers--;
  record.rejected ||= rejected;

  finishPhysicalOwnerQueryPreparation(record);
}

function finishPhysicalOwnerQueryPreparation(record: PhysicalOwnerQueryPreparationRecord): void {
  if (
    record.state === "pending" &&
    record.pendingObservers === 0 &&
    !record.deliveryPending &&
    !record.observerInstalling
  ) {
    if (record.failures.length > 0) record.state = "unacknowledged";
    else record.state = record.rejected ? "rejected" : "fulfilled";

    if (record.state !== "unacknowledged") record.owner.queryPreparations.delete(record);
  }

  record.lifetime.finishRetirement();
}

function observePhysicalOwnerQueryPreparation(
  record: PhysicalOwnerQueryPreparationRecord,
  original: unknown,
): void {
  record.pendingObservers++;
  record.observerInstalling = true;

  try {
    nativeApply(nativePromiseThen, original, [
      () => finishPhysicalOwnerQueryPreparationObserver(record, false),
      () => finishPhysicalOwnerQueryPreparationObserver(record, true),
    ]);
  } catch (reason) {
    record.pendingObservers--;
    record.failures.push(reason);
  } finally {
    record.observerInstalling = false;

    finishPhysicalOwnerQueryPreparation(record);
  }
}

/** @internal Record the raw return before property access, then its one normalized completion. */
export function retainPhysicalOwnerQueryPreparation(
  ticket: PhysicalOwnerQueryPreparation | undefined,
  original: unknown,
  completion?: Promise<unknown>,
): void {
  const record = physicalOwnerQueryPreparationRecord(ticket);

  if (!record) return;

  if (record.state !== "invoking")
    throw new TypeError("A native query preparation requires its original invocation");

  if (!record.originalAssigned) {
    if (completion !== undefined)
      throw new TypeError("A native query preparation records its raw result first");

    record.original = original;
    record.originalAssigned = true;

    if (nativePromiseBrand === undefined) {
      record.failures.push(
        new TypeError("A native query preparation requires its native Promise classifier"),
      );

      return;
    }

    try {
      if (nativePromiseBrand(original)) observePhysicalOwnerQueryPreparation(record, original);
    } catch (reason) {
      record.failures.push(reason);
    }

    return;
  }

  if (
    !Object.is(record.original, original) ||
    completion === undefined ||
    record.completionAssigned
  )
    throw new TypeError("A native query preparation completion must match its original result");

  record.completionAssigned = true;
  record.completion = completion;
  record.deliveryPending = true;

  if (completion !== record.original) observePhysicalOwnerQueryPreparation(record, completion);
}

/** @internal Finish synchronous setup without clearing pending native observations. */
export function completePhysicalOwnerQueryPreparation(
  ticket: PhysicalOwnerQueryPreparation | undefined,
): void {
  const record = physicalOwnerQueryPreparationRecord(ticket);

  if (!record || record.state !== "invoking") return;

  record.state = "pending";

  finishPhysicalOwnerQueryPreparation(record);
}

/** @internal Close delivery after its first callback or synchronous registration failure. */
export function completePhysicalOwnerQueryPreparationDelivery(
  ticket: PhysicalOwnerQueryPreparation | undefined,
): void {
  const record = physicalOwnerQueryPreparationRecord(ticket);

  if (!record || !record.deliveryPending) return;

  record.deliveryPending = false;

  finishPhysicalOwnerQueryPreparation(record);
}

class PhysicalServerLifetime {
  readonly retired: Promise<void>;
  owner: Owner | undefined;
  private readonly records: PhysicalOwnerRecord[] = [];
  readonly cleanupFailures: PhysicalOwnerFailureSlot[] = [];
  private readonly imports = new Map<Promise<unknown>, PhysicalModuleImportRecord>();
  private readonly nativeRetirement: PhysicalModuleImportRecord | undefined;
  private progressiveControllerSettlement: PhysicalProgressiveControllerRecord | undefined;
  private construction: ConstructionState = "acquired";
  private constructionFailure: { readonly reason: unknown } | undefined;
  private closeDepth = 0;
  private closing = false;
  private settled = false;
  private resolveRetired!: () => void;
  private rejectRetired!: (reason: unknown) => void;

  constructor(
    readonly nativeRequest?: PhysicalNativeRequestLifetime,
    readonly nativeExecution?: PhysicalNativeExecutionLifetime,
  ) {
    if (nativeRequest !== undefined && nativeExecution !== undefined)
      throw new TypeError("A server lifetime binds one native request or execution owner");

    if (nativeRequest !== undefined) {
      if (!nativeRequests.has(nativeRequest))
        throw new TypeError("A server lifetime requires an original native request reservation");

      if (nativePromiseBrand === undefined)
        throw new TypeError("An admitted native request requires its native Promise classifier");

      nativeRequest.bind();
    }

    if (nativeExecution !== undefined) {
      if (!nativeExecutions.has(nativeExecution))
        throw new TypeError("A server lifetime requires an original native execution reservation");

      nativeExecution.bind();
    }

    this.retired = new NativePromise<void>((resolve, reject) => {
      this.resolveRetired = resolve;
      this.rejectRetired = reject;
    });

    nativeApply(nativePromiseThen, this.retired, [undefined, () => undefined]);

    const nativeOriginal = nativeRequest?.retired ?? nativeExecution?.retired;

    if (nativeOriginal) {
      const record: PhysicalModuleImportRecord = {
        original: nativeOriginal,
        state: "pending",
      };
      this.nativeRetirement = record;

      try {
        nativeApply(nativePromiseThen, record.original, [
          () => {
            record.state = "fulfilled";

            this.finishRetirement();
          },
          (reason: unknown) => {
            record.state = "rejected";
            record.failure = { reason };

            this.finishRetirement();
          },
        ]);
      } catch (reason) {
        record.state = "unacknowledged";
        record.failure = { reason };
      }
    }
  }

  beginConstruction(): void {
    if (this.construction !== "acquired" || this.closing)
      throw new TypeError("A server render lifetime permits one construction before close");

    this.construction = "constructing";
  }

  bindContext(context: RuntimeContext): void {
    if (this.construction !== "constructing" || contextLifetimes.has(context))
      throw new TypeError("A server runtime requires its original construction record");

    contextLifetimes.set(context, this);
  }

  completeConstruction(): void {
    this.construction = "constructed";

    this.finishRetirement();
  }

  failConstruction(reason: unknown): void {
    this.construction = "unacknowledged";
    this.constructionFailure = { reason };

    this.finishRetirement();
  }

  acquireOwner(owner: Owner, parent: Owner | null): void {
    const parentRecord = parent ? physicalOwners.get(parent) : undefined;

    if (
      (parent && parentRecord?.lifetime !== this) ||
      (!parent && this.owner) ||
      (parentRecord?.record.closed && parentRecord.record.construction !== "constructing") ||
      (this.closing &&
        this.construction !== "constructing" &&
        parentRecord?.record.construction !== "constructing")
    )
      throw new TypeError("A physical Owner requires an admitted server construction");

    const record: PhysicalOwnerRecord = {
      parent: parentRecord?.record,
      queryPreparations: new Set(),
      taskInvocations: new Set(),
      construction: "constructing",
      closed: false,
      closeDepth: 0,
    };

    this.records.push(record);

    physicalOwners.set(owner, { lifetime: this, record });

    if (!parent) this.owner = owner;
  }

  beginClose(): void {
    this.nativeRequest?.fenceAdmission();
    this.nativeExecution?.closeAdmission();
    this.closing = true;
    this.closeDepth++;
  }

  isAdmissionOpen(): boolean {
    return !this.closing;
  }

  /** @internal Snapshot this lifetime existing originals without issuing or observing imports. */
  readModuleImports(): readonly PhysicalServerModuleImportSnapshot[] {
    return Object.freeze(
      [...this.imports.values()].map((record) =>
        Object.freeze({
          original: record.original,
          state: record.state,
          ...(record.state === "fulfilled" ? { namespace: record.namespace } : {}),
          ...(record.failure ? { failure: record.failure } : {}),
        }),
      ),
    );
  }

  retainModuleImport(original: Promise<unknown>): void {
    if (this.imports.has(original)) return;

    const record: PhysicalModuleImportRecord = { original, state: "pending" };

    this.imports.set(original, record);

    try {
      nativeApply(nativePromiseThen, original, [
        (namespace: unknown) => {
          record.namespace = namespace;
          record.state = "fulfilled";

          this.finishRetirement();
        },
        (reason: unknown) => {
          record.state = "rejected";
          record.failure = { reason };

          this.finishRetirement();
        },
      ]);
    } catch (reason) {
      record.state = "unacknowledged";
      record.failure = { reason };
    }

    this.finishRetirement();
  }

  /** @internal Retain the exact controller original once during session construction. */
  retainProgressiveControllerSettlement(original: Promise<void>): void {
    if (this.construction !== "constructing" || this.closing)
      throw new TypeError("A progressive controller requires an active server construction");

    if (this.progressiveControllerSettlement)
      throw new TypeError(
        "A server lifetime already retains its progressive controller settlement",
      );

    const record: PhysicalProgressiveControllerRecord = {
      original,
      state: "pending",
    };
    this.progressiveControllerSettlement = record;

    try {
      nativeApply(nativePromiseThen, original, [
        () => {
          record.state = "fulfilled";

          this.finishRetirement();
        },
        (reason: unknown) => {
          record.state = "rejected";
          record.failure = { reason };

          this.finishRetirement();
        },
      ]);
    } catch (reason) {
      record.state = "unacknowledged";
      record.failure = { reason };

      this.finishRetirement();

      throw reason;
    }

    this.finishRetirement();
  }

  finishClose(): void {
    this.closeDepth--;

    this.finishRetirement();
  }

  private hasPendingOwnerShutdown(): boolean {
    return this.records.some(
      (record) =>
        record.construction === "constructing" ||
        record.closeDepth !== 0 ||
        [...record.taskInvocations].some((task) => task.state === "invoking") ||
        (record.construction === "constructed" && !record.closed),
    );
  }

  private hasPendingOwnerOriginals(): boolean {
    return this.records.some(
      (record) =>
        record.ownerRetirement?.state === "pending" ||
        [...record.taskInvocations].some(
          (task) => task.state === "invoking" || task.state === "pending",
        ),
    );
  }

  finishRetirement(): void {
    if (
      this.nativeRequest &&
      this.closing &&
      this.closeDepth === 0 &&
      this.construction !== "constructing" &&
      !this.hasPendingOwnerShutdown()
    ) {
      this.nativeRequest.beginClose();
      this.nativeRequest.finishAdmission();
    }

    if (
      this.nativeExecution &&
      this.closing &&
      this.closeDepth === 0 &&
      this.construction !== "constructing" &&
      !this.hasPendingOwnerShutdown()
    ) {
      this.nativeExecution.beginClose();
      this.nativeExecution.finishAdmission();
    }

    if (
      !this.closing ||
      this.settled ||
      this.closeDepth !== 0 ||
      this.construction === "constructing" ||
      this.hasPendingOwnerShutdown() ||
      this.hasPendingOwnerOriginals() ||
      this.records.some((record) =>
        [...record.queryPreparations].some(
          (preparation) =>
            preparation.state === "invoking" ||
            preparation.state === "pending" ||
            preparation.deliveryPending ||
            preparation.observerInstalling,
        ),
      ) ||
      [...this.imports.values()].some((record) => record.state === "pending") ||
      this.progressiveControllerSettlement?.state === "pending" ||
      this.nativeRetirement?.state === "pending"
    )
      return;

    const failures: unknown[] = [];

    if (
      this.nativeRetirement?.state === "rejected" ||
      this.nativeRetirement?.state === "unacknowledged"
    )
      failures.push(this.nativeRetirement.failure?.reason);

    if (this.constructionFailure)
      failures.push(
        new Error("Server runtime construction is unacknowledged", {
          cause: this.constructionFailure.reason,
        }),
      );

    const progressiveController = this.progressiveControllerSettlement;

    if (
      progressiveController?.state === "rejected" ||
      progressiveController?.state === "unacknowledged"
    )
      failures.push(progressiveController.failure?.reason);

    for (const record of this.records) {
      if (!this.constructionFailure && record.constructionFailure)
        failures.push(
          new Error("Server Owner construction is unacknowledged", {
            cause: record.constructionFailure.reason,
          }),
        );

      for (const preparation of record.queryPreparations) {
        if (preparation.state === "unacknowledged") {
          for (const reason of preparation.failures)
            failures.push(
              new Error("Server query input preparation observation is unacknowledged", {
                cause: reason,
              }),
            );
        }
      }

      for (const task of record.taskInvocations) {
        if (task.state === "unacknowledged" && task.failure)
          failures.push(
            new Error("Server task invocation completion observation is unacknowledged", {
              cause: task.failure.reason,
            }),
          );
      }
    }

    for (const slot of this.cleanupFailures)
      if (slot.failure) failures.push(slot.failure.reason);

    for (const record of this.imports.values()) {
      if (record.state === "unacknowledged")
        failures.push(
          new Error("Server module import observation is unacknowledged", {
            cause: record.failure?.reason,
          }),
        );
    }

    this.settled = true;

    if (failures.length === 1) {
      this.rejectRetired(failures[0]);

      return;
    }

    if (failures.length > 1) {
      this.rejectRetired(new AggregateError(failures, "Server runtime cleanup failed"));

      return;
    }

    if (this.construction === "acquired") {
      this.resolveRetired();

      return;
    }

    this.resolveRetired();
  }
}

/** @internal Acquire the inert record before server construction can call authored code. */
export function acquirePhysicalServerLifetime(
  nativeOwner?: PhysicalNativeRequestLifetime | PhysicalNativeExecutionLifetime,
): PhysicalServerLifetime {
  if (nativeOwner === undefined) return new PhysicalServerLifetime();

  const request = nativeRequests.get(nativeOwner);
  if (request) return new PhysicalServerLifetime(request);

  const execution = nativeExecutions.get(nativeOwner);
  if (execution) return new PhysicalServerLifetime(undefined, execution);

  throw new TypeError("A server lifetime requires its original native request or execution owner");
}

/** @internal Only the actual constructed Owner can recover its admitted native request lifetime. */
export function physicalNativeRequestForOwner(
  owner: Owner,
): PhysicalNativeRequestLifetime | undefined {
  return physicalOwners.get(owner)?.lifetime.nativeRequest;
}

/** @internal Only the actual constructed Owner can recover its admitted native execution lifetime. */
export function physicalNativeExecutionForOwner(
  owner: Owner,
): PhysicalNativeExecutionLifetime | undefined {
  return physicalOwners.get(owner)?.lifetime.nativeExecution;
}

/** @internal Retain actual server Owners independently of their mutable logical tree. */
export function acquirePhysicalOwner(
  owner: Owner,
  context: RuntimeContext,
  parent: Owner | null,
): void {
  contextLifetimes.get(context)?.acquireOwner(owner, parent);
}

function physicalOwnerTaskRecord(
  ticket: PhysicalOwnerTaskInvocation | undefined,
): PhysicalOwnerTaskRecord | undefined {
  if (ticket === undefined) return undefined;

  const record = physicalOwnerTaskInvocations.get(ticket);

  if (!record)
    throw new TypeError("A native task invocation requires its original Owner reservation");

  return record;
}

/**
 * @internal Reserve one Task invocation under its actual physical Owner before operation callout.
 * @param owner The genuine Owner receiving the invocation.
 * @returns A one-use reservation, or undefined when the Owner has no physical native lifetime.
 * @throws TypeError when a recorded Owner is not live and constructed.
 */
export function acquirePhysicalOwnerTaskInvocation(
  owner: Owner,
): PhysicalOwnerTaskInvocation | undefined {
  const physical = physicalOwners.get(owner);

  if (!physical) return undefined;

  if (
    physical.record.closed ||
    physical.record.construction !== "constructed" ||
    !physical.lifetime.isAdmissionOpen()
  )
    throw new TypeError("A native task invocation requires its actual live constructed Owner");

  const ticket: PhysicalOwnerTaskInvocation = Object.freeze({});
  const record: PhysicalOwnerTaskRecord = {
    lifetime: physical.lifetime,
    owner: physical.record,
    state: "invoking",
    originalAssigned: false,
    completionAssigned: false,
  };

  physical.record.taskInvocations.add(record);
  physicalOwnerTaskInvocations.set(ticket, record);

  return ticket;
}

/**
 * @internal Retain the exact raw Task result before its one existing Promise.resolve normalization.
 * @param ticket The reservation issued for this actual Owner invocation.
 * @param original The exact synchronous result or PromiseLike returned by the Task operation.
 * @throws TypeError when the ticket is foreign, already used, or outside its invocation state.
 */
export function retainPhysicalOwnerTaskOriginal(
  ticket: PhysicalOwnerTaskInvocation | undefined,
  original: unknown,
): void {
  const record = physicalOwnerTaskRecord(ticket);

  if (!record) return;
  if (record.state !== "invoking" || record.originalAssigned)
    throw new TypeError("A native task invocation retains its raw result once");

  record.original = original;
  record.originalAssigned = true;
}

/**
 * @internal Observe the one normalized Task completion without replacing its public result.
 * @param ticket The reservation issued for this actual Owner invocation.
 * @param original The same raw result already retained for the ticket.
 * @param completion The single existing Promise.resolve result returned to Task handlers.
 * @throws TypeError when the original identity or one-use state does not match. Observer failures
 * remain recorded as incomplete physical work.
 */
export function retainPhysicalOwnerTaskCompletion(
  ticket: PhysicalOwnerTaskInvocation | undefined,
  original: unknown,
  completion: Promise<unknown>,
): void {
  const record = physicalOwnerTaskRecord(ticket);

  if (!record) return;
  if (
    record.state !== "invoking" ||
    !record.originalAssigned ||
    !Object.is(record.original, original) ||
    record.completionAssigned
  )
    throw new TypeError("A native task completion must match its retained raw result");

  record.completion = completion;
  record.completionAssigned = true;
  record.state = "pending";

  try {
    nativeApply(nativePromiseThen, completion, [
      () => settlePhysicalOwnerTask(record, "fulfilled"),
      () => settlePhysicalOwnerTask(record, "rejected"),
    ]);
  } catch (reason) {
    record.state = "unacknowledged";
    record.failure = { reason };
  }

  record.lifetime.finishRetirement();
}

/**
 * @internal Finish an invocation that threw synchronously; Task keeps the original semantic error.
 * @param ticket The reservation issued before that operation callout.
 * @throws TypeError when a raw result was already assigned or the ticket state has advanced.
 */
export function completePhysicalOwnerTaskInvocation(
  ticket: PhysicalOwnerTaskInvocation | undefined,
): void {
  const record = physicalOwnerTaskRecord(ticket);

  if (!record) return;
  if (record.state !== "invoking" || record.originalAssigned)
    throw new TypeError("Only a synchronous native task invocation can finish without a result");

  settlePhysicalOwnerTask(record, "fulfilled");
}

/**
 * @internal Retain failure to observe an admitted Task result as incomplete physical work.
 * @param ticket The invocation reservation whose raw return could not be observed.
 * @param reason The exact observation or normalization failure, including undefined.
 */
export function failPhysicalOwnerTaskObservation(
  ticket: PhysicalOwnerTaskInvocation | undefined,
  reason: unknown,
): void {
  const record = physicalOwnerTaskRecord(ticket);

  if (!record || record.state === "unacknowledged") return;

  record.state = "unacknowledged";
  record.failure = { reason };
  record.lifetime.finishRetirement();
}

function settlePhysicalOwnerTask(
  record: PhysicalOwnerTaskRecord,
  state: "fulfilled" | "rejected",
): void {
  if (record.state !== "pending" && record.state !== "invoking") return;

  record.state = state;
  record.original = undefined;
  record.completion = undefined;
  record.owner.taskInvocations.delete(record);
  record.lifetime.finishRetirement();
}

/** @internal Physical admission does not change existing boundary error routing. */
export function physicalOwnerAdmissionOpen(owner: Owner): boolean {
  return physicalOwners.get(owner)?.lifetime.isAdmissionOpen() !== false;
}

/**
 * @internal Read the existing same-session import records of an actual physical server Owner.
 * Frozen snapshots preserve original Promise, state, fulfilled namespace, and failure references.
 * This reader installs no import observer or new Promise. A missing physical Owner remains
 * unavailable rather than being represented as an empty import set.

 * @param owner The actual Owner belonging to the physical server session.
 * @returns Frozen snapshots for that session, or undefined when this Owner has no physical owner.
 */
export function readPhysicalServerModuleImports(
  owner: Owner,
): readonly PhysicalServerModuleImportSnapshot[] | undefined {
  return physicalOwners.get(owner)?.lifetime.readModuleImports();
}

/**
 * @internal Retain the compiler's original import Promise under its actual server lifetime.
 * Logical Owner cancellation does not cancel native module evaluation. Browser Owners have no
 * physical server record and keep their existing import behavior. An observation failure is
 * retained for retirement without replacing the import's original return value or rejection.
 *
 * @param owner The actual Owner executing the compiler-generated import expression.
 * @param original The exact Promise returned by that expression.
 * @returns Nothing. The awaiting continuation keeps its original Promise and error channel.
 */
export function retainPhysicalServerModuleImport(
  owner: Owner,
  original: Promise<unknown>,
): void {
  physicalOwners.get(owner)?.lifetime.retainModuleImport(original);
}

/** @internal Finish only the synchronous Owner constructor, without acknowledging its work. */
export function completePhysicalOwnerConstruction(owner: Owner): void {
  const physical = physicalOwners.get(owner);

  if (!physical) return;

  physical.record.construction = "constructed";

  physical.lifetime.finishRetirement();
}

/** @internal Preserve a partial Owner even when its constructor never returns. */
export function failPhysicalOwnerConstruction(
  owner: Owner,
  reason: unknown,
): void {
  const physical = physicalOwners.get(owner);

  if (!physical) return;

  physical.record.construction = "unacknowledged";
  physical.record.constructionFailure = { reason };

  physical.lifetime.finishRetirement();
}

/**
 * @internal Bind one actual Owner retirement Promise before destroy cleanup callouts begin.
 * Rejection causes are already retained by their cleanup records; only the exact Promise state
 * controls this physical join. Failure to observe the Promise is retained as incomplete work.
 * @throws TypeError if a different Owner retirement operation was already bound.
 */
export function retainPhysicalOwnerRetirement(
  owner: Owner,
  original: Promise<void>,
): void {
  const physical = physicalOwners.get(owner);

  if (!physical) return;
  if (physical.record.ownerRetirement)
    throw new TypeError("A physical Owner retains one original retirement operation");

  const record: PhysicalOwnerRetirementRecord = { original, state: "pending" };
  physical.record.ownerRetirement = record;

  try {
    nativeApply(nativePromiseThen, original, [
      () => {
        record.state = "fulfilled";
        physical.lifetime.finishRetirement();
      },
      () => {
        record.state = "rejected";
        physical.lifetime.finishRetirement();
      },
    ]);
  } catch (reason) {
    record.state = "unacknowledged";
    physical.lifetime.cleanupFailures.push({ failure: { reason } });
    physical.lifetime.finishRetirement();
  }
}

/** @internal Fence and retain each actual synchronous cleanup pass before its callouts. */
export function beginPhysicalOwnerClose(owner: Owner): void {
  const physical = physicalOwners.get(owner);

  if (!physical) return;

  physical.record.closed = true;
  physical.record.closeDepth++;

  if (!physical.record.parent) physical.lifetime.beginClose();
}

/** @internal Retain each cleanup attempt's original cause, including undefined. */
export function recordPhysicalOwnerCleanupFailure(
  owner: Owner,
  reason: unknown,
): boolean {
  const physical = physicalOwners.get(owner);

  if (!physical) return false;

  physical.lifetime.cleanupFailures.push({ failure: { reason } });

  return true;
}

/** @internal Reserve the actual cleanup attempt before invoking user code. */
export function reservePhysicalOwnerCleanupFailure(
  owner: Owner,
): ((reason: unknown) => void) | undefined {
  const physical = physicalOwners.get(owner);

  if (!physical) return undefined;

  const slot: PhysicalOwnerFailureSlot = {};
  physical.lifetime.cleanupFailures.push(slot);

  return (reason) => {
    if (!slot.failure) slot.failure = { reason };
  };
}

/** @internal Finish a logical cleanup pass without treating it as original-work completion. */
export function finishPhysicalOwnerClose(owner: Owner): void {
  const physical = physicalOwners.get(owner);

  if (!physical) return;

  physical.record.closeDepth--;

  if (!physical.record.parent) physical.lifetime.finishClose();
  else physical.lifetime.finishRetirement();
}
