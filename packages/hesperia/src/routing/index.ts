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

/** Typed route declaration inspected by the compiler; its server members never enter the browser manifest. */
export function route<Pattern extends string = string>(
  configuration: Route.Declaration<Pattern>,
): Route.Declaration<Pattern> {
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
  }
}
