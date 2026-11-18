import { Fault, signal } from "aeolia";
import type {
  AccumulatePolicy,
  ProjectionPolicy,
  QueryProgressCohortEntry,
  QueryProgressEvent,
  QueryProgressObservation,
  QueryProgressSnapshot,
  QueryStore,
  ReducePolicy,
} from "aeolia";
import type { Owner } from "../runtime/owner.ts";

/** Lifecycle states exposed by a Hesperia query progress view. */
export type QueryProgressStatus =
  | "idle"
  | "pending"
  | "streaming"
  | "complete"
  | "interrupted"
  | "failed";

/**
 * Query-owned read-only progress for one keyed query execution.
 * This view has no query writer or independent request lifecycle.
 *
 * @typeParam T - Latest, accumulated, or reduced progress value.
 */
export interface QueryProgressView<T> {
  /** Latest progress value, or the declared policy initializer before data arrives. */
  readonly value: () => T;
  /** Whether the current execution is waiting for its first accepted progress value. */
  readonly pending: () => boolean;
  /** Current source or local projection error. */
  readonly error: () => unknown;
  /** Current progress lifecycle, including valid completion and interruption. */
  readonly status: () => QueryProgressStatus;
}

/**
 * Projection overloads supported by a progress-capable query view.
 * Accumulation and reduction use Aeolia's existing policy definitions.
 *
 * @typeParam P - One accepted assembled progress value from the query.
 */
export interface QueryProgressProject<P> {
  /** Observe the latest assembled progress value. */
  (): QueryProgressView<P | undefined>;
  /** Observe the latest assembled progress value. */
  (policy: undefined): QueryProgressView<P | undefined>;
  /** Accumulate progress values in a bounded read-only array. */
  (policy: AccumulatePolicy): QueryProgressView<readonly P[]>;
  /** Reduce progress values using Aeolia's synchronous reducer policy. */
  <V>(policy: ReducePolicy<P, V>): QueryProgressView<V>;
  /** Preserve the output type of a policy union selected by the caller. */
  <V, K extends "reduce" | "accumulate">(
    policy: ProjectionPolicy<P, V> & { readonly kind: K },
  ): QueryProgressView<K extends "accumulate" ? readonly P[] : V>;
}

/** Captured policy fields used after public validation. @internal */
export type PreparedQueryProgressPolicy<P, V = unknown> =
  | AccumulatePolicy
  | ReducePolicy<P, V>
  | undefined;

interface ProjectionState {
  value: unknown;
  reportRevision: number;
  failed: boolean;
  error: unknown;
}

interface ProgressState<T> {
  readonly value: T;
  readonly pending: boolean;
  readonly error: unknown;
  readonly status: QueryProgressStatus;
}

interface QueryProgressProjectionRuntime<T, P> {
  readonly view: QueryProgressView<unknown>;
  readonly entry: QueryProgressCohortEntry<T, P>;
  process(event: QueryProgressEvent<P>, source: QueryProgressObservation<P>): void;
  installStop(stop: () => void): void;
}

/** Prepare a projection before its acquired query starts reporting. @internal */
export function prepareQueryProgressView<T, P>(
  owner: Owner,
  policy: PreparedQueryProgressPolicy<P, any>,
  guard: () => void,
  beforeEvent: (store: QueryStore<T, P>, observation: QueryProgressObservation<P>) => void,
): { readonly view: QueryProgressView<unknown>; readonly entry: QueryProgressCohortEntry<T, P> } {
  const runtime = createQueryProgressProjection(owner, policy, guard, beforeEvent);

  return Object.freeze({ view: runtime.view, entry: runtime.entry });
}

/** Adapt Aeolia's ordered query-progress observation to a Hesperia projection. @internal */
export function createQueryProgressView<P>(
  owner: Owner,
  source: QueryProgressObservation<P>,
): QueryProgressView<P | undefined>;

/** Adapt latest progress with an explicit policy slot and read guard. @internal */
export function createQueryProgressView<P>(
  owner: Owner,
  source: QueryProgressObservation<P>,
  policy: undefined,
  guard?: () => void,
): QueryProgressView<P | undefined>;

/** Adapt progress with bounded accumulation using Aeolia's policy semantics. @internal */
export function createQueryProgressView<P>(
  owner: Owner,
  source: QueryProgressObservation<P>,
  policy: AccumulatePolicy,
  guard?: () => void,
): QueryProgressView<readonly P[]>;

/** Adapt progress with Aeolia's synchronous reduction policy. @internal */
export function createQueryProgressView<P, V>(
  owner: Owner,
  source: QueryProgressObservation<P>,
  policy: ReducePolicy<P, V>,
  guard?: () => void,
): QueryProgressView<V>;

