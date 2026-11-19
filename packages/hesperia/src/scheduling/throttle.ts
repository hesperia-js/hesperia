// Adapted from Node.js v24.22.0 lib/internal/util/throttle.js.
// See ../../docs/scheduling-node-license.md for the retained MIT notice.
import type {
  AbortListenerRegistrar,
  Deferred,
  SchedulingCallback,
  ThrottleOptions,
  ThrottledFunction,
  TimerHandle,
} from "./types.ts";
import {
  addPortableAbortListener,
  createAbortError,
  createDeferred,
  createThrottledError,
  defineFunctionIdentity,
  invalidArgumentType,
  setTimerReferenced,
  validateBoolean,
  validateInteger,
  validateOneOf,
  validateOptionsObject,
  validateSignal,
} from "./types.ts";

const MAX_TIMEOUT = 2_147_483_647;

interface QueuedCall<Result> extends Deferred<Result> {
  readonly arguments: unknown[];
}

/**
 * Create a Node-compatible throttled callback for browser and fallback runtimes.
 *
 * Calls start only when both the rate window and concurrency limit allow them.
 * Excess calls queue by default; `overflow: "drop"` or an exhausted
 * `maxPending` returns a rejected `ERR_THROTTLED` promise. Cancellation rejects
 * queued work and resets rate accounting, but leaves started callbacks alone.
 * In Node, `ref()` and `unref()` affect current and future timers; browser timer
 * handles have no process-liveness behavior and make those methods no-ops.
 *
 * @typeParam Callback - Callback argument and result types.
 * @param callback - Function to invoke when capacity is available.
 * @param limit - Maximum calls allowed per interval, a positive safe integer.
 * @param interval - Rate interval in milliseconds, an integer from `0` through `2147483647`.
 * @param options - Optional queue, concurrency, window and cancellation settings.
 * @returns A promise-returning throttled function with cancellation and capacity state.
 * @throws {TypeError} If the callback, options object, overflow, boolean or signal is invalid.
 * @throws {RangeError} If numeric arguments are outside Node's accepted integer bounds.
 * @throws {Error} With name `AbortError` and code `ABORT_ERR` if the signal was already aborted.
 */
export function throttle<Callback extends SchedulingCallback>(
  callback: Callback,
  limit: number,
  interval: number,
  options: ThrottleOptions = {},
): ThrottledFunction<Callback> {
  return createThrottle(callback, limit, interval, options);
}

