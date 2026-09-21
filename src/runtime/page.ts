import type { Accessor } from "../client.ts";
import type { ReadonlyQueryParams } from "../routing/query.ts";
import type { ComponentProps } from "./components.ts";

declare const pagePropsType: unique symbol;

/** Query declarations accepted by a page. Values remain native URL strings. */
export type PageQuerySchema = { readonly [name: string]: string | undefined };

/** Route values supplied by the filesystem router. */
export type PageRouteParams = {
  readonly [name: string]: string | readonly string[] | undefined;
};

/** Internal brand retaining the author's page input for compiler analysis. */
export type PagePropsBrand<P> = { readonly [pagePropsType]?: P };

type QueryNames<P> = P extends { readonly queryParams: infer Q } ? keyof Q & string : never;

type PageInput<P> = {
  readonly queryParams: P extends { readonly queryParams: infer Q }
    ? { readonly [K in keyof Q]: string | undefined }
    : PageQuerySchema;
};

/**
 * Map an authored page input to its body-facing values.
 *
 * Route parameters stay plain immutable values. The query view remains a
 * reactive accessor, while ordinary authored properties use Component.Props.
 */
export type PageProps<
  P extends PageInput<P> = {
    readonly queryParams: PageQuerySchema;
  },
  R extends PageRouteParams = {},
> = {
  readonly params: Readonly<R>;
} & {
  readonly queryParams: Accessor<ReadonlyQueryParams<QueryNames<P>>>;
} & ComponentProps<Omit<P, "queryParams">> &
  PagePropsBrand<P>;

/** Apply a generated route context only to a trusted PageProps brand. */
export type AtPageRoute<T, R extends PageRouteParams> = typeof pagePropsType extends keyof T
  ? T extends PagePropsBrand<infer P>
    ? P extends PageInput<P>
      ? PageProps<P, R>
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
   * Query declarations allow strings and optional strings; they do not validate
   * the URL, and get still returns null for an absent key. Other props follow
   * Component.Props. Per-file route inference requires Hesperia's checker/editor.
   * @typeParam P - Query names under queryParams, plus ordinary authored props.
   */
  export type Props<P extends PageInput<P> = { readonly queryParams: PageQuerySchema }> =
    PageProps<P>;
}
