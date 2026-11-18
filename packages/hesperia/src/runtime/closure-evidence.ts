/** @internal Symbolic target reference emitted before the final module graph exists. */
export interface ClosedClosureReferenceV2 {
  readonly version: 2;
  readonly buildIdentity: string;
  readonly target: "server" | "resume";
  readonly evidenceRef: string;
}

/** @internal Opaque final-target binding; data validation does not authenticate its issuer. */
export interface ClosedClosureBindingV2 extends ClosedClosureReferenceV2 {
  readonly resolverGraphDigest: string;
}

/** @internal The server/resume pair supplied through the admitted capture path. */
export interface ClosedClosureBindingsV1 {
  readonly version: 1;
  readonly buildIdentity: string;
  readonly serverClosure: ClosedClosureBindingV2;
  readonly resumeClosure: ClosedClosureBindingV2;
}

const referenceFields = ["version", "buildIdentity", "target", "evidenceRef"] as const;
const bindingFields = [...referenceFields, "resolverGraphDigest"] as const;
const pairFields = ["version", "buildIdentity", "serverClosure", "resumeClosure"] as const;

function ownDataRecord(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    return undefined;

  const record: Record<string, unknown> = Object.create(null);
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return undefined;
    record[key] = descriptor.value;
  }
  return record;
}

function referenceFrom(record: Record<string, unknown>): ClosedClosureReferenceV2 | undefined {
  const { version, buildIdentity, target, evidenceRef } = record;
  if (
    version !== 2 ||
    typeof buildIdentity !== "string" ||
    !buildIdentity ||
    (target !== "server" && target !== "resume") ||
    typeof evidenceRef !== "string" ||
    !evidenceRef
  )
    return undefined;
  return Object.freeze({ version: 2, buildIdentity, target, evidenceRef });
}

/** @internal Snapshot only the exact symbolic-reference data contract. */
export function readClosedClosureReferenceV2(value: unknown): ClosedClosureReferenceV2 | undefined {
  const record = ownDataRecord(value, referenceFields);
  return record && referenceFrom(record);
}

/** @internal Snapshot only an exact binding with the selected full-digest grammar. */
export function readClosedClosureBindingV2(value: unknown): ClosedClosureBindingV2 | undefined {
  const record = ownDataRecord(value, bindingFields);
  if (!record) return undefined;
  const reference = referenceFrom(record);
  const digest = record.resolverGraphDigest;
  if (!reference || typeof digest !== "string" || !/^sha256-[0-9a-f]{64}$/.test(digest))
    return undefined;
  return Object.freeze({ ...reference, resolverGraphDigest: digest });
}

/** @internal Snapshot the closed fixed-role pair without issuing compiler or native authority. */
export function readClosedClosureBindingsV1(value: unknown): ClosedClosureBindingsV1 | undefined {
  const record = ownDataRecord(value, pairFields);
  if (
    !record ||
    record.version !== 1 ||
    typeof record.buildIdentity !== "string" ||
    !record.buildIdentity
  )
    return undefined;
  const serverClosure = readClosedClosureBindingV2(record.serverClosure);
  const resumeClosure = readClosedClosureBindingV2(record.resumeClosure);
  if (
    !serverClosure ||
    !resumeClosure ||
    serverClosure.target !== "server" ||
    resumeClosure.target !== "resume" ||
    serverClosure.buildIdentity !== record.buildIdentity ||
    resumeClosure.buildIdentity !== record.buildIdentity
  )
    return undefined;
  return Object.freeze({
    version: 1,
    buildIdentity: record.buildIdentity,
    serverClosure,
    resumeClosure,
  });
}

/** @internal Compare an admitted binding's symbolic fields to the compiled reference. */
export function matchesClosedClosureReference(
  binding: ClosedClosureBindingV2,
  reference: ClosedClosureReferenceV2,
): boolean {
  return (
    binding.version === reference.version &&
    binding.buildIdentity === reference.buildIdentity &&
    binding.target === reference.target &&
    binding.evidenceRef === reference.evidenceRef
  );
}

/** @internal Compare every field of two already-checked opaque binding pairs. */
export function sameClosedClosureBindings(
  left: ClosedClosureBindingsV1,
  right: ClosedClosureBindingsV1,
): boolean {
  return (
    left.version === right.version &&
    left.buildIdentity === right.buildIdentity &&
    matchesClosedClosureReference(left.serverClosure, right.serverClosure) &&
    matchesClosedClosureReference(left.resumeClosure, right.resumeClosure) &&
    left.serverClosure.resolverGraphDigest === right.serverClosure.resolverGraphDigest &&
    left.resumeClosure.resolverGraphDigest === right.resumeClosure.resolverGraphDigest
  );
}
