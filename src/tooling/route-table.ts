import { relative, resolve } from "node:path";
import type { RouteManifest, RouteNode, RouteSegment } from "../routing/manifest.ts";

/** A browser route module with its authored root-relative identity and lazy default export. */
export interface RouteTableModule {
  readonly filename: string;
  readonly load: () => Promise<unknown>;
}

/** Browser guard asset with a literal import loader captured in the generated route table. */
export interface RouteTableGuardModule {
  readonly filename: string;
  readonly load: () => Promise<unknown>;
}

/** Browser-safe conventional modules associated with one scanner node. */
export interface RouteTableFiles {
  readonly page?: RouteTableModule;
  readonly layout?: RouteTableModule;
  readonly loading?: RouteTableModule;
  readonly error?: RouteTableModule;
  readonly notFound?: RouteTableModule;
  readonly guard?: RouteTableGuardModule;
}

/** Scanner structure plus browser-loadable route roles. */
export interface RouteTableNode {
  readonly id: string;
  readonly pattern: string;
  readonly segments: readonly RouteSegment[];
  readonly files: RouteTableFiles;
  readonly children: readonly RouteTableNode[];
}

/** Internal browser route table emitted beside the author-owned entrypoint. */
export interface RouteTable {
  readonly version: 1;
  readonly root: RouteTableNode;
  readonly routes: readonly RouteTableNode[];
}

/** Inputs needed to produce the virtual module consumed by the browser bundler. */
export interface RouteTableInput {
  readonly manifest: RouteManifest;
  readonly root: string;
  /** Route declaration filename to its separately published client guard asset URL. */
  readonly guardUrls?: ReadonlyMap<string, string>;
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
      if (guardUrl)
        files.push(
          `guard:{filename:${JSON.stringify(guardUrl)},load:()=>import(${JSON.stringify(guardUrl)})}`,
        );
    }
    const segments = `[${node.segments.map((part) => `{kind:${JSON.stringify(part.kind)},value:${JSON.stringify(part.value)}}`).join(",")}]`;
    const children = `[${node.children.map((child) => nodeIds.get(child)!).join(",")}]`;
    return `{id:${JSON.stringify(node.id)},pattern:${JSON.stringify(node.pattern)},segments:${segments},files:{${files.join(",")}},children:${children}}`;
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

function sourceKey(filename: string): string {
  return resolve(filename).replaceAll("\\", "/").toLowerCase();
}
