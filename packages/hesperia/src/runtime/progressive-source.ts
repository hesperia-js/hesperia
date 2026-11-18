import type { TransferCommit } from "aeolia";
import type { ProgressiveByteLimitsV1, ResolvedProgressivePolicyV1 } from "./progressive-policy.ts";
export type { ProgressiveByteLimitsV1, ResolvedProgressivePolicyV1 } from "./progressive-policy.ts";

const nativeReflectApply = Reflect.apply;
const NativePromise = Promise;
const nativePromiseResolve = Promise.resolve;
const nativePromiseReject = Promise.reject;
const nativeGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const nativeObjectIsFrozen = Object.isFrozen;
const nativeReflectOwnKeys = Reflect.ownKeys;
const nativeGetPrototypeOf = Object.getPrototypeOf;
const nativeObjectPrototype = Object.prototype;
const NativeUint8Array = Uint8Array;
const nativeNumberIsSafeInteger = Number.isSafeInteger;
const typedArrayPrototype = nativeGetPrototypeOf(NativeUint8Array.prototype) as object;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "byteLength",
)?.get;
const typedArrayTag = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)?.get;
const nativeTypedArraySet = NativeUint8Array.prototype.set;

declare const progressiveSourceIdentity: unique symbol;

/** @internal Opaque identity for one session-created progressive source. */
export interface ProgressiveSourceV1<Event> {
  readonly [progressiveSourceIdentity]: Event;
}

/** The byte class used when checking the resolved progressive limits. */
export type ProgressiveByteKindV1 = "boundary" | "control";

/** Why a progressive frame can never fit the resolved boundary or total queue byte limits. */
export type ProgressiveByteAdmissionResultV1 =
  | { readonly accepted: true }
  | {
      readonly accepted: false;
      readonly reason: "boundary-bytes" | "queue-frame-bytes";
    };

/** @internal Prepared graph/native publication captured before the final seal. */
export interface PreparedProgressiveCapturePublicationV1 {
  /** Validate actual local and complete participant currentness while pending. */
  recheck(): void;
  /** The actual native seal, absent for an ordinary graph with no native participant. */
  readonly seal?: () => TransferCommit | undefined;
  /** Publish prebuilt graph/source/chain roots without callouts or further refusal. */
  publish(): void;
  /** Deliver notifications only after graph and byte queue publication. */
  notify(): void;
}

/** @internal The actual persistent graph candidate produced while encoding one frame. */
export interface ProgressiveCaptureTransactionV1 {
  /** Prepare the actual graph/native and Hosting chain cut before byte publication. */
  preparePublication?(): PreparedProgressiveCapturePublicationV1;
  /** Commit the prepared graph immediately before synchronous byte publication. */
  commit(): void;
  /** Discard only an uncommitted graph candidate. */
  discard(): void;
}

/** @internal Actual shell bytes and the pending capture that produced their persistent graph. */
export interface ProgressiveInitialFrameV1 {
  readonly kind: "frame";
  readonly bytes: Uint8Array;
  readonly transaction: ProgressiveCaptureTransactionV1;
}

/** @internal Bounded encoding either returns actual frame bytes or reports a real boundary overflow. */
export type ProgressiveEncodingResultV1 =
  | {
      readonly kind: "frame";
      readonly bytes: Uint8Array;
      /** Absent only for a control frame that creates no graph candidate. */
      readonly transaction?: ProgressiveCaptureTransactionV1;
    }
  | {
      readonly kind: "boundary-overflow";
      readonly transaction: ProgressiveCaptureTransactionV1;
    };

/** @internal Deliver every prepared notification after the complete logical cut. */
export function deliverProgressivePublication(
  commit: TransferCommit | undefined,
  notify: (() => void) | undefined,
  receiver: unknown,
  notifyQueue?: () => void,
): void {
  const failures: unknown[] = [];

  if (commit) {
    try {
      commit.notifications.deliver();
    } catch (reason) {
      failures.push(reason);
    }
  }

  if (notify) {
    try {
      nativeReflectApply(notify, receiver, []);
    } catch (reason) {
      failures.push(reason);
    }
  }

  if (notifyQueue) {
    try {
      notifyQueue();
    } catch (reason) {
      failures.push(reason);
    }
  }

  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, "Progressive publication notifications failed", {
      cause: failures[0],
    });
}

