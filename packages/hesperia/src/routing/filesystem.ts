import { resolveAppConfiguration, type AppConfiguration } from "../application.ts";
import { defineComponent, type Component } from "../runtime/components.ts";
import type { RuntimeRoot } from "../runtime/dom.ts";
import { RenderFault } from "../runtime/owner.ts";
import type {
  InternalStyleRuntime,
  PreparedStyleGroupLease,
  StyleCompositionId,
} from "../runtime/style.ts";
import type {
  RouteTable,
  RouteTableGuardModule,
  RouteTableModule,
  RouteTableNode,
} from "./route-table.ts";
import { matchNotFound, matchRoute, type RouteManifest, type RouteParams } from "./manifest.ts";
import { Router, type RouteCandidate, type RouteGuard, type RouteInputs } from "./navigation.ts";
import { isWithinMount, normalizeMountPath } from "./navigation-url.ts";
import { bindDevelopmentRouteMatcher } from "./development.ts";
import {
  boundarySlot,
  type RouteHost,
  type RouteHostModule,
  type RouteHostStyles,
} from "./route-host.ts";

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
  errorStyleKeys: ReadonlyMap<string, string>,
): RouteHostModule[] {
  const modules: RouteHostModule[] = [];

  for (let index = 0; index < match.chain.length; index++) {
    const node = match.chain[index]!;
    const definition = definitions.get(node);
    const fallback = errors.get(node);

    if (definition && node.files.layout)
      modules.push({
        node,
        definition,
        error: fallback,
        ...(errorStyleKeys.has(node.id) ? { errorStyleKey: errorStyleKeys.get(node.id)! } : {}),
      });
    else if (fallback)
      modules.push({
        node,
        definition: boundarySlot as Component<unknown>,
        error: fallback,
        ...(errorStyleKeys.has(node.id) ? { errorStyleKey: errorStyleKeys.get(node.id)! } : {}),
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

function routeMatch(
  table: RouteTable,
  url: URL,
  mountPath: string,
): { match: TableMatch; notFound: boolean } | null {
  if (!isWithinMount(url.pathname, mountPath)) return null;

  const manifest = table as unknown as RouteManifest;
  const routeUrl = new URL(url.href);

  if (mountPath !== "/") routeUrl.pathname = routeUrl.pathname.slice(mountPath.length) || "/";

  const ordinary = matchRoute(manifest, routeUrl);

  if (ordinary) return { match: ordinary as unknown as TableMatch, notFound: false };

  const fallback = matchNotFound(manifest, routeUrl);
  return fallback ? { match: fallback as unknown as TableMatch, notFound: true } : null;
}

/** Create the browser Router over the generated conventional route table. */
export function createFilesystemRouter(
  window: Window,
  runtime: RuntimeRoot,
  host: RouteHost,
  table: RouteTable,
  configuration: FilesystemRouterConfiguration = resolveAppConfiguration({}),
  styleRuntime?: InternalStyleRuntime,
  mountPath = "/",
): Router {
  const normalizedMount = normalizeMountPath(mountPath);

  const resolve = async (url: URL, signal: AbortSignal): Promise<RouteCandidate> => {
    const selected = routeMatch(table, url, normalizedMount);

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

    const viewStyles = notFound ? match.leaf.viewStyles?.notFound : match.leaf.viewStyles?.page;
    const errorStyleKeys = new Map(
      (viewStyles?.errors ?? []).map(({ boundaryNodeId }) => [boundaryNodeId, boundaryNodeId]),
    );
    const layouts = routeModules(match, layoutDefinitions, errorDefinitions, errorStyleKeys);
    const guards: RouteGuard[] = [];

    for (const node of match.chain) {
      if (node.files.guard) guards.push(await loadGuard(node.files.guard, signal));
    }

    const loading = nearestModule(match, "loading");
    const loadingDefinition = loading ? await loadComponent(loading, signal) : undefined;
    const loadingComposition = viewStyles?.loading;
    const styleRecords = new Map<
      StyleCompositionId,
      { head: HTMLHeadElement; lease: PreparedStyleGroupLease; references: number }
    >();
    let stylesPrepared = false;
    let stylePreloadFailed = false;
    let baseStylesReleased = false;

    const releaseStyleReference = (compositionId: StyleCompositionId): void => {
      const record = styleRecords.get(compositionId);

      if (!record) return;

      record.references--;

      if (record.references === 0) {
        record.lease.release();

        styleRecords.delete(compositionId);
      }
    };

    const releaseBaseStyles = (): void => {
      if (baseStylesReleased) return;

      baseStylesReleased = true;

      if (loadingComposition) releaseStyleReference(loadingComposition);
    };

    const ensureStyles = async (compositionId: StyleCompositionId, nextSignal?: AbortSignal) => {
      if (!styleRuntime)
        throw new RenderFault(
          "style-runtime",
          "Generated route CSS metadata requires a style runtime bound to the root shell",
        );

      const head = runtime.context.document.head;
      const current = styleRecords.get(compositionId);

      if (current?.head === head) return current;

      const lease = await styleRuntime.prepareInstalledHead(compositionId, head, nextSignal);

      if (stylePreloadFailed || nextSignal?.aborted) {
        lease.release();

        throw (
          nextSignal?.reason ??
          new RenderFault("style-preload", "Stylesheet preparation was abandoned")
        );
      }

      const record = {
        head,
        lease,
        references: current?.references ?? 0,
      };

      styleRecords.set(compositionId, record);

      current?.lease.release();

      return record;
    };

    const createRouteStyles = async (
      defaultComposition: StyleCompositionId | undefined,
      nextSignal: AbortSignal,
    ): Promise<RouteHostStyles | undefined> => {
      if (!viewStyles || !defaultComposition) return undefined;

      if (defaultComposition === loadingComposition && !stylesPrepared)
        throw new RenderFault("style-preload", "Loading styles were not prepared before admission");

      const errors = new Map(
        viewStyles.errors.map(({ boundaryNodeId, compositionId }) => [
          boundaryNodeId,
          compositionId,
        ]),
      );
      const held = new Set<StyleCompositionId>();

      const retain = async (
        compositionId: StyleCompositionId,
        signal = nextSignal,
      ): Promise<void> => {
        const record = await ensureStyles(compositionId, signal);

        if (held.has(compositionId)) return;

        record.references++;

        held.add(compositionId);
      };

      await retain(defaultComposition);

      let released = false;

      const selectedComposition = (selection?: string): StyleCompositionId => {
        if (selection === undefined) return defaultComposition;

        const composition = errors.get(selection);

        if (!composition)
          throw new RenderFault(
            "style-composition",
            `No error stylesheet composition exists for route boundary ${selection}`,
          );

        return composition;
      };

      return {
        async prepareRestore(selection, nextSignal) {
          if (released)
            throw new RenderFault("style-lease", "A released route style lease cannot restore");

          await retain(selectedComposition(selection), nextSignal);
        },

        activate(selection) {
          if (released)
            throw new RenderFault("style-lease", "A released route style lease cannot activate");

          const record = styleRecords.get(selectedComposition(selection));

          if (!record)
            throw new RenderFault(
              "style-composition",
              `The selected route stylesheet composition ${selectedComposition(selection)} is unavailable`,
            );

          record.lease.activate(runtime.owner);
        },

        release() {
          if (released) return;

          released = true;

          for (const compositionId of held) releaseStyleReference(compositionId);
        },
      };
    };

    const loadPage = () => {
      const module = notFound ? match.leaf.files.notFound : match.leaf.files.page;

      if (!module)
        throw new RenderFault("route-page", `Route ${match.leaf.pattern} has no page module`);

      return loadComponent(module, signal);
    };

    const makeRoute = async (
      inputs: RouteInputs,
      page: RouteHostModule,
      defaultComposition: StyleCompositionId | undefined,
    ): Promise<ReturnType<RouteHost["prepare"]>> => {
      const styles = await createRouteStyles(defaultComposition, inputs.signal);
      let prepared: ReturnType<RouteHost["prepare"]> & { readonly ready?: Promise<void> };

      try {
        prepared = host.prepare({
          layouts,
          page,
          inputs,
          ...(styles ? { styles } : {}),
        }) as typeof prepared;
        // Terminal route metadata waits for an async page boundary to settle.
        await prepared.ready;
        return prepared;
      } catch (error) {
        styles?.release();

        throw error;
      }
    };

    return {
      params: match.params,
      guards: Object.freeze(guards),
      departingOwners: host.departingOwners(layouts),
      preload: async (nextSignal) => {
        if (!viewStyles) return;

        if (!styleRuntime)
          throw new RenderFault(
            "style-runtime",
            "Generated route CSS metadata requires a style runtime bound to the root shell",
          );

        try {
          const head = runtime.context.document.head;
          const lease = await styleRuntime.prepareInstalledHead(
            viewStyles.loading,
            head,
            nextSignal,
          );

          if (stylePreloadFailed || nextSignal.aborted) {
            lease.release();

            throw (
              nextSignal.reason ??
              new RenderFault("style-preload", "Stylesheet preparation was abandoned")
            );
          }

          styleRecords.set(viewStyles.loading, { head, lease, references: 1 });

          stylesPrepared = true;
        } catch (error) {
          stylePreloadFailed = true;

          for (const record of styleRecords.values()) record.lease.release();

          styleRecords.clear();

          baseStylesReleased = true;
          throw error;
        }
      },
      release: releaseBaseStyles,
      prepareLoading: async (inputs) => {
        let page: RouteHostModule;

        if (loading) {
          // Loading views are boundary content, so they receive no page route
          // params or query accessor.
          page = { node: match.leaf, definition: loadingDefinition! };
        } else {
          runtime.context.warn(
            `Route ${match.leaf.pattern} has no +loading.tsx; the loading area is empty. Add a root loading skeleton for a visible transition.`,
          );

          page = { node: emptyNode, definition: emptyRoute as Component<unknown> };
        }

        return makeRoute(inputs, page, viewStyles?.loading);
      },
      prepare: async (inputs) =>
        makeRoute(
          inputs,
          {
            ...pageModule(match.leaf, await loadPage()),
            // Filesystem pages always receive an async boundary.  A missing
            // loading module means that the route area stays empty while the
            // page is pending; it does not remove the boundary itself.
            loading: loading ? await loadComponent(loading, signal) : emptyRoute,
          },
          viewStyles?.destination,
        ),
    };
  };

  const router = new Router({
    window,
    resolve,
    pageCacheSize: configuration.pageCacheSize,
    onError: runtime.context.onError,
  });

  bindDevelopmentRouteMatcher(
    router,
    (url) => routeMatch(table, url, normalizedMount)?.match.leaf.id,
  );

  return router;
}
