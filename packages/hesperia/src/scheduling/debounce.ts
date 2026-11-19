// Adapted from Node.js v24.22.0 lib/internal/util/debounce.js.
// See ../../docs/scheduling-node-license.md for the retained MIT notice.
import type {
  DebounceOptions,
  DebouncedFunction,
  Deferred,
  AbortListenerRegistrar,
  SchedulingCallback,
  TimerHandle,
} from "./types.ts";
import {
  addPortableAbortListener,
  createAbortError,
  createDeferred,
  defineFunctionIdentity,
  invalidArgumentType,
  setTimerReferenced,
  validateBoolean,
  validateInteger,
  validateOptionsObject,
  validateSignal,
} from "./types.ts";

const MAX_TIMEOUT = 2_147_483_647;

/**
 * Create a Node-compatible debounced callback for browser and fallback runtimes.
 *
 * Queued calls share the latest trailing invocation's result. An optional
 * signal rejects queued and future calls; cancellation does not stop a callback
 * that has already started. In Node, `ref()` and `unref()` affect current and
 * future timers. Browser timer handles have no process-liveness behavior, so
 * those methods are chainable no-ops there.
 *
 * @typeParam Callback - Callback argument and result types.
 * @param callback - Function to invoke after the quiet period.
 * @param wait - Quiet-period duration, an integer from `0` through `2147483647`.
 * @param options - Optional leading, supersession and cancellation settings.
 * @returns A promise-returning debounced function with `cancel`, `flush`, `ref`,
 * `unref`, `pending` and `pendingCount` controls.
 * @throws {TypeError} If the callback, options object or boolean/signal options are invalid.
 * @throws {RangeError} If `wait` is not an integer in the accepted range.
 * @throws {Error} With name `AbortError` and code `ABORT_ERR` if the signal was already aborted.
 */
export function debounce<Callback extends SchedulingCallback>(
  callback: Callback,
  wait: number,
  options: DebounceOptions = {},
): DebouncedFunction<Callback> {
  return createDebounce(callback, wait, options);
}

/** Internal construction path used by the Node entry with its public signal helper. */
export function createDebounce<Callback extends SchedulingCallback>(
  callback: Callback,
  wait: number,
  options: DebounceOptions = {},
  registerAbortListener: AbortListenerRegistrar = addPortableAbortListener,
): DebouncedFunction<Callback> {
  if (typeof callback !== "function") throw invalidArgumentType("fn", "function", callback);

  validateInteger(wait, "wait", 0, MAX_TIMEOUT);

  validateOptionsObject(options);

  const { leading = false, rejectOnCancel = false, signal } = options;

  validateBoolean(leading, "options.leading");

  validateBoolean(rejectOnCancel, "options.rejectOnCancel");

  validateSignal(signal, "options.signal");

  if (signal?.aborted) throw createAbortError(undefined, signal.reason, true);

  type Result = Awaited<ReturnType<Callback>>;
  let latestArguments: Parameters<Callback> | undefined;
  let pendingCalls: Deferred<Result>[] = [];
  let timeout: TimerHandle | undefined;
  let timeoutReferenced = true;
  let signalAbortError: (Error & { code: "ABORT_ERR"; cause?: unknown }) | undefined;
  let abortRegistration: unknown;

  function rejectPending(error: unknown): void {
    const calls = pendingCalls;
    pendingCalls = [];

    for (const call of calls) call.reject(error);
  }

  function cancelWithError(error: unknown): void {
    if (timeout === undefined) return;

    clearTimeout(timeout);
    timeout = undefined;
    latestArguments = undefined;

    rejectPending(error);
  }

  function cancel(reason?: unknown): void {
    if (timeout === undefined) return;

    const error =
      reason === undefined ? createAbortError() : createAbortError(undefined, reason, true);

    cancelWithError(error);
  }

  function abort(): void {
    void abortRegistration;

    if (signalAbortError === undefined) {
      signalAbortError =
        signal?.reason === undefined
          ? createAbortError()
          : createAbortError(undefined, signal.reason, true);
    }

    cancelWithError(signalAbortError);
  }

  function ref(): DebouncedFunction<Callback> {
    timeoutReferenced = true;
    setTimerReferenced(timeout, true);

    return debounced as DebouncedFunction<Callback>;
  }

  function unref(): DebouncedFunction<Callback> {
    timeoutReferenced = false;
    setTimerReferenced(timeout, false);

    return debounced as DebouncedFunction<Callback>;
  }

  function invoke(arguments_: Parameters<Callback>, calls: Deferred<Result>[]): void {
    if (signal?.aborted) {
      abort();

      for (const call of calls) call.reject(signalAbortError);

      return;
    }

    let result: ReturnType<Callback>;

    try {
      result = Reflect.apply(callback, debounced, arguments_) as ReturnType<Callback>;
    } catch (error) {
      for (const call of calls) call.reject(error);

      return;
    }

    for (const call of calls) call.resolve(result as Result | PromiseLike<Result>);
  }

  function invokePending(): void {
    const arguments_ = latestArguments;
    latestArguments = undefined;
    const calls = pendingCalls;
    pendingCalls = [];

    if (calls.length > 0 && arguments_ !== undefined) invoke(arguments_, calls);
  }

  function onTimeout(): void {
    timeout = undefined;
    invokePending();
  }

  function scheduleTimeout(): void {
    if (timeout !== undefined) clearTimeout(timeout);

    timeout = setTimeout(onTimeout, wait);

    if (!timeoutReferenced) setTimerReferenced(timeout, false);
  }

  function flush(): void {
    if (pendingCalls.length === 0) return;

    if (timeout !== undefined) clearTimeout(timeout);
    timeout = undefined;

    invokePending();
  }

  function debounced(...arguments_: Parameters<Callback>): Promise<Result> {
    if (signal?.aborted) abort();

    if (signalAbortError !== undefined) return Promise.reject(signalAbortError);

    const invokeNow = leading && timeout === undefined;

    if (timeout !== undefined && pendingCalls.length > 0) {
      const lastPending = pendingCalls[pendingCalls.length - 1];
      if (lastPending !== undefined) void lastPending.promise.catch(() => undefined);

      if (rejectOnCancel) rejectPending(createAbortError("The debounced call was superseded"));
    }

    scheduleTimeout();

    if (signal?.aborted) {
      abort();
      return Promise.reject(signalAbortError);
    }

    const call = createDeferred<Result>();

    if (invokeNow) invoke(arguments_, [call]);
    else {
      pendingCalls.push(call);
      latestArguments = arguments_;
    }
    return call.promise;
  }

  Object.defineProperties(debounced, {
    cancel: { configurable: true, enumerable: true, value: cancel, writable: true },
    flush: { configurable: true, enumerable: true, value: flush, writable: true },
    ref: { configurable: true, enumerable: true, value: ref, writable: true },
    unref: { configurable: true, enumerable: true, value: unref, writable: true },
    pending: {
      get: () =>
        pendingCalls.length === 0 ? null : (pendingCalls[pendingCalls.length - 1]?.promise ?? null),
    },
    pendingCount: { get: () => pendingCalls.length },
  });

  defineFunctionIdentity(callback, debounced);

  if (signal !== undefined) abortRegistration = registerAbortListener(signal, abort);

  return debounced as DebouncedFunction<Callback>;
}