/** @internal Owned queue roots prepared before graph/native publication. */
export interface PreparedProgressiveBytePublicationV1 {
  /** Reject stale queue or reservation state before the final native seal. */
  recheck(): void;
  /** Swap only prebuilt owned roots and scalar state. Call once after recheck. */
  publish(): void;
  /** Resolve waiting readers and capacity only after logical publication. */
  notify(): void;
}

/** @internal One bounded reservation made before a progressive terminal is encoded. */
export interface ProgressiveByteReservationV1 {
  /**
   * Check native byte identity and the granted capacity before committing a graph candidate.
   * @param bytes The actual bounded frame bytes, before graph commitment.
   * @returns Whether these bytes fit; this operation does not publish or release the reservation.
   * @throws The exact revocation reason, or TypeError for invalid native bytes or reservation state.
   */
  check(bytes: Uint8Array): ProgressiveByteAdmissionResultV1;

  /**
   * Copy and publish one actual encoded event within the capacity reserved for it.
   * @param bytes The genuine encoded wire event produced after this reservation was granted.
   * @returns Whether publication succeeded, or the permanent boundary or total-queue byte limit.
   * @throws The exact queued failure or cancellation reason if the reservation was revoked.
   * @throws {TypeError} If this reservation is foreign, released, or already published.
   */
  publish(bytes: Uint8Array): ProgressiveByteAdmissionResultV1;

  /** Copy bytes and prebuild queue roots while the capture remains pending. */
  prepare(bytes: Uint8Array): PreparedProgressiveBytePublicationV1;

  /**
   * Release the unused event and byte reservation.
   * @returns Nothing. Releasing an unused reservation is idempotent.
   */
  release(): void;
}

/** @internal Bounded byte admission supplied to the session's fixed producer binding. */
export interface ProgressiveByteAdmissionV1 {
  /**
   * Reserve one event slot and bounded wire space before capture or encoding.
   * Boundary reservations use the lesser of the boundary and total queue byte limits; control
   * reservations use the total queue byte limit. Temporary queue occupancy waits for a real pull.
   * @param kind Whether the event will be a boundary terminal or shell/control frame.
   * @returns The one reservation for that event after its actual capacity is available.
   * @throws The exact queued failure or cancellation reason when the queue closes while waiting.
   * @throws {TypeError} If a reservation or capacity wait is already active.
   */
  reserve(kind: ProgressiveByteKindV1): Promise<ProgressiveByteReservationV1>;

  /**
   * Mark normal end of the byte iterator after the complete frame was admitted.
   * @returns Nothing. Previously admitted chunks remain available to the iterator.
   */
  finish(): void;

  /**
   * Fail the iterator when an incomplete frame or byte admission cannot be published.
   * @param reason The exact source or bounded-admission failure, including `undefined`.
   * @returns Nothing. Previously admitted chunks drain before the iterator rejects.
   */
  fail(reason: unknown): void;
}

/** @internal The only operation a genuine session producer can bind to one native body. */
export interface ProgressiveProducerV1<Event> {
  /** The exact captured Hosting policy selected for this session. */
  readonly policy: ResolvedProgressivePolicyV1;

  /** The exact session promise that joins its original boundary work. */
  readonly settled: Promise<void>;

  /**
   * Revoke publication while the original session work continues through `settled`.
   * @param reason The original request or stream cancellation reason.
   * @returns Nothing. The exact session `settled` promise remains the original-work join.
   */
  cancel(reason?: unknown): void;

  /**
   * Install the Hosting encoder and bounded byte admission before terminal work is queued.
   * The producer reserves capacity before capture/encoding, then publishes one terminal at a time;
   * count-bounded per-boundary rendered records may stay with the session owner, but encoded
   * frames must not accumulate in a pending list awaiting body pulls.
   * @param encode The actual Hosting event encoder for this server session.
   * @param policy The exact resolved Hosting policy captured for this session.
   * @param admission The one-use native byte queue for this source.
   * @returns Nothing. The source remains joined by its original `settled` promise.
   * @throws The original synchronous binding failure.
   */
  bind(
    encode: (event: Event) => ProgressiveEncodingResultV1,
    policy: ResolvedProgressivePolicyV1,
    admission: ProgressiveByteAdmissionV1,
  ): void;
}

