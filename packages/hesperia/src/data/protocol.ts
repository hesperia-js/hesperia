import type { Owner } from "../runtime/owner.ts";
import { isObjectLike } from "../utils.ts";

export type FrameworkAwaitKind = "task" | "query" | "render";

interface OwnerAwaitRegistration {
  readonly owner: Owner;
  readonly kind: FrameworkAwaitKind;
  readonly waitForOwner?: (owner: Owner) => PromiseLike<unknown>;
  readonly onConsume?: (owner: Owner) => void;
}

type AwaitRegistration = OwnerAwaitRegistration | { readonly kind: "import" };

const registrations = new WeakMap<object, AwaitRegistration>();
const freshQueries = new WeakMap<Owner, WeakSet<object>>();

/**
 * Record compiler-generated dynamic import provenance without assigning an owner.
 *
 * @typeParam T - The original native or lowered import Promise type.
 * @param value - The Promise returned by the generated dynamic import expression.
 * @returns The same Promise, without adding handlers or changing its settlement.
 * Each awaiting component owns its continuation; disposing one does not cancel
 * the import or another component waiting for the same Promise.
 */
export function registerModuleImport<T extends Promise<unknown>>(value: T): T {
  registrations.set(value, { kind: "import" });

  return value;
}

/** Register an owner-bound awaitable for compiler/runtime provenance checks. */
export function registerFrameworkAwaitable<T extends object>(
  value: T,
  owner: Owner,
  kind: FrameworkAwaitKind,
  waitForOwner?: (owner: Owner) => PromiseLike<unknown>,
  onConsume?: (owner: Owner) => void,
): T {
  registrations.set(value, { owner, kind, waitForOwner, onConsume });

  return value;
}

/** Return the internal provenance record for a framework awaitable, if registered. */
export function frameworkAwaitRegistration(value: unknown): AwaitRegistration | undefined {
  if (!isObjectLike(value)) return undefined;

  return registrations.get(value);
}

/** Mark a query value as freshly completed for one newly constructed Owner. */
export function markFrameworkQueryFresh(owner: Owner, identity: object): void {
  const queries = freshQueries.get(owner) ?? new WeakSet<object>();

  queries.add(identity);

  freshQueries.set(owner, queries);
}

/** Consume the reset-fresh marker so normal same-identity refresh behavior remains unchanged. */
export function consumeFrameworkQueryFresh(owner: Owner, identity: object): boolean {
  const queries = freshQueries.get(owner);

  if (!queries?.has(identity)) return false;

  queries.delete(identity);

  return true;
}
