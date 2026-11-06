import { addAbortListener } from "node:events";
import * as nodeUtil from "node:util";
import { createDebounce, debounce as portableDebounce } from "./debounce.ts";
import { createThrottle, throttle as portableThrottle } from "./throttle.ts";
import type {
  AbortListenerRegistrar,
  DebounceOptions,
  DebouncedFunction,
  SchedulingCallback,
  ThrottleOptions,
  ThrottledFunction,
} from "./types.ts";

const registerAbortListener: AbortListenerRegistrar = (signal, listener) =>
  addAbortListener(signal, listener);

const qualifiedNodeVersions = new Set(["24.22.0", "26.10.0", "26.12.0"]);
const runtimeVersions = readRuntimeVersions();
const versionQualified =
  runtimeVersions.bun === undefined && qualifiedNodeVersions.has(runtimeVersions.node);
const nativeDebounce =
  versionQualified && "debounce" in nodeUtil
    ? (Reflect.get(nodeUtil, "debounce") as unknown)
    : undefined;
const nativeThrottle =
  versionQualified && "throttle" in nodeUtil
    ? (Reflect.get(nodeUtil, "throttle") as unknown)
    : undefined;
const nativeAvailable =
  typeof nativeDebounce === "function" && typeof nativeThrottle === "function";

/**
 * Node entry point for debounce. Delegates only on source-qualified Node versions
 * with both native functions present; other Node versions use the portable path.
 *
 * @typeParam Callback - Callback argument and result types.
 * @param callback - Function to invoke after the quiet period.
 * @param wait - Quiet-period duration.
 * @param options - Optional leading, supersession and cancellation settings.
 * @returns A promise-returning debounced function with Node-compatible controls.
 * @throws Synchronously for invalid construction arguments or an already-aborted signal.
 */
export function debounce<Callback extends SchedulingCallback>(
  callback: Callback,
  wait: number,
  options?: DebounceOptions,
): DebouncedFunction<Callback> {
  if (nativeAvailable) return (nativeDebounce as typeof portableDebounce)(callback, wait, options);

  return createDebounce(callback, wait, options, registerAbortListener);
}

/**
 * Node entry point for throttle. Delegates only on source-qualified Node versions
 * with both native functions present; other Node versions use the portable path.
 *
 * @typeParam Callback - Callback argument and result types.
 * @param callback - Function to invoke when rate and concurrency allow.
 * @param limit - Maximum calls allowed per interval.
 * @param interval - Rate interval in milliseconds.
 * @param options - Optional queue, concurrency, window and cancellation settings.
 * @returns A promise-returning throttled function with Node-compatible controls.
 * @throws Synchronously for invalid construction arguments or an already-aborted signal.
 */
export function throttle<Callback extends SchedulingCallback>(
  callback: Callback,
  limit: number,
  interval: number,
  options?: ThrottleOptions,
): ThrottledFunction<Callback> {
  if (nativeAvailable)
    return (nativeThrottle as typeof portableThrottle)(callback, limit, interval, options);

  return createThrottle(callback, limit, interval, options, registerAbortListener);
}

function readRuntimeVersions(): { readonly node: string; readonly bun: string | undefined } {
  const nodeProcess = (
    globalThis as typeof globalThis & {
      readonly process?: { readonly versions?: { readonly node?: string; readonly bun?: string } };
    }
  ).process;
  const versions = nodeProcess?.versions;

  return { node: versions?.node ?? "", bun: versions?.bun };
}
