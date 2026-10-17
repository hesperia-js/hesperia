import { isAbsolute, join, relative, resolve } from "node:path";
import type { RouteManifest, RouteSegment } from "hesperia/routing";
import { RouteScanError, scanRouteFiles } from "./scanner.ts";
import type { VirtualModule } from "./checking.ts";
import { normalizeFilename as normalize } from "./utils.ts";

/** Marker identifying declarations generated and owned by Hesperia. */
export const PAGE_DECLARATION_MARKER = "// HESPERIA GENERATED PAGE ROUTES";

/** Generated root declaration and route aliases used by checking views. */
export interface PageDeclarations {
  /** Root hesperia.d.ts source generated from this route snapshot. */
  readonly declaration: VirtualModule;
  /** Normalized absolute page filename to its generated route alias. */
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
 * Derive immutable route parameter aliases from one source snapshot.
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

  for (const [index, node] of (manifest?.routes ?? []).entries()) {
    const filename = node.files.page;

    if (!filename) continue;

    const alias = `__hesperia_page_route_${index}`;

    contexts.set(normalize(filename), alias);

    const identity = relative(root, filename).replaceAll("\\", "/");

    aliases.push(
      `  // ${JSON.stringify(identity)}\n  type ${alias} = ${routeType(node.segments)};`,
    );
  }

  const declaration = `${PAGE_DECLARATION_MARKER}\nexport {};\ndeclare global {\n${aliases.join("\n")}\n}\n`;
  return {
    declaration: {
      filename: options.root === undefined ? "hesperia.d.ts" : join(root, "hesperia.d.ts"),
      source: declaration,
    },
    contexts,
    ...(routeError ? { routeError } : {}),
  };
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
