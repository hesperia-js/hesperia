/** Byte limits captured from the resolved native progressive plan. */
export interface ProgressiveByteLimitsV1 {
  /** Maximum encoded size of one fulfilled boundary terminal. */
  readonly maxBoundaryBytes: number;

  /** Maximum encoded bytes waiting in the internal queue for stream pulls. */
  readonly maxQueuedBytes: number;

  /** Maximum encoded wire events waiting in the internal queue; shell and control frames count. */
  readonly maxQueuedEvents: number;
}

/** Captured Hosting policy shared with Runtime for one admitted progressive response. */
export interface ResolvedProgressivePolicyV1 extends ProgressiveByteLimitsV1 {
  /** Version of the canonical progressive policy contract. */
  readonly version: 1;

  /** Stable identity of the captured Hosting policy. */
  readonly identity: string;

  /** Captured policy revision used by the actual request plan. */
  readonly revision: number;

  /** Maximum number of real async boundaries admitted for this response. */
  readonly maxBoundaryCount: number;

  /** Maximum encoded size of one progressive wire frame. */
  readonly maxFrameBytes: number;

  /** Maximum number of nodes admitted in one progressive region. */
  readonly maxRegionNodes: number;

  /** Maximum encoded text bytes admitted in one progressive region. */
  readonly maxRegionTextBytes: number;
}