export function createQueryProgressView<P, V = unknown>(
  owner: Owner,
  source: QueryProgressObservation<P>,
  policy?: PreparedQueryProgressPolicy<P, V>,
  guard: () => void = () => owner.assertReadable(),
): QueryProgressView<unknown> {
  const runtime = createQueryProgressProjection<unknown, P, V>(owner, policy, guard, () => {});
  const unsubscribe = source.subscribe((event) => runtime.process(event, source));

  runtime.installStop(unsubscribe);

  return runtime.view;
}

function createQueryProgressProjection<T, P, V>(
  owner: Owner,
  policy: PreparedQueryProgressPolicy<P, V>,
  guard: () => void,
  beforeEvent: (store: QueryStore<T, P>, observation: QueryProgressObservation<P>) => void,
): QueryProgressProjectionRuntime<T, P> {
  owner.assertActive();

  const initialValue = (): unknown =>
    policy === undefined ? undefined : policy.kind === "reduce" ? policy.initial : [];
  const initial = initialValue();
  const state = signal<ProgressState<unknown>>(
    { value: initial, pending: false, error: undefined, status: "idle" },
    { label: "query:progress-view" },
  );
  let execution: object | undefined;
  let projection: ProjectionState = {
    value: initial,
    reportRevision: -1,
    failed: false,
    error: undefined,
  };
  let released = false;
  let closed = false;
  let currentObservation: QueryProgressObservation<P> | undefined;
  let listenerStop: (() => void) | undefined;
  let lastStoppedListener: (() => void) | undefined;

  const stopListening = (): void => {
    const stop = listenerStop;
    listenerStop = undefined;

    if (!stop) return;

    lastStoppedListener = stop;
    stop();
  };

  const installListener = (source: QueryProgressObservation<P>, stop: () => void): void => {
    if (currentObservation === source && listenerStop === stop) return;

    const previous = listenerStop;
    currentObservation = source;
    listenerStop = stop;

    if (previous) {
      lastStoppedListener = previous;
      previous();
    }
  };

  const failEntry = (error: unknown): never => {
    closed = true;

    try {
      stopListening();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "Query progress cohort cleanup failed");
    }

    throw error;
  };

  const resetProjection = (snapshot: QueryProgressSnapshot<P>, reportRevision: number): void => {
    execution = snapshot.execution;
    projection = {
      value: initialValue(),
      reportRevision,
      failed: false,
      error: undefined,
    };
  };

  const publish = (snapshot: QueryProgressSnapshot<P>): void => {
    state.set({
      value:
        policy === undefined ? (snapshot.hasValue ? snapshot.value : undefined) : projection.value,
      pending: !projection.failed && snapshot.status === "active" && !snapshot.hasValue,
      error: projection.failed ? projection.error : snapshot.error,
      status: projection.failed ? "failed" : mapStatus(snapshot.status, snapshot.hasValue),
    });
  };

  const captureAfterReducer = (
    currentProjection: ProjectionState,
    snapshot: QueryProgressSnapshot<P>,
    before: QueryProgressSnapshot<P>,
    source: QueryProgressObservation<P>,
  ): QueryProgressSnapshot<P> | undefined => {
    if (
      released ||
      closed ||
      projection !== currentProjection ||
      currentObservation !== source ||
      execution !== snapshot.execution ||
      currentProjection.reportRevision !== snapshot.reportRevision
    )
      return undefined;

    let latest: QueryProgressSnapshot<P>;

    try {
      latest = source.capture();
    } catch {
      return undefined;
    }

    if (
      latest.execution !== snapshot.execution ||
      latest.reportRevision < snapshot.reportRevision ||
      (before.status === "active" && latest.status === "interrupted")
    )
      return undefined;

    return latest;
  };

  const fold = (
    snapshot: QueryProgressSnapshot<P>,
    source: QueryProgressObservation<P>,
  ): QueryProgressSnapshot<P> | undefined => {
    const currentProjection = projection;

    if (!snapshot.hasValue || currentProjection.failed) return snapshot;

    let nextValue: unknown;
    let failure: unknown;
    let failed = false;
    let before: QueryProgressSnapshot<P> | undefined;

    if (policy?.kind === "reduce") {
      if (released || closed) return undefined;

      guard();

      try {
        before = source.capture();
      } catch {
        return undefined;
      }

      if (
        before.execution !== snapshot.execution ||
        before.reportRevision < snapshot.reportRevision
      )
        return undefined;
    }

    if (policy?.kind === "reduce") {
      try {
        nextValue = policy.step(currentProjection.value as V, snapshot.value as P);
      } catch (error) {
        failure = error;
        failed = true;
      }

      if (released || closed) return undefined;

      guard();
    } else {
      try {
        if (policy === undefined) nextValue = snapshot.value;
        else {
          const current = currentProjection.value as readonly P[];

          if (current.length >= policy.max) {
            if ((policy.onOverflow ?? "fail") === "fail")
              throw new Error("Aeolia projection accumulation exceeded max");

            nextValue = [...current.slice(1), snapshot.value as P];
          } else nextValue = [...current, snapshot.value as P];
        }
      } catch (error) {
        failure = error;
        failed = true;
      }
    }

    if (policy?.kind === "reduce") {
      const latest = captureAfterReducer(currentProjection, snapshot, before!, source);

      if (latest === undefined) return undefined;

      if (failed) {
        currentProjection.failed = true;
        currentProjection.error = failure;
      } else currentProjection.value = nextValue;

      return latest;
    }

    if (failed) {
      currentProjection.failed = true;
      currentProjection.error = failure;
    } else currentProjection.value = nextValue;

    return snapshot;
  };

  const process = (event: QueryProgressEvent<P>, source: QueryProgressObservation<P>): void => {
    if (released || closed) return;

    currentObservation = source;
    guard();

    const { snapshot } = event;

    if (event.kind === "current") {
      resetProjection(snapshot, snapshot.reportRevision);
      const latest = snapshot.hasValue ? fold(snapshot, source) : snapshot;

      if (latest !== undefined) publish(latest);

      return;
    }

    if (event.kind === "lifecycle") {
      if (snapshot.execution !== execution) resetProjection(snapshot, snapshot.reportRevision);

      publish(snapshot);

      return;
    }

    if (snapshot.execution === undefined) return;

    if (snapshot.execution !== execution) resetProjection(snapshot, snapshot.reportRevision - 1);

    if (snapshot.reportRevision <= projection.reportRevision) return;

    projection.reportRevision = snapshot.reportRevision;
    const latest = fold(snapshot, source);

    if (latest !== undefined) publish(latest);
  };

  owner.onRelease(() => {
    released = true;
    stopListening();
  });

  const entry = Object.freeze<QueryProgressCohortEntry<T, P>>({
    signal: owner.signal,
    onEvent: (event, context): void => {
      if (released || closed) {
        if (context.stop !== lastStoppedListener) {
          lastStoppedListener = context.stop;
          context.stop();
        }

        return;
      }

      try {
        installListener(context.observation, context.stop);
        beforeEvent(context.store, context.observation);
      } catch (error) {
        failEntry(error);
      }

      try {
        process(event, context.observation);
      } catch (error) {
        failEntry(error);
      }
    },
  });

  const installStop = (stop: () => void): void => {
    if (released || closed) {
      lastStoppedListener = stop;
      stop();

      return;
    }

    listenerStop = stop;
  };

  const read = <T>(select: (value: ProgressState<unknown>) => T): T => {
    guard();

    return select(state.get());
  };

  const view = Object.freeze({
    value: () => read((current) => current.value),
    pending: () => read((current) => current.pending),
    error: () => read((current) => current.error),
    status: () => read((current) => current.status),
  });

  return { view, entry, process, installStop };
}

