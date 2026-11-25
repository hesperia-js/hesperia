import type { Component } from "./components.ts";
import { type Owner, RenderFault } from "./owner.ts";

/** Resolved project fallback values for channel declarations. */
export interface ChannelProjectDefaults {
  /** Positive finite overall timeout for one admitted send, in milliseconds. */
  readonly sendTimeoutMs: number;
  /** Positive safe integer limit for unfinished sends on one channel operation. */
  readonly maxPendingSends: number;
}

/** Build-time project policy attached to a generated component definition. */
export interface CompiledProjectPolicy {
  /** Permit explicitly requested iframe sandbox permissions besides allow-scripts. */
  readonly allowUnsafeEmbed: boolean;
  /** Complete immutable project fallback, below channel declaration defaults. */
  readonly channelDefaults: ChannelProjectDefaults;
}

const builtinChannelDefaults: ChannelProjectDefaults = Object.freeze({
  sendTimeoutMs: 10000,
  maxPendingSends: 64,
});
const builtinProjectPolicy: CompiledProjectPolicy = Object.freeze({
  allowUnsafeEmbed: false,
  channelDefaults: builtinChannelDefaults,
});
const definitionPolicies = new WeakMap<Function, CompiledProjectPolicy>();
const rootPolicies = new WeakMap<Owner, CompiledProjectPolicy>();

/**
 * @internal Resolve authored channel settings without reading accessor values.
 * Omitted fields use 10000 ms and 64. Invalid fields throw project-policy-value.
 * The result is an immutable copy and does not retain the caller's object.
 */
export function normalizeChannelProjectDefaults(value?: unknown): ChannelProjectDefaults {
  if (value === undefined) return builtinChannelDefaults;

  const { sendTimeoutMs: timeout, maxPendingSends: count } = channelDataFields(value);

  return validatedChannelDefaults(
    timeout === undefined ? builtinChannelDefaults.sendTimeoutMs : timeout,
    count === undefined ? builtinChannelDefaults.maxPendingSends : count,
  );
}

/**
 * @internal Validate, copy and freeze a complete generated or transported pair.
 * Missing, accessor, or invalid fields throw project-policy-value.
 */
export function snapshotChannelProjectDefaults(
  value: ChannelProjectDefaults,
): ChannelProjectDefaults {
  const { sendTimeoutMs, maxPendingSends } = channelDataFields(value);

  return validatedChannelDefaults(sendTimeoutMs, maxPendingSends);
}

/**
 * Attach compiled project policy to a root component without changing its identity.
 * Generated project code uses this before passing the definition to mount or bootstrap.
 * Conflicting registration throws project-policy-conflict before replacing the policy.
 */
export function registerProjectPolicy<P>(
  definition: Component<P>,
  policy: CompiledProjectPolicy,
): Component<P> {
  if (typeof definition !== "function")
    throw new RenderFault(
      "project-policy-definition",
      "Project policy requires a component definition",
    );

  const normalized = normalizeProjectPolicy(policy);
  const previous = definitionPolicies.get(definition);

  if (previous) {
    if (!samePolicy(previous, normalized))
      throw new RenderFault(
        "project-policy-conflict",
        "A component definition cannot register conflicting project policies",
      );

    return definition;
  }

  definitionPolicies.set(definition, normalized);

  return definition;
}

/** @internal Resolve generated input against the policy on the actual compiled definition. */
export function projectPolicyForDefinition(
  definition: Function,
  channelDefaults?: ChannelProjectDefaults,
): CompiledProjectPolicy {
  if (typeof definition !== "function")
    throw new RenderFault(
      "project-policy-definition",
      "Project policy requires a component definition",
    );

  const registered = definitionPolicies.get(definition);

  if (channelDefaults === undefined) return registered ?? builtinProjectPolicy;

  const normalized = snapshotChannelProjectDefaults(channelDefaults);

  if (registered) {
    if (!sameChannelDefaults(registered.channelDefaults, normalized))
      throw new RenderFault(
        "project-policy-conflict",
        "Generated channel defaults conflict with the compiled definition policy",
      );

    return registered;
  }

  return Object.freeze({ allowUnsafeEmbed: false, channelDefaults: normalized });
}

