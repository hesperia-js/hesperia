// Validation and error behavior is adapted from Node.js v24.22.0 internals.
// See ../../docs/scheduling-node-license.md for the retained MIT notice.

/** Options shared by debounce's portable and native implementations. */
export interface DebounceOptions {
  /** Call on the first edge of each quiet window. Defaults to `false`. */
  readonly leading?: boolean;

  /** Reject superseded queued calls instead of coalescing them. Defaults to `false`. */
  readonly rejectOnCancel?: boolean;

  /** Reject queued and future calls after this signal aborts. */
  readonly signal?: AbortSignal;
}

/** Options shared by throttle's portable and native implementations. */
export interface ThrottleOptions {
  /** Maximum unsettled callback invocations. Defaults to `Infinity`. */
  readonly concurrency?: number;

  /** Maximum queued calls. Defaults to `Infinity`. */
  readonly maxPending?: number;

  /** Queue calls past the current rate/concurrency capacity, or reject them. Defaults to `"queue"`. */
  readonly overflow?: "queue" | "drop";

  /** Reject queued and future calls after this signal aborts. */
  readonly signal?: AbortSignal;

  /** Enforce the rate over a rolling interval instead of fixed windows. Defaults to `false`. */
  readonly strict?: boolean;
}

/** A callback whose return value is assimilated by the scheduling utility's promise. */
export type SchedulingCallback = (...args: never[]) => unknown;

/** Promise-returning wrapper and controls returned by {@link debounce}. */
export interface DebouncedFunction<Callback extends SchedulingCallback> {
  /**
   * Queue this call and return a promise for the result of the scheduled callback.
   * Every queued call in one trailing window resolves or rejects with that invocation.
   */
  (...args: Parameters<Callback>): Promise<Awaited<ReturnType<Callback>>>;

  /**
   * Reject queued calls with an `AbortError` whose `cause` is `reason` when supplied.
   * Calls that already started continue, and this wrapper accepts future calls.
   */
  cancel(reason?: unknown): void;

  /**
   * Start the queued trailing invocation immediately. The original call promises
   * settle with its result; `flush()` itself returns `undefined`.
   */
  flush(): void;

  /** Keep the current and future timeout referenced in Node. Browsers return this wrapper unchanged. */
  ref(): this;

  /** Allow the current and future timeout not to keep Node alive. Browsers return this wrapper unchanged. */
  unref(): this;

  /** Latest queued promise, or `null` when no call is waiting. */
  readonly pending: Promise<Awaited<ReturnType<Callback>>> | null;

  /** Number of queued calls, excluding an invocation that has already started. */
  readonly pendingCount: number;
}

/** Promise-returning wrapper and controls returned by {@link throttle}. */
export interface ThrottledFunction<Callback extends SchedulingCallback> {
  /** Invoke immediately when rate and concurrency allow, otherwise queue or reject. */
  (...args: Parameters<Callback>): Promise<Awaited<ReturnType<Callback>>>;

  /** Reject queued calls with an `AbortError` and reset rate accounting; active callbacks continue. */
  cancel(reason?: unknown): void;

  /**
   * Report whether a new call could start immediately. This is observational
   * only and does not reserve capacity.
   */
  hasImmediateCapacity(): boolean;

  /** Keep the current and future timeout referenced in Node. Browsers return this wrapper unchanged. */
  ref(): this;

  /** Allow the current and future timeout not to keep Node alive. Browsers return this wrapper unchanged. */
  unref(): this;

  /** Latest queued promise, or `null` when no call is waiting. */
  readonly pending: Promise<Awaited<ReturnType<Callback>>> | null;

  /** Number of queued calls, excluding active callbacks. */
  readonly pendingCount: number;

  /** Number of callback invocations that have not settled. */
  readonly activeCount: number;
}

/** The host timer handle type, kept out of the public scheduling entry. */
export type TimerHandle = ReturnType<typeof setTimeout>;

/** Internal signal-listener registration hook for the portable and Node entries. */
export type AbortListenerRegistrar = (signal: AbortSignal, listener: () => void) => unknown;

/** A promise with externally controlled settlement used by the portable implementations. */
export interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value | PromiseLike<Value>) => void;
  readonly reject: (reason?: unknown) => void;
}