/** Validate once and capture policy fields before an execution or acquisition. @internal */
export function prepareQueryProgressPolicy<P, V>(
  policy: unknown,
): PreparedQueryProgressPolicy<P, V> {
  if (policy === undefined) return undefined;
  if (
    policy === null ||
    (typeof policy !== "object" && typeof policy !== "function") ||
    !("kind" in policy)
  )
    throw new TypeError("Invalid projection policy.");

  const kind = policy.kind;

  if (kind === "reduce") {
    if (!("initial" in policy) || !("step" in policy))
      throw new TypeError("Invalid projection policy.");

    const initial = policy.initial;
    const step = policy.step;

    if (typeof step !== "function") throw new TypeError("Invalid projection policy.");

    return Object.freeze({ kind: "reduce", initial, step }) as ReducePolicy<P, V>;
  }

  if (kind !== "accumulate") throw new TypeError("Invalid projection policy.");

  if (!("max" in policy)) throw new TypeError("Invalid projection policy.");

  const max = policy.max;
  let onOverflow: unknown;

  if ("onOverflow" in policy) onOverflow = policy.onOverflow;

  if (
    typeof max !== "number" ||
    (onOverflow !== undefined && onOverflow !== "fail" && onOverflow !== "drop-oldest")
  )
    throw new TypeError("Invalid projection policy.");

  if (!(Number.isFinite(max) && max >= 1 && Number.isInteger(max)))
    throw new Fault("contract", ["max"]);

  return Object.freeze({
    kind: "accumulate",
    max,
    ...(onOverflow === undefined ? {} : { onOverflow }),
  }) as AccumulatePolicy;
}

function mapStatus(
  status: QueryProgressSnapshot<unknown>["status"],
  hasValue: boolean,
): QueryProgressStatus {
  switch (status) {
    case "idle":
      return "idle";
    case "active":
      return hasValue ? "streaming" : "pending";
    case "complete":
      return "complete";
    case "interrupted":
      return "interrupted";
    case "failed":
      return "failed";
  }

  return "failed";
}
