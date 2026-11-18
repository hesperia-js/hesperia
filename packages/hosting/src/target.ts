/** An explicit deployment contract, independent of operation-validation profiles. */
interface TargetDeclaration<Runtime extends string, Profile extends string> {
  /** Declaration format version. */
  readonly version: 1;
  /** Runtime selected by the project, never inferred from the build process. */
  readonly runtime: Runtime;
  /** Owned deployment contract within that runtime. */
  readonly profile: Profile;
}

/** The five supported declaration shapes; recognition does not imply implementation availability. */
export type ProductionTargetV1 =
  | TargetDeclaration<"browser", "static">
  | TargetDeclaration<"node", "fetch">
  | TargetDeclaration<"workerd", "module-worker">
  | TargetDeclaration<"bun", "elysia">
  | TargetDeclaration<"bun", "hono">;

/** A source-free binding between one declaration and its exact owned descriptor. */
interface CapturedTarget<Declaration extends ProductionTargetV1, Identity extends string> {
  /** Captured binding format version, independent of completed-record versions. */
  readonly version: 1;
  /** Normalized explicit declaration saved by the producer. */
  readonly declaration: Declaration;
  /** Descriptor identity that must agree with the declaration. */
  readonly descriptorIdentity: Identity;
  /** Owned descriptor revision required by this binding. */
  readonly descriptorRevision: 1;
}

/** A closed correlated union; declaration and descriptor identity cannot be crossed. */
export type CapturedProductionTargetV1 =
  | CapturedTarget<TargetDeclaration<"browser", "static">, "hesperia.target/browser-static/1">
  | CapturedTarget<TargetDeclaration<"node", "fetch">, "hesperia.target/node-fetch/1">
  | CapturedTarget<
      TargetDeclaration<"workerd", "module-worker">,
      "hesperia.target/workerd-module-worker/1"
    >
  | CapturedTarget<TargetDeclaration<"bun", "elysia">, "hesperia.target/bun-elysia/1">
  | CapturedTarget<TargetDeclaration<"bun", "hono">, "hesperia.target/bun-hono/1">;

/** The backend-free static-directory binding. */
export type BrowserStaticBinding = Extract<
  CapturedProductionTargetV1,
  { readonly declaration: { readonly runtime: "browser" } }
>;

/** The module-worker binding, whose packaging and process lifetime are separate from in-process hosts. */
export type WorkerdBinding = Extract<
  CapturedProductionTargetV1,
  { readonly declaration: { readonly runtime: "workerd" } }
>;

/** Bindings that can carry request-time server artifacts. */
export type ServerTargetBinding = Exclude<CapturedProductionTargetV1, BrowserStaticBinding>;

/** Owned module-contract data; project and captured inputs cannot override the ABI. */
interface OwnedTarget<Binding extends CapturedProductionTargetV1, ABI extends string> {
  /** The exact normalized descriptor binding. */
  readonly binding: Binding;
  /** Module or directory contract associated with that descriptor. */
  readonly moduleABI: ABI;
}

/** Internal correlated descriptor facts, without a provider-availability claim. */
export type OwnedProductionTargetV1 =
  | OwnedTarget<BrowserStaticBinding, "browser-static-directory-v1">
  | OwnedTarget<
      Extract<
        CapturedProductionTargetV1,
        { readonly descriptorIdentity: "hesperia.target/node-fetch/1" }
      >,
      "node-captured-esm-v1"
    >
  | OwnedTarget<WorkerdBinding, "workerd-module-worker-v1">
  | OwnedTarget<
      Extract<
        CapturedProductionTargetV1,
        { readonly descriptorIdentity: "hesperia.target/bun-elysia/1" }
      >,
      "bun-captured-esm-v1"
    >
  | OwnedTarget<
      Extract<
        CapturedProductionTargetV1,
        { readonly descriptorIdentity: "hesperia.target/bun-hono/1" }
      >,
      "bun-captured-esm-v1"
    >;

/**
 * Snapshot an explicit project target using only its own data descriptors.
 *
 * No property getter is invoked. Proxy reflection traps retain their native
 * synchronous behavior. The returned plain record is fresh and frozen.
 *
 * @param value - Untrusted declaration with exactly version, runtime and profile.
 * @returns The normalized declaration; it supplies no compatibility default.
 * @throws TypeError for malformed fields, accessors, symbols or unsupported pairs.
 */
