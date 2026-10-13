import { relative, resolve } from "node:path";
import type { RouteManifest, RouteNode } from "hesperia/routing";
import type { RouteStyleMetadata, RouteViewStyles } from "./route-style-topology.ts";

/** Inputs needed to produce the virtual module consumed by the browser bundler. */
export interface RouteTableInput {
  readonly manifest: RouteManifest;
  readonly root: string;
  /** Route declaration filename to its separately published client guard asset URL. */
  readonly guardUrls?: ReadonlyMap<string, string>;
  /** Finite private CSS composition IDs for each selectable route view. */
  readonly styleMetadata?: RouteStyleMetadata;
}

/** A generated route-table module and the source paths its lazy imports may resolve. */
export interface RouteTableSource {
  readonly code: string;
  readonly modules: ReadonlyMap<string, string>;
}

const roles = ["page", "layout", "loading", "error", "notFound"] as const;

/**
 * Generate an internal route table without selecting startup ownership or composing components.
 *
 * The resulting source has no authored route executable code. Its dynamic imports resolve only to
 * scanner-approved TSX roles, and each loader returns that module's default export when invoked.
 */
export function createRouteTable(input: RouteTableInput): RouteTableSource {
  const root = resolve(input.root);

  if (input.styleMetadata) validateRouteStyleMetadata(input.manifest, input.styleMetadata);

  const moduleIds = new Map<string, string>();
  const modules = new Map<string, string>();
  const nodes: RouteNode[] = [];
  const nodeIds = new Map<RouteNode, string>();

  const visit = (node: RouteNode): void => {
    if (nodeIds.has(node)) return;

    nodeIds.set(node, `node${nodes.length}`);

    nodes.push(node);

    for (const child of node.children) visit(child);
  };

  visit(input.manifest.root);

  const moduleSpecifier = (filename: string): string => {
    const absolute = resolve(filename);
    const existing = moduleIds.get(absolute);

    if (existing) return existing;

    const specifier = `hesperia-route-module:${moduleIds.size}`;

    moduleIds.set(absolute, specifier);

    modules.set(specifier, absolute);

    return specifier;
  };

  const nodeExpression = (node: RouteNode): string => {
    const files: string[] = [];

    for (const role of roles) {
      const filename = node.files[role];

      if (!filename) continue;

      const specifier = moduleSpecifier(filename);
      const rootRelative = relative(root, resolve(filename)).replaceAll("\\", "/");

      files.push(
        `${JSON.stringify(role)}:{filename:${JSON.stringify(rootRelative)},load:()=>import(${JSON.stringify(specifier)}).then(module=>module.default)}`,
      );
    }

    if (node.files.route) {
      const guardUrl =
        input.guardUrls?.get(sourceKey(node.files.route)) ?? input.guardUrls?.get(node.files.route);

      if (guardUrl) {
        const guardImport = relativeAssetImport(guardUrl);

        files.push(
          `guard:{filename:${JSON.stringify(guardUrl)},load:()=>import(${JSON.stringify(guardImport)})}`,
        );
      }
    }

    const segments = `[${node.segments.map((part) => `{kind:${JSON.stringify(part.kind)},value:${JSON.stringify(part.value)}}`).join(",")}]`;
    const children = `[${node.children.map((child) => nodeIds.get(child)!).join(",")}]`;
    const viewStyles = input.styleMetadata?.views.get(node.id);
    return `{id:${JSON.stringify(node.id)},pattern:${JSON.stringify(node.pattern)},segments:${segments},files:{${files.join(",")}},children:${children}${viewStyles ? `,viewStyles:${JSON.stringify(viewStyles)}` : ""}}`;
  };

  const declarations = [...nodes]
    .reverse()
    .map((node) => `const ${nodeIds.get(node)}=${nodeExpression(node)};`)
    .join("\n");
  const rootExpression = nodeIds.get(input.manifest.root)!;
  const routes = `[${input.manifest.routes.map((node) => nodeIds.get(node)!).join(",")}]`;
  const code = `${declarations}\nconst routeTable={version:1,root:${rootExpression},routes:${routes}};\nexport {routeTable};\nexport default routeTable;\n`;
  return { code, modules };
}

function relativeAssetImport(path: string): string {
  if (!path.startsWith("/assets/") || path.includes("\\"))
    throw new TypeError(`Route guard asset path is not a logical browser asset: ${path}`);

  const segments = path.slice("/assets/".length).split("/");

  if (segments.some((segment) => !segment || segment === "." || segment === ".."))
    throw new TypeError(`Route guard asset path is not canonical: ${path}`);

  return `./${segments.join("/")}`;
}

function validateRouteStyleMetadata(manifest: RouteManifest, metadata: RouteStyleMetadata): void {
  const compositions = new Set<string>();

  for (const item of metadata.compositions) {
    if (!item.compositionId || compositions.has(item.compositionId))
      throw new TypeError(`Duplicate or missing stylesheet composition ID: ${item.compositionId}`);

    compositions.add(item.compositionId);
  }

  const seenNodes = new Set<string>();

  const checkView = (
    node: RouteNode,
    chain: readonly RouteNode[],
    mode: "page" | "notFound",
    view: RouteViewStyles | undefined,
  ): void => {
    if (!node.files[mode] && view)
      throw new TypeError(`Route ${node.id} has ${mode} styles without a ${mode} file`);

    if (node.files[mode] && !view)
      throw new TypeError(`Route ${node.id} is missing ${mode} style metadata`);

    if (!view) return;

    for (const id of [view.destination, view.loading])
      if (!compositions.has(id))
        throw new TypeError(`Route ${node.id} references unknown stylesheet composition ${id}`);

    const boundaries = new Set<string>();

    for (const error of view.errors) {
      if (boundaries.has(error.boundaryNodeId))
        throw new TypeError(`Route ${node.id} repeats error boundary ${error.boundaryNodeId}`);

      boundaries.add(error.boundaryNodeId);

      if (!chain.some((item) => item.id === error.boundaryNodeId && item.files.error))
        throw new TypeError(
          `Route ${node.id} has non-ancestor error boundary ${error.boundaryNodeId}`,
        );

      if (!compositions.has(error.compositionId))
        throw new TypeError(
          `Route ${node.id} references unknown stylesheet composition ${error.compositionId}`,
        );
    }
  };

  const visit = (node: RouteNode, ancestors: readonly RouteNode[]): void => {
    if (seenNodes.has(node.id)) throw new TypeError(`Duplicate route node ID ${node.id}`);

    seenNodes.add(node.id);

    const chain = [...ancestors, node];
    const views = metadata.views.get(node.id);

    checkView(node, chain, "page", views?.page);

    checkView(node, chain, "notFound", views?.notFound);

    for (const child of node.children) visit(child, chain);
  };

  visit(manifest.root, []);

  for (const id of metadata.views.keys())
    if (!seenNodes.has(id)) throw new TypeError(`Unknown route style node ${id}`);
}

function sourceKey(filename: string): string {
  const normalized = resolve(filename).replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
