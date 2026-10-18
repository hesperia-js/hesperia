import { Signal, withoutWrites } from "aeolia";
import type { Graph, QueryStore } from "aeolia";
import type { Scheduler } from "./scheduler.ts";

/** Lifecycle phases distinguish cleanup access from final destruction. */
export type OwnerState = "building" | "mounted" | "suspended" | "cleaning" | "destroyed";

let bodyDepth = 0;
let cleanupDepth = 0;

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

export type QueryReadKind = "metadata" | "value";

/** Waiting-state capability inherited by descendants of an explicit async boundary. */
export interface AsyncBoundaryHost {
  /** Lifetime whose waiting view owns pending descendants. */
  readonly owner: Owner;

  /** Keep content uncommitted until an owned render wait completes. */
  capture(owner: Owner, promise: Promise<void>): void;

  /** Retain a source and observe value only when the owner consumes its value or awaits it. */
  consumeQuery<T>(owner: Owner, graph: Graph, store: QueryStore<T>, kind: QueryReadKind): void;

  /** Route reset-unavailable scheduled reads to loading; reject callback reads clearly. */
  assertQueryReadable<T>(owner: Owner, graph: Graph, store: QueryStore<T>): void;
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
  private readonly cleanups: (() => void)[] = [];
  private readonly releases: (() => void)[] = [];
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

  /** Register author cleanup, executed before descendants and in reverse order. */
  onCleanup(cleanup: () => void): void {
    this.assertActive();

    this.cleanups.push(cleanup);
  }

  /** Register a resource release after descendant destruction. */
  onRelease(release: () => void): void {
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
   * Revoke publication, run parent cleanup, destroy descendants, release native
   * nodes, and finally destroy this owner. Teardown continues after failures.
   */
  dispose(reason: unknown = new RenderFault("cancelled", "Component removed")): void {
    if (this.state === "cleaning" || this.state === "destroyed") return;

    const errors: unknown[] = [];

    this.destroy(reason, errors);

    if (errors.length) reportFault(this, new AggregateError(errors, "Component cleanup failed"));
  }

  private destroy(reason: unknown, errors: unknown[]): void {
    if (this.state === "cleaning" || this.state === "destroyed") return;

    this.state = "cleaning";

    this.controller.abort(reason);

    for (const cleanup of this.cleanups.splice(0).reverse()) {
      try {
        runCleanup(cleanup);
      } catch (error) {
        errors.push(error);
      }
    }

    for (const child of this.children.slice()) child.destroy(reason, errors);

    for (const release of this.releases.splice(0).reverse()) {
      try {
        release();
      } catch (error) {
        errors.push(error);
      }
    }

    if (this.styleLifecycle) {
      const binding = this.styleLifecycle;
      this.styleLifecycle = undefined;

      try {
        binding.lifecycle.released(this, binding.ownerId);
      } catch (error) {
        errors.push(error);
      }
    }

    for (const node of this.nodes) node.parentNode?.removeChild(node);

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
export function runCleanup(cleanup: () => void): void {
  const priorRenderOwners = renderOwners.splice(0);
  cleanupDepth++;

  try {
    Signal.subtle.untrack(() => withoutWrites(cleanup));
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
