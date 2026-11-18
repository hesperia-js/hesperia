export interface AsyncBoundaryHostRecordV1 {
  /** Exact server-captured boundary identity and keyed child range. */
  readonly boundary: { readonly ownerId: string; readonly slot: string; readonly key: string };
  /** Identity of the actual parent Owner that invokes the compiled boundary. */
  readonly parentOwnerId: string;
  /** Identity of the boundary's actual loading-view Owner. */
  readonly loadingOwnerId: string;
  /** Identity of the boundary's actual content-view Owner. */
  readonly contentOwnerId: string;
  /** View selected by the settled server render. */
  readonly selected: "loading" | "content";
}
