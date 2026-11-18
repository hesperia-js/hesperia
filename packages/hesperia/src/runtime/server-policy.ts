import type {
  DataApplication,
  DataBindingBootstrap,
  DataSecurity,
  DataSecurityPartition,
} from "../data/environment.ts";
import type { NativeHttpRequestUseV1 } from "./native-http-work.ts";
import type { Owner } from "./owner.ts";
import type {
  PhysicalNativeExecutionLifetime,
  PhysicalNativeRequestLifetime,
} from "./retirement.ts";

const boundServerExecutionKey: unique symbol = Symbol("bound server execution");

/** @internal One opaque identity issued by the native module parent. */
export type BoundServerExecution = object & { readonly [boundServerExecutionKey]: never };

const requestExecutionContextBrand: unique symbol = Symbol("server request execution context");

export interface ServerRequestExecutionContext {
  readonly [requestExecutionContextBrand]: true;
}

type RequestDataIdentity =
  | { readonly kind: "none" }
  | {
      readonly kind: "bound";
      readonly application: DataApplication;
      readonly security: DataSecurity;
    };

interface ServerRequestExecutionRecord {
  readonly parent: object;
  readonly entry: object;
  readonly custody: object;
  readonly request: Request;
  readonly use: NativeHttpRequestUseV1;
  readonly reservation: PhysicalNativeRequestLifetime;
  readonly execution?: BoundServerExecution;
  owner?: Owner;
  dataIdentity?: RequestDataIdentity;
}

const serverRequestExecutionRecords = new WeakMap<
  ServerRequestExecutionContext,
  ServerRequestExecutionRecord
>();

/** @internal Issue only for an exact request already admitted by its NativeModuleParent. */
export function issueServerRequestExecutionContext(
  parent: object,
  entry: object,
  custody: object,
  request: Request,
  use: NativeHttpRequestUseV1,
  reservation: PhysicalNativeRequestLifetime,
  execution?: BoundServerExecution,
): ServerRequestExecutionContext {
  const context = Object.freeze(Object.create(null)) as ServerRequestExecutionContext;

  serverRequestExecutionRecords.set(context, {
    parent,
    entry,
    custody,
    request,
    use,
    reservation,
    ...(execution === undefined ? {} : { execution }),
  });

  return context;
}

/** @internal Validate the opaque request context against the Host lifetime's exact reservation. */
export function assertServerRequestExecutionContext(
  context: unknown,
  reservation: PhysicalNativeRequestLifetime,
): asserts context is ServerRequestExecutionContext {
  const record =
    typeof context === "object" && context !== null
      ? serverRequestExecutionRecords.get(context as ServerRequestExecutionContext)
      : undefined;

  if (!record) throw new TypeError("A server session requires its live request execution context");

  if (record.reservation !== reservation)
    throw new TypeError(
      "A server session requires the request context for its exact native reservation",
    );
}

/** @internal Bind the actual Host Owner after its request lifetime has been constructed. */
export function bindServerRequestExecutionOwner(
  context: ServerRequestExecutionContext,
  reservation: PhysicalNativeRequestLifetime,
  owner: Owner,
): void {
  assertServerRequestExecutionContext(context, reservation);

  const record = serverRequestExecutionRecords.get(context)!;

  if (record.owner)
    throw new TypeError("A server request execution context binds to one actual Host Owner");

  if (record.execution !== undefined && serverSourceOwnerBindings.has(owner))
    throw new TypeError("An actual Host Owner is already bound to a live server policy context");

  record.owner = owner;

  if (record.execution !== undefined) {
    const binding: ServerSourceOwnerBinding = Object.freeze({
      kind: "request",
      context,
      execution: record.execution,
      parent: record.parent,
      entry: record.entry,
      custody: record.custody,
      reservation: record.reservation,
    });
    serverSourceOwnerBindings.set(owner, binding);
  }
}

/** @internal Record the actual Data identities installed on that Host Owner. */
export function bindServerRequestDataIdentity(
  context: ServerRequestExecutionContext,
  reservation: PhysicalNativeRequestLifetime,
  owner: Owner,
  identity: { readonly application: DataApplication; readonly security: DataSecurity } | undefined,
): void {
  assertServerRequestExecutionContext(context, reservation);

  const record = serverRequestExecutionRecords.get(context)!;

  if (record.owner !== owner || record.dataIdentity !== undefined)
    throw new TypeError("A server request Data identity binds once to its actual Host Owner");

  record.dataIdentity =
    identity === undefined
      ? Object.freeze({ kind: "none" as const })
      : Object.freeze({ kind: "bound" as const, ...identity });
}