export function snapshotProductionTarget(value: unknown): ProductionTargetV1 {
  return snapshotOwnedProductionTarget(value).binding.declaration;
}

/**
 * Snapshot a captured target and verify its declaration/descriptor correspondence.
 *
 * All four outer descriptors are captured before inspecting the declaration.
 * No input object is retained or reread after normalization.
 *
 * @param value - Untrusted versioned declaration and descriptor binding.
 * @returns A fresh frozen binding containing a fresh frozen declaration.
 * @throws TypeError for unknown keys, unsupported versions/revisions or crossed identities.
 */
export function snapshotCapturedProductionTarget(value: unknown): CapturedProductionTargetV1 {
  const fields = dataFields(
    value,
    ["version", "declaration", "descriptorIdentity", "descriptorRevision"],
    "captured production target",
  );

  if (fields.get("version") !== 1 || fields.get("descriptorRevision") !== 1)
    throw new TypeError("Unsupported captured production target version or descriptor revision");

  const target = snapshotOwnedProductionTarget(fields.get("declaration"));

  if (fields.get("descriptorIdentity") !== target.binding.descriptorIdentity)
    throw new TypeError("Captured production target descriptor does not match its declaration");

  return target.binding;
}

/**
 * Resolve only the closed declaration/identity/ABI association for internal consumers.
 *
 * @param value - Untrusted explicit project declaration.
 * @returns Fresh frozen owned data, without renderer, loader or availability facts.
 * @throws TypeError for malformed or unrecognized declarations.
 */
export function snapshotOwnedProductionTarget(value: unknown): OwnedProductionTargetV1 {
  const fields = dataFields(value, ["version", "runtime", "profile"], "production target");

  if (fields.get("version") !== 1)
    throw new TypeError("Unsupported production target declaration version");

  const runtime = fields.get("runtime");
  const profile = fields.get("profile");

  if (runtime === "browser" && profile === "static")
    return ownedTarget(
      "browser",
      "static",
      "hesperia.target/browser-static/1",
      "browser-static-directory-v1",
    );

  if (runtime === "node" && profile === "fetch")
    return ownedTarget("node", "fetch", "hesperia.target/node-fetch/1", "node-captured-esm-v1");

  if (runtime === "workerd" && profile === "module-worker")
    return ownedTarget(
      "workerd",
      "module-worker",
      "hesperia.target/workerd-module-worker/1",
      "workerd-module-worker-v1",
    );

  if (runtime === "bun" && profile === "elysia")
    return ownedTarget("bun", "elysia", "hesperia.target/bun-elysia/1", "bun-captured-esm-v1");

  if (runtime === "bun" && profile === "hono")
    return ownedTarget("bun", "hono", "hesperia.target/bun-hono/1", "bun-captured-esm-v1");

  throw new TypeError(
    "Unsupported production target; select browser/static, node/fetch, workerd/module-worker, bun/elysia or bun/hono",
  );
}

function ownedTarget<
  const Runtime extends string,
  const Profile extends string,
  const Identity extends string,
  const ABI extends string,
>(runtime: Runtime, profile: Profile, descriptorIdentity: Identity, moduleABI: ABI) {
  const declaration = Object.freeze({ version: 1 as const, runtime, profile });
  const binding = Object.freeze({
    version: 1 as const,
    declaration,
    descriptorIdentity,
    descriptorRevision: 1 as const,
  });

  return Object.freeze({ binding, moduleABI });
}

function dataFields(
  value: unknown,
  expected: readonly string[],
  label: string,
): ReadonlyMap<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError(`${label} must be an object`);

  const keys = Reflect.ownKeys(value);

  if (
    keys.length !== expected.length ||
    keys.some((key) => typeof key !== "string" || !expected.includes(key))
  )
    throw new TypeError(`${label} has unexpected or missing fields`);

  const fields = new Map<string, unknown>();

  for (const key of expected) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);

    if (!descriptor || !("value" in descriptor))
      throw new TypeError(`${label}.${key} must be an own data property`);

    fields.set(key, descriptor.value);
  }

  return fields;
}
