import type { Contract, Graph } from "aeolia";
import { createContractApi, type HesperiaContractApi } from "./contract.ts";
import type { Owner } from "../runtime/owner.ts";

interface AdaptedApiRecord<C extends Contract = Contract> {
  readonly graph: Graph<C>;
  readonly contract: C;
}

/** The shape of an adapted API before a component owner is known. */
export type ImportedApi<C extends Contract = Contract> = HesperiaContractApi<C>;

const adaptedApis = new WeakMap<object, AdaptedApiRecord>();

/**
 * Mark a graph and contract pair for direct component imports.
 *
 * Provider adapters own their public constructor and may use this internal
 * marker to defer Hesperia's owner-bound projection until a component reads the
 * imported value. The marker itself never exposes a graph to authored code.
 */
export function markImportedApi<C extends Contract>(graph: Graph<C>, contract: C): ImportedApi<C> {
  const value = Object.freeze(Object.create(null)) as object;
  adaptedApis.set(value, Object.freeze({ graph, contract }));
  return value as ImportedApi<C>;
}

const ownerCaches = new WeakMap<Owner, WeakMap<object, unknown>>();
const adaptedNamespaces = new WeakMap<Owner, WeakSet<object>>();

/**
 * Resolve a direct import against the current generated component owner.
 * Unmarked imports are returned unchanged, preserving ordinary module values.
 */
export function bindImported(
  owner: Owner,
  value: unknown,
  mode: "direct" | "namespace" = "direct",
): unknown {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return value;
  if (mode === "direct" && adaptedApis.has(value)) owner.assertActive();
  const cache = ownerCaches.get(owner) ?? new WeakMap<object, unknown>();
  ownerCaches.set(owner, cache);
  const namespaces = adaptedNamespaces.get(owner) ?? new WeakSet<object>();
  adaptedNamespaces.set(owner, namespaces);
  return bindValue(owner, value, cache, namespaces, mode);
}

function bindValue(
  owner: Owner,
  value: object,
  cache: WeakMap<object, unknown>,
  namespaces: WeakSet<object>,
  mode: "direct" | "namespace",
): unknown {
  const record = adaptedApis.get(value);
  if (record !== undefined) owner.assertActive();
  const existing = cache.get(value);
  if (existing !== undefined) {
    if (namespaces.has(value)) owner.assertActive();
    return existing;
  }
  if (record !== undefined) {
    owner.assertActive();
    const bound = createContractApi(owner, record.graph, record.contract);
    cache.set(value, bound);
    return bound;
  }
  if (mode !== "namespace") return value;

  let adapted = false;
  const properties: PropertyKey[] = [];
  for (const property of Reflect.ownKeys(value)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, property);
    if (!descriptor) continue;
    properties.push(property);
    if (
      "value" in descriptor &&
      isObjectLike(descriptor.value) &&
      adaptedApis.has(descriptor.value)
    )
      adapted = true;
  }
  if (!adapted) return value;
  owner.assertActive();
  namespaces.add(value);
  const container = Object.create(Object.getPrototypeOf(value));
  cache.set(value, container);
  for (const property of properties) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, property);
    if (!descriptor) continue;
    Object.defineProperty(container, property, {
      configurable: true,
      enumerable: descriptor.enumerable,
      get() {
        const current = Reflect.get(value, property);
        return isObjectLike(current)
          ? bindValue(owner, current, cache, namespaces, "direct")
          : current;
      },
    });
  }
  return container;
}

function isObjectLike(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}
