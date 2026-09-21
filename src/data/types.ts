import type {
  AccumulatePolicy,
  ProjectionPolicy,
  ReducePolicy,
  QueryStore,
  StreamStore,
  Store,
  StoreStatus,
  StreamStatus,
} from "aeolia";
import type { Owner } from "../runtime/owner.ts";

/** The lifecycle state published by an owner-bound task controller. */
export type TaskStatus = "idle" | "pending" | "success" | "failure" | "cancelled";

/** A callable reactive read used by Hesperia's authoring surface. */
export type Accessor<T> = () => T;

/** Context supplied to a task factory for one invocation. */
export interface TaskContext {
  /** Aborts when this invocation is cancelled or its owner is destroyed. */
  readonly signal: AbortSignal;
}

/** The callable operation constructed for one task invocation. */
export type TaskInvocation<Input = void, Output = unknown> = (
  input: Input,
) => Output | PromiseLike<Output>;

/** Factory that creates a fresh callable operation for each task invocation. */
export type TaskFactory<Input = void, Output = unknown> = (
  context: TaskContext,
) => TaskInvocation<Input, Output>;

/** Awaitable handle for one particular task invocation. */
export interface TaskRun<Output> extends PromiseLike<Output> {
  /** Monotonically increasing identity local to the task controller. */
  readonly id: number;
  /** Cancellation signal supplied to the invocation factory. */
  readonly signal: AbortSignal;
  /** Cancel this invocation; repeated cancellation is harmless. */
  cancel(reason?: unknown): void;
}

/** Owner-bound task state and its latest-invocation-wins dispatcher. */
export interface Task<Input = void, Output = unknown> {
  /** Start one invocation and return its directly awaitable handle. */
  readonly run: (input: Input) => TaskRun<Output>;
  /** Latest successful output, or `undefined` when no output is published. */
  readonly value: Accessor<Output | undefined>;
  /** Whether the latest invocation is still pending. */
  readonly pending: Accessor<boolean>;
  /** Latest declared or unexpected invocation failure. */
  readonly error: Accessor<unknown>;
  /** Current latest-invocation lifecycle state. */
  readonly status: Accessor<TaskStatus>;
}

/** A live query view whose reads and await are owned by one component. */
export interface QueryView<T> {
  /** The underlying store key. */
  readonly key: QueryStore<T>["key"];
  /** The graph owning the underlying store. */
  readonly graph: QueryStore<T>["graph"];
  /** Live committed or predicted value read. */
  readonly value: Accessor<T | undefined>;
  /** Whether this query caller is fetching or revalidating. */
  readonly pending: Accessor<boolean>;
  /** Latest shared query failure. */
  readonly error: Accessor<unknown>;
  /** Current query caller status. */
  readonly status: Accessor<StoreStatus>;
  /** The original Aeolia readiness promise, with its semantics unchanged. */
  readonly ready: QueryStore<T>["ready"];
  /** The underlying Aeolia query store, for explicit interoperability. */
  readonly source: QueryStore<T>;
  /** Commit a local value through the underlying store. */
  readonly set: (value: T) => void;
  /** Compute and commit a local value through the underlying store. */
  readonly update: (next: (current: T | undefined) => T) => void;
  /**
   * Explicitly revalidate through the underlying query caller.
   *
   * This is an author initiated retry and re-arms Aeolia's automatic recovery
   * allowance. Awaiting a failed view uses the query member's internal
   * recovery path instead, so failed recovery remains disarmed until this
   * method is called.
   */
  readonly revalidate: QueryStore<T>["revalidate"];
  /**
   * Await the query state observed at the start of the await.
   *
   * A ready, stale, or revalidating query resolves immediately with a live
   * owner-bound accessor and starts a refresh when no request is pending. A
   * fetching query without committed data waits for that request; an initial
   * request failure rejects with its backend reason. An already failed query
   * rejects immediately with `{ status: "failed", error }` and starts one
   * shared recovery attempt. A failed recovery is disarmed by Aeolia until an
   * explicit {@link revalidate} call.
   */
  readonly then: <TResult1 = Accessor<T>, TResult2 = never>(
    onfulfilled?: ((value: Accessor<T>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ) => PromiseLike<TResult1 | TResult2>;
}

/** A callable owner-bound view over a declared writable Aeolia store. */
export interface Cell<T> extends Accessor<T | undefined> {
  /** Commit a local value through the underlying store. */
  set(value: T): void;
  /** Compute and commit a local value through the underlying store. */
  update(next: (current: T | undefined) => T): void;
  /** The underlying Aeolia store, for explicit interoperability. */
  readonly source: Store<T>;
}

/** Aeolia's projection policy accepted by a shared feed view. */
export type FeedPolicy<T, V = T> = ProjectionPolicy<T, V>;

/** The common state accessors exposed by a non-awaitable stream view. */
interface FeedState<T, V> {
  /** Latest source value, or the initialized projected value for a policy view. */
  readonly value: Accessor<V>;
  /** Whether the shared source is awaiting its first emission. */
  readonly pending: Accessor<boolean>;
  /** Source or projection failure, if one occurred. */
  readonly error: Accessor<unknown>;
  /** The underlying stream lifecycle, including dormant `empty`. */
  readonly status: Accessor<StreamStatus>;
  /**
   * The shared Aeolia stream store, available after owner activation.
   * Reading this getter while dormant or after the owner is released throws a rendering fault.
   */
  readonly source: StreamStore<T>;
}

/**
 * A reduced or accumulated owner-bound stream view.
 *
 * Its value accessor is initialized before the source opens: accumulation
 * starts with an empty readonly array and reduction starts with `initial`.
 */
export type FeedProjection<T, V> = FeedState<T, V>;

/**
 * A non-awaitable owner-bound latest-value stream view.
 *
 * Calling {@link Feed.project} creates an independent view over the same shared
 * source. Each view has its own accumulation or reduction state and listener;
 * it does not replay the source store's latest value.
 */
export interface Feed<T> extends FeedState<T, T | undefined> {
  /** Select an independent projection; the returned view cannot be projected again. */
  readonly project: {
    /**
     * Create an independent bounded accumulation view.
     *
     * The returned view is owner-bound, stays cold until owner commit, and
     * retains its own history while sharing the keyed source with this feed.
     *
     * @param policy - The positive maximum and optional overflow behavior.
     * @returns A view initialized to an empty readonly array.
     * @throws A rendering fault if called after this owner is released. An
     * invalid maximum is reported through the owner fault channel at commit.
     */
    (policy: AccumulatePolicy): FeedProjection<T, readonly T[]>;
    /**
     * Create an independent reducer view.
     *
     * The returned view is owner-bound, stays cold until owner commit, and
     * retains its own accumulator while sharing the keyed source with this
     * feed. Its value accessor starts at `policy.initial`.
     * A later `step` failure affects only this view: `status()` becomes
     * `"failed"` and `error()` returns the thrown value. Other views keep receiving events.
     *
     * @param policy - The initial accumulator and one-item reducer.
     * @returns A view initialized to the reducer's accumulator.
     * @throws A rendering fault if called after this owner is released.
     */
    <V>(policy: ReducePolicy<T, V>): FeedProjection<T, V>;
  };
}

/** Construct an owner-bound task controller. */
export type CreateTask = <Input, Output>(
  owner: Owner,
  factory: TaskFactory<Input, Output>,
) => Task<Input, Output>;