/** @internal Require the same Owner and completed Data identity binding before API-scope install. */
export function assertServerRequestExecutionOwner(
  context: ServerRequestExecutionContext,
  reservation: PhysicalNativeRequestLifetime,
  owner: Owner,
): void {
  assertServerRequestExecutionContext(context, reservation);

  const record = serverRequestExecutionRecords.get(context)!;

  if (record.owner !== owner || record.dataIdentity === undefined)
    throw new TypeError("A request API scope requires its actual Host Owner and Data identity");
}

/** @internal Recover the exact Owner retained by a still-owned native request reservation. */
export function readServerRequestExecutionOwner(
  context: ServerRequestExecutionContext,
  reservation: PhysicalNativeRequestLifetime,
): Owner | undefined {
  assertServerRequestExecutionContext(context, reservation);
  const record = serverRequestExecutionRecords.get(context)!;
  return record.dataIdentity === undefined ? undefined : record.owner;
}

/** @internal Drop strong request/Owner/Data references only after the outer operation retires. */
export function releaseServerRequestExecutionContext(context: ServerRequestExecutionContext): void {
  const record = serverRequestExecutionRecords.get(context);
  const owner = record?.owner;
  const execution = record?.execution;

  if (record && owner !== undefined && execution !== undefined) {
    const binding = serverSourceOwnerBindings.get(owner);

    if (
      binding?.kind === "request" &&
      binding.context === context &&
      binding.execution === execution &&
      binding.parent === record.parent &&
      binding.entry === record.entry &&
      binding.custody === record.custody &&
      binding.reservation === record.reservation
    )
      serverSourceOwnerBindings.delete(owner);
  }

  serverRequestExecutionRecords.delete(context);
}

const serverExecutionContextBrand: unique symbol = Symbol("server execution context");

export interface ServerExecutionContext {
  readonly [serverExecutionContextBrand]: true;
}

interface ServerExecutionRecord {
  readonly parent: object;
  readonly entry: object;
  readonly custody: object;
  readonly reservation: PhysicalNativeExecutionLifetime;
  dataBinding?: DataBindingBootstrap;
  readonly dataBindingMode: "fixed" | "deferred-static-render";
  readonly execution?: BoundServerExecution;
  state: "active" | "revoked";
  owner?: Owner;
  dataIdentityState: "pending" | "unbound" | "bound";
  dataIdentity?: RequestDataIdentity;
}

const serverExecutionRecords = new WeakMap<ServerExecutionContext, ServerExecutionRecord>();

/** @internal Link a real Host Owner to its original NativeOwner-issued execution context. */
export type ServerSourceOwnerBinding =
  | {
      readonly kind: "request";
      readonly context: ServerRequestExecutionContext;
      readonly execution: BoundServerExecution;
      readonly parent: object;
      readonly entry: object;
      readonly custody: object;
      readonly reservation: PhysicalNativeRequestLifetime;
    }
  | {
      readonly kind: "execution";
      readonly context: ServerExecutionContext;
      readonly execution: BoundServerExecution;
      readonly parent: object;
      readonly entry: object;
      readonly custody: object;
      readonly reservation: PhysicalNativeExecutionLifetime;
    };

const serverSourceOwnerBindings = new WeakMap<
  Owner,
  ServerSourceOwnerBinding
>();

/** @internal Issue only for a static or independent execution admitted by its NativeModuleParent. */
export function issueServerExecutionContext(
  parent: object,
  entry: object,
  custody: object,
  reservation: PhysicalNativeExecutionLifetime,
  dataBinding?: DataBindingBootstrap,
  execution?: BoundServerExecution,
  dataBindingMode: "fixed" | "deferred-static-render" = "fixed",
): ServerExecutionContext {
  if (dataBindingMode === "deferred-static-render" && dataBinding !== undefined)
    throw new TypeError("A deferred static render cannot start with a Data binding");

  const context = Object.freeze(Object.create(null)) as ServerExecutionContext;

  serverExecutionRecords.set(context, {
    parent,
    entry,
    custody,
    reservation,
    ...(dataBinding === undefined ? {} : { dataBinding }),
    dataBindingMode,
    ...(execution === undefined ? {} : { execution }),
    state: "active",
    dataIdentityState: "pending",
  });

  return context;
}