/** Internal construction path used by the Node entry with its public signal helper. */
export function createThrottle<Callback extends SchedulingCallback>(
  callback: Callback,
  limit: number,
  interval: number,
  options: ThrottleOptions = {},
  registerAbortListener: AbortListenerRegistrar = addPortableAbortListener,
): ThrottledFunction<Callback> {
  if (typeof callback !== "function") throw invalidArgumentType("fn", "function", callback);

  validateInteger(limit, "limit", 1);

  validateInteger(interval, "interval", 0, MAX_TIMEOUT);

  validateOptionsObject(options);

  const {
    concurrency = Number.POSITIVE_INFINITY,
    maxPending = Number.POSITIVE_INFINITY,
    overflow = "queue",
    signal,
    strict = false,
  } = options;

  if (concurrency !== Number.POSITIVE_INFINITY)
    validateInteger(concurrency, "options.concurrency", 1);

  if (maxPending !== Number.POSITIVE_INFINITY) validateInteger(maxPending, "options.maxPending", 0);

  validateOneOf(overflow, "options.overflow", ["queue", "drop"] as const);

  validateSignal(signal, "options.signal");

  validateBoolean(strict, "options.strict");

  if (signal?.aborted) throw createAbortError(undefined, signal.reason, true);

  type Result = Awaited<ReturnType<Callback>>;
  let activeCount = 0;
  let pendingCalls: Array<QueuedCall<Result> | undefined> = [];
  let pendingIndex = 0;
  let timeout: TimerHandle | undefined;
  let timeoutReferenced = true;
  let strictIndex = 0;
  let strictTicks: number[] = [];
  let windowCount = 0;
  let windowStart: number | undefined;
  let signalAbortError: (Error & { code: "ABORT_ERR"; cause?: unknown }) | undefined;
  let abortRegistration: unknown;

  function getPendingCount(): number {
    return pendingCalls.length - pendingIndex;
  }

  function dequeue(): QueuedCall<Result> {
    const call = pendingCalls[pendingIndex] as QueuedCall<Result>;
    pendingCalls[pendingIndex] = undefined;
    pendingIndex += 1;

    if (pendingIndex === pendingCalls.length) {
      pendingCalls = [];
      pendingIndex = 0;
    } else if (pendingIndex > 1024 && pendingIndex * 2 >= pendingCalls.length) {
      pendingCalls = pendingCalls.slice(pendingIndex);
      pendingIndex = 0;
    }

    return call;
  }

  function rejectPending(error: unknown): void {
    const calls = pendingCalls;
    const start = pendingIndex;
    pendingCalls = [];
    pendingIndex = 0;

    for (let index = start; index < calls.length; index += 1) calls[index]?.reject(error);
  }

  function resetLimiter(): void {
    strictIndex = 0;
    strictTicks = [];
    windowCount = 0;
    windowStart = undefined;
  }

  function cancelWithError(error: unknown): void {
    if (timeout !== undefined) {
      clearTimeout(timeout);
      timeout = undefined;
    }

    resetLimiter();

    rejectPending(error);
  }

  function cancel(reason?: unknown): void {
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

  function ref(): ThrottledFunction<Callback> {
    timeoutReferenced = true;
    setTimerReferenced(timeout, true);

    return throttled as ThrottledFunction<Callback>;
  }

  function unref(): ThrottledFunction<Callback> {
    timeoutReferenced = false;
    setTimerReferenced(timeout, false);

    return throttled as ThrottledFunction<Callback>;
  }

  function now(): number {
    const clock = globalThis.performance;

    return clock !== undefined && typeof clock.now === "function" ? clock.now() : Date.now();
  }

  function pruneStrictTicks(currentTime: number): void {
    while (
      strictIndex < strictTicks.length &&
      currentTime - strictTicks[strictIndex]! >= interval
    ) {
      strictIndex += 1;
    }

    if (strictIndex === strictTicks.length) {
      strictIndex = 0;
      strictTicks = [];
    } else if (strictIndex > 1024 && strictIndex * 2 >= strictTicks.length) {
      strictTicks = strictTicks.slice(strictIndex);
      strictIndex = 0;
    }
  }

  function hasCapacity(currentTime: number): boolean {
    if (strict) {
      pruneStrictTicks(currentTime);

      return strictTicks.length - strictIndex < limit;
    }

    if (windowStart === undefined || currentTime - windowStart >= interval) {
      windowCount = 0;
      windowStart = currentTime;
    }

    return windowCount < limit;
  }

  function reserve(currentTime: number): void {
    if (strict) strictTicks.push(currentTime);
    else windowCount += 1;
  }

  function invoke(call: QueuedCall<Result>): void {
    if (signal?.aborted) {
      abort();

      call.reject(signalAbortError);
      return;
    }

    activeCount += 1;
    let result: Promise<Result>;

    try {
      result = Promise.resolve(
        Reflect.apply(callback, throttled, call.arguments) as Result | PromiseLike<Result>,
      );
    } catch (error) {
      result = Promise.reject(error);
    }

    call.resolve(result);

    void result.then(onSettled, onSettled);
  }

  function hasImmediateCapacity(): boolean {
    if (signal?.aborted || getPendingCount() !== 0 || activeCount >= concurrency) {
      return false;
    }

    const currentTime = now();

    if (strict) {
      let index = strictIndex;
      while (index < strictTicks.length && currentTime - strictTicks[index]! >= interval) {
        index += 1;
      }

      return strictTicks.length - index < limit;
    }

    return (
      windowStart === undefined || currentTime - windowStart >= interval || windowCount < limit
    );
  }

  function schedule(): void {
    if (timeout !== undefined || getPendingCount() === 0 || activeCount >= concurrency) return;

    const currentTime = now();

    if (hasCapacity(currentTime)) {
      drain();
      return;
    }

    const nextAt = strict
      ? strictTicks[strictIndex]! + interval
      : (windowStart as number) + interval;

    timeout = setTimeout(onTimeout, Math.max(0, nextAt - currentTime));

    if (!timeoutReferenced) setTimerReferenced(timeout, false);
  }

  function drain(): void {
    if (signal?.aborted) {
      abort();
      return;
    }

    while (getPendingCount() !== 0 && activeCount < concurrency) {
      const currentTime = now();

      if (!hasCapacity(currentTime)) break;

      const call = dequeue();
      reserve(currentTime);
      invoke(call);
    }

    schedule();
  }

  function onSettled(): void {
    activeCount -= 1;

    drain();
  }

  function onTimeout(): void {
    timeout = undefined;

    drain();
  }

  function drop(): Promise<Result> {
    const promise = Promise.reject<Result>(createThrottledError());

    void promise.catch(() => undefined);

    return promise;
  }

  function throttled(...arguments_: Parameters<Callback>): Promise<Result> {
    if (signal?.aborted) abort();

    if (signalAbortError !== undefined) return Promise.reject(signalAbortError);

    const currentTime = now();
    const canInvoke =
      getPendingCount() === 0 && activeCount < concurrency && hasCapacity(currentTime);

    if (!canInvoke && (overflow === "drop" || getPendingCount() >= maxPending)) return drop();

    const call: QueuedCall<Result> = {
      ...createDeferred<Result>(),
      arguments: arguments_,
    };

    if (canInvoke) {
      reserve(currentTime);
      invoke(call);
    } else {
      pendingCalls.push(call);
      schedule();
    }

    return call.promise;
  }

  Object.defineProperties(throttled, {
    cancel: { configurable: true, enumerable: true, value: cancel, writable: true },
    hasImmediateCapacity: {
      configurable: true,
      enumerable: true,
      value: hasImmediateCapacity,
      writable: true,
    },
    ref: { configurable: true, enumerable: true, value: ref, writable: true },
    unref: { configurable: true, enumerable: true, value: unref, writable: true },
    pending: {
      get: () =>
        getPendingCount() === 0 ? null : (pendingCalls[pendingCalls.length - 1]?.promise ?? null),
    },
    pendingCount: { get: getPendingCount },
    activeCount: { get: () => activeCount },
  });

  defineFunctionIdentity(callback, throttled);

  if (signal !== undefined) abortRegistration = registerAbortListener(signal, abort);

  return throttled as ThrottledFunction<Callback>;
}