/** Create a deferred promise without changing its resolution behavior. */
export function createDeferred<Value>(): Deferred<Value> {
  let resolve!: Deferred<Value>["resolve"];
  let reject!: Deferred<Value>["reject"];
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

/** Throw a Node-style argument type error with its stable code. */
export function invalidArgumentType(
  name: string,
  expected: string,
  value: unknown,
): TypeError & { code: "ERR_INVALID_ARG_TYPE" } {
  const received = describeReceivedValue(value);
  const error = new TypeError(
    `The "${name}" argument must be of type ${expected}. Received ${received}`,
  ) as TypeError & {
    code: "ERR_INVALID_ARG_TYPE";
  };
  error.code = "ERR_INVALID_ARG_TYPE";
  return error;
}

/** Throw a Node-style range error for a numeric option. */
export function argumentOutOfRange(
  name: string,
  expected: string,
  value: number,
): RangeError & { code: "ERR_OUT_OF_RANGE" } {
  const error = new RangeError(
    `The value of "${name}" is out of range. It must be ${expected}. Received ${String(value)}`,
  ) as RangeError & { code: "ERR_OUT_OF_RANGE" };
  error.code = "ERR_OUT_OF_RANGE";
  return error;
}

/** Throw a Node-style value error for enum options. */
export function invalidArgumentValue(
  name: string,
  value: unknown,
  reason: string,
): TypeError & { code: "ERR_INVALID_ARG_VALUE" } {
  const error = new TypeError(
    `The "${name}" argument ${reason}. Received ${describeReceivedValue(value)}`,
  ) as TypeError & { code: "ERR_INVALID_ARG_VALUE" };
  error.code = "ERR_INVALID_ARG_VALUE";
  return error;
}

/** Validate an integer using Node's safe-integer bounds. */
export function validateInteger(
  value: unknown,
  name: string,
  minimum = Number.MIN_SAFE_INTEGER,
  maximum = Number.MAX_SAFE_INTEGER,
): asserts value is number {
  if (typeof value !== "number") throw invalidArgumentType(name, "number", value);

  if (!Number.isInteger(value)) throw argumentOutOfRange(name, "an integer", value);

  if (value < minimum || value > maximum)
    throw argumentOutOfRange(name, `>= ${minimum} && <= ${maximum}`, value);
}

/** Validate a boolean option. */
export function validateBoolean(value: unknown, name: string): asserts value is boolean {
  if (typeof value !== "boolean") throw invalidArgumentType(name, "boolean", value);
}

/** Validate the object shape accepted for a utility options argument. */
export function validateOptionsObject(value: unknown): asserts value is object {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw invalidArgumentType("options", "Object", value);
}

/** Match Node's structural AbortSignal validation without a realm-specific instanceof check. */
export function validateSignal(
  value: unknown,
  name: string,
): asserts value is AbortSignal | undefined {
  if (
    value !== undefined &&
    (value === null || typeof value !== "object" || !("aborted" in value))
  ) {
    throw invalidArgumentType(name, "AbortSignal", value);
  }
}

/** Validate that a value is one of the supported string options. */
export function validateOneOf<Value extends string>(
  value: unknown,
  name: string,
  values: readonly Value[],
): asserts value is Value {
  if (values.includes(value as Value)) return;

  const allowed = values.map((item) => `'${item}'`).join(", ");

  throw invalidArgumentValue(name, value, `must be one of: ${allowed}`);
}

/** Build the public Node-compatible abort error used by cancellation and signal abort. */
export function createAbortError(
  message = "The operation was aborted",
  cause?: unknown,
  includeCause = cause !== undefined,
): Error & { code: "ABORT_ERR"; cause?: unknown } {
  const error = new Error(message) as Error & { code: "ABORT_ERR"; cause?: unknown };
  error.name = "AbortError";
  error.code = "ABORT_ERR";

  if (includeCause) {
    Object.defineProperty(error, "cause", {
      configurable: true,
      value: cause,
      writable: true,
    });
  }

  return error;
}

/** Create Node's stable throttled-call error code and message. */
export function createThrottledError(): Error & { code: "ERR_THROTTLED" } {
  const error = new Error("The call was dropped by the throttled function") as Error & {
    code: "ERR_THROTTLED";
  };
  error.code = "ERR_THROTTLED";

  return error;
}

/** Apply ref/unref to a Node timer handle; numeric browser handles are left alone. */
export function setTimerReferenced(handle: TimerHandle | undefined, referenced: boolean): void {
  if (handle === undefined || (typeof handle !== "object" && typeof handle !== "function")) return;

  const timer = handle as { readonly ref?: unknown; readonly unref?: unknown };
  const method = referenced ? timer.ref : timer.unref;

  if (typeof method === "function") Reflect.apply(method, handle, []);
}

/** Register an abort listener through a follower signal where the host supports it. */
export function addPortableAbortListener(signal: AbortSignal, listener: () => void): AbortSignal {
  let observedSignal = signal;
  const any = globalThis.AbortSignal?.any;

  if (typeof any === "function") {
    try {
      observedSignal = any.call(globalThis.AbortSignal, [signal]);
    } catch {
      observedSignal = signal;
    }
  }

  let handled = false;
  const handleAbort = (): void => {
    if (handled) return;

    handled = true;
    listener();
  };

  observedSignal.addEventListener("abort", handleAbort, { once: true });

  if (observedSignal.aborted) handleAbort();
  return observedSignal;
}

/** Preserve the callback's public `name` and `length` on its wrapper. */
export function defineFunctionIdentity(
  callback: { readonly name: string; readonly length: number },
  wrapper: object,
): void {
  Object.defineProperties(wrapper, {
    length: { configurable: true, value: callback.length },
    name: { configurable: true, value: callback.name },
  });
}

function describeReceivedValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an instance of Array";
  if (typeof value === "string") return `type string (${JSON.stringify(value)})`;
  if (typeof value === "number") return `type number (${String(value)})`;
  if (typeof value === "object") return "an instance of Object";
  return `type ${typeof value} (${String(value)})`;
}