/** @internal Claimed one-use byte iterator for a native progressive response body. */
export interface ClaimedProgressiveSourceV1 {
  /** The bounded byte iterator whose chunks were admitted before their publication. */
  readonly iterator: AsyncIterator<Uint8Array>;

  /** Original producer work, still joined after publication is cancelled. */
  readonly settled: Promise<void>;

  /** The first bounded-byte failure, including an exact `undefined` reason. */
  readonly failure?: { readonly reason: unknown };

  /**
   * Revoke publication and close the byte iterator without retiring original work.
   * @param reason The original request or body cancellation reason.
   * @returns Nothing. The producer's `settled` promise still joins original work.
   */
  cancel(reason?: unknown): void;
}

/** @internal One acquired source record retained before response construction can call out. */
export interface ProgressiveSourceUseV1 {
  /** The exact session promise captured when the source identity was issued. */
  readonly settled: Promise<void>;

  /**
   * Revoke this source's publication at most once without replacing its original join.
   * @param reason The original request or body cancellation reason.
   * @returns Nothing. The exact session `settled` promise remains the original-work join.
   */
  cancel(reason?: unknown): void;
}

interface SourceRecord<Event> {
  readonly producer: ProgressiveProducerV1<Event>;
  readonly policy: ResolvedProgressivePolicyV1;
  readonly bind: ProgressiveProducerV1<Event>["bind"];
  readonly cancel: ProgressiveProducerV1<Event>["cancel"];
  readonly settled: Promise<void>;
  acquired: boolean;
  claimed: boolean;
  cancelled: boolean;
}

const sourceRecords = new WeakMap<object, SourceRecord<never>>();
const sourceUses = new WeakMap<object, SourceRecord<never>>();

interface QueueReader {
  readonly resolve: (result: IteratorResult<Uint8Array>) => void;
  readonly reject: (reason: unknown) => void;
}

interface QueueReservationRecord {
  readonly kind: ProgressiveByteKindV1;
  readonly byteCapacity: number;
  state: "active" | "published" | "released" | "revoked";
}

interface QueueReservationWaiter {
  readonly kind: ProgressiveByteKindV1;
  readonly resolve: (reservation: ProgressiveByteReservationV1) => void;
  readonly reject: (reason: unknown) => void;
}

class BoundedByteQueue implements ProgressiveByteAdmissionV1 {
  private chunks: Uint8Array[] = [];
  private readers: QueueReader[] = [];
  private revision = 0;
  private queuedBytes = 0;
  private reservedBytes = 0;
  private reservedEvents = 0;
  private ended = false;
  private cancelledWith?: { readonly reason: unknown };
  private failedWith?: { readonly reason: unknown };
  private reservation?: QueueReservationRecord;
  private capacityWaiter?: QueueReservationWaiter;
  private readonly accepted = Object.freeze({ accepted: true as const });

  constructor(private readonly limits: ProgressiveByteLimitsV1) {}

  get failure(): { readonly reason: unknown } | undefined {
    return this.failedWith;
  }

