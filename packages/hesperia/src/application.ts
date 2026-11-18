import { isNonArrayObject } from "./utils.ts";
import { normalizeDataBindingBootstrap, type DataBindingBootstrap } from "./data/environment.ts";

/** Application settings exported by the root app.config.ts module. */
export interface AppConfiguration {
  /**
   * Maximum number of inactive page instances retained for history navigation.
   * Defaults to five; the visible page does not count toward this limit.
   * Zero disables retention after navigation completes. On overflow the earliest
   * cached page is destroyed, so returning to it creates a fresh lifetime.
   * Must be a nonnegative safe integer. Temporary retention of the outgoing
   * page while navigation is pending remains available for cancellation.
   */
  readonly pageCacheSize?: number;

  /** Optional application identity and root security supplier for adapted data. */
  readonly dataBinding?: DataBindingBootstrap;
}

/** Configuration consumed by application startup after validating authored fields. */
interface ResolvedAppConfiguration {
  readonly pageCacheSize: number;
  readonly dataBinding?: DataBindingBootstrap;
}

/** Validate runtime settings before creating any application component lifetime. */
export function resolveAppConfiguration(value: unknown): ResolvedAppConfiguration {
  if (!isNonArrayObject(value))
    throw new TypeError("app.config.ts must default-export a configuration object");

  for (const key of Object.keys(value)) {
    if (key !== "pageCacheSize" && key !== "dataBinding")
      throw new TypeError(`Unknown application setting: ${key}`);
  }

  const supplied = (value as AppConfiguration).pageCacheSize;

  const size = supplied === undefined ? 5 : supplied;

  if (!Number.isSafeInteger(size) || size < 0)
    throw new TypeError("pageCacheSize must be a nonnegative safe integer");

  const dataBindingDescriptor = Object.getOwnPropertyDescriptor(value, "dataBinding");

  if (dataBindingDescriptor && !Object.hasOwn(dataBindingDescriptor, "value"))
    throw new TypeError("app.config.ts dataBinding must be an own data property");

  const dataBinding = normalizeDataBindingBootstrap(dataBindingDescriptor?.value);

  return dataBinding === undefined
    ? Object.freeze({ pageCacheSize: size })
    : Object.freeze({ pageCacheSize: size, dataBinding });
}
