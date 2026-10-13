import { isNonArrayObject } from "./utils.ts";

/** Browser application settings exported by the root app.config.ts module. */
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
}

/** Validate runtime settings before creating any application component lifetime. */
export function resolveAppConfiguration(value: unknown): Required<AppConfiguration> {
  if (!isNonArrayObject(value))
    throw new TypeError("app.config.ts must default-export a configuration object");

  for (const key of Object.keys(value)) {
    if (key !== "pageCacheSize") throw new TypeError(`Unknown application setting: ${key}`);
  }

  const supplied = (value as AppConfiguration).pageCacheSize;

  const size = supplied === undefined ? 5 : supplied;

  if (!Number.isSafeInteger(size) || size < 0)
    throw new TypeError("pageCacheSize must be a nonnegative safe integer");

  return Object.freeze({ pageCacheSize: size });
}