  /** Seed the actual shell before binding asynchronous terminal production. */
  seed(initial: ProgressiveInitialFrameV1): void {
    this.assertOpen();

    if (this.chunks.length || this.queuedBytes || this.reservation || this.capacityWaiter)
      throw new TypeError("The progressive shell can seed only an empty byte queue");

    const transaction = ownDataValue<ProgressiveCaptureTransactionV1>(initial, "transaction");
    const commit = ownDataValue(transaction, "commit");
    const discard = ownDataValue(transaction, "discard");

    if (typeof commit !== "function" || typeof discard !== "function")
      throw new TypeError("The progressive shell requires its actual capture transaction");

    let commitmentStarted = false;
    try {
      if (ownDataValue(initial, "kind") !== "frame")
        throw new TypeError("The progressive shell requires a captured frame");

      const bytes = ownDataValue<Uint8Array>(initial, "bytes");
      const byteLength = nativeByteLength(bytes);

      if (!byteLength) throw new TypeError("A progressive shell must contain encoded bytes");
      if (byteLength > this.limits.maxQueuedBytes || this.limits.maxQueuedEvents < 1)
        throw new RangeError("The progressive shell exceeds its resolved queue limits");

      const copy = copyNativeBytes(bytes, byteLength);
      const chunks = [copy];
      const prepare = transaction.preparePublication;
      const prepared =
        prepare &&
        (nativeReflectApply(prepare, transaction, []) as
          | PreparedProgressiveCapturePublicationV1
          | undefined);
      const recheck = prepared?.recheck;
      const seal = prepared?.seal;
      const publish = prepared?.publish;
      const notify = prepared?.notify;

      if (
        prepared &&
        (typeof recheck !== "function" ||
          typeof publish !== "function" ||
          typeof notify !== "function")
      )
        throw new TypeError("The shell preparation has no fixed publication operations");

      if (recheck) nativeReflectApply(recheck, prepared, []);

      this.assertOpen();

      const nativeCommit = seal
        ? (nativeReflectApply(seal, prepared, []) as TransferCommit | undefined)
        : undefined;

      if (seal && !nativeCommit) throw new TypeError("The shell native capture became stale");

      if (nativeCommit) nativeCommit.publish();
      if (publish) nativeReflectApply(publish, prepared, []);
      else nativeReflectApply(commit, transaction, []);

      this.chunks = chunks;
      this.queuedBytes = byteLength;
      this.revision++;
      commitmentStarted = true;

      deliverProgressivePublication(nativeCommit, notify, prepared);
    } catch (reason) {
      if (!commitmentStarted) {
        try {
          nativeReflectApply(discard, transaction, []);
        } catch (cleanup) {
          throw new AggregateError(
            [reason, cleanup],
            "Progressive shell admission and capture discard failed",
            { cause: reason },
          );
        }
      }

      throw reason;
    }
  }

  reserve(kind: ProgressiveByteKindV1): Promise<ProgressiveByteReservationV1> {
    if (kind !== "boundary" && kind !== "control")
      throw new TypeError("The progressive byte kind is invalid");

    this.assertOpen();

    if (this.capacityWaiter || this.reservation)
      throw new TypeError(
        "The progressive byte queue permits one reservation or capacity wait at a time",
      );

    return new NativePromise<ProgressiveByteReservationV1>((resolve, reject) => {
      this.capacityWaiter = { kind, resolve, reject };
      this.grantCapacityWaiter();
    });
  }

  finish(): void {
    if (this.failedWith) throw new TypeError("A failed progressive byte queue cannot finish");
    if (this.cancelledWith) return;

    this.revision++;
    this.ended = true;
    this.revokeReservation();
    this.rejectCapacityWaiter(
      new TypeError("The progressive byte queue finished before reservation"),
    );
    this.flushReaders();
  }

  fail(reason: unknown): void {
    if (this.ended || this.cancelledWith || this.failedWith) return;

    this.revision++;
    this.failedWith = { reason };
    this.revokeReservation();
    this.rejectCapacityWaiter(reason);
    this.flushReaders();
  }

  cancel(reason?: unknown): void {
    if (this.cancelledWith) return;

    this.revision++;
    this.cancelledWith = { reason };
    this.chunks.length = 0;
    this.queuedBytes = 0;
    this.revokeReservation();
    this.rejectCapacityWaiter(reason);
    this.flushReaders();
  }

  next(): Promise<IteratorResult<Uint8Array>> {
    this.revision++;
    if (this.chunks.length) {
      const value = this.chunks.shift()!;

      this.queuedBytes -= value.byteLength;
      this.grantCapacityWaiter();

      return nativeReflectApply(nativePromiseResolve, NativePromise, [
        { done: false, value },
      ]) as Promise<IteratorResult<Uint8Array>>;
    }

    if (this.failedWith)
      return nativeReflectApply(nativePromiseReject, NativePromise, [
        this.failedWith.reason,
      ]) as Promise<IteratorResult<Uint8Array>>;
    if (this.ended || this.cancelledWith)
      return nativeReflectApply(nativePromiseResolve, NativePromise, [
        { done: true, value: undefined },
      ]) as Promise<IteratorResult<Uint8Array>>;

    return new NativePromise((resolve, reject) => {
      this.readers.push({ resolve, reject });
    });
  }

