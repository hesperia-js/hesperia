import type { Owner } from "../runtime/owner.ts";

export type FrameworkAwaitKind = "task" | "query" | "render";

interface AwaitRegistration {
  readonly owner: Owner;
  readonly kind: FrameworkAwaitKind;
  readonly waitForOwner?: (owner: Owner) => PromiseLike<unknown>;
}

const registrations = new WeakMap<object, AwaitRegistration>();

/** Register an owner-bound awaitable for compiler/runtime provenance checks. */
export function registerFrameworkAwaitable<T extends object>(
  value: T,
  owner: Owner,
  kind: FrameworkAwaitKind,
  waitForOwner?: (owner: Owner) => PromiseLike<unknown>,
): T {
  registrations.set(value, { owner, kind, waitForOwner });
  return value;
}

/** Return the internal provenance record for a framework awaitable, if registered. */
export function frameworkAwaitRegistration(value: unknown): AwaitRegistration | undefined {
  if ((typeof value !== "object" && typeof value !== "function") || value === null)
    return undefined;
  return registrations.get(value);
}
