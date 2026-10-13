import type { RouteSegment } from "./manifest.ts";
import type { StyleCompositionId } from "../runtime/style.ts";

/** A browser route module with its authored root-relative identity and lazy default export. */
export interface RouteTableModule {
  readonly filename: string;
  readonly load: () => Promise<unknown>;
}

/** Browser guard asset with a literal import loader captured in the generated route table. */
export interface RouteTableGuardModule {
  readonly filename: string;
  readonly load: () => Promise<unknown>;
}

/** Browser-safe conventional modules associated with one scanner node. */
export interface RouteTableFiles {
  readonly page?: RouteTableModule;
  readonly layout?: RouteTableModule;
  readonly loading?: RouteTableModule;
  readonly error?: RouteTableModule;
  readonly notFound?: RouteTableModule;
  readonly guard?: RouteTableGuardModule;
}

/** Complete CSS selections for one route-view mode. */
export interface RouteTableViewStyles {
  readonly destination: StyleCompositionId;
  readonly loading: StyleCompositionId;
  readonly errors: readonly {
    readonly boundaryNodeId: string;
    readonly compositionId: StyleCompositionId;
  }[];
}

/** Scanner structure plus browser-loadable route roles. */
export interface RouteTableNode {
  readonly id: string;
  readonly pattern: string;
  readonly segments: readonly RouteSegment[];
  readonly files: RouteTableFiles;
  /** Independent page and not-found stylesheet modes emitted by the compiler. */
  readonly viewStyles?: {
    readonly page?: RouteTableViewStyles;
    readonly notFound?: RouteTableViewStyles;
  };
  readonly children: readonly RouteTableNode[];
}

/** Internal browser route table emitted beside the author-owned entrypoint. */
export interface RouteTable {
  readonly version: 1;
  readonly root: RouteTableNode;
  readonly routes: readonly RouteTableNode[];
}