  private reservationBytes(kind: ProgressiveByteKindV1): number {
    return kind === "boundary"
      ? Math.min(this.limits.maxBoundaryBytes, this.limits.maxQueuedBytes)
      : this.limits.maxQueuedBytes;
  }

  private grantCapacityWaiter(): void {
    const waiter = this.capacityWaiter;

    if (!waiter) return;

    if (this.failedWith) {
      this.capacityWaiter = undefined;
      waiter.reject(this.failedWith.reason);

      return;
    }

    if (this.cancelledWith) {
      this.capacityWaiter = undefined;
      waiter.reject(this.cancelledWith.reason);

      return;
    }

    if (this.ended) {
      this.capacityWaiter = undefined;
      waiter.reject(new TypeError("The progressive byte queue ended before reservation"));

      return;
    }

    const byteCapacity = this.reservationBytes(waiter.kind);

    if (
      this.queuedBytes + this.reservedBytes + byteCapacity > this.limits.maxQueuedBytes ||
      this.chunks.length + this.reservedEvents + 1 > this.limits.maxQueuedEvents
    )
      return;

    this.capacityWaiter = undefined;
    const record: QueueReservationRecord = { kind: waiter.kind, byteCapacity, state: "active" };
    this.reservation = record;
    this.reservedBytes = byteCapacity;
    this.reservedEvents = 1;

    waiter.resolve(
      Object.freeze({
        check: (bytes: Uint8Array) => this.check(record, bytes),
        publish: (bytes: Uint8Array) => this.publish(record, bytes),
        prepare: (bytes: Uint8Array) => this.preparePublication(record, bytes),
        release: () => this.release(record),
      }),
    );
  }

  private check(
    record: QueueReservationRecord,
    bytes: Uint8Array,
  ): ProgressiveByteAdmissionResultV1 {
    if (record.state !== "active" || this.reservation !== record) this.throwReservationRevocation();
    this.assertOpen();

    const byteLength = nativeByteLength(bytes);

    if (!byteLength)
      throw new TypeError("A progressive frame must contain at least one encoded byte");
    if (record.kind === "boundary" && byteLength > this.limits.maxBoundaryBytes)
      return { accepted: false, reason: "boundary-bytes" };
    if (byteLength > this.limits.maxQueuedBytes)
      return { accepted: false, reason: "queue-frame-bytes" };
    if (byteLength > record.byteCapacity)
      throw new TypeError("The progressive reservation does not cover its encoded frame");

    return this.accepted;
  }

  private preparePublication(
    record: QueueReservationRecord,
    bytes: Uint8Array,
  ): PreparedProgressiveBytePublicationV1 {
    const checked = this.check(record, bytes);

    if (!checked.accepted) throw new RangeError(checked.reason);

    const copy = copyNativeBytes(bytes, nativeByteLength(bytes));
    const revision = this.revision;
    const reader = this.readers[0];
    const readers = reader ? this.readers.slice(1) : this.readers;
    const chunks = reader ? this.chunks : [...this.chunks, copy];
    const queuedBytes = reader ? this.queuedBytes : this.queuedBytes + copy.byteLength;
    const result: IteratorResult<Uint8Array> = { done: false, value: copy };
    const publishedRevision = revision + 1;
    let published = false;
    let notified = false;

    return Object.freeze({
      recheck: () => {
        this.assertOpen();

        if (this.revision !== revision || this.reservation !== record || record.state !== "active")
          this.throwReservationRevocation();
      },
      publish: () => {
        this.chunks = chunks;
        this.readers = readers;
        this.queuedBytes = queuedBytes;
        this.reservation = undefined;
        this.reservedBytes = 0;
        this.reservedEvents = 0;
        this.revision = publishedRevision;
        record.state = "published";
        published = true;
      },
      notify: () => {
        if (!published || notified) return;

        notified = true;

        if (reader) reader.resolve(result);

        this.grantCapacityWaiter();
      },
    });
  }

