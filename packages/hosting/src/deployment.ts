import {
  readResolvedGeneratedAssets,
  type ResolvedGeneratedAssets,
} from "hesperia/runtime/generated-assets";
import { canonicalizeMountURL } from "./internal/mount.ts";

/** A versioned deployment choice resolved independently from compiled control and policy. */
export interface ResolvedDeploymentV1 {
  /** Deployment record format version. */
  readonly version: 1;
  /** Canonical application mount selected for this deployment. */
  readonly mountPathname: string;
  /** Exact generated-resource root and native module credentials selected for this deployment. */
  readonly generatedAssets: ResolvedGeneratedAssets;
}

/**
 * Strictly snapshot a persisted resolved deployment record.
 *
 * This accepts only the versioned resolved shape; it does not parse raw host options, apply
 * defaults, or infer a binding from generated wrapper text.
 *
 * @param value - Untrusted value read from a persisted deployment record.
 * @returns A fresh frozen record containing the canonical mount and resolved generated assets.
 * @throws TypeError for unknown keys, accessors, noncanonical mounts, or invalid runtime bindings.
 */
export function snapshotDeployment(value: unknown): ResolvedDeploymentV1 {
  const fields = snapshotFields(value);

  if (fields.version !== 1) throw new TypeError("unsupported resolved deployment version");

  if (typeof fields.mountPathname !== "string")
    throw new TypeError("deployment mountPathname must be a string");

  const mountPathname = canonicalizeMountURL(fields.mountPathname);

  if (mountPathname !== fields.mountPathname)
    throw new TypeError("deployment mountPathname must already be canonical");

  const generatedAssets = readResolvedGeneratedAssets(fields.generatedAssets);

  if (!generatedAssets)
    throw new TypeError("deployment generatedAssets must be a resolved runtime binding");

  return Object.freeze({ version: 1, mountPathname, generatedAssets });
}

function snapshotFields(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("deployment must be an object with own data fields");

  const prototype = Object.getPrototypeOf(value);

  if (prototype !== Object.prototype && prototype !== null)
    throw new TypeError("deployment must be an ordinary or null-prototype record");

  const allowed = ["version", "mountPathname", "generatedAssets"] as const;
  const keys = Reflect.ownKeys(value);

  if (
    keys.length !== allowed.length ||
    keys.some((key) => typeof key !== "string" || !allowed.some((allowedKey) => allowedKey === key))
  )
    throw new TypeError("deployment has unknown or missing fields");

  const fields: Record<string, unknown> = Object.create(null);

  for (const key of allowed) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);

    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value"))
      throw new TypeError(`deployment ${key} must be an enumerable own data field`);

    fields[key] = descriptor.value;
  }

  return fields;
}
