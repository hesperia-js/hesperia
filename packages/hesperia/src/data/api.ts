import type { Contract, Graph } from "aeolia";
import { createContractApi, type HesperiaContractApi } from "./contract.ts";
import type { Owner } from "../runtime/owner.ts";
import { isObjectLike } from "../utils.ts";

interface AdaptedApiRecord {
  readonly graph: Graph;
  readonly contract: Contract;
  readonly project?: (bound: object) => object;
}

/** The shape of an adapted API before a component owner is known. */
export type ImportedApi<C extends Contract = Contract> = HesperiaContractApi<C>;

const adaptedApis = new WeakMap<object, AdaptedApiRecord>();
const adaptedApiGraphs = new WeakMap<object, Graph>();

/**
 * Mark a graph and contract pair for direct component imports.
 *
 * Provider adapters own their public constructor and may use this internal
 * marker to defer Hesperia's owner-bound projection until a component reads the
 * imported value. With a projector, the compiled component receives its
 * facade from the already owner-bound API; the projector never receives the
 * owner or graph. The marker itself never exposes a graph to authored code.
 *
 * @param graph - Public Aeolia graph that owns the declared operation state.
 * @param contract - The same public Aeolia contract used to create `graph`.
 * @param project - Optional provider projection applied after Hesperia binds
 * the graph and contract to a component owner.
 * @returns A marker resolved to the owner-bound API, or to `Facade` when a
 * projector is supplied.
 */
export function markImportedApi<C extends Contract>(graph: Graph<C>, contract: C): ImportedApi<C>;

export function markImportedApi<C extends Contract, Facade extends object>(
  graph: Graph<C>,
  contract: C,
  project: (bound: HesperiaContractApi<C>) => Facade,
): Facade;

export function markImportedApi<C extends Contract, Facade extends object>(
  graph: Graph<C>,
  contract: C,
  project?: (bound: HesperiaContractApi<C>) => Facade,
): ImportedApi<C> | Facade {
  const value = Object.freeze(Object.create(null)) as object;
  const record: AdaptedApiRecord = project
    ? {
        graph,
        contract,
        project: (bound) => project(bound as unknown as HesperiaContractApi<C>),
      }
    : { graph, contract };

  adaptedApis.set(value, Object.freeze(record));

  return value as ImportedApi<C> | Facade;
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
  if (!isObjectLike(value)) return value;

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

    adaptedApiGraphs.set(bound as object, record.graph);

    const adaptedValue = record.project ? record.project(bound) : bound;

    if (isObjectLike(adaptedValue)) adaptedApiGraphs.set(adaptedValue, record.graph);

    cache.set(value, adaptedValue);

    return adaptedValue;
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

/** Reset the shared Aeolia graph behind an imported, bound, or projected API. */
export function reset(api: object): Promise<void> {
  const graph = adaptedApis.get(api)?.graph ?? adaptedApiGraphs.get(api);

  if (!graph) throw new TypeError("reset expects an API returned by withAeolia");

  return graph.reset();
}
