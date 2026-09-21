import { resolveAppConfiguration, type AppConfiguration } from "../application.ts";
import { defineComponent, type Component } from "../runtime/components.ts";
import type { RuntimeRoot } from "../runtime/dom.ts";
import { RenderFault } from "../runtime/owner.ts";
import type {
  RouteTable,
  RouteTableGuardModule,
  RouteTableModule,
  RouteTableNode,
} from "../tooling/route-table.ts";
import { matchNotFound, matchRoute, type RouteManifest, type RouteParams } from "./manifest.ts";
import { Router, type RouteCandidate, type RouteGuard, type RouteInputs } from "./navigation.ts";
import { boundarySlot, type RouteHost, type RouteHostModule } from "./route-host.ts";

/** Runtime dependencies used by the generated filesystem router. */
export interface FilesystemRouterConfiguration extends AppConfiguration {
  readonly pageCacheSize?: number;
}

const emptyRoute = defineComponent(() => null);
const emptyNode = {};

interface TableMatch {
  readonly leaf: RouteTableNode;
  readonly chain: readonly RouteTableNode[];
  readonly params: RouteParams;
}

function assertComponent(value: unknown, filename: string): Component<unknown> {
  if (typeof value !== "function")
    throw new RenderFault(
      "route-module",
      `Route module ${filename} must default-export a component`,
    );
  return value as Component<unknown>;
}

async function loadComponent(
  module: RouteTableModule,
  signal: AbortSignal,
): Promise<Component<unknown>> {
  const value = await module.load();
  if (signal.aborted) throw signal.reason;
  return assertComponent(value, module.filename);
}

function routeModules(
  match: TableMatch,
  definitions: ReadonlyMap<RouteTableNode, Component<unknown>>,
  errors: ReadonlyMap<RouteTableNode, Component<unknown>>,
): RouteHostModule[] {
  const modules: RouteHostModule[] = [];
  for (let index = 0; index < match.chain.length; index++) {
    const node = match.chain[index]!;
    const definition = definitions.get(node);
    const fallback = errors.get(node);
    if (definition && node.files.layout) modules.push({ node, definition, error: fallback });
    else if (fallback)
      modules.push({
        node,
        definition: boundarySlot as Component<unknown>,
        error: fallback,
      });
  }
  return modules;
}

function nearestModule(match: TableMatch, role: "loading" | "error"): RouteTableModule | undefined {
  for (let index = match.chain.length - 1; index >= 0; index--) {
    const module = match.chain[index]!.files[role];
    if (module) return module;
  }
  return undefined;
}

async function loadGuard(module: RouteTableGuardModule, signal: AbortSignal): Promise<RouteGuard> {
  const value = await module.load();
  if (signal.aborted) throw signal.reason;
  const guard =
    value && typeof value === "object" && "default" in value
      ? (value as { default?: unknown }).default
      : value;
  if (typeof guard !== "function")
    throw new RenderFault(
      "route-guard",
      `Client guard ${module.filename} must default-export a function`,
    );
  return guard as RouteGuard;
}

function pageModule(node: RouteTableNode, definition: Component<unknown>): RouteHostModule {
  return {
    node,
    definition,
    props: (inputs) => ({ params: inputs.params, queryParams: inputs.queryParams }),
  };
}

function routeMatch(table: RouteTable, url: URL): { match: TableMatch; notFound: boolean } | null {
  const manifest = table as unknown as RouteManifest;
  const ordinary = matchRoute(manifest, url);
  if (ordinary) return { match: ordinary as unknown as TableMatch, notFound: false };
  const fallback = matchNotFound(manifest, url);
  return fallback ? { match: fallback as unknown as TableMatch, notFound: true } : null;
}

/** Create the browser Router over the generated conventional route table. */
export function createFilesystemRouter(
  window: Window,
  runtime: RuntimeRoot,
  host: RouteHost,
  table: RouteTable,
  configuration: FilesystemRouterConfiguration = resolveAppConfiguration({}),
): Router {
  const resolve = async (url: URL, signal: AbortSignal): Promise<RouteCandidate> => {
    const selected = routeMatch(table, url);
    if (!selected)
      return {
        params: Object.freeze({}),
        prepare: () => {
          throw new RenderFault("route-not-found", `No route matched ${url.pathname}`);
        },
      };

    const { match, notFound } = selected;
    const layoutDefinitions = new Map<RouteTableNode, Component<unknown>>();
    await Promise.all(
      match.chain.map(async (node) => {
        if (!node.files.layout) return;
        layoutDefinitions.set(node, await loadComponent(node.files.layout, signal));
      }),
    );
    const errorDefinitions = new Map<RouteTableNode, Component<unknown>>();
    await Promise.all(
      match.chain.map(async (node) => {
        const module = node.files.error;
        if (module) errorDefinitions.set(node, await loadComponent(module, signal));
      }),
    );
    const layouts = routeModules(match, layoutDefinitions, errorDefinitions);
    const guards: RouteGuard[] = [];
    for (const node of match.chain) {
      if (node.files.guard) guards.push(await loadGuard(node.files.guard, signal));
    }
    const loading = nearestModule(match, "loading");
    const loadPage = () => {
      const module = notFound ? match.leaf.files.notFound : match.leaf.files.page;
      if (!module)
        throw new RenderFault("route-page", `Route ${match.leaf.pattern} has no page module`);
      return loadComponent(module, signal);
    };
    const makeRoute = async (
      inputs: RouteInputs,
      page: RouteHostModule,
    ): Promise<ReturnType<RouteHost["prepare"]>> => {
      const prepared = host.prepare({ layouts, page, inputs }) as ReturnType<
        RouteHost["prepare"]
      > & { readonly ready?: Promise<void> };
      // The intermediate composition is already visible through
      // prepareLoading. Terminal route metadata waits for the page boundary's
      // content to settle, so an unresolved async page cannot commit early.
      await prepared.ready;
      return prepared;
    };

    return {
      params: match.params,
      guards: Object.freeze(guards),
      departingOwners: host.departingOwners(layouts),
      prepareLoading: async (inputs) => {
        let page: RouteHostModule;
        if (loading) {
          // Loading views are boundary content, so they receive no page route
          // params or query accessor.
          page = { node: match.leaf, definition: await loadComponent(loading, signal) };
        } else {
          runtime.context.warn(
            `Route ${match.leaf.pattern} has no +loading.tsx; the loading area is empty. Add a root loading skeleton for a visible transition.`,
          );
          page = { node: emptyNode, definition: emptyRoute as Component<unknown> };
        }
        return makeRoute(inputs, page);
      },
      prepare: async (inputs) =>
        makeRoute(inputs, {
          ...pageModule(match.leaf, await loadPage()),
          // Filesystem pages always receive an async boundary.  A missing
          // loading module means that the route area stays empty while the
          // page is pending; it does not remove the boundary itself.
          loading: loading ? await loadComponent(loading, signal) : emptyRoute,
        }),
    };
  };

  return new Router({
    window,
    resolve,
    pageCacheSize: configuration.pageCacheSize,
    onError: runtime.context.onError,
  });
}
