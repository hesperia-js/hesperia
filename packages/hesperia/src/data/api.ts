import type { Contract, Graph, GraphOptions, OperationDefinition, OperationTree } from "aeolia";
import { createContractApi, type HesperiaContractApi } from "./contract.ts";
import type { Owner } from "../runtime/owner.ts";
import { isObjectLike } from "../utils.ts";
import {
  assertPhysicalGraphConstructionUse,
  beginPhysicalGraphConstruction,
  completePhysicalGraphConstruction,
  failPhysicalGraphConstruction,
  type PhysicalGraphConstruction,
} from "../runtime/retirement.ts";
import type { NativeOperationPolicy } from "../validation/native-operation.ts";

type FiniteOperation = Extract<OperationDefinition, { readonly kind: "query" | "mutation" }>;
type OperationPolicies = ReadonlyMap<FiniteOperation, NativeOperationPolicy>;

interface AdaptedApiRecord {
  readonly graph: Graph;
  readonly contract: Contract;
  readonly project?: (bound: object) => object;
  readonly policies?: OperationPolicies;
}

interface CapturedGraphOptions {
  readonly prototype: object | null;
  readonly descriptors: readonly (readonly [PropertyKey, PropertyDescriptor])[];
}

interface RecordedGraphRecipe {
  readonly contract: Contract;
  readonly createRequestGraph: (construction?: PhysicalGraphConstruction) => object;
}

/** Compiler descriptor retained by identity with its actual graph result. @internal */
export interface CheckedGraphSourceUse {
  /** Per-source-use descriptor; the string alone does not authenticate a graph. */
  readonly id: string;
  /** Optional containing component descriptor. */
  readonly component?: string;
  /** Checked source category. */
  readonly kind: "graph";
}

/** Exact graph construction retained for one checked compiler use. @internal */
export interface RecordedGraphConstruction {
  /** Graph returned by the captured public constructor. */
  readonly graph: Graph;
  /** Contract read from the original options object. */
  readonly contract: Contract;
  /** Original public Aeolia constructor. */
  readonly create: (options: GraphOptions<Contract>) => Graph;
  /** Original options object passed to that constructor. */
  readonly options: GraphOptions<Contract>;
  /** Actual native-owner reservation, when construction used the admission bridge. */
  readonly construction: PhysicalGraphConstruction | undefined;
  /** Compiler descriptor supplied with the actual graph call. */
  readonly checkedUse: CheckedGraphSourceUse;
}

const recordedGraphConstructions = new WeakMap<object, RecordedGraphConstruction>();
const recordedGraphConstructionsByGraph = new WeakMap<object, RecordedGraphConstruction>();

interface TypedRecordedGraphRecipe<C extends Contract> extends RecordedGraphRecipe {
  readonly contract: C;
  readonly createRequestGraph: (construction?: PhysicalGraphConstruction) => Graph<C>;
}

/** The shape of an adapted API before a component owner is known. */
export type ImportedApi<C extends Contract = Contract> = HesperiaContractApi<C>;

const adaptedApis = new WeakMap<object, AdaptedApiRecord>();
const adaptedApiGraphs = new WeakMap<object, Graph>();
const recordedGraphRecipes = new WeakMap<object, RecordedGraphRecipe>();

/**
 * Capture the compiler-qualified public createGraph call for request-local
 * graph recreation. The original options object reaches the public callee
 * unchanged; only its own data descriptors are retained for later requests.
 * @param create - Public Aeolia graph constructor used for the original and request-local graphs.
 * @param options - The original options object passed unchanged to `create`.
 * @param checkedUse - Optional compiler descriptor retained with the actual graph result.
 * @returns The graph created by the original public call.
 */
export function createRecordedAeoliaGraph<C extends Contract>(
  create: (options: GraphOptions<C>) => Graph<C>,
  options: GraphOptions<C>,
  checkedUse?: CheckedGraphSourceUse,
): Graph<C> {
  return recordAeoliaGraph(create, options, undefined, checkedUse);
}

