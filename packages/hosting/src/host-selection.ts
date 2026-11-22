import { canonicalizeMountURL } from "./internal/mount.ts";
import type { HostSelection } from "./index.ts";

/**
 * Capture an explicit host selection without invoking accessors.
 * @param selection - Optional own-data mount selection supplied by the caller.
 * @returns A frozen canonical selection, or undefined for the saved mount.
 * @throws TypeError for invalid fields, accessors or mount paths.
 * @internal
 */
export function snapshotHostSelection(
  selection: HostSelection | undefined,
): HostSelection | undefined {
  if (selection === undefined) return undefined;

  if (selection === null || typeof selection !== "object" || Array.isArray(selection))
    throw new TypeError("host selection must be an object with own data fields");

  if (Reflect.ownKeys(selection).some((key) => key !== "mountURL"))
    throw new TypeError("host selection has unexpected fields");

  const descriptor = Object.getOwnPropertyDescriptor(selection, "mountURL");

  if (descriptor && !("value" in descriptor))
    throw new TypeError("host selection mountURL must be an own data field");

  return descriptor?.value === undefined
    ? Object.freeze({})
    : Object.freeze({ mountURL: canonicalizeMountURL(descriptor.value) });
}