  private publish(
    record: QueueReservationRecord,
    bytes: Uint8Array,
  ): ProgressiveByteAdmissionResultV1 {
    try {
      const checked = this.check(record, bytes);

      if (!checked.accepted) {
        this.release(record);

        return checked;
      }

      const prepared = this.preparePublication(record, bytes);

      prepared.recheck();
      prepared.publish();
      prepared.notify();

      return this.accepted;
    } catch (reason) {
      if (record.state === "active") this.release(record);

      throw reason;
    }
  }

  private release(record: QueueReservationRecord): void {
    if (record.state === "released" || record.state === "revoked") return;
    if (record.state !== "active" || this.reservation !== record)
      throw new TypeError("The progressive byte reservation was already published");

    this.reservation = undefined;
    this.reservedBytes = 0;
    this.reservedEvents = 0;
    this.revision++;
    record.state = "released";
    this.grantCapacityWaiter();
  }

  private revokeReservation(): void {
    const record = this.reservation;

    if (!record) return;

    this.reservation = undefined;
    this.reservedBytes = 0;
    this.reservedEvents = 0;
    this.revision++;
    record.state = "revoked";
  }

  private rejectCapacityWaiter(reason: unknown): void {
    const waiter = this.capacityWaiter;

    if (!waiter) return;

    this.capacityWaiter = undefined;
    waiter.reject(reason);
  }

  private throwReservationRevocation(): never {
    if (this.failedWith) throw this.failedWith.reason;
    if (this.cancelledWith) throw this.cancelledWith.reason;

    throw new TypeError("The progressive byte reservation is no longer active");
  }

  private assertOpen(): void {
    if (this.failedWith) throw this.failedWith.reason;
    if (this.cancelledWith) throw this.cancelledWith.reason;
    if (this.ended) throw new TypeError("The progressive byte queue is already finished");
  }

  private flushReaders(): void {
    while (this.readers.length) {
      const reader = this.readers.shift()!;

      if (this.chunks.length) {
        const value = this.chunks.shift()!;

        this.queuedBytes -= value.byteLength;
        reader.resolve({ done: false, value });
      } else if (this.failedWith) reader.reject(this.failedWith.reason);
      else reader.resolve({ done: true, value: undefined });
    }
  }
}

function validateLimits(limits: ProgressiveByteLimitsV1): ProgressiveByteLimitsV1 {
  const maxBoundaryBytes = ownDataValue<number>(limits, "maxBoundaryBytes");
  const maxQueuedBytes = ownDataValue<number>(limits, "maxQueuedBytes");
  const maxQueuedEvents = ownDataValue<number>(limits, "maxQueuedEvents");

  if (
    !nativeNumberIsSafeInteger(maxBoundaryBytes) ||
    maxBoundaryBytes <= 0 ||
    !nativeNumberIsSafeInteger(maxQueuedBytes) ||
    maxQueuedBytes <= 0 ||
    !nativeNumberIsSafeInteger(maxQueuedEvents) ||
    maxQueuedEvents <= 0
  )
    throw new TypeError("Progressive byte limits must be positive safe integers");

  return Object.freeze({ maxBoundaryBytes, maxQueuedBytes, maxQueuedEvents });
}

function ownDataValue<T = unknown>(value: object, key: PropertyKey): T {
  const descriptor = nativeGetOwnPropertyDescriptor(value, key);

  if (!descriptor || !("value" in descriptor))
    throw new TypeError(`Progressive field ${String(key)} must be an own data property`);

  return descriptor.value as T;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && nativeNumberIsSafeInteger(value) && value > 0;
}