/**
 * Create the graph through one actual native-owner construction reservation.
 * @param construction - Exact one-use reservation returned by the native graph bridge.
 * @param create - Original public Aeolia constructor.
 * @param options - Original options object passed unchanged to `create`.
 * @param checkedUse - Optional compiler use descriptor retained with the actual graph result.
 * @returns The graph created by the admitted constructor.
 * @internal
 */
export function createAdmittedAeoliaGraph<C extends Contract>(
  construction: PhysicalGraphConstruction,
  create: (options: GraphOptions<C>) => Graph<C>,
  options: GraphOptions<C>,
  checkedUse?: CheckedGraphSourceUse,
): Graph<C> {
  if (construction === undefined)
    throw new TypeError("An admitted Aeolia Graph requires its original constructor reservation");

  return recordAeoliaGraph(create, options, construction, checkedUse);
}

function recordAeoliaGraph<C extends Contract>(
  create: (options: GraphOptions<C>) => Graph<C>,
  options: GraphOptions<C>,
  construction?: PhysicalGraphConstruction,
  checkedUse?: CheckedGraphSourceUse,
): Graph<C> {
  if (construction !== undefined) {
    if (checkedUse !== undefined) assertPhysicalGraphConstructionUse(construction, checkedUse);

    beginPhysicalGraphConstruction(construction);
  }

  try {
    const captured = captureGraphOptions(options);
    const graph = create(options);

    if (construction !== undefined) completePhysicalGraphConstruction(construction, graph);

    const contract = captured.descriptors.find(([key]) => key === "contract")?.[1].value as
      | C
      | undefined;

    if (contract === undefined || contract === null || !isObjectLike(graph))
      throw new TypeError("Recorded Aeolia graph creation did not produce a valid contract graph");

    const recipe: TypedRecordedGraphRecipe<C> = Object.freeze({
      contract,
      createRequestGraph: (requestConstruction?: PhysicalGraphConstruction) => {
        if (requestConstruction !== undefined) {
          if (checkedUse !== undefined)
            assertPhysicalGraphConstructionUse(requestConstruction, checkedUse);

          beginPhysicalGraphConstruction(requestConstruction);
        }

        try {
          const requestOptions = restoreGraphOptions(captured, contract);
          const requestGraph = create(requestOptions);

          if (requestConstruction !== undefined)
            completePhysicalGraphConstruction(requestConstruction, requestGraph);

          if (checkedUse !== undefined) {
            const requestRecord: RecordedGraphConstruction = Object.freeze({
              graph: requestGraph,
              contract,
              create: create as (options: GraphOptions<Contract>) => Graph,
              options: requestOptions as GraphOptions<Contract>,
              construction: requestConstruction,
              checkedUse,
            });
            recordedGraphConstructionsByGraph.set(requestGraph, requestRecord);
          }

          return requestGraph;
        } catch (reason) {
          if (requestConstruction !== undefined)
            failPhysicalGraphConstruction(requestConstruction, reason);

          throw reason;
        }
      },
    });

    recordedGraphRecipes.set(graph, recipe);

    if (checkedUse !== undefined) {
      const useRecord: RecordedGraphConstruction = Object.freeze({
        graph,
        contract,
        create: create as (options: GraphOptions<Contract>) => Graph,
        options: options as GraphOptions<Contract>,
        construction,
        checkedUse,
      });
      recordedGraphConstructions.set(checkedUse, useRecord);
      recordedGraphConstructionsByGraph.set(graph, useRecord);
    }

    return graph;
  } catch (reason) {
    if (construction !== undefined) failPhysicalGraphConstruction(construction, reason);

    throw reason;
  }
}

/**
 * Read the actual graph construction from the graph object itself.
 * @param graph - Exact graph returned by the recorded public constructor.
 * @returns Actual construction facts when this graph has a checked source use.
 * @internal
 */
export function readActualGraphConstruction(graph: Graph): RecordedGraphConstruction | undefined {
  const record = recordedGraphConstructionsByGraph.get(graph);

  return record?.graph === graph ? record : undefined;
}

