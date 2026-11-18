import type { Accessor } from "../client.ts";
import type { ReadonlyQueryParams } from "../routing/query.ts";
import type { ComponentProps } from "./components.ts";

declare const pagePropsType: unique symbol;
declare const pageRouteContextType: unique symbol;

/** Query declarations accepted by a page. Values remain native URL strings. */
export type PageQuerySchema = { readonly [name: string]: string | undefined };

/** Route values supplied by the filesystem router. */
export type PageRouteParams = {
  readonly [name: string]: string | readonly string[] | undefined;
};

/**
 * Results from successful ordinary loaders, keyed by canonical leading-slash route-node ID.
 * A present key with undefined is a completed result; a missing key has no completed loader value.
 */
export type PageRouteData = Readonly<Record<string, unknown>>;

/** Type-only descriptor emitted for a generated route context. */
export interface PageRouteContext<Params extends PageRouteParams, Data extends PageRouteData> {
  readonly [pageRouteContextType]: {
    readonly params: Params;
    readonly routeData: Data;
  };
}

/** Internal brand retaining the author's page input for compiler analysis. */
export type PagePropsBrand<P> = { readonly [pagePropsType]?: P };

type QueryNames<P> = P extends { readonly queryParams: infer Q } ? keyof Q & string : never;

type PageInput<P> = {
  readonly queryParams: P extends { readonly queryParams: infer Q }
    ? { readonly [K in keyof Q]: string | undefined }
    : PageQuerySchema;
};

type PageRouteParamsFrom<Context> =
  Context extends PageRouteContext<infer Params, PageRouteData>
    ? Params
    : Context extends PageRouteParams
      ? Context
      : {};

type PageRouteDataFrom<Context> =
  Context extends PageRouteContext<PageRouteParams, infer Data> ? Data : {};

type AvailableRouteDataKeys<Data extends PageRouteData> = Extract<
  {
    [RouteId in keyof Data]-?: [Data[RouteId]] extends [never] ? never : RouteId;
  }[keyof Data],
  string
>;

type PageRouteDataProps<Data extends PageRouteData> =
  AvailableRouteDataKeys<Data> extends never
    ? {}
    : {
        readonly routeData: Readonly<{
          readonly [RouteId in AvailableRouteDataKeys<Data>]: Accessor<Data[RouteId]>;
        }>;
      };

/**
 * Map an authored page input to its body-facing values.
 *
 * Route parameters stay plain immutable values. The query view remains a
 * reactive accessor. Route data is available only for the page and matched
 * ancestors: each canonical route ID maps to an accessor, including when its
 * completed value is undefined. Ordinary authored properties use Component.Props.
 */
export type PageProps<
  P extends PageInput<P> = {
    readonly queryParams: PageQuerySchema;
  },
  R extends PageRouteParams = {},
  Data extends PageRouteData = {},
> = {
  readonly params: Readonly<R>;
} & {
  readonly queryParams: Accessor<ReadonlyQueryParams<QueryNames<P>>>;
} & PageRouteDataProps<Data> &
  ComponentProps<
    Omit<P, "queryParams" | (AvailableRouteDataKeys<Data> extends never ? never : "routeData")>
  > &
  PagePropsBrand<P>;

/** Apply a generated route context only to a trusted PageProps brand. */
export type AtPageRoute<T, Context> = typeof pagePropsType extends keyof T
  ? T extends PagePropsBrand<infer P>
    ? P extends PageInput<P>
      ? PageProps<P, PageRouteParamsFrom<Context>, PageRouteDataFrom<Context>>
      : T
    : T
  : T;

/** Types for authored page declarations. */
export namespace Page {
  /**
   * Declare page inputs while Hesperia infers route parameters from the page file.
   *
   * `params` contains plain immutable values for this page lifetime. `queryParams`
   * is a reactive accessor whose get/getAll/has methods accept the declared keys.
   * When matched route loaders have results, routeData is a readonly object of
   * accessors keyed by this route and its ancestors; a present accessor may return undefined.
   * Query declarations allow strings and optional strings; they do not validate
   * the URL, and get still returns null for an absent key. Other props follow
   * Component.Props. Per-file route inference requires Hesperia's checker/editor.
   * @typeParam P - Query names under queryParams, plus ordinary authored props.
   */
  export type Props<P extends PageInput<P> = { readonly queryParams: PageQuerySchema }> =
    PageProps<P>;
}
