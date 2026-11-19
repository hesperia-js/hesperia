import { isAbsolute, join, relative, resolve } from "node:path";
import type { RouteManifest, RouteNode, RouteSegment } from "hesperia/routing";
import { RouteScanError, scanRouteFiles } from "./scanner.ts";
import type { VirtualModule } from "./checking.ts";
import { normalizeFilename as normalize } from "./utils.ts";

/** Marker identifying declarations generated and owned by Hesperia. */
export const PAGE_DECLARATION_MARKER = "// HESPERIA GENERATED PAGE ROUTES";

/** Generated root declaration and route aliases used by checking views. */
export interface PageDeclarations {
  /** Root hesperia.d.ts source generated from this route snapshot. */
  readonly declaration: VirtualModule;
  /** Normalized absolute page or layout filename to its generated route context alias. */
  readonly contexts: ReadonlyMap<string, string>;
  /** Scanner failure; publishers must refuse to write this declaration. */
  readonly routeError?: RouteScanError;
}

/** Options for deterministic page declaration generation. */
export interface PageDeclarationOptions {
  /** Application directory; defaults to the current working directory. */
  readonly root?: string;
}

/**
 * Derive route parameter and loader-result aliases from one source snapshot.
 *
 * The declaration is suitable for project checking and for the root-level
 * generated `hesperia.d.ts` publisher. Invalid route snapshots produce an
 * empty declaration; the route checker remains responsible for diagnostics.
 */
export function generatePageDeclarations(
  modules: readonly VirtualModule[],
  options: PageDeclarationOptions = {},
): PageDeclarations {
  const root = resolve(options.root ?? process.cwd());
  const routeRoot = resolve(root, "src/routes");
  const sourcePaths = modules
    .map((module) =>
      isAbsolute(module.filename) ? resolve(module.filename) : resolve(root, module.filename),
    )
    .filter((filename) => {
      const prefix = `${normalize(routeRoot)}/`;
      return normalize(filename).startsWith(prefix);
    });
  let manifest: RouteManifest | undefined;
  let routeError: RouteScanError | undefined;

  try {
    manifest = scanRouteFiles(routeRoot, sourcePaths);
  } catch (error) {
    if (!(error instanceof RouteScanError)) throw error;

    routeError = error;
  }

  const contexts = new Map<string, string>();
  const aliases: string[] = [];
  const chains = new Map<RouteNode, readonly RouteNode[]>();

  if (manifest) collectRouteChains(manifest.root, [], chains);

  const routeResultNames = new Map<RouteNode, string>();
  const routeResultAliases: string[] = [];

  for (const node of chains.keys()) {
    if (!node.files.route) continue;

    const suffix = String(routeResultNames.size);
    const alias = "__hesperia_route_data_result_" + suffix;
    const sourceAlias = "__hesperia_route_data_source_" + suffix;
    const identity = relative(root, node.files.route).replaceAll("\\", "/");
    const specifier = "./" + identity.replace(/\.ts$/u, "");

    routeResultNames.set(node, alias);
    routeResultAliases.push(
      "  type " + sourceAlias + " = typeof import(" + JSON.stringify(specifier) + ").default;",
      "  type " + alias + " = __hesperia_route_data_from_configuration<" + sourceAlias + ">;",
    );
  }

  for (const [index, node] of (manifest?.routes ?? []).entries()) {
    const filename = node.files.page;

    if (!filename) continue;

    const alias = "__hesperia_page_route_" + index;

    contexts.set(normalize(filename), alias);

    if (node.files.layout) contexts.set(normalize(node.files.layout), alias);

    const identity = relative(root, filename).replaceAll("\\", "/");
    const chain = chains.get(node) ?? [node];

    aliases.push(
      "  // " +
        JSON.stringify(identity) +
        "\n  type " +
        alias +
        " = " +
        pageRouteContext(node, chain, routeResultNames) +
        ";",
    );
  }

  let layoutIndex = 0;

  for (const node of chains.keys()) {
    const filename = node.files.layout;

    if (!filename || contexts.has(normalize(filename))) continue;

    const alias = "__hesperia_layout_route_" + layoutIndex++;

    contexts.set(normalize(filename), alias);

    const identity = relative(root, filename).replaceAll("\\", "/");
    const chain = chains.get(node) ?? [node];

    aliases.push(
      "  // " +
        JSON.stringify(identity) +
        "\n  type " +
        alias +
        " = " +
        pageRouteContext(node, chain, routeResultNames) +
        ";",
    );
  }

  const helpers = [
    "  type __hesperia_route_data_map<Data> = { readonly [Key in keyof Data as [Data[Key]] extends [never] ? never : Key]: Data[Key] };",
    ...(routeResultAliases.length
      ? [
          "  type __hesperia_route_data_value<Loader> = Loader extends (...args: never[]) => infer Result ? Exclude<Awaited<Result>, Response> : never;",
          "  type __hesperia_route_data_from_configuration<Configuration> = Configuration extends { readonly load?: infer Loader } ? __hesperia_route_data_value<NonNullable<Loader>> : never;",
        ]
      : []),
  ];
  const declaration =
    PAGE_DECLARATION_MARKER +
    "\nexport {};\n" +
    [...helpers, ...routeResultAliases].map((line) => line.slice(2)).join("\n") +
    "\ndeclare global {\n" +
    aliases.join("\n") +
    "\n}\n";

  return {
    declaration: {
      filename: options.root === undefined ? "hesperia.d.ts" : join(root, "hesperia.d.ts"),
      source: declaration,
    },
    contexts,
    ...(routeError ? { routeError } : {}),
  };
}

function collectRouteChains(
  node: RouteNode,
  parents: readonly RouteNode[],
  chains: Map<RouteNode, readonly RouteNode[]>,
): void {
  const chain = [...parents, node];

  chains.set(node, chain);

  for (const child of node.children) collectRouteChains(child, chain, chains);
}

function pageRouteContext(
  node: RouteNode,
  chain: readonly RouteNode[],
  routeResultNames: ReadonlyMap<RouteNode, string>,
): string {
  const routeData = chain.flatMap((routeNode) => {
    const result = routeResultNames.get(routeNode);

    return result ? ["readonly " + JSON.stringify(routeNode.id) + ": " + result + ";"] : [];
  });

  return (
    'import("hesperia/runtime").PageRouteContext<' +
    routeType(node.segments) +
    ", __hesperia_route_data_map<{ " +
    routeData.join(" ") +
    " }>>"
  );
}

function routeType(segments: readonly RouteSegment[]): string {
  const fields = segments.map((segment) => {
    const key = JSON.stringify(segment.value);

    if (segment.kind === "param") return `readonly ${key}: string;`;

    if (segment.kind === "optional") return `readonly ${key}?: string;`;

    if (segment.kind === "rest") return `readonly ${key}: readonly string[];`;

    if (segment.kind === "optional-rest") return `readonly ${key}?: readonly string[];`;

    return "";
  });
  return `{ ${fields.filter(Boolean).join(" ")} }`;
}
