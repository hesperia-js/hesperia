export { Router, redirect, registerDeparture } from "./navigation.ts";
export type {
  RouteGuard,
  DepartureCheck,
  NavigationContext,
  RouteInputs,
  PreparedRoute,
  PreparedRouteInstallOptions,
  RouteCandidate,
  NavigationOptions,
  NavigationResult,
  RouterOptions,
  Redirect,
} from "./navigation.ts";
export { matchRoute, matchNotFound, compareRoutes } from "./manifest.ts";
export type {
  RouteManifest,
  RouteNode,
  RouteFiles,
  RouteSegment,
  RouteMatch,
  RouteParams,
} from "./manifest.ts";
export type { ReadonlyQueryParams } from "./query.ts";
export type {
  RouteTable,
  RouteTableFiles,
  RouteTableGuardModule,
  RouteTableModule,
  RouteTableNode,
} from "./route-table.ts";

type SegmentParams<S extends string> = S extends `[...${infer K}]`
  ? { [P in K]: readonly string[] }
  : S extends `[[...${infer K}]]`
    ? { [P in K]?: readonly string[] }
    : S extends `[[${infer K}]]`
      ? { [P in K]?: string }
      : S extends `[${infer K}]`
        ? { [P in K]: string }
        : {};

type PatternParams<S extends string> = string extends S
  ? import("./manifest.ts").RouteParams
  : S extends `${infer H}/${infer T}`
    ? SegmentParams<H> & PatternParams<T>
    : SegmentParams<S>;

/**
 * Declare a route with readonly literal tag types for compiler inspection.
 * Server members are not included in the browser manifest.
 * @typeParam Tags The authored literal tags.
 * @param configuration The authored route declaration.
 * @returns The same configuration object with readonly tag types.
 */
export function route<const Tags extends readonly string[]>(
  configuration: Route.Declaration & { readonly tags: Tags },
): Route.Declaration & { readonly tags: Readonly<Tags> };
/**
 * Declare a route with an explicit path pattern for its guard parameters.
 * @typeParam Pattern Route path pattern.
 * @param configuration The authored route declaration.
 * @returns The same configuration object.
 */
export function route<Pattern extends string = string>(
  configuration: Route.Declaration<Pattern>,
): Route.Declaration<Pattern>;
export function route(configuration: object): object {
  return configuration;
}

/** Types associated with a route declaration. */
export namespace Route {
  /** Referenced client guard; the compiler validates path parameter names against the route pattern. */
  export type Guard<Pattern extends string = string> = (
    context: Omit<import("./navigation.ts").NavigationContext, "params"> & {
      readonly params: Readonly<PatternParams<Pattern>>;
    },
  ) =>
    | boolean
    | import("./navigation.ts").Redirect
    | PromiseLike<boolean | import("./navigation.ts").Redirect>;

  /** Statically inspected declaration; request-time loader execution remains a separate target. */
  export interface Declaration<Pattern extends string = string> {
    /** Identifier reference to a separately client-eligible guard binding. */
    readonly guard?: Guard<Pattern>;
    /** Server-only request loader, preserved for compiler target diagnostics rather than browser execution. */
    readonly load?: unknown;
    /** Literal response policy inspected by the compiler. */
    readonly headers?: Readonly<Record<string, string>>;
    /** Literal tag declarations inspected by the compiler; generation does not yet publish them. */
    readonly tags?: readonly string[];
  }
}