/** @internal Validate the opaque execution context against its exact execution child. */
export function assertServerExecutionContext(
  context: unknown,
  reservation: PhysicalNativeExecutionLifetime,
): asserts context is ServerExecutionContext {
  const record =
    typeof context === "object" && context !== null
      ? serverExecutionRecords.get(context as ServerExecutionContext)
      : undefined;

  if (!record || record.state !== "active")
    throw new TypeError("A server session requires its live execution context");

  if (record.reservation !== reservation)
    throw new TypeError(
      "A server session requires the execution context for its exact native reservation",
    );
}

/** @internal Require the exact reserved static-render context before exposing an Owner signal. */
export function assertStaticRenderExecutionContext(
  context: unknown,
  reservation: PhysicalNativeExecutionLifetime,
): asserts context is ServerExecutionContext {
  assertServerExecutionContext(context, reservation);

  const record = serverExecutionRecords.get(context)!;

  if (
    record.dataBindingMode !== "deferred-static-render" ||
    record.dataIdentityState !== "pending" ||
    record.dataIdentity !== undefined
  )
    throw new TypeError("A static render Owner requires its unused deferred Data binding slot");
}

/** @internal Bind the actual Host Owner after its execution lifetime has been constructed. */
export function bindServerExecutionOwner(
  context: ServerExecutionContext,
  reservation: PhysicalNativeExecutionLifetime,
  owner: Owner,
): void {
  assertServerExecutionContext(context, reservation);

  const record = serverExecutionRecords.get(context)!;

  if (record.owner)
    throw new TypeError("A server execution context binds to one actual Host Owner");

  if (record.execution !== undefined && serverSourceOwnerBindings.has(owner))
    throw new TypeError("An actual Host Owner is already bound to a live server policy context");

  record.owner = owner;

  if (record.execution !== undefined) {
    const binding: ServerSourceOwnerBinding = Object.freeze({
      kind: "execution",
      context,
      execution: record.execution,
      parent: record.parent,
      entry: record.entry,
      custody: record.custody,
      reservation: record.reservation,
    });
    serverSourceOwnerBindings.set(owner, binding);
  }
}

/** @internal Record the actual Data identities installed on that Host Owner. */
export function bindServerExecutionDataIdentity(
  context: ServerExecutionContext,
  reservation: PhysicalNativeExecutionLifetime,
  owner: Owner,
  dataBinding: DataBindingBootstrap | undefined,
  identity: { readonly application: DataApplication; readonly security: DataSecurity } | undefined,
): void {
  assertServerExecutionContext(context, reservation);

  const record = serverExecutionRecords.get(context)!;

  if (
    record.owner !== owner ||
    record.dataIdentityState !== "pending" ||
    (record.dataBinding !== dataBinding &&
      (record.dataBindingMode !== "deferred-static-render" || record.dataBinding !== undefined)) ||
    (identity === undefined) !== (dataBinding === undefined) ||
    (identity !== undefined &&
      (dataBinding === undefined || identity.application !== dataBinding.application))
  )
    throw new TypeError("A server execution Data identity binds once to its actual Host Owner");

  if (record.dataBindingMode === "deferred-static-render") record.dataBinding = dataBinding;

  record.dataIdentity =
    identity === undefined
      ? Object.freeze({ kind: "none" as const })
      : Object.freeze({ kind: "bound" as const, ...identity });
  record.dataIdentityState = identity === undefined ? "unbound" : "bound";
}

/** @internal Require the same Owner and completed Data identity binding before API-scope install. */
export function assertServerExecutionOwner(
  context: ServerExecutionContext,
  reservation: PhysicalNativeExecutionLifetime,
  owner: Owner,
): void {
  assertServerExecutionContext(context, reservation);

  const record = serverExecutionRecords.get(context)!;

  if (
    record.owner !== owner ||
    record.dataIdentityState === "pending" ||
    record.dataIdentity === undefined
  )
    throw new TypeError("An execution API scope requires its actual Host Owner and Data identity");
}

