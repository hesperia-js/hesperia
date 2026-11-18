import type { Component } from "./components.ts";
import { Owner, RenderFault } from "./owner.ts";

/** Build-time project policy attached to a generated component definition. */
export interface CompiledProjectPolicy {
  /** Permit explicitly requested iframe sandbox permissions besides allow-scripts. */
  readonly allowUnsafeEmbed: boolean;
}

const definitionPolicies = new WeakMap<Function, boolean>();
const rootPolicies = new WeakMap<Owner, boolean>();

/**
 * Attach compiled project policy to a root component without changing its identity.
 * Generated project code uses this before passing the definition to mount or bootstrap.
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

  if (typeof policy?.allowUnsafeEmbed !== "boolean")
    throw new RenderFault("project-policy-value", "allowUnsafeEmbed must be a boolean");

  const previous = definitionPolicies.get(definition);

  if (previous !== undefined || definitionPolicies.has(definition)) {
    if (previous !== policy.allowUnsafeEmbed)
      throw new RenderFault(
        "project-policy-conflict",
        "A component definition cannot register conflicting project policies",
      );

    return definition;
  }

  definitionPolicies.set(definition, policy.allowUnsafeEmbed);

  return definition;
}

/** Install policy once on a fresh runtime root before any component body runs. */
export function installRootProjectPolicy(
  root: Owner,
  definition: Component<unknown> | undefined,
  policy?: CompiledProjectPolicy,
): void {
  if (root.parent !== null)
    throw new RenderFault(
      "project-policy-root",
      "Project policy can only be installed on a runtime root",
    );

  const registered = definition === undefined ? undefined : definitionPolicies.get(definition);
  let value = registered ?? false;

  if (policy !== undefined) {
    if (policy === null || typeof policy !== "object" || Array.isArray(policy))
      throw new RenderFault(
        "project-policy-value",
        "Project policy requires an object with own data fields",
      );

    const descriptor = Object.getOwnPropertyDescriptor(policy, "allowUnsafeEmbed");

    if (descriptor && !("value" in descriptor))
      throw new RenderFault(
        "project-policy-value",
        "Project policy field allowUnsafeEmbed must not be an accessor",
      );

    if (typeof descriptor?.value !== "boolean")
      throw new RenderFault("project-policy-value", "allowUnsafeEmbed must be a boolean");

    value = descriptor.value;

    if (registered !== undefined && registered !== value)
      throw new RenderFault(
        "project-policy-conflict",
        "Generated project policy conflicts with the compiled definition policy",
      );
  }

  const previous = rootPolicies.get(root);

  if (previous !== undefined || rootPolicies.has(root)) {
    if (previous !== value)
      throw new RenderFault(
        "project-policy-conflict",
        "A runtime root already has another project policy",
      );

    return;
  }

  rootPolicies.set(root, value);
}

const builtinProjectPolicies: readonly CompiledProjectPolicy[] = [
  Object.freeze({ allowUnsafeEmbed: false }),
  Object.freeze({ allowUnsafeEmbed: true }),
];

/** @internal Read the selected immutable policy from the actual Owner root. */
export function projectPolicyFor(owner: Owner): CompiledProjectPolicy {
  let root = owner;

  while (root.parent) root = root.parent;

  return builtinProjectPolicies[rootPolicies.get(root) ? 1 : 0]!;
}

/** Read only the policy installed on the owner tree's root definition. */
export function allowUnsafeEmbedFor(owner: Owner): boolean {
  let root = owner;

  while (root.parent) root = root.parent;

  return rootPolicies.get(root) ?? false;
}
