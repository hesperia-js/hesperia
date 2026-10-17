declare module "hesperia:plugin/elysia/app-routes" {
  export interface Route {
    readonly method: string;
    readonly path: string;
  }

  export const routes: readonly Route[];
}

declare module "hesperia:plugin/elysia/app-effects" {
  export interface Effect {
    readonly source: { readonly method: string; readonly path: string };
    readonly target: { readonly method: string; readonly path: string };
    readonly select: (input: {
      readonly params?: Readonly<Record<string, string | number>>;
      readonly body?: unknown;
      readonly query?: unknown;
      readonly headers?: unknown;
    }) => unknown;
    readonly on: "invalidate" | "revalidate";
  }

  export const effects: readonly Effect[];
}