/** @internal Read a live actual Owner binding without accepting copied context fields. */
export function readServerSourceOwnerBinding(
  owner: Owner,
): ServerSourceOwnerBinding | undefined {
  const binding = serverSourceOwnerBindings.get(owner);

  if (binding === undefined) return undefined;

  if (binding.kind === "request") {
    const record = serverRequestExecutionRecords.get(binding.context);

    assertServerRequestExecutionOwner(binding.context, binding.reservation, owner as Owner);

    if (
      record === undefined ||
      record.execution !== binding.execution ||
      record.parent !== binding.parent ||
      record.entry !== binding.entry ||
      record.custody !== binding.custody ||
      record.reservation !== binding.reservation
    )
      throw new TypeError("The request Owner binding no longer matches its native execution");

    return binding;
  }

  const record = serverExecutionRecords.get(binding.context);

  assertServerExecutionOwner(binding.context, binding.reservation, owner as Owner);

  if (
    record === undefined ||
    record.execution !== binding.execution ||
    record.parent !== binding.parent ||
    record.entry !== binding.entry ||
    record.custody !== binding.custody ||
    record.reservation !== binding.reservation
  )
    throw new TypeError("The execution Owner binding no longer matches its native execution");

  return binding;
}

/** @internal Require the actual Owner policy context to match its original Data identities. */
export function assertServerSourceOwnerDataIdentity(
  owner: Owner,
  application: DataApplication,
  security: DataSecurityPartition | undefined,
): void {
  const identity = readServerSourceOwnerDataIdentity(owner);

  if (identity.kind !== "bound" || identity.application !== application)
    throw new TypeError(
      "The server source Data identities do not match its actual Owner policy context",
    );

  const securityMatches =
    security === undefined
      ? identity.security.kind === "none"
      : identity.security.kind === "partition" && identity.security.partition === security;

  if (!securityMatches)
    throw new TypeError(
      "The server source Data identities do not match its actual Owner policy context",
    );
}

/** @internal Read the actual Owner's one-time Data identity, preserving unbound versus bound-none. */
export function readServerSourceOwnerDataIdentity(owner: Owner):
  | { readonly kind: "unbound" }
  | {
      readonly kind: "bound";
      readonly application: DataApplication;
      readonly security: DataSecurity;
    } {
  const binding = readServerSourceOwnerBinding(owner);

  if (binding === undefined)
    throw new TypeError("A server source requires its actual Owner policy context");

  const identity =
    binding.kind === "request"
      ? serverRequestExecutionRecords.get(binding.context)?.dataIdentity
      : serverExecutionRecords.get(binding.context)?.dataIdentity;

  if (identity === undefined)
    throw new TypeError("A server source requires its completed Data identity binding");

  return identity.kind === "none" ? { kind: "unbound" } : identity;
}

/** @internal Drop strong Owner and Data references after the execution producer retires. */
export function releaseServerExecutionContext(context: ServerExecutionContext): void {
  const record = serverExecutionRecords.get(context);
  const owner = record?.owner;
  const execution = record?.execution;

  if (record && owner !== undefined && execution !== undefined) {
    const binding = serverSourceOwnerBindings.get(owner);

    if (
      binding?.kind === "execution" &&
      binding.context === context &&
      binding.execution === execution &&
      binding.parent === record.parent &&
      binding.entry === record.entry &&
      binding.custody === record.custody &&
      binding.reservation === record.reservation
    )
      serverSourceOwnerBindings.delete(owner);
  }

  serverExecutionRecords.delete(context);
}

/** @internal Require the actual Owner and completed Data binding before a request uses its backend. */
export function assertServerRequestExecutionReady(
  context: ServerRequestExecutionContext,
  reservation: PhysicalNativeRequestLifetime,
): void {
  assertServerRequestExecutionContext(context, reservation);
  const record = serverRequestExecutionRecords.get(context)!;

  if (record.owner === undefined || record.dataIdentity === undefined)
    throw new TypeError(
      "A configured request execution requires its actual Host Owner and Data identity",
    );
}

/** @internal Read the Data security kind bound to this ready request owner. */
export function readServerRequestDataSecurityKind(
  context: ServerRequestExecutionContext,
  reservation: PhysicalNativeRequestLifetime,
): "unbound" | "none" | "partition" {
  assertServerRequestExecutionReady(context, reservation);
  const identity = serverRequestExecutionRecords.get(context)!.dataIdentity!;
  return identity.kind === "none" ? "unbound" : identity.security.kind;
}

/** @internal Require the actual Owner and completed Data binding before a Host execution uses its backend. */
export function assertServerExecutionReady(
  context: ServerExecutionContext,
  reservation: PhysicalNativeExecutionLifetime,
): void {
  assertServerExecutionContext(context, reservation);
  const record = serverExecutionRecords.get(context)!;

  if (record.owner === undefined || record.dataIdentity === undefined)
    throw new TypeError("A configured Host execution requires its actual Owner and Data identity");
}
