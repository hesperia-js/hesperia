import type {
  AccumulatePolicy,
  GraphId,
  Projection,
  Readable,
  ReducePolicy,
  StoreKey,
  StreamDefinition,
  StreamStatus,
} from "aeolia";
import type { Accessor, FeedProjection, TaskRun } from "./types.ts";

declare const channelType: unique symbol;

/** The carrier passed to the incoming Aeolia stream member for one channel opening. */
export interface ChannelCarrier<Opening> {
  /** The input that identifies this opening of the logical channel. */
  readonly opening: Opening;
  /** Opaque operation identity associated with this channel opening. */
  readonly operation: object;
}

/**
 * A declaration-only channel leaf that remains a one-member Aeolia operation
 * tree.
 *
 * The private type brand carries the channel's opening, incoming, send, and
 * terminal types. It has no runtime representation. The only string-named
 * member is `incoming`, so a raw Aeolia graph exposes that stream member rather
 * than a channel acquisition function.
 */
export type ChannelDeclaration<Opening, Incoming, Message, Result> = {
  /** Aeolia declaration that supplies incoming values for this channel. */
  readonly incoming: StreamDefinition<ChannelCarrier<Opening>, Incoming>;
  /** Type-only channel metadata used to preserve the four inferred types. */
  readonly [channelType]: {
    readonly opening: Opening;
    readonly incoming: Incoming;
    readonly message: Message;
    readonly result: Result;
  };
};

/** Options for one independent channel send. */
export interface ChannelSendOptions {
  /**
   * Positive finite deadline override for this send.
   *
   * When omitted, the effective deadline follows the channel default, then the
   * Hesperia project default when available, then the built-in default.
   */
  readonly timeoutMs?: number;
  /** Caller-owned signal that cancels this send without cancelling sibling sends. */
  readonly signal?: AbortSignal;
}

/**
 * A per-view projection of channel input without access to the shared source.
 *
 * Its accumulator belongs to the Aeolia projection. Closing it releases this
 * view's receive listener; it does not close the shared channel for other views.
 */
export type ChannelProjection<Incoming, Value> = Omit<FeedProjection<Incoming, Value>, "source"> & {
  /** Stop this projection and release its receive listener. */
  close(): void;
};

/**
 * Owner-bound view of one channel operation.
 *
 * Awaiting the view observes that operation's terminal result. JavaScript
 * thenable adoption applies when the view is returned directly from an async
 * function; containing the view in an ordinary object preserves the handle.
 */
export interface ChannelView<Incoming, Message, Result> extends PromiseLike<Result> {
  /** The effective key shared by matching channel views in this graph. */
  readonly key: StoreKey;
  /** Identity of the graph that owns the shared incoming state. */
  readonly graph: GraphId;
  /**
   * Latest native incoming value visible while this channel is active, or the
   * captured terminal value after the incoming stream ends.
   *
   * A present value may itself be `undefined`; use `available()` to distinguish
   * presence from absence. These accessors are separate reads, not an atomic
   * snapshot. A local capture fault remains observable rather than becoming an
   * absent value.
   */
  readonly value: Accessor<Incoming | undefined>;
  /**
   * Whether the native incoming value is visibly present while active or
   * present in the sealed terminal record after the stream ends. A present
   * value may be `undefined`. This reports presence, not request success or
   * readiness. A local capture fault remains observable rather than becoming
   * false presence.
   */
  readonly available: Accessor<boolean>;
  /** Whether the shared incoming source is waiting for its first emission. */
  readonly pending: Accessor<boolean>;
  /**
   * Latest shared incoming-operation failure, when one exists. Projection
   * failures stay local to each projection.
   */
  readonly error: Accessor<unknown>;
  /** Current lifecycle of the shared incoming stream. */
  readonly status: Accessor<StreamStatus>;

  /**
   * Admit one independent outgoing message.
   *
   * The returned handle settles when this send's local adapter work settles. It
   * does not report remote receipt or application success.
   *
   * @param message - Payload owned by this send until its handle settles.
   * @param options - Optional finite deadline override and per-send cancellation signal.
   * @returns The cancellable handle for this send only.
   */
  send(message: Message, options?: ChannelSendOptions): TaskRun<void>;

  /**
   * Wait until capacity may be available without reserving a slot or payload.
   *
   * Waking is advisory; a later send can still be refused if another caller
   * consumes capacity first.
   *
   * @param options - Optional signal that cancels this wait.
   * @returns A promise that settles when capacity may be available or the wait is cancelled.
   */
  waitForCapacity(options?: { readonly signal?: AbortSignal }): Promise<void>;

