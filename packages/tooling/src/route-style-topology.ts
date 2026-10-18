import { relative, resolve } from "node:path";
import type { RouteManifest, RouteNode } from "hesperia/routing";
import type { StyleTopology } from "./style-topology.ts";

export interface RouteViewStyles {
  readonly destination: string;
  readonly loading: string;
  readonly errors: readonly { readonly boundaryNodeId: string; readonly compositionId: string }[];
}

export interface RouteStyleMetadata {
  readonly compositions: readonly {
    readonly compositionId: string;
    readonly entries: readonly string[];
    readonly styles: readonly string[];
  }[];
  readonly views: ReadonlyMap<
    string,
    { readonly page?: RouteViewStyles; readonly notFound?: RouteViewStyles }
  >;
}

/** Build every finite route vector from scanner ancestry and static module closures. */
export function buildRouteStyleMetadata(
  root: string,
  manifest: RouteManifest,
  topology: StyleTopology,
): RouteStyleMetadata {
  const entryClosures = new Map<string, readonly string[]>();

  for (const entry of topology.entries) {
    if (entryClosures.has(entry.entryId))
      throw new TypeError(`Duplicate stylesheet entry ${entry.entryId}`);

    entryClosures.set(entry.entryId, entry.closure);
  }

  const compositions: RouteStyleMetadata["compositions"][number][] = [];
  const compositionIds = new Set<string>();
  const views = new Map<string, { page?: RouteViewStyles; notFound?: RouteViewStyles }>();
  const nodeIds = new Set<string>();

  const entryId = (filename: string): string =>
    relative(root, resolve(filename)).replaceAll("\\", "/");

  const compose = (
    node: RouteNode,
    mode: "page" | "notFound",
    kind: "destination" | "loading" | "error",
    filenames: readonly string[],
    boundaryId?: string,
  ): string => {
    const compositionId = JSON.stringify(["route", node.id, mode, kind, boundaryId ?? null]);

    if (compositionIds.has(compositionId))
      throw new TypeError(`Duplicate stylesheet composition ${compositionId}`);

    compositionIds.add(compositionId);

    const entries: string[] = [];
    const styles: string[] = [];
    const seenEntries = new Set<string>();
    const seenStyles = new Set<string>();

    for (const filename of filenames) {
      const id = entryId(filename);

      if (seenEntries.has(id)) continue;

      const closure = entryClosures.get(id);

      if (!closure) throw new TypeError(`Missing stylesheet entry ${id}`);

      seenEntries.add(id);

      entries.push(id);

      for (const style of closure)
        if (!seenStyles.has(style)) {
          seenStyles.add(style);

          styles.push(style);
        }
    }

    compositions.push({ compositionId, entries, styles });

    return compositionId;
  };

  const visit = (node: RouteNode, ancestors: readonly RouteNode[]): void => {
    if (nodeIds.has(node.id)) throw new TypeError(`Duplicate route node ID ${node.id}`);

    nodeIds.add(node.id);

    const chain = [...ancestors, node];
    const layouts = chain.flatMap((item) => (item.files.layout ? [item.files.layout] : []));
    const loading = [...chain].reverse().find((item) => item.files.loading)?.files.loading;

    const mode = (kind: "page" | "notFound"): RouteViewStyles => {
      const selected = node.files[kind];

      if (!selected) throw new TypeError(`Route ${node.id} has no ${kind} file`);

      const shell = resolve(root, "app.tsx");
      const destination = compose(node, kind, "destination", [shell, ...layouts, selected]);
      const loadingId = compose(
        node,
        kind,
        "loading",
        loading ? [shell, ...layouts, loading] : [shell, ...layouts],
      );
      const errors = chain.flatMap((boundary, index) => {
        if (!boundary.files.error) return [];

        const survivors = chain
          .slice(0, index)
          .flatMap((item) => (item.files.layout ? [item.files.layout] : []));
        return [
          {
            boundaryNodeId: boundary.id,
            compositionId: compose(
              node,
              kind,
              "error",
              [shell, ...survivors, boundary.files.error],
              boundary.id,
            ),
          },
        ];
      });
      return { destination, loading: loadingId, errors };
    };

    const row: { page?: RouteViewStyles; notFound?: RouteViewStyles } = {};

    if (node.files.page) row.page = mode("page");

    if (node.files.notFound) row.notFound = mode("notFound");

    if (row.page || row.notFound) views.set(node.id, row);

    for (const child of node.children) visit(child, chain);
  };

  visit(manifest.root, []);

  return { compositions, views };
}
