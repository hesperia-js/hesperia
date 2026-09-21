import type { Contract, Graph } from "aeolia";
import { markImportedApi, type ImportedApi } from "../data/api.ts";

/**
 * Adapt a matching Aeolia graph and contract for direct imports in compiled
 * Hesperia components.
 *
 * The graph must be the graph created from the supplied contract. The graph and
 * its stores remain shared; query, stream, and mutation handles are projected
 * for the component owner when the imported value is read. Components import
 * the returned API directly from their ordinary module; no startup registration
 * is required.
 *
 * @param graph - Public Aeolia graph that owns the declared operation state.
 * @param contract - The same public Aeolia contract used to create `graph`.
 * @returns An adapted API whose operation handles belong to each consuming
 * component owner when compiled direct imports read them.
 */
export function withAeolia<C extends Contract>(graph: Graph<C>, contract: C): ImportedApi<C> {
  return markImportedApi(graph, contract);
}

export type { ImportedApi } from "../data/api.ts";
export type { Feed, FeedPolicy, FeedProjection } from "../data/types.ts";