  /**
   * Finish input for the shared logical operation.
   *
   * New sends through all views stop after finish is accepted. This does not
   * close this local view or imply that the operation has reached its terminal result.
   *
   * @returns A promise for completion of the local finish action.
   */
  finish(): Promise<void>;

  /**
   * Close this local view and revoke its unfinished sends.
   *
   * Other views of the shared operation remain active.
   *
   * @param reason - Optional reason supplied to this view's cancellation work.
   */
  close(reason?: unknown): void;

  /** Independent projections over the channel's incoming messages. */
  readonly project: {
    /**
     * Accumulate incoming messages in a bounded array.
     *
     * @param policy - Maximum retained messages and overflow behavior.
     * @returns An owner-bound projection with an inferred readonly array value.
     */
    (policy: AccumulatePolicy): ChannelProjection<Incoming, readonly Incoming[]>;
    /**
     * Reduce incoming messages into an accumulator.
     *
     * @param policy - Initial accumulator and one-message reduction step.
     * @returns An owner-bound projection with the reducer's value type.
     */
    <Value>(policy: ReducePolicy<Incoming, Value>): ChannelProjection<Incoming, Value>;
  };
}

/**
 * Native, non-owner-bound view of a channel operation.
 *
 * It exposes Aeolia readables and projections for incoming state and keeps the
 * same per-send, finish, close, and terminal-await distinctions as an
 * owner-bound view.
 */
export interface StandaloneChannel<Incoming, Message, Result> extends PromiseLike<Result> {
  /** The effective key shared by matching channel views in this graph. */
  readonly key: StoreKey;
  /** Identity of the graph that owns the shared incoming state. */
  readonly graph: GraphId;
  /**
   * Latest native incoming value visible while this channel is active, or the
   * captured terminal value after the incoming stream ends.
   *
   * A present value may itself be `undefined`; use `available` to distinguish
   * presence from absence. These readables are separate reads, not an atomic
   * snapshot. A local capture fault remains observable rather than becoming an
   * absent value.
   */
  readonly value: Readable<Incoming | undefined>;
  /**
   * Whether the native incoming value is visibly present while active or
   * present in the sealed terminal record after the stream ends. A present
   * value may be `undefined`. This reports presence, not request success or
   * readiness. A local capture fault remains observable rather than becoming
   * false presence.
   */
  readonly available: Readable<boolean>;
  /** Whether the shared incoming source is waiting for its first emission. */
  readonly pending: Readable<boolean>;
  /**
   * Latest shared incoming-operation failure, when one exists. Projection
   * failures stay local to each projection.
   */
  readonly error: Readable<unknown>;
  /** Current lifecycle of the shared incoming stream. */
  readonly status: Readable<StreamStatus>;

  /**
   * Admit one independent outgoing message.
   *
   * The returned handle settles when this send's local adapter work settles. It
   * does not report remote receipt or application success.
   *
   * @param message - Payload owned by this send until its handle settles.
   * @param options - Optional finite deadline override and per-send cancellation signal.
   * @returns The cancellable handle for this send only.
   */
  send(message: Message, options?: ChannelSendOptions): TaskRun<void>;

  /**
   * Wait until capacity may be available without reserving a slot or payload.
   *
   * @param options - Optional signal that cancels this wait.
   * @returns A promise that settles when capacity may be available or the wait is cancelled.
   */
  waitForCapacity(options?: { readonly signal?: AbortSignal }): Promise<void>;

  /**
   * Finish input for the shared logical operation.
   *
   * New sends through all views stop after finish is accepted. This does not
   * close this local view or imply that the operation has reached its terminal result.
   *
   * @returns A promise for completion of the local finish action.
   */
  finish(): Promise<void>;

  /**
   * Close this local view and revoke its unfinished sends.
   *
   * Other views of the shared operation remain active.
   *
   * @param reason - Optional reason supplied to this view's cancellation work.
   */
  close(reason?: unknown): void;

  /** Independent Aeolia projections over the channel's incoming messages. */
  readonly project: {
    /**
     * Accumulate incoming messages in a bounded array.
     *
     * @param policy - Maximum retained messages and overflow behavior.
     * @returns An Aeolia projection with an inferred readonly array value.
     */
    (policy: AccumulatePolicy): Projection<readonly Incoming[]>;
    /**
     * Reduce incoming messages into an accumulator.
     *
     * @param policy - Initial accumulator and one-message reduction step.
     * @returns An Aeolia projection with the reducer's value type.
     */
    <Value>(policy: ReducePolicy<Incoming, Value>): Projection<Value>;
  };
}