/**
 * Read the graph and native construction retained for one exact checked use.
 * @param checkedUse - Same object supplied to the original graph constructor.
 * @returns The actual graph record for this use, or `undefined` when absent.
 * @internal
 */
export function readRecordedAeoliaGraphConstruction(
  checkedUse: CheckedGraphSourceUse,
): RecordedGraphConstruction | undefined {
  const record = recordedGraphConstructions.get(checkedUse);

  return record?.checkedUse === checkedUse ? record : undefined;
}

function captureGraphOptions<C extends Contract>(options: GraphOptions<C>): CapturedGraphOptions {
  if (!isObjectLike(options))
    throw new TypeError("Recorded Aeolia graph options must be a fresh object literal");

  const prototype = Object.getPrototypeOf(options);

  if (prototype !== Object.prototype && prototype !== null)
    throw new TypeError("Recorded Aeolia graph options must not use a custom prototype");

  const descriptors: (readonly [PropertyKey, PropertyDescriptor])[] = [];

  for (const key of Reflect.ownKeys(options)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(options, key);

    if (!descriptor || !("value" in descriptor) || descriptor.get || descriptor.set)
      throw new TypeError("Recorded Aeolia graph options must contain only own data properties");

    descriptors.push([key, Object.freeze({ ...descriptor })]);
  }

  return {
    prototype,
    descriptors: Object.freeze(descriptors),
  };
}

function restoreGraphOptions<C extends Contract>(
  captured: CapturedGraphOptions,
  contract: C,
): GraphOptions<C> {
  const options: GraphOptions<C> = { contract };

  Object.setPrototypeOf(options, captured.prototype);
  Reflect.deleteProperty(options, "contract");
  for (const [key, capturedDescriptor] of captured.descriptors) {
    Object.defineProperty(options, key, { ...capturedDescriptor });
  }

  return options;
}

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
 * @param policies - Preparation policies keyed by finite declarations in this contract.
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
  project: (bound: HesperiaContractApi<C, true>) => Facade,
  policies: OperationPolicies,
): Facade;

export function markImportedApi<C extends Contract, Facade extends object>(
  graph: Graph<C>,
  contract: C,
  project?: (bound: HesperiaContractApi<C>) => Facade,
  policies?: OperationPolicies,
): ImportedApi<C> | Facade {
  const value = Object.freeze(Object.create(null)) as object;
  const capturedPolicies = snapshotPolicies(contract.operations, policies);
  const record: AdaptedApiRecord = project
    ? {
        graph,
        contract,
        project: (bound) => project(bound as unknown as HesperiaContractApi<C>),
        ...(capturedPolicies === undefined ? {} : { policies: capturedPolicies }),
      }
    : {
        graph,
        contract,
        ...(capturedPolicies === undefined ? {} : { policies: capturedPolicies }),
      };

  adaptedApis.set(value, Object.freeze(record));

  return value as ImportedApi<C> | Facade;
}

function snapshotPolicies(
  operations: OperationTree,
  policies: OperationPolicies | undefined,
): OperationPolicies | undefined {
  if (policies === undefined) return undefined;

  const definitions = new Set<object>();
  const visited = new Set<object>();
  const collect = (tree: object): void => {
    if (visited.has(tree)) return;

    visited.add(tree);
    for (const declaration of Object.values(tree)) {
      if (!isObjectLike(declaration)) continue;

      const kind = Reflect.get(declaration, "kind");
      if (kind === "query" || kind === "mutation") definitions.add(declaration);
      else if (kind !== "store" && kind !== "stream") collect(declaration);
    }
  };
  collect(operations);

  const captured = new Map<FiniteOperation, NativeOperationPolicy>();
  for (const [definition, policy] of policies) {
    if (!definitions.has(definition))
      throw new TypeError(
        "Native operation policies must reference finite operations in their contract",
      );

    const prepare = policy?.prepare;
    if (typeof prepare !== "function")
      throw new TypeError("Native operation policies require a preparation function");

    captured.set(definition, Object.freeze({ prepare }));
  }

  return captured;
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

    const bound = createContractApi(owner, record.graph, record.contract, record.policies);

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