function capturePolicy(value: unknown): ResolvedProgressivePolicyV1 {
  if (!value || typeof value !== "object" || !nativeObjectIsFrozen(value))
    throw new TypeError("The progressive session policy must be an immutable own-data object");

  const prototype = nativeGetPrototypeOf(value);

  if (prototype !== nativeObjectPrototype && prototype !== null)
    throw new TypeError(
      "The progressive session policy must be an ordinary or null-prototype record",
    );

  const keys = nativeReflectApply(nativeReflectOwnKeys, Reflect, [value]) as PropertyKey[];

  if (keys.length !== 10)
    throw new TypeError("The progressive session policy must contain exactly ten own fields");

  for (let index = 0; index < keys.length; index++) {
    const key = keys[index];

    if (key === undefined || !isProgressivePolicyKey(key))
      throw new TypeError("The progressive session policy contains an unknown or non-string field");
  }

  const version = ownDataValue(value, "version");
  const identity = ownDataValue(value, "identity");
  const revision = ownDataValue(value, "revision");
  const maxBoundaryBytes = ownDataValue(value, "maxBoundaryBytes");
  const maxQueuedBytes = ownDataValue(value, "maxQueuedBytes");
  const maxQueuedEvents = ownDataValue(value, "maxQueuedEvents");
  const maxBoundaryCount = ownDataValue(value, "maxBoundaryCount");
  const maxFrameBytes = ownDataValue(value, "maxFrameBytes");
  const maxRegionNodes = ownDataValue(value, "maxRegionNodes");
  const maxRegionTextBytes = ownDataValue(value, "maxRegionTextBytes");

  if (
    version !== 1 ||
    typeof identity !== "string" ||
    !identity.length ||
    !isPositiveSafeInteger(revision) ||
    !isPositiveSafeInteger(maxBoundaryBytes) ||
    !isPositiveSafeInteger(maxQueuedBytes) ||
    !isPositiveSafeInteger(maxQueuedEvents) ||
    !isPositiveSafeInteger(maxBoundaryCount) ||
    !isPositiveSafeInteger(maxFrameBytes) ||
    !isPositiveSafeInteger(maxRegionNodes) ||
    !isPositiveSafeInteger(maxRegionTextBytes)
  )
    throw new TypeError("The progressive session policy is incomplete or invalid");

  return value as ResolvedProgressivePolicyV1;
}

function isProgressivePolicyKey(key: PropertyKey): key is string {
  return (
    key === "version" ||
    key === "identity" ||
    key === "revision" ||
    key === "maxBoundaryBytes" ||
    key === "maxQueuedBytes" ||
    key === "maxQueuedEvents" ||
    key === "maxBoundaryCount" ||
    key === "maxFrameBytes" ||
    key === "maxRegionNodes" ||
    key === "maxRegionTextBytes"
  );
}

function nativeByteLength(bytes: Uint8Array): number {
  if (!typedArrayByteLength || !typedArrayTag)
    throw new TypeError("Native typed-array identity is unavailable");

  const tag = nativeReflectApply(typedArrayTag, bytes, []);

  if (tag !== "Uint8Array") throw new TypeError("Progressive frames must use a genuine Uint8Array");

  return nativeReflectApply(typedArrayByteLength, bytes, []) as number;
}

function copyNativeBytes(bytes: Uint8Array, byteLength: number): Uint8Array {
  const sourceByteLength = nativeByteLength(bytes);

  if (sourceByteLength !== byteLength)
    throw new TypeError("Progressive frame bytes changed during admission");

  const copy = new NativeUint8Array(byteLength);

  nativeReflectApply(nativeTypedArraySet, copy, [bytes]);

  return copy;
}

/**
 * @internal Issue one opaque source identity from the actual session producer.
 * Import this private module from the producer constructor before authored callouts. The returned
 * object carries no structural authority; only this module's WeakMap can authenticate it.
 * @param producer The session's actual original-work join, cancel operation, and fixed binder.
 * @returns An opaque identity that can be acquired once by a native request body.
 * @throws {TypeError} If the producer lacks a fixed binder, cancel operation, or settled join.
 */