/** @internal Install one complete policy before authored component or scoped work runs. */
export function installRootProjectPolicy(
  root: Owner,
  definition: Function | undefined,
  policy?: CompiledProjectPolicy,
): void {
  if (root.parent !== null)
    throw new RenderFault(
      "project-policy-root",
      "Project policy can only be installed on a runtime root",
    );

  const registered = definition && definitionPolicies.get(definition);
  const value =
    policy === undefined ? (registered ?? builtinProjectPolicy) : normalizeProjectPolicy(policy);

  if (registered && !samePolicy(registered, value))
    throw new RenderFault(
      "project-policy-conflict",
      "Generated project policy conflicts with the compiled definition policy",
    );

  const previous = rootPolicies.get(root);

  if (previous) {
    if (!samePolicy(previous, value))
      throw new RenderFault(
        "project-policy-conflict",
        "A runtime root already has another project policy",
      );

    return;
  }

  rootPolicies.set(root, value);
}

/** @internal Read the complete immutable policy from the owner's root, or built-ins. */
export function projectPolicyFor(owner: Owner): CompiledProjectPolicy {
  let root = owner;

  while (root.parent) root = root.parent;

  return rootPolicies.get(root) ?? builtinProjectPolicy;
}

/** Read only the policy installed on the owner tree's root definition. */
export function allowUnsafeEmbedFor(owner: Owner): boolean {
  return projectPolicyFor(owner).allowUnsafeEmbed;
}

function normalizeProjectPolicy(policy: CompiledProjectPolicy): CompiledProjectPolicy {
  const allowUnsafeEmbed = ownDataField(policy, "allowUnsafeEmbed");
  const channelDefaults = ownDataField(policy, "channelDefaults");

  if (typeof allowUnsafeEmbed !== "boolean")
    throw new RenderFault(
      "project-policy-value",
      "allowUnsafeEmbed must be a boolean own data field",
    );

  if (channelDefaults === null || typeof channelDefaults !== "object")
    throw new RenderFault(
      "project-policy-value",
      "Compiled channel defaults require a complete own data pair",
    );

  return Object.freeze({
    allowUnsafeEmbed,
    channelDefaults: snapshotChannelProjectDefaults(channelDefaults as ChannelProjectDefaults),
  });
}

function channelDataFields(value: unknown): { sendTimeoutMs: unknown; maxPendingSends: unknown } {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new RenderFault(
      "project-policy-value",
      "channels must be an object with own data fields",
    );

  for (const key of Reflect.ownKeys(value)) {
    if (key !== "sendTimeoutMs" && key !== "maxPendingSends")
      throw new RenderFault(
        "project-policy-value",
        "channels has an unknown field: " + String(key),
      );
  }

  return {
    sendTimeoutMs: ownDataField(value, "sendTimeoutMs"),
    maxPendingSends: ownDataField(value, "maxPendingSends"),
  };
}

function validatedChannelDefaults(
  sendTimeoutMs: unknown,
  maxPendingSends: unknown,
): ChannelProjectDefaults {
  if (typeof sendTimeoutMs !== "number" || !Number.isFinite(sendTimeoutMs) || sendTimeoutMs <= 0)
    throw new RenderFault(
      "project-policy-value",
      "channels.sendTimeoutMs must be finite and positive",
    );

  if (
    typeof maxPendingSends !== "number" ||
    !Number.isSafeInteger(maxPendingSends) ||
    maxPendingSends <= 0
  )
    throw new RenderFault(
      "project-policy-value",
      "channels.maxPendingSends must be a positive safe integer",
    );

  return Object.freeze({ sendTimeoutMs, maxPendingSends });
}

function ownDataField(value: unknown, name: string): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new RenderFault(
      "project-policy-value",
      "Project policy requires an object with own data fields",
    );

  const descriptor = Object.getOwnPropertyDescriptor(value, name);

  if (descriptor && !("value" in descriptor))
    throw new RenderFault(
      "project-policy-value",
      "Project policy field " + name + " must not be an accessor",
    );

  return descriptor?.value;
}

function sameChannelDefaults(left: ChannelProjectDefaults, right: ChannelProjectDefaults): boolean {
  return (
    left.sendTimeoutMs === right.sendTimeoutMs && left.maxPendingSends === right.maxPendingSends
  );
}

function samePolicy(left: CompiledProjectPolicy, right: CompiledProjectPolicy): boolean {
  return (
    left.allowUnsafeEmbed === right.allowUnsafeEmbed &&
    sameChannelDefaults(left.channelDefaults, right.channelDefaults)
  );
}