export function issueProgressiveSource<Event>(
  producer: ProgressiveProducerV1<Event>,
): ProgressiveSourceV1<Event> {
  if (!producer) throw new TypeError("A progressive source requires its fixed producer binding");

  const producerRecord = producer as unknown as object;
  const bind = ownDataValue(producerRecord, "bind");

  if (typeof bind !== "function")
    throw new TypeError("A progressive source requires its fixed producer binding");

  const cancel = ownDataValue(producerRecord, "cancel");
  const settled = ownDataValue<Promise<void>>(producerRecord, "settled");
  const policy = capturePolicy(ownDataValue(producerRecord, "policy"));

  if (typeof cancel !== "function" || !settled || !policy)
    throw new TypeError(
      "A progressive source requires its captured policy, cancellation, and settled join",
    );

  const source = Object.freeze({}) as unknown as ProgressiveSourceV1<Event>;

  sourceRecords.set(source, {
    producer: producer as unknown as ProgressiveProducerV1<never>,
    policy,
    bind: bind as unknown as ProgressiveProducerV1<never>["bind"],
    cancel: cancel as unknown as ProgressiveProducerV1<never>["cancel"],
    settled,
    acquired: false,
    claimed: false,
    cancelled: false,
  });

  return source;
}

/**
 * @internal Acquire the original producer join before byte validation or body construction.
 *
 * @param source The exact opaque source issued by its real session producer.
 * @returns A one-use retained handle for the source's original settled promise and cancellation.
 * @throws {TypeError} If the source is foreign or has already been acquired.
 */
export function acquireProgressiveSource<Event>(
  source: ProgressiveSourceV1<Event>,
): ProgressiveSourceUseV1 {
  const record = sourceRecords.get(source);

  if (!record || record.acquired)
    throw new TypeError("The progressive source is foreign or already acquired");

  record.acquired = true;

  const use = Object.freeze({
    settled: record.settled,
    cancel(reason?: unknown) {
      if (record.cancelled) return;

      record.cancelled = true;
      nativeReflectApply(record.cancel, record.producer, [reason]);
    },
  });

  sourceUses.set(use, record);

  return use;
}

/**
 * @internal Claim one actual source and install its bounded byte producer before any asynchronous
 * terminal work can enqueue output.
 *
 * @param use The exact source use acquired before byte validation or body construction.
 * @param encode Hosting's synchronous event encoder and actual capture transaction.
 * @param limits The byte limits resolved for this response's native plan.
 * @param initial The shell's actual bytes and pending graph capture, admitted synchronously by this claim.
 * @returns A one-use byte iterator with the producer's original settled promise and cancel method.
 * @throws {TypeError} If the source is foreign, already claimed or cancelled, or the limits are invalid.
 * @throws {RangeError} If the initial shell exceeds the queued-byte or queued-event limit.
 */
export function claimProgressiveSource<Event>(
  use: ProgressiveSourceUseV1,
  encode: (event: Event) => ProgressiveEncodingResultV1,
  limits: ProgressiveByteLimitsV1,
  initial: ProgressiveInitialFrameV1,
): ClaimedProgressiveSourceV1 {
  const record = sourceUses.get(use);

  if (!record || !record.acquired || record.claimed)
    throw new TypeError("The progressive source use is foreign or was already claimed");

  if (record.cancelled)
    throw new TypeError("The progressive source use was cancelled before it was claimed");

  record.claimed = true;
  const resolvedLimits = validateLimits(limits);

  if (
    resolvedLimits.maxBoundaryBytes !== record.policy.maxBoundaryBytes ||
    resolvedLimits.maxQueuedBytes !== record.policy.maxQueuedBytes ||
    resolvedLimits.maxQueuedEvents !== record.policy.maxQueuedEvents
  )
    throw new TypeError("The progressive queue limits do not match the captured session policy");

  const queue = new BoundedByteQueue(resolvedLimits);

  queue.seed(initial);

  try {
    nativeReflectApply(record.bind, record.producer, [encode, record.policy, queue]);
  } catch (reason) {
    queue.fail(reason);

    throw reason;
  }

  const iterator: AsyncIterator<Uint8Array> = Object.freeze({
    next: () => queue.next(),
    return: () => {
      queue.cancel();
      use.cancel();

      return nativeReflectApply(nativePromiseResolve, NativePromise, [
        { done: true, value: undefined },
      ]) as Promise<IteratorResult<Uint8Array>>;
    },
  });

  return Object.freeze({
    iterator,
    settled: use.settled,
    get failure() {
      return queue.failure;
    },
    cancel(reason?: unknown) {
      queue.cancel(reason);
      use.cancel(reason);
    },
  });
}
