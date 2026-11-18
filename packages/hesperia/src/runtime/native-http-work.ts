import {
  acquireProgressiveSource,
  claimProgressiveSource,
  type ClaimedProgressiveSourceV1,
  type ProgressiveByteLimitsV1,
  type ProgressiveEncodingResultV1,
  type ProgressiveInitialFrameV1,
  type ProgressiveSourceUseV1,
  type ProgressiveSourceV1,
} from "./progressive-source.ts";
import type { PhysicalNativeExecutionLifetime } from "./retirement.ts";

/** @internal A request's original response and native body work under one module parent. */
export interface NativeHttpRequestUseV1 {
  /**
   * The exact original retirement promise for this use's admitted native request scope.
   * This is separate from the response/body `retired` join. Reading before the parent binds the
   * reservation throws synchronously.
   */
  readonly requestScopeRetired: Promise<void>;

  /**
   * Physical settlement of the response, route-load producer, and body work observed for this request.
   * Semantic response rejection is retained on its original promise and does not by itself
   * reject this join. Missing or unacknowledged work never resolves it.
   * Platform handoff joins owned production and reader work, not native transport drain.
   */
  readonly retired: Promise<void>;

  /**
   * Observe the exact promise returned by the native host response dispatch without replacing it.
   *
   * @param original - The original host promise for its response or unclaimed result.
   * @returns Nothing. The original promise remains the caller's result and error channel.
   * @remarks A synchronous observation failure is retained as an unacknowledged join.
   * @throws {TypeError} If this request use has already completed.
   */
  observeResponse(original: Promise<Response | undefined>): void;

  /**
   * Reserve the one matched route-load operation under this request's active server session.
   * The caller must invoke this immediately before starting the exact original loader promise.
   *
   * @returns A one-use observer and cleanup handle for the original route-load operation and any
   * Response it produces before Host adopts that Response.
   * @remarks Admission uses this exact claimed use, current request-scope reservation, and its
   * physical session fence. Closing the module parent alone does not revoke an already admitted use.
   * @throws {TypeError} If this use has completed, has no claimed admission-open server session, or
   * already has a route-load producer.
   */
  beginRouteLoadProduction(): RouteLoadProductionUseV1;

  /**
   * Reserve the one static-serving response producer under this request's active server session.
   * The caller must reserve it immediately before starting the exact original Response promise.
   *
   * @returns A one-use observer and cleanup handle for the original static response operation
   * and any Response body it produces before Host adopts that Response.
   * @remarks Admission uses this exact claimed use, current request-scope reservation, and its
   * physical session fence. Host adoption releases producer retirement without joining delivery
   * of the adopted body.
   * @throws {TypeError} If this use has completed, has no claimed admission-open server session, or
   * already has a static-serving producer.
   */
  beginStaticServingProduction(): StaticServingProductionUseV1;

  /**
   * Adopt an existing native response and its original body into this request use.
   *
   * @param response - The exact native response returned by the request producer.
   * @returns The exact captured body stream, or `null` when the response has no body.
   * @throws The original native Response body getter error; retirement retains the failed record.
   * @throws {TypeError} If another request use already owns this response or body, or if the first
   * Host enrollment happens after this use knows the original response outcome.
   * @remarks Repeating enrollment for a response already associated with this use returns the
   * same body resource while retained, including after response fulfillment. Once a final-only
   * body resource has been released, repeating enrollment throws instead of treating it as bodyless.
   * A response producer may reserve a late raw Response for same-use cleanup before Host sees it;
   * this call remains the adoption point. The response and body are not cloned or wrapped. Native
   * stream operations report body-used or locked errors when they run.
   */
  enrollResponseBody(response: Response): ReadableStream<Uint8Array> | null;

  /**
   * Observe the native adapter's original delivery operation for this response.
   *
   * @param response - The exact response passed to the adapter, or `undefined` when unclaimed.
   * @param original - The adapter's original delivery promise.
   * @returns Nothing. The original promise remains the adapter's result and error channel.
   * @remarks A rejection is retained as a delivery failure; it does not acknowledge cleanup.
   * @throws {TypeError} If this request use has already completed.
   */
  observeDelivery(response: Response | undefined, original: Promise<void>): void;

  /**
   * Prepare and record the actual platform handoff without claiming transport drain.
   * @param source The original Host Response, or the actual adapter fallback after an unclaimed result.
   * @returns The exact Response the fixed callback must return; raw bodies use an owned forwarder.
   * @throws The original preparation failure, or TypeError for a foreign, repeated or wrong-mode use.
   */
  recordPlatformResponseHandoff(source: Response): Response;

  /**
   * Start and observe cancellation of a body associated with this use.
   *
   * @param response - The exact response whose original body is being cancelled.
   * @param reason - The cancellation reason passed to the native body stream.
   * @returns The exact native `cancel` promise after invocation returns. Later calls reuse that promise.
   * If the body reached EOF without native cancellation, calls reuse its body-completion join.
   * @throws {TypeError} If the response is foreign, bodyless, or this use has completed.
   * @throws {TypeError} If cancellation reenters its native invocation before its promise is available.
   * @throws The exact synchronous error from native cancellation.
   */
  cancelResponseBody(response: Response, reason?: unknown): Promise<void>;

  /**
   * Reserve this request's actual Bun final-fetch observer before Host dispatch begins.
   *
   * @param adapterDrain - The exact cached drain promise for this admitted native transport.
   * @returns A one-use observer for the outer Bun fetch invocation and both response boundaries.
   * @throws {TypeError} If this use is complete or already has a Bun fetch observer.
   */
  reserveNativeBunFetch(adapterDrain: Promise<void>): NativeBunFetchUseV1;

  /**
   * Reserve the fixed Node framework-response owner before Host dispatch.
   *
   * @param originalDelivery - The actual raw-pair driver operation, including final native writing.
   * @returns A one-use observer for the actual framework invocation and its original/final bodies.
   * @throws {TypeError} If the use is not a native delivery or already has a framework owner.
   */
  reserveNativeNodeFetch(originalDelivery: Promise<void>): NativeNodeFetchUseV1;

  /**
   * Retain a synchronous dispatch failure when no original response promise can be observed.
   *
   * @param reason - The exact thrown value, including `undefined`.
   * @returns Nothing. The retirement join rejects with the retained failure.
   * @throws {TypeError} If this request use completed with a different outcome.
   */
  failDispatch(reason: unknown): void;

  /**
   * Construct a native response from immutable buffered bytes under this request's body record.
   *
   * @param blob - The exact buffered Blob used as the response body.
   * @param init - Native response status, status text, and headers.
   * @returns The constructed response associated with this request use.
   * @throws The original native Blob validation, clone, or Response construction error; retirement
   * retains the failed record.
   * @throws {TypeError} If this use is complete or the original response outcome is known.
   */
  createBlobResponse(blob: Blob, init?: ResponseInit): Response;

  /**
   * Construct a native response backed by one actual session-created progressive source.
   * The stream and native Response are prepared before the source seals its shell capture.
   *
   * @param source The opaque source issued by the original progressive server session.
   * @param options The synchronously encoded shell, Hosting encoder, and resolved byte limits.
   * @param init Native response status, status text, and headers.
   * @returns A response whose original source join, iterator pulls, delivery, and cancellation are
   * retained by this request use.
   * @throws The original source, byte admission, stream, or Response construction error.
   * @throws {TypeError} If this use is complete or the original response outcome is known.
   */
  createProgressiveResponse<Event>(
    source: ProgressiveSourceV1<Event>,
    options: ProgressiveResponseOptionsV1<Event>,
    init?: ResponseInit,
  ): Response;

  /**
   * Construct a native response with no body under this request's body record.
   *
   * @param init - Native response status, status text, and headers.
   * @returns The constructed bodyless response associated with this request use.
   * @throws The original native Response construction error; retirement retains the failed record.
   * @throws {TypeError} If this use is complete or the original response outcome is known.
   */
  createBodylessResponse(init?: ResponseInit): Response;
}

/** @internal The exact original operation channels for one requestless server execution. */
export interface NativeExecutionProducerOriginalsV1 {
  readonly result: Promise<unknown>;
  readonly settled: Promise<unknown>;
  readonly retired: Promise<void>;
}

/** @internal One requestless producer bound to its actual native execution child. */
export interface NativeExecutionProducerUseV1 {
  /** Retain the exact original operation channels without replacing any of them. */
  observe(originals: NativeExecutionProducerOriginalsV1): void;
  /** Retain the invocation failure and report a distinct physical observer attachment failure. */
  failInvocation(reason: unknown): { readonly reason: unknown } | undefined;
  /** Retain an operation-shape or observer failure as unacknowledged. */
  failObservation(reason: unknown): void;
  /** Release this use after its operation and physical child have both retired. */
  complete(): void;
}

interface NativeExecutionProducerRecord {
  readonly execution: object;
  readonly lifetime: PhysicalNativeExecutionLifetime;
  readonly observeFailedPhysicalRetirement: boolean;
  originals?: NativeExecutionProducerOriginalsV1;
  state:
    | "reserved"
    | "observing"
    | "invocation-failed"
    | "fulfilled"
    | "rejected"
    | "unacknowledged";
  physicalState: "pending" | "fulfilled" | "rejected" | "unacknowledged";
  completeRequested: boolean;
  failure?: { readonly reason: unknown };
}

/** @internal Fixed response-boundary operations owned by one native framework invocation. */
interface NativeFrameworkFetchUseV1 {
  /**
   * Project the exact original Host response through a private zero-high-water-mark body forwarder.
   *
   * @param original - The exact fulfilled response already observed by this request use.
   * @returns A response carrying the original status and headers over its owned forwarder.
   * @throws The original native getter, reader, metadata-copy, stream, or Response construction error.
   * @remarks Body reader cleanup remains joined if projection fails.
   */
  projectOriginalResponse(original: Response): Promise<Response>;

  /**
   * Observe the exact promise returned by the selected outer framework handler.
   *
   * @param original - The handler's original asynchronous Response operation before final publication.
   * @returns Nothing. The native caller retains its original promise and error channel.
   * @throws {TypeError} If the final-fetch outcome slot was already used.
   */
  observeOriginalFetch(original: Promise<Response>): void;

  /**
   * Publish the exact final Response returned by the outer framework invocation.
   *
   * @param final - The actual final Response before any ownership projection.
   * @returns The native response writer receives this Response after final-body ownership is established.
   * @throws The original native metadata or Response projection error when publication cannot proceed.
   */
  publishFinalResponse(final: Response): Promise<Response>;

  /**
   * Record failure of the actual framework invocation and start owned body cleanup.
   *
   * @param reason - The callback's exact thrown or rejected value, including `undefined`.
   * @returns The cached cleanup operation for currently owned bodies. `payloadCleanup` also joins
   * the original handler and cleanup of a Response it produces after callback failure.
   * @remarks Callback failure does not replace the original handler promise's outcome.
   * @throws {TypeError} If the callback already succeeded, its failure changes, or cleanup reenters
   * before its join exists.
   */
  rejectFinalFetch(reason: unknown): Promise<void>;

  /**
   * Join the final-fetch operation and all owned final-body cleanup, independently of transport stop.
   */
  readonly payloadCleanup: Promise<void>;
}

/** @internal The actual Bun callback and its original/final response boundaries. */
export interface NativeBunFetchUseV1 extends NativeFrameworkFetchUseV1 {}

/** @internal The actual Node framework invocation and its original/final response boundaries. */
export interface NativeNodeFetchUseV1 extends Omit<
  NativeFrameworkFetchUseV1,
  "publishFinalResponse"
> {
  /**
   * Associate the actual final framework result and its native Response view over the same body.
   * @param final - Exact result of the observed framework invocation.
   * @param nativeView - Native view prepared by the fixed Node driver using the Response protocol.
   * @returns A native response over the owned final body forwarder.
   */
  publishFinalResponse(final: Response, nativeView: Response): Promise<Response>;
}

/** Synchronous frame data supplied by the actual native Hosting caller. */
export interface ProgressiveResponseOptionsV1<Event> extends ProgressiveByteLimitsV1 {
  /** Actual shell bytes and their pending graph capture; counts as one queued control event. */
  readonly initial: ProgressiveInitialFrameV1;

  /** Synchronous Hosting encoder returning bounded bytes and their actual graph candidate. */
  readonly encode: (event: Event) => ProgressiveEncodingResultV1;
}

type Observation<T> =
  | { readonly kind: "missing" }
  | { readonly kind: "admitting" }
  | { readonly kind: "pending"; readonly original: Promise<T> }
  | { readonly kind: "fulfilled"; readonly value: T; readonly original?: Promise<T> }
  | {
      readonly kind: "rejected";
      readonly reason: { readonly value: unknown };
      readonly original?: Promise<T>;
    }
  | {
      readonly kind: "unacknowledged";
      readonly reason: { readonly value: unknown };
      readonly original?: Promise<T>;
    };

type NativeHttpRequestCompletionMode = "native-delivery" | "platform-handoff" | "unacknowledged";

type PlatformResponseHandoff =
  | { readonly kind: "awaiting-response" | "awaiting-handoff" }
  | { readonly kind: "associating"; readonly source: Response }
  | { readonly kind: "handed-off"; readonly source: Response; readonly response: Response }
  | { readonly kind: "not-handed-off"; readonly reason: { readonly value: unknown } };

type ResponseBodyKind = "blob" | "bodyless" | "native" | "progressive";
type ResponseBodyConstruction = "constructing" | "constructed" | "failed";
type ProgressiveTerminal = "open" | "complete" | "cancelled" | "failed";

interface ProgressivePullRecord {
  original: BodyPullObservation<IteratorResult<Uint8Array>>;
  callback: Observation<void>;
  callbackPromise?: Promise<void>;
}

type ProgressivePreparation =
  | { readonly kind: "preparing" | "claiming" | "claimed" }
  | {
      readonly kind: "cancelled" | "failed";
      readonly reason: { readonly value: unknown };
    };

interface ProgressiveCancellationAdmission {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
}

interface ResponseBodyRecord {
  readonly owner: object;
  kind: ResponseBodyKind;
  construction: ResponseBodyConstruction;
  response?: Response;
  nativeBody?: ReadableStream<Uint8Array> | null;
  forwardingState: NativeBodyForwardingState;
  forwardingReader?: ReadableStreamDefaultReader<Uint8Array>;
  forwardingStream?: ReadableStream<Uint8Array>;
  forwardingController?: ReadableStreamDefaultController<Uint8Array>;
  forwardingPulls: NativeBodyPullRecord[];
  forwardingCancellation?: CancellationRecord;
  forwardingRelease: Observation<void>;
  readerAcquisitionFailed: boolean;
  readerAcquisitionFailure?: { readonly reason: unknown };
  transportReaderRetryUsed: boolean;
  transportReaderRetryFailure?: { readonly reason: unknown };
  frameworkPayload: boolean;
  payloadReleased: boolean;
  cancellations: CancellationRecord[];
  progressiveUse?: ProgressiveSourceUseV1;
  progressive?: ClaimedProgressiveSourceV1;
  progressivePreparation?: ProgressivePreparation;
  progressiveSettled: Observation<void>;
  progressiveTerminal?: ProgressiveTerminal;
  progressiveFailure?: { readonly reason: unknown };
  progressivePulls: ProgressivePullRecord[];
  progressiveCancelOperation?: Observation<void>;
  progressiveCancelAdmission?: ProgressiveCancellationAdmission;
  progressiveCancelRequested?: boolean;
  constructionFailure?: { readonly reason: unknown };
  completedBodyOperation?: Promise<void>;
  responseProduction?: NativeResponseProductionRecord;
}

type RouteLoadProductionOutcome =
  | Readonly<{ readonly kind: "response"; readonly response: Response }>
  | Readonly<{ readonly kind: "values" | "failure" | "aborted" }>;

interface RouteLoadProductionUseV1 {
  /**
   * Physical settlement of the original route-load operation and any required unhanded body cleanup.
   * A semantic route-load rejection remains on its original promise and does not alone reject this join.
   * @returns The same cached promise on every read.
   */
  readonly retired: Promise<void>;

  /**
   * Observe the exact original route-load promise without replacing its result or error channel.
   * @param original - The Promise returned by the actual route-load executor.
   * @returns Nothing. The original remains the caller's result and error channel.
   * @throws {TypeError} If the observation is repeated or its observer cannot be installed.
   */
  observe(original: Promise<RouteLoadProductionOutcome>): void;

  /**
   * Retain a synchronous executor failure when it returned no original promise.
   * @param reason - The exact thrown value, including `undefined`.
   * @returns Nothing. The failure rejects `retired`.
   * @throws {TypeError} If the original operation has already started.
   */
  failInvocation(reason: unknown): void;

  /**
   * Cancel the exact produced Response when it did not reach Host adoption.
   * @param response - The original Response produced by this route-load operation.
   * @param reason - The exact native body cancellation reason.
   * @returns The cached native cancellation promise, or `undefined` for a bodyless response.
   * @throws {TypeError} If the Response has no producer association or Host already adopted it.
   * @throws The exact synchronous error from native body cleanup, or the raw reason from a retained failure.
   */
  cancelUnhanded(response: Response, reason?: unknown): Promise<void> | undefined;
}

interface StaticServingProductionUseV1 {
  /**
   * Physical settlement of the original static response and any required unhanded body cleanup.
   * Semantic rejection stays on the original Promise and does not alone reject this join. Host
   * adoption releases producer retirement without waiting for delivery of the adopted body.
   */
  readonly retired: Promise<void>;

  /**
   * Observe the exact original Response promise without replacing its result or error channel.
   * @param original The Promise returned by the actual static-serving producer.
   * @returns Nothing. The original Promise remains the caller's result and error channel.
   * @throws {TypeError} If the observation is repeated or the observer cannot be installed.
   */
  observe(original: Promise<Response>): void;

  /**
   * Retain a synchronous producer invocation failure when it returned no original Promise.
   * @param reason The exact thrown value, including `undefined`.
   * @returns Nothing. The failure rejects `retired`.
   * @throws {TypeError} If the original operation has already started.
   */
  failInvocation(reason: unknown): void;

  /**
   * Cancel the exact produced Response when it did not reach Host adoption.
   * @param response The original Response produced by this static-serving operation.
   * @param reason The exact native body cancellation reason.
   * @returns The cached native cancellation promise, or `undefined` for a bodyless Response.
   * @throws {TypeError} If the Response has no producer association or Host already adopted it.
   * @throws The exact synchronous error from native body cleanup, or the raw reason from a retained failure.
   */
  cancelUnhanded(response: Response, reason?: unknown): Promise<void> | undefined;
}

type ResponseProductionKind = "route-load" | "static-serving";
type ResponseProductionOriginalState =
  | "admitted"
  | "pending"
  | "fulfilled"
  | "rejected"
  | "invocation-failed"
  | "callback-failed"
  | "unacknowledged";

type ResponseProductionDisposition =
  | "none"
  | "pending"
  | "bodyless"
  | "adopted"
  | "cancelling"
  | "cancelled"
  | "failed";

interface ResponseProductionRecord<Kind extends ResponseProductionKind> {
  readonly kind: Kind;
  readonly retired: Promise<void>;
  resolveRetired: () => void;
  rejectRetired: (reason: unknown) => void;
  originalState: ResponseProductionOriginalState;
  original?: Promise<unknown>;
  response?: Response;
  body?: ResponseBodyRecord;
  responseDisposition: ResponseProductionDisposition;
  cancellation?: Promise<void>;
  failure?: { readonly reason: unknown };
  retiredFailureRecorded: boolean;
  misuseFailure?: { readonly reason: unknown };
  retiredSettled: boolean;
}

type RouteLoadProductionRecord = ResponseProductionRecord<"route-load">;
type StaticServingProductionRecord = ResponseProductionRecord<"static-serving">;
type NativeResponseProductionRecord = RouteLoadProductionRecord | StaticServingProductionRecord;

interface FinalResponseBodyV1 {
  readonly record: ResponseBodyRecord;
  readonly stream: ReadableStream<Uint8Array> | null;
}

type NativeBodyForwardingState =
  | "unstarted"
  | "opening"
  | "open"
  | "closed"
  | "cancelled"
  | "failed"
  | "unacknowledged";

type BodyPullObservation<Result> =
  | { readonly kind: "admitting" }
  | { readonly kind: "pending"; readonly original: Promise<Result> }
  | { readonly kind: "fulfilled" }
  | {
      readonly kind: "rejected";
      readonly reason: { readonly value: unknown };
      readonly original?: Promise<Result>;
    }
  | {
      readonly kind: "unacknowledged";
      readonly reason: { readonly value: unknown };
      readonly original?: Promise<Result>;
    };

interface NativeBodyPullRecord {
  original: BodyPullObservation<ReadableStreamReadResult<Uint8Array>>;
  callback: Observation<void>;
  callbackPromise?: Promise<void>;
}

interface CancellationRecord {
  observation: Exclude<Observation<void>, { readonly kind: "missing" }>;
  started: boolean;
  readonly admission: Promise<void>;
  resolveAdmission: () => void;
  rejectAdmission: (reason: unknown) => void;
}

interface RetainedFailure {
  readonly acquisition: number;
  readonly order: number;
  readonly reason: { readonly value: unknown };
}

type NativeFrameworkFetchOutcome =
  | { readonly kind: "fulfilled" }
  | { readonly kind: "rejected"; readonly reason: { readonly value: unknown } }
  | { readonly kind: "unacknowledged"; readonly reason: { readonly value: unknown } };
type NativeFrameworkFetchResult =
  | { readonly kind: "fulfilled"; readonly response: Response }
  | { readonly kind: "rejected"; readonly reason: { readonly value: unknown } };

interface NativeFrameworkFetchRecord {
  readonly kind: "bun" | "node";
  readonly adapterDrainOriginal: Promise<void>;
  adapterDrain: Observation<void>;
  // Handler settlement and failure of the actual native callback have separate outcomes.
  original: Observation<Response>;
  readonly outcomeReady: Promise<NativeFrameworkFetchOutcome>;
  resolveOutcomeReady: (outcome: NativeFrameworkFetchOutcome) => void;
  requestSignal?: AbortSignal;
  requestAbortListener?: EventListener;
  requestAbort?: { readonly value: unknown };
  requestAbortObservationFailure?: { readonly reason: unknown };
  bodyCleanupRequested?: { readonly value: unknown };
  outcomeReadyRecorded: boolean;
  originalFetchObserved: boolean;
  publicationSettled: boolean;
  originalProjectionSettled: boolean;
  fetchResponse?: Response;
  publishedResponse?: Response;
  nativeFinalResponse?: Response;
  finalResponse?: Response;
  publication: Observation<Response>;
  rejectionCleanup: Observation<void>;
  rejectionReason?: { readonly value: unknown };
  originalProjection: Observation<Response | undefined>;
  originalBody?: ResponseBodyRecord;
  finalBody?: ResponseBodyRecord;
  readonly payloadCleanup: Promise<void>;
  resolvePayloadCleanup: () => void;
  rejectPayloadCleanup: (reason: unknown) => void;
  payloadCleanupFailure?: { readonly reason: unknown };
  payloadCleanupSettled: boolean;
  transportEnded: boolean;
}

const nativeBodyOwners = new WeakMap<ReadableStream<Uint8Array>, ResponseBodyRecord>();
const nativeBodyCleanupFailures = new WeakMap<AggregateError, readonly unknown[]>();
const nativeReflectApply = Reflect.apply;
const nativePromiseThen = Promise.prototype.then;
const NativePromise = Promise;
const nativePromiseResolve = Promise.resolve;
const nativePromiseReject = Promise.reject;
const NativeResponse = Response;
const nativeRequestMethodGetter = Object.getOwnPropertyDescriptor(Request.prototype, "method")?.get;
const nativeRequestSignalGetter = Object.getOwnPropertyDescriptor(Request.prototype, "signal")?.get;
const nativeResponseBodyGetter = Object.getOwnPropertyDescriptor(Response.prototype, "body")?.get;
const nativeResponseStatusGetter = Object.getOwnPropertyDescriptor(
  Response.prototype,
  "status",
)?.get;
const nativeResponseStatusTextGetter = Object.getOwnPropertyDescriptor(
  Response.prototype,
  "statusText",
)?.get;
const nativeResponseHeadersGetter = Object.getOwnPropertyDescriptor(
  Response.prototype,
  "headers",
)?.get;
const NativeHeaders = Headers;
const nativeHeadersForEach = Headers.prototype.forEach;
const nativeHeadersAppend = Headers.prototype.append;
const nativeHeadersGetSetCookie = Object.getOwnPropertyDescriptor(
  Headers.prototype,
  "getSetCookie",
)?.value;
const NativeBlob = Blob;
const blobSizeGetter = Object.getOwnPropertyDescriptor(Blob.prototype, "size")?.get;
const blobTypeGetter = Object.getOwnPropertyDescriptor(Blob.prototype, "type")?.get;
const nativeReadableStream = ReadableStream;
const nativeReadableStreamCancel = ReadableStream.prototype.cancel;
const nativeReadableStreamGetReader = ReadableStream.prototype.getReader;
const nativeReaderPrototype = ReadableStreamDefaultReader.prototype;
const nativeReaderRead = Object.getOwnPropertyDescriptor(nativeReaderPrototype, "read")?.value;
const nativeReaderCancel = Object.getOwnPropertyDescriptor(nativeReaderPrototype, "cancel")?.value;
const nativeReaderReleaseLock = Object.getOwnPropertyDescriptor(
  nativeReaderPrototype,
  "releaseLock",
)?.value;
const nativeControllerPrototype = ReadableStreamDefaultController.prototype;
const nativeControllerEnqueue = Object.getOwnPropertyDescriptor(
  nativeControllerPrototype,
  "enqueue",
)?.value;
const nativeControllerClose = Object.getOwnPropertyDescriptor(
  nativeControllerPrototype,
  "close",
)?.value;
const nativeControllerError = Object.getOwnPropertyDescriptor(
  nativeControllerPrototype,
  "error",
)?.value;
const nativePromiseAllSettled = Promise.allSettled;
const nativeAbortSignalAbortedGetter = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  "aborted",
)?.get;
const nativeAbortSignalReasonGetter = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  "reason",
)?.get;
const nativeAddEventListener = Object.getOwnPropertyDescriptor(
  EventTarget.prototype,
  "addEventListener",
)?.value;
const nativeRemoveEventListener = Object.getOwnPropertyDescriptor(
  EventTarget.prototype,
  "removeEventListener",
)?.value;

function observeOriginal<T>(
  original: Promise<T>,
  fulfilled: (value: T) => void,
  rejected: (reason: unknown) => void,
  callbackFailed: (reason: unknown) => void,
): void {
  const invoke = (callback: () => void): void => {
    try {
      callback();
    } catch (reason) {
      try {
        callbackFailed(reason);
      } catch {
        // Keep internal observer failures off the original promise's error channel.
      }
    }
  };

  nativeReflectApply(nativePromiseThen, original, [
    (value: T) => {
      invoke(() => fulfilled(value));
    },
    (reason: unknown) => {
      invoke(() => rejected(reason));
    },
  ]);
}

class NativeHttpRequestUseRecord {
  readonly retired: Promise<void>;
  readonly failures: RetainedFailure[] = [];
  readonly bodies = new Set<ResponseBodyRecord>();
  private readonly bodyOwnerIdentity = Object.freeze({});
  // Response identity is use-local; only a non-null body stream has cross-use ownership.
  private readonly responseBodies = new WeakMap<Response, ResponseBodyRecord>();
  private readonly responseProducers = new WeakMap<Response, NativeResponseProductionRecord>();
  private readonly adoptedResponses = new WeakSet<Response>();
  private requestScopeRetirement?: Promise<void>;
  response: Observation<Response | undefined> = { kind: "missing" };
  delivery: Observation<void> = { kind: "missing" };
  deliveryResponse?: Response;
  private routeLoadProduction?: RouteLoadProductionRecord;
  private staticServingProduction?: StaticServingProductionRecord;
  private routeLoadRetirement: Observation<void> = { kind: "missing" };
  private staticServingRetirement: Observation<void> = { kind: "missing" };
  private responseProductionFailureCleanup?: { readonly reason: unknown };
  claimed = false;
  sessionConstructionClaimed = false;
  completed = false;
  private deferFinish = 0;
  private nextFailureOrder = 0;
  private unacknowledged?: { readonly reason: unknown };
  private readonly missingDeliveryReceipt?: { readonly reason: unknown };
  private platformHandoff?: PlatformResponseHandoff;
  private frameworkFetch?: NativeFrameworkFetchRecord;
  private resolveRetired!: () => void;
  private rejectRetired!: (reason: unknown) => void;

  readonly view: NativeHttpRequestUseV1;

  constructor(
    readonly acquisition: number,
    readonly entry: object,
    readonly request: Request,
    private readonly changed: (record: NativeHttpRequestUseRecord) => void,
    private readonly assertRequestResponseProductionAdmission: (
      use: NativeHttpRequestUseV1,
    ) => void,
    private readonly assertFinalResponseHandoffCurrent: (use: NativeHttpRequestUseV1) => void,
    private readonly completionMode: NativeHttpRequestCompletionMode = "native-delivery",
  ) {
    this.retired = new NativePromise<void>((resolve, reject) => {
      this.resolveRetired = resolve;
      this.rejectRetired = reject;
    });
    nativeReflectApply(nativePromiseThen, this.retired, [undefined, () => undefined]);

    if (completionMode === "platform-handoff") this.platformHandoff = { kind: "awaiting-response" };

    if (completionMode === "unacknowledged") {
      const reason = new TypeError(
        "Ordinary Host.handle has no observed native delivery operation",
      );

      this.delivery = { kind: "unacknowledged", reason: { value: reason } };
      this.missingDeliveryReceipt = { reason };
    }

    const readRequestScopeRetirement = (): Promise<void> => {
      const original = this.requestScopeRetirement;

      if (original === undefined)
        throw new TypeError("The native request scope retirement promise is not bound");

      return original;
    };

    this.view = Object.freeze({
      get requestScopeRetired() {
        return readRequestScopeRetirement();
      },
      retired: this.retired,
      observeResponse: (original: Promise<Response | undefined>) => this.observeResponse(original),
      beginRouteLoadProduction: () => this.beginRouteLoadProduction(),
      beginStaticServingProduction: () => this.beginStaticServingProduction(),
      enrollResponseBody: (response: Response) => this.enrollResponseBody(response),
      observeDelivery: (response: Response | undefined, original: Promise<void>) =>
        this.observeDelivery(response, original),
      recordPlatformResponseHandoff: (source: Response) =>
        this.recordPlatformResponseHandoff(source),
      cancelResponseBody: (response: Response, reason?: unknown) =>
        this.cancelResponseBody(response, reason),
      reserveNativeBunFetch: (adapterDrain: Promise<void>) =>
        this.reserveNativeBunFetch(adapterDrain),
      reserveNativeNodeFetch: (originalDelivery: Promise<void>) =>
        this.reserveNativeNodeFetch(originalDelivery),
      failDispatch: (reason: unknown) => this.failDispatch(reason),
      createBlobResponse: (blob: Blob, init?: ResponseInit) => this.createBlobResponse(blob, init),
      createProgressiveResponse: <Event>(
        source: ProgressiveSourceV1<Event>,
        options: ProgressiveResponseOptionsV1<Event>,
        init?: ResponseInit,
      ) => this.createProgressiveResponse(source, options, init),
      createBodylessResponse: (init?: ResponseInit) => this.createBodylessResponse(init),
    });
  }

  /** @internal Bind the parent's exact physical request reservation before this use is claimed. */
  bindRequestScopeRetirement(original: Promise<void>): void {
    if (this.completed || this.claimed || this.requestScopeRetirement !== undefined)
      throw new TypeError(
        "The native request scope retirement promise can be bound only once before claim",
      );

    this.requestScopeRetirement = original;
  }

  private beginRouteLoadProduction(): RouteLoadProductionUseV1 {
    this.assertOpen();

    if (!this.sessionConstructionClaimed)
      throw new TypeError("A route-load producer requires this request's claimed server session");

    if (this.routeLoadProduction) {
      const error = new TypeError("This native request use already has a route-load producer");

      this.failUnacknowledged(error, true);

      throw error;
    }

    this.assertRequestResponseProductionAdmission(this.view);

    const record = this.createResponseProductionRecord("route-load");
    this.routeLoadProduction = record;

    const use: RouteLoadProductionUseV1 = Object.freeze({
      retired: record.retired,
      observe: (original: Promise<RouteLoadProductionOutcome>) =>
        this.observeRouteLoadProduction(record, original),
      failInvocation: (reason: unknown) => this.failRouteLoadInvocation(record, reason),
      cancelUnhanded: (response: Response, reason?: unknown) =>
        this.cancelUnhandedRouteLoadResponse(record, response, reason),
    });

    this.finishIfSettled();

    return use;
  }

  private beginStaticServingProduction(): StaticServingProductionUseV1 {
    this.assertOpen();

    if (!this.sessionConstructionClaimed)
      throw new TypeError(
        "A static-serving producer requires this request's claimed server session",
      );

    if (this.staticServingProduction) {
      const error = new TypeError("This native request use already has a static-serving producer");

      this.failUnacknowledged(error, true);

      throw error;
    }

    this.assertRequestResponseProductionAdmission(this.view);

    const record = this.createResponseProductionRecord("static-serving");
    this.staticServingProduction = record;

    const use: StaticServingProductionUseV1 = Object.freeze({
      retired: record.retired,
      observe: (original: Promise<Response>) =>
        this.observeStaticServingProduction(record, original),
      failInvocation: (reason: unknown) => this.failResponseProductionInvocation(record, reason),
      cancelUnhanded: (response: Response, reason?: unknown) =>
        this.cancelUnhandedResponseProduction(record, response, reason),
    });

    this.finishIfSettled();

    return use;
  }

  private createResponseProductionRecord<Kind extends ResponseProductionKind>(
    kind: Kind,
  ): ResponseProductionRecord<Kind> {
    let resolveRetired!: () => void;
    let rejectRetired!: (reason: unknown) => void;
    const retired = new NativePromise<void>((resolve, reject) => {
      resolveRetired = resolve;
      rejectRetired = reject;
    });
    nativeReflectApply(nativePromiseThen, retired, [undefined, () => undefined]);

    const record: ResponseProductionRecord<Kind> = {
      kind,
      retired,
      resolveRetired,
      rejectRetired,
      originalState: "admitted",
      responseDisposition: "none",
      retiredFailureRecorded: false,
      retiredSettled: false,
    };
    this.setResponseProductionRetirement(record, { kind: "pending", original: retired });

    try {
      observeOriginal(
        retired,
        () => {
          this.setResponseProductionRetirement(record, { kind: "fulfilled", value: undefined });
          this.finishIfSettled();
        },
        (reason) => {
          this.setResponseProductionRetirement(record, {
            kind: "rejected",
            reason: { value: reason },
          });

          if (!record.retiredFailureRecorded) {
            this.addFailure(reason);
            record.retiredFailureRecorded = true;
          }

          this.finishIfSettled();
        },
        (reason) => {
          this.setResponseProductionRetirement(record, {
            kind: "unacknowledged",
            reason: { value: reason },
          });

          if (!record.retiredFailureRecorded) {
            this.failUnacknowledged(reason, true);
            record.retiredFailureRecorded = true;
          }

          this.finishIfSettled();
        },
      );
    } catch (reason) {
      this.setResponseProductionRetirement(record, {
        kind: "unacknowledged",
        reason: { value: reason },
      });
      record.retiredFailureRecorded = true;
      this.failUnacknowledged(reason, true);
      record.retiredSettled = true;
      record.rejectRetired(reason);
    }

    return record;
  }

  private setResponseProductionRetirement<Kind extends ResponseProductionKind>(
    record: ResponseProductionRecord<Kind>,
    observation: Observation<void>,
  ): void {
    if (record.kind === "route-load") this.routeLoadRetirement = observation;
    else this.staticServingRetirement = observation;
  }

  private observeRouteLoadProduction(
    record: RouteLoadProductionRecord,
    original: Promise<RouteLoadProductionOutcome>,
  ): void {
    this.observeResponseProduction(record, original, (outcome) => {
      if (typeof outcome !== "object" || outcome === null || typeof outcome.kind !== "string")
        throw new TypeError("The route-load producer returned an invalid outcome");

      if (outcome.kind === "response") {
        const response = (outcome as { readonly response?: unknown }).response;

        if (typeof response !== "object" || response === null)
          throw new TypeError("The route-load response outcome has no Response");

        this.associateResponseProduction(record, response as Response);
      } else if (
        outcome.kind !== "values" &&
        outcome.kind !== "failure" &&
        outcome.kind !== "aborted"
      ) {
        throw new TypeError("The route-load producer returned an unknown outcome kind");
      } else record.responseDisposition = "none";
    });
  }

  private observeStaticServingProduction(
    record: StaticServingProductionRecord,
    original: Promise<Response>,
  ): void {
    this.observeResponseProduction(record, original, (response) => {
      if (typeof response !== "object" || response === null)
        throw new TypeError("The static-serving producer did not return a Response");

      this.associateResponseProduction(record, response);
    });
  }

  private observeResponseProduction<Outcome>(
    record: NativeResponseProductionRecord,
    original: Promise<Outcome>,
    onFulfilled: (value: Outcome) => void,
  ): void {
    if (!this.isCurrentResponseProduction(record) || record.originalState !== "admitted") {
      const error = new TypeError(`The ${record.kind} producer observation was already used`);

      if (this.isCurrentResponseProduction(record) && !record.misuseFailure) {
        record.misuseFailure = { reason: error };
        record.retiredFailureRecorded = true;
        this.failUnacknowledged(error, true);
        this.finishResponseProduction(record);
      } else this.failUnacknowledged(error, true);

      throw error;
    }

    record.originalState = "pending";
    record.original = original;

    try {
      observeOriginal(
        original,
        (value) => {
          try {
            onFulfilled(value);
            record.originalState = "fulfilled";
            record.original = undefined;
            this.finishResponseProduction(record);
          } catch (reason) {
            record.originalState = "callback-failed";
            record.original = undefined;
            record.responseDisposition = "failed";
            record.failure = { reason };

            if (!record.retiredFailureRecorded) {
              this.failUnacknowledged(reason, true);
              record.retiredFailureRecorded = true;
            }

            this.finishResponseProduction(record);
          }
        },
        () => {
          record.originalState = "rejected";
          record.original = undefined;
          record.responseDisposition = "none";
          this.finishResponseProduction(record);
        },
        (reason) => {
          record.originalState = "callback-failed";
          record.original = undefined;
          record.failure = { reason };

          if (!record.retiredFailureRecorded) {
            this.failUnacknowledged(reason, true);
            record.retiredFailureRecorded = true;
          }

          this.finishResponseProduction(record);
        },
      );
    } catch (reason) {
      record.originalState = "unacknowledged";
      record.original = original;
      record.failure = { reason };
      record.retiredFailureRecorded = true;
      this.failUnacknowledged(reason, true);
      this.finishResponseProduction(record);

      throw reason;
    }
  }

  private failResponseProductionInvocation(
    record: StaticServingProductionRecord,
    reason: unknown,
  ): void {
    if (record !== this.staticServingProduction || record.originalState !== "admitted") {
      const error = new TypeError(
        "A static-serving invocation failed after its original operation started",
      );

      if (record === this.staticServingProduction && !record.misuseFailure) {
        record.misuseFailure = { reason: error };
        record.retiredFailureRecorded = true;
        this.failUnacknowledged(error, true);
        this.finishResponseProduction(record);
      } else this.failUnacknowledged(error, true);

      throw error;
    }

    record.originalState = "invocation-failed";
    record.failure = { reason };
    this.finishResponseProduction(record);
  }

  private isCurrentResponseProduction(record: NativeResponseProductionRecord): boolean {
    return record.kind === "route-load"
      ? this.routeLoadProduction === record
      : this.staticServingProduction === record;
  }

  private failRouteLoadInvocation(record: RouteLoadProductionRecord, reason: unknown): void {
    if (record !== this.routeLoadProduction || record.originalState !== "admitted") {
      const error = new TypeError(
        "A route-load invocation failed after its original operation started",
      );

      if (record === this.routeLoadProduction && !record.misuseFailure) {
        record.misuseFailure = { reason: error };
        record.retiredFailureRecorded = true;
        this.failUnacknowledged(error, true);
        this.finishResponseProduction(record);
      } else this.failUnacknowledged(error, true);

      throw error;
    }

    record.originalState = "invocation-failed";
    record.failure = { reason };
    this.finishResponseProduction(record);
  }

  private cancelUnhandedRouteLoadResponse(
    record: RouteLoadProductionRecord,
    response: Response,
    reason?: unknown,
  ): Promise<void> | undefined {
    return this.cancelUnhandedResponseProduction(record, response, reason);
  }

  private cancelUnhandedResponseProduction(
    record: NativeResponseProductionRecord,
    response: Response,
    reason?: unknown,
  ): Promise<void> | undefined {
    if (
      !this.isCurrentResponseProduction(record) ||
      this.responseProducers.get(response) !== record
    ) {
      const error = new TypeError(`The unhanded ${record.kind} Response has no matching producer`);

      this.failUnacknowledged(error, true);

      throw error;
    }

    if (record.responseDisposition === "adopted" || this.adoptedResponses.has(response))
      throw new TypeError(`The ${record.kind} Response was already adopted by Host`);

    if (record.responseDisposition === "bodyless") return undefined;

    if (record.cancellation) return record.cancellation;

    if (record.responseDisposition === "cancelled") {
      const error = new TypeError(
        `The ${record.kind} Response has no retained cancellation operation`,
      );

      this.failUnacknowledged(error, true);
      record.responseDisposition = "failed";
      record.failure = { reason: error };
      record.retiredFailureRecorded = true;
      this.finishResponseProduction(record);

      throw error;
    }

    if (record.responseDisposition === "failed") throw record.failure?.reason;

    const body = record.body;

    if (!body) {
      const error = new TypeError(`The ${record.kind} Response has no request-use body record`);

      this.failUnacknowledged(error, true);
      record.responseDisposition = "failed";
      record.failure = { reason: error };
      record.retiredFailureRecorded = true;
      this.failResponseProduction(record, error, true);

      throw error;
    }

    if (record.responseDisposition === "cancelling" && !record.cancellation)
      return this.cancelResponseBody(response, reason);

    if (record.responseDisposition === "pending") record.responseDisposition = "cancelling";
    else if (record.responseDisposition !== "cancelling") {
      const error = new TypeError(
        `The ${record.kind} Response has not reached a cancellable state`,
      );

      this.failUnacknowledged(error, true);

      throw error;
    }

    let cancellation: Promise<void>;

    if (
      body.forwardingCancellation?.started &&
      body.forwardingCancellation.observation.kind === "admitting"
    )
      return this.cancelResponseBody(response, reason);

    try {
      cancellation = this.cancelResponseBody(response, reason);
    } catch (failure) {
      if (!record.failure) {
        record.responseDisposition = "failed";
        record.failure = { reason: failure };
        record.retiredFailureRecorded = true;
        this.failResponseProduction(record, failure, true);
      }

      throw failure;
    }

    record.cancellation = cancellation;

    if (
      body.payloadReleased ||
      body.forwardingState === "closed" ||
      body.forwardingState === "cancelled"
    ) {
      record.responseDisposition = "cancelled";
      this.finishResponseProduction(record);
    }

    return cancellation;
  }

  private finishResponseProduction(record: NativeResponseProductionRecord): void {
    if (record.retiredSettled) {
      this.finishIfSettled();

      return;
    }

    if (record.originalState === "admitted" || record.originalState === "pending") return;

    if (
      record.originalState === "unacknowledged" ||
      record.originalState === "invocation-failed" ||
      record.originalState === "callback-failed"
    ) {
      this.failResponseProduction(record, record.failure?.reason, record.retiredFailureRecorded);

      return;
    }

    if (record.responseDisposition === "pending" || record.responseDisposition === "cancelling")
      return;

    if (record.responseDisposition === "failed") {
      this.failResponseProduction(record, record.failure?.reason, record.retiredFailureRecorded);

      return;
    }

    if (record.misuseFailure) {
      this.failResponseProduction(
        record,
        record.misuseFailure.reason,
        record.retiredFailureRecorded,
      );

      return;
    }

    record.retiredSettled = true;
    record.resolveRetired();
    this.releaseResponseProduction(record);
  }

  private failResponseProduction(
    record: NativeResponseProductionRecord,
    reason: unknown,
    alreadyRecorded = false,
  ): void {
    if (record.retiredSettled) return;

    record.retiredSettled = true;
    record.retiredFailureRecorded = alreadyRecorded;
    record.rejectRetired(reason);
    this.releaseResponseProduction(record, record.originalState === "unacknowledged");
  }

  private releaseResponseProduction(
    record: NativeResponseProductionRecord,
    retainUnknownOriginal = false,
  ): void {
    if (!retainUnknownOriginal) record.original = undefined;

    if (record.body?.responseProduction === record) record.body.responseProduction = undefined;

    record.body = undefined;

    if (record.responseDisposition !== "failed") record.response = undefined;
  }

  reserveNativeBunFetch(adapterDrain: Promise<void>): NativeBunFetchUseV1 {
    return this.reserveFrameworkFetch("bun", adapterDrain);
  }

  reserveNativeNodeFetch(originalDelivery: Promise<void>): NativeNodeFetchUseV1 {
    if (this.completionMode !== "native-delivery")
      throw new TypeError("Node framework delivery requires the actual native request owner");

    const use = this.reserveFrameworkFetch("node", originalDelivery);

    return Object.freeze({
      payloadCleanup: use.payloadCleanup,
      projectOriginalResponse: use.projectOriginalResponse,
      observeOriginalFetch: use.observeOriginalFetch,
      rejectFinalFetch: use.rejectFinalFetch,
      publishFinalResponse: (final: Response, nativeView: Response) =>
        this.publishFinalResponse(final, nativeView),
    });
  }

  private reserveFrameworkFetch(
    kind: "bun" | "node",
    adapterDrain: Promise<void>,
  ): NativeFrameworkFetchUseV1 {
    this.assertOpen();

    if (this.completionMode === "platform-handoff") {
      const error = new TypeError("Platform handoff cannot acquire framework transport ownership");

      this.failDispatch(error);
      throw error;
    }

    if (this.frameworkFetch) {
      const error = new TypeError(
        "The native request use already has a native framework final-fetch owner",
      );

      this.failUnacknowledged(error, true);

      throw error;
    }

    let resolveOutcomeReady!: (outcome: NativeFrameworkFetchOutcome) => void;
    const outcomeReady = new NativePromise<NativeFrameworkFetchOutcome>((resolve) => {
      resolveOutcomeReady = resolve;
    });
    let resolvePayloadCleanup!: () => void;
    let rejectPayloadCleanup!: (reason: unknown) => void;
    const payloadCleanup = new NativePromise<void>((resolve, reject) => {
      resolvePayloadCleanup = resolve;
      rejectPayloadCleanup = reject;
    });
    nativeReflectApply(nativePromiseThen, payloadCleanup, [undefined, () => undefined]);

    const final: NativeFrameworkFetchRecord = {
      kind,
      adapterDrainOriginal: adapterDrain,
      adapterDrain: { kind: "pending", original: adapterDrain },
      original: { kind: "missing" },
      outcomeReady,
      resolveOutcomeReady,
      requestSignal: undefined,
      requestAbortListener: undefined,
      requestAbort: undefined,
      requestAbortObservationFailure: undefined,
      outcomeReadyRecorded: false,
      originalFetchObserved: false,
      publicationSettled: false,
      originalProjectionSettled: false,
      publication: { kind: "missing" },
      rejectionCleanup: { kind: "missing" },
      originalProjection: { kind: "missing" },
      payloadCleanup,
      resolvePayloadCleanup,
      rejectPayloadCleanup,
      payloadCleanupFailure: undefined,
      payloadCleanupSettled: false,
      transportEnded: false,
    };

    this.frameworkFetch = final;

    try {
      this.observeRequestAbort(final);
    } catch (reason) {
      final.requestAbortObservationFailure = { reason };
      this.recordFrameworkFetchSetupFailure(final, reason);
    }

    const use: NativeFrameworkFetchUseV1 = Object.freeze({
      payloadCleanup,
      projectOriginalResponse: (original: Response) => this.projectOriginalResponse(original),
      observeOriginalFetch: (original: Promise<Response>) => this.observeOriginalFetch(original),
      publishFinalResponse: (response: Response) => this.publishFinalResponse(response),
      rejectFinalFetch: (reason: unknown) => this.rejectFinalFetch(reason),
    });

    try {
      observeOriginal(
        adapterDrain,
        () => {
          final.adapterDrain = { kind: "fulfilled", value: undefined, original: adapterDrain };
          final.transportEnded = true;
          this.cancelOpenBodyRecords(undefined, true);
          this.updateFrameworkPayloadCleanup();
          this.finishIfSettled();
        },
        (reason) => {
          final.adapterDrain = {
            kind: "rejected",
            reason: { value: reason },
            original: adapterDrain,
          };
          if (kind === "node") {
            final.bodyCleanupRequested ??= { value: reason };
            void this.cancelOpenBodyRecords(reason);
          }

          this.failUnacknowledged(reason, true);
          this.updateFrameworkPayloadCleanup();
          this.finishIfSettled();
        },
        (reason) => {
          final.adapterDrain = {
            kind: "unacknowledged",
            reason: { value: reason },
            original: adapterDrain,
          };
          if (kind === "node") {
            final.bodyCleanupRequested ??= { value: reason };
            void this.cancelOpenBodyRecords(reason);
          }

          this.failUnacknowledged(reason, true);
          this.updateFrameworkPayloadCleanup();
          this.finishIfSettled();
        },
      );
    } catch (reason) {
      final.adapterDrain = {
        kind: "unacknowledged",
        reason: { value: reason },
        original: adapterDrain,
      };
      this.recordFrameworkFetchSetupFailure(final, reason);
    }

    return use;
  }

  private observeOriginalFetch(original: Promise<Response>): void {
    const final = this.requireFrameworkFetch();

    if (final.originalFetchObserved || final.outcomeReadyRecorded) {
      const error = new TypeError(
        "The native framework final-fetch operation was observed more than once",
      );

      this.failUnacknowledged(error, true);

      throw error;
    }

    final.originalFetchObserved = true;
    final.original = { kind: "pending", original };

    try {
      observeOriginal(
        original,
        (response) => {
          final.original = { kind: "fulfilled", value: response, original };
          this.recordFrameworkFetchOutcome({ kind: "fulfilled", response });

          const cleanup = final.bodyCleanupRequested ?? final.rejectionReason;

          if (cleanup) this.cancelFinalResponseAfterFailure(response, cleanup.value);

          this.updateFrameworkPayloadCleanup();
          this.finishIfSettled();
        },
        (reason) => {
          final.original = { kind: "rejected", reason: { value: reason }, original };
          this.recordFrameworkFetchOutcome({ kind: "rejected", reason: { value: reason } });
          if (!final.rejectionReason) void this.cancelOpenBodyRecords(reason);
          this.updateFrameworkPayloadCleanup();
          this.finishIfSettled();
        },
        (reason) => {
          this.recordFrameworkFetchUnacknowledged(final, reason, original);
        },
      );
    } catch (reason) {
      this.recordFrameworkFetchUnacknowledged(final, reason, original);

      throw reason;
    }
  }

  private publishFinalResponse(
    finalResponse: Response,
    nativeView: Response = finalResponse,
  ): Promise<Response> {
    const final = this.requireFrameworkFetch();

    if (final.publishedResponse || final.publicationSettled || final.rejectionReason) {
      const error = new TypeError(
        "The native framework final response was published more than once or after callback failure",
      );

      this.failUnacknowledged(error, true);

      return nativeReflectApply(nativePromiseReject, NativePromise, [error]) as Promise<Response>;
    }

    final.publishedResponse = finalResponse;
    final.nativeFinalResponse = nativeView;

    if (final.original.kind === "missing") {
      final.original = { kind: "fulfilled", value: finalResponse };
      this.recordFrameworkFetchOutcome({ kind: "fulfilled", response: finalResponse });
    }

    const publication = nativeReflectApply(nativePromiseThen, final.outcomeReady, [
      (outcome: NativeFrameworkFetchOutcome): Promise<Response> | Response => {
        if (outcome.kind === "rejected") {
          const error = new TypeError("A final Response was published after its fetch rejected");

          this.failUnacknowledged(error, true);

          throw error;
        }

        if (outcome.kind === "unacknowledged") {
          final.finalResponse = nativeView;
          this.cancelFinalResponseAfterFailure(finalResponse, outcome.reason.value);

          return nativeView;
        }

        if (final.fetchResponse !== finalResponse) {
          const error = new TypeError(
            "The published Response differs from the original framework fetch result",
          );

          this.failUnacknowledged(error, true);

          throw error;
        }

        if (final.requestAbortObservationFailure) {
          final.finalResponse = nativeView;
          this.cancelFinalResponseAfterFailure(
            finalResponse,
            final.requestAbortObservationFailure.reason,
          );

          return nativeView;
        }

        return this.projectFinalResponse(nativeView);
      },
    ]) as Promise<Response>;

    final.publication = { kind: "pending", original: publication };

    try {
      observeOriginal(
        publication,
        (response) => {
          final.publication = { kind: "fulfilled", value: response, original: publication };
          final.finalResponse = response;
          final.publicationSettled = true;
          this.updateFrameworkPayloadCleanup();
          this.finishIfSettled();
        },
        (reason) => {
          final.publication = {
            kind: "rejected",
            reason: { value: reason },
            original: publication,
          };
          final.publicationSettled = true;
          this.failUnacknowledged(reason, true);
          this.updateFrameworkPayloadCleanup();
          this.finishIfSettled();
        },
        (reason) => {
          final.publication = {
            kind: "unacknowledged",
            reason: { value: reason },
            original: publication,
          };
          final.publicationSettled = true;
          this.failUnacknowledged(reason, true);
          this.updateFrameworkPayloadCleanup();
          this.finishIfSettled();
        },
      );
    } catch (reason) {
      final.publication = {
        kind: "unacknowledged",
        reason: { value: reason },
        original: publication,
      };
      final.publicationSettled = true;
      this.failUnacknowledged(reason, true);
      this.updateFrameworkPayloadCleanup();
      this.finishIfSettled();

      throw reason;
    }

    return publication;
  }

  private rejectFinalFetch(reason: unknown): Promise<void> {
    const final = this.requireFrameworkFetch();

    if (
      !final.rejectionReason &&
      (final.payloadCleanupSettled || final.publication.kind === "fulfilled")
    ) {
      const error = new TypeError(
        "The native framework invocation rejected after final publication completed",
      );

      this.failUnacknowledged(error, true);

      return nativeReflectApply(nativePromiseReject, NativePromise, [error]) as Promise<void>;
    }

    if (final.rejectionCleanup.kind === "pending") {
      if (
        final.rejectionReason &&
        Object.is(final.rejectionReason.value, reason) &&
        final.rejectionCleanup.original
      )
        return final.rejectionCleanup.original;
    }

    if (final.rejectionReason) {
      if (!Object.is(final.rejectionReason.value, reason)) {
        const error = new TypeError("The framework fetch rejection changed after cleanup began");

        this.failUnacknowledged(error, true);

        return nativeReflectApply(nativePromiseReject, NativePromise, [error]) as Promise<void>;
      }

      if (final.rejectionCleanup.kind === "admitting") {
        const error = new TypeError(
          "native framework invocation failure cleanup reentered before its original join was available",
        );

        this.failUnacknowledged(error, true);

        throw error;
      }

      if (
        (final.rejectionCleanup.kind === "fulfilled" ||
          final.rejectionCleanup.kind === "rejected" ||
          final.rejectionCleanup.kind === "unacknowledged") &&
        final.rejectionCleanup.original
      )
        return final.rejectionCleanup.original;

      if (final.rejectionCleanup.kind === "fulfilled")
        return nativeReflectApply(nativePromiseResolve, NativePromise, [
          undefined,
        ]) as Promise<void>;

      if (
        final.rejectionCleanup.kind === "rejected" ||
        final.rejectionCleanup.kind === "unacknowledged"
      )
        return nativeReflectApply(nativePromiseReject, NativePromise, [
          final.rejectionCleanup.reason.value,
        ]) as Promise<void>;
    }

    final.rejectionReason = { value: reason };
    final.rejectionCleanup = { kind: "admitting" };

    if (final.original.kind === "missing") {
      final.original = { kind: "rejected", reason: { value: reason } };
      this.recordFrameworkFetchOutcome({ kind: "rejected", reason: { value: reason } });
    }

    let cleanup: Promise<void>;

    try {
      if (final.original.kind === "fulfilled")
        this.cancelFinalResponseAfterFailure(final.original.value, reason);

      cleanup = this.cancelOpenBodyRecords(reason);
    } catch (failure) {
      final.rejectionCleanup = { kind: "unacknowledged", reason: { value: failure } };
      this.failUnacknowledged(failure, true);
      this.updateFrameworkPayloadCleanup();
      this.finishIfSettled();

      throw failure;
    }

    final.rejectionCleanup = { kind: "pending", original: cleanup };

    try {
      observeOriginal(
        cleanup,
        () => {
          final.rejectionCleanup = { kind: "fulfilled", value: undefined, original: cleanup };
          this.updateFrameworkPayloadCleanup();
          this.finishIfSettled();
        },
        (failure) => {
          final.rejectionCleanup = {
            kind: "rejected",
            reason: { value: failure },
            original: cleanup,
          };
          this.failUnacknowledged(failure, true);
          this.updateFrameworkPayloadCleanup();
          this.finishIfSettled();
        },
        (failure) => {
          final.rejectionCleanup = {
            kind: "unacknowledged",
            reason: { value: failure },
            original: cleanup,
          };
          this.failUnacknowledged(failure, true);
          this.updateFrameworkPayloadCleanup();
          this.finishIfSettled();
        },
      );
    } catch (failure) {
      final.rejectionCleanup = {
        kind: "unacknowledged",
        reason: { value: failure },
        original: cleanup,
      };
      this.failUnacknowledged(failure, true);
      this.updateFrameworkPayloadCleanup();
      this.finishIfSettled();

      throw failure;
    }

    return cleanup;
  }

  private recordFrameworkFetchOutcome(outcome: NativeFrameworkFetchResult): void {
    const final = this.requireFrameworkFetch();

    if (final.outcomeReadyRecorded) {
      const current = final.original;
      const matches =
        outcome.kind === "fulfilled"
          ? current.kind === "fulfilled" && Object.is(current.value, final.fetchResponse)
          : current.kind === "rejected" && Object.is(current.reason.value, outcome.reason.value);

      if (!matches)
        this.failUnacknowledged(new TypeError("The framework fetch outcome changed"), true);

      return;
    }

    final.outcomeReadyRecorded = true;

    if (outcome.kind === "fulfilled") {
      final.fetchResponse = outcome.response;
      final.resolveOutcomeReady({ kind: "fulfilled" });
    } else final.resolveOutcomeReady(outcome);
  }

  private requireFrameworkFetch(): NativeFrameworkFetchRecord {
    if (!this.frameworkFetch)
      throw new TypeError("This native request use has no native framework final-fetch owner");

    return this.frameworkFetch;
  }

  private observeRequestAbort(final: NativeFrameworkFetchRecord): void {
    if (
      !nativeRequestSignalGetter ||
      !nativeAbortSignalAbortedGetter ||
      !nativeAbortSignalReasonGetter ||
      !nativeAddEventListener ||
      !nativeRemoveEventListener
    )
      throw new TypeError("The native Request abort observation operations are unavailable");

    const signal = nativeReflectApply(nativeRequestSignalGetter, this.request, []) as AbortSignal;
    const listener: EventListener = () => this.handleRequestAbort(final, signal);

    final.requestSignal = signal;
    final.requestAbortListener = listener;

    nativeReflectApply(nativeAddEventListener, signal, ["abort", listener, false]);

    if (nativeReflectApply(nativeAbortSignalAbortedGetter, signal, []) as boolean)
      this.handleRequestAbort(final, signal);
  }

  private handleRequestAbort(final: NativeFrameworkFetchRecord, signal: AbortSignal): void {
    if (final.requestAbort) return;

    let reason: unknown;

    try {
      if (!nativeAbortSignalReasonGetter)
        throw new TypeError("The native AbortSignal reason operation is unavailable");

      reason = nativeReflectApply(nativeAbortSignalReasonGetter, signal, []);
    } catch (failure) {
      reason = failure;
      this.failUnacknowledged(failure, true);
    }

    final.requestAbort = { value: reason };

    try {
      void this.cancelOpenBodyRecords(reason);
    } catch (failure) {
      this.failUnacknowledged(failure, true);
    }

    this.updateFrameworkPayloadCleanup();
    this.finishIfSettled();
  }

  private recordFrameworkFetchSetupFailure(
    final: NativeFrameworkFetchRecord,
    reason: unknown,
  ): void {
    final.payloadCleanupFailure ??= { reason };
    this.failUnacknowledged(reason, true);
    this.updateFrameworkPayloadCleanup();
    this.finishIfSettled();
  }

  private recordFrameworkFetchUnacknowledged(
    final: NativeFrameworkFetchRecord,
    reason: unknown,
    original?: Promise<Response>,
  ): void {
    final.payloadCleanupFailure ??= { reason };
    if (original) final.originalFetchObserved = true;

    if (final.original.kind === "missing" || final.original.kind === "pending")
      final.original = { kind: "unacknowledged", reason: { value: reason }, original };

    if (!final.outcomeReadyRecorded) {
      final.outcomeReadyRecorded = true;
      final.resolveOutcomeReady({ kind: "unacknowledged", reason: { value: reason } });
    }

    this.failUnacknowledged(reason, true);
    this.updateFrameworkPayloadCleanup();
    this.finishIfSettled();
  }

  private removeRequestAbortListener(final: NativeFrameworkFetchRecord): void {
    const signal = final.requestSignal;
    const listener = final.requestAbortListener;

    if (signal && listener) {
      if (!nativeRemoveEventListener)
        throw new TypeError("The native AbortSignal listener removal operation is unavailable");

      nativeReflectApply(nativeRemoveEventListener, signal, ["abort", listener, false]);
    }

    final.requestSignal = undefined;
    final.requestAbortListener = undefined;
  }

  private cancelFinalResponseAfterFailure(response: Response, reason: unknown): void {
    const final = this.frameworkFetch;
    let finalBody: ResponseBodyRecord | undefined;

    if (final) final.bodyCleanupRequested ??= { value: reason };

    if (final?.kind === "node") {
      if (!final.nativeFinalResponse) return;

      response = final.nativeFinalResponse;
    }

    try {
      const enrollment = this.enrollFinalResponse(response);

      finalBody = enrollment.record;
      finalBody.frameworkPayload = true;
      if (final) final.finalBody = finalBody;

      if (finalBody.nativeBody !== null && finalBody.forwardingState === "unstarted")
        this.ensureNativeBodyForwarder(finalBody);
    } catch (failure) {
      this.failUnacknowledged(failure, true);
    }

    try {
      void this.cancelOpenBodyRecords(reason, final?.transportEnded ?? false);
    } catch (failure) {
      this.failUnacknowledged(failure, true);
    }
  }

  private settleOriginalProjectionAbsent(): void {
    const final = this.frameworkFetch;

    if (!final || final.originalProjection.kind !== "missing") return;

    final.originalProjection = { kind: "fulfilled", value: undefined };
    final.originalProjectionSettled = true;
  }

  private failOriginalProjectionObservation(reason: unknown): void {
    const final = this.frameworkFetch;

    if (!final || final.originalProjection.kind !== "missing") return;

    final.originalProjection = { kind: "unacknowledged", reason: { value: reason } };
    final.originalProjectionSettled = true;
  }

  private projectOriginalResponse(original: Response): Promise<Response> {
    const final = this.requireFrameworkFetch();

    if (final.originalProjection.kind !== "missing" || final.originalProjectionSettled) {
      const error = new TypeError("The original Host response was projected more than once");

      this.failUnacknowledged(error, true);

      return nativeReflectApply(nativePromiseReject, NativePromise, [error]) as Promise<Response>;
    }

    if (this.response.kind !== "fulfilled" || this.response.value !== original) {
      const error = new TypeError("The projected response is not the exact observed Host response");

      this.failUnacknowledged(error, true);

      return nativeReflectApply(nativePromiseReject, NativePromise, [error]) as Promise<Response>;
    }

    const body = this.responseBodies.get(original);

    if (!body || body.owner !== this.bodyOwnerIdentity) {
      const error = new TypeError(
        "The original Host response has no body record from this request use",
      );

      this.failUnacknowledged(error, true);

      return nativeReflectApply(nativePromiseReject, NativePromise, [error]) as Promise<Response>;
    }

    body.frameworkPayload = true;
    final.originalBody = body;

    const projection = this.createOriginalEnvelope(original, body);

    final.originalProjection = { kind: "pending", original: projection };

    try {
      observeOriginal(
        projection,
        (response) => {
          final.originalProjection = { kind: "fulfilled", value: response, original: projection };
          final.originalProjectionSettled = true;
          this.updateFrameworkPayloadCleanup();
          this.finishIfSettled();
        },
        (reason) => {
          final.originalProjection = {
            kind: "rejected",
            reason: { value: reason },
            original: projection,
          };
          final.originalProjectionSettled = true;
          this.failUnacknowledged(reason, true);
          this.updateFrameworkPayloadCleanup();
          this.finishIfSettled();
        },
        (reason) => {
          final.originalProjection = {
            kind: "unacknowledged",
            reason: { value: reason },
            original: projection,
          };
          final.originalProjectionSettled = true;
          this.failUnacknowledged(reason, true);
          this.updateFrameworkPayloadCleanup();
          this.finishIfSettled();
        },
      );
    } catch (reason) {
      final.originalProjection = {
        kind: "unacknowledged",
        reason: { value: reason },
        original: projection,
      };
      final.originalProjectionSettled = true;
      this.failUnacknowledged(reason, true);
      this.updateFrameworkPayloadCleanup();
      this.finishIfSettled();

      throw reason;
    }

    return projection;
  }

  private async createOriginalEnvelope(
    original: Response,
    body: ResponseBodyRecord,
  ): Promise<Response> {
    if (body.nativeBody === null)
      return this.frameworkFetch?.kind === "node"
        ? this.createBodylessMetadataResponse(this.nativeResponseMetadata(original))
        : original;

    let metadata: ResponseInit;

    try {
      metadata = this.nativeResponseMetadata(original);
    } catch (reason) {
      await this.cancelAfterProjectionFailure(body, reason);
      throw reason;
    }

    if (this.frameworkFetch?.requestAbort) {
      try {
        await this.cancelFinalBoundaryOnFailure(body, this.frameworkFetch.requestAbort.value);
      } catch (reason) {
        this.failUnacknowledged(reason, true);
      }

      return original;
    }

    if (this.frameworkFetch?.requestAbortObservationFailure) {
      try {
        await this.cancelFinalBoundaryOnFailure(
          body,
          this.frameworkFetch.requestAbortObservationFailure.reason,
        );
      } catch (reason) {
        this.failUnacknowledged(reason, true);
      }

      return original;
    }

    if (this.frameworkFetch?.rejectionReason) {
      await this.cancelBodyRecord(body, this.frameworkFetch.rejectionReason.value);

      return original;
    }

    if (this.frameworkFetch?.original.kind === "rejected") {
      await this.cancelBodyRecord(body, this.frameworkFetch.original.reason.value);

      return original;
    }

    if (this.frameworkFetch?.original.kind === "unacknowledged") {
      try {
        await this.cancelFinalBoundaryOnFailure(body, this.frameworkFetch.original.reason.value);
      } catch (reason) {
        this.failUnacknowledged(reason, true);
      }

      return original;
    }

    if (this.frameworkFetch?.transportEnded) {
      try {
        await this.cancelBodyRecord(body, undefined);
      } catch (reason) {
        this.failUnacknowledged(reason, true);
      }

      return original;
    }

    try {
      const method = this.nativeRequestMethod();

      if (method === "HEAD") {
        try {
          this.ensureNativeBodyForwarder(body);
          await this.cancelBodyRecord(body, undefined);
        } catch (reason) {
          this.failUnacknowledged(reason, true);
        }

        return this.createBodylessMetadataResponse(metadata);
      }

      const forwarder = this.ensureNativeBodyForwarder(body);

      return this.createResponseOverForwarder(body, forwarder, metadata);
    } catch (reason) {
      await this.cancelAfterProjectionFailure(body, reason);
      throw reason;
    }
  }

  private async cancelAfterProjectionFailure(
    body: ResponseBodyRecord,
    primary: unknown,
  ): Promise<void> {
    this.failUnacknowledged(primary, true);

    try {
      await this.cancelBodyRecord(body, primary);
    } catch (cleanup) {
      this.failUnacknowledged(cleanup, true);
      throw this.combinePrimaryAndBodyCleanupFailure(
        primary,
        cleanup,
        "Native response projection and body cleanup failed",
      );
    }
  }

  private async projectFinalResponse(finalResponse: Response): Promise<Response> {
    let metadata: ResponseInit;
    let body: ResponseBodyRecord;
    let stream: ReadableStream<Uint8Array> | null;

    try {
      const enrollment = this.enrollFinalResponse(finalResponse);

      body = enrollment.record;
      stream = enrollment.stream;
      body.frameworkPayload = true;
      if (this.frameworkFetch) this.frameworkFetch.finalBody = body;
      metadata = this.nativeResponseMetadata(finalResponse);
    } catch (reason) {
      this.failUnacknowledged(reason, true);

      try {
        await this.cancelOpenBodyRecords(reason);
      } catch (cleanup) {
        this.failUnacknowledged(cleanup, true);
        throw this.combinePrimaryAndBodyCleanupFailure(
          reason,
          cleanup,
          "Final response metadata and body cleanup failed",
        );
      }

      throw reason;
    }

    if (this.frameworkFetch?.requestAbort) {
      try {
        await this.cancelFinalBoundaryOnFailure(body, this.frameworkFetch.requestAbort.value);
      } catch (reason) {
        this.failUnacknowledged(reason, true);
      }

      return finalResponse;
    }

    if (metadata.status === 0) {
      if (stream !== null) {
        try {
          this.ensureNativeBodyForwarder(body);
        } catch (reason) {
          this.failUnacknowledged(reason, true);
        }
      }

      try {
        await this.cancelOpenBodyRecords(undefined);
      } catch {
        // The exact unsendable Response remains the native framework invocation's result; retirement keeps cleanup failures.
      }

      return finalResponse;
    }

    let isHead: boolean;

    try {
      isHead = this.nativeRequestMethod() === "HEAD";
    } catch (reason) {
      this.failUnacknowledged(reason, true);

      try {
        await this.cancelOpenBodyRecords(reason);
      } catch (cleanup) {
        this.failUnacknowledged(cleanup, true);
        throw this.combinePrimaryAndBodyCleanupFailure(
          reason,
          cleanup,
          "Final response method lookup and body cleanup failed",
        );
      }

      return finalResponse;
    }

    if (isHead) {
      if (stream !== null) {
        try {
          this.ensureNativeBodyForwarder(body);
        } catch (reason) {
          this.failUnacknowledged(reason, true);
        }
      }

      try {
        await this.cancelOpenBodyRecords(undefined);
      } catch {
        // The bodyless response still carries the final status and headers; cleanup remains on the use.
      }

      if (stream === null) return finalResponse;

      try {
        return this.createBodylessMetadataResponse(metadata);
      } catch (reason) {
        this.failUnacknowledged(reason, true);

        try {
          await this.cancelFinalBoundaryOnFailure(body, reason);
        } catch (cleanup) {
          this.failUnacknowledged(cleanup, true);
          throw this.combinePrimaryAndBodyCleanupFailure(
            reason,
            cleanup,
            "HEAD response projection and body cleanup failed",
          );
        }

        throw reason;
      }
    }

    if (stream === null) {
      try {
        await this.cancelOpenBodyRecords(undefined);
      } catch {
        // The final bodyless Response remains observable while its original body cleanup stays joined.
      }

      return finalResponse;
    }

    if (this.frameworkFetch?.transportEnded) {
      this.terminalizeNativeForwarder(body, undefined);

      try {
        await this.cancelBodyRecord(body, undefined);
      } catch (reason) {
        this.failUnacknowledged(reason, true);
      }

      return finalResponse;
    }

    if (body.forwardingStream === stream) {
      this.responseBodies.set(finalResponse, body);

      return finalResponse;
    }

    if (body.nativeBody === stream && body.forwardingStream && body.forwardingState === "open") {
      this.responseBodies.set(finalResponse, body);

      try {
        return this.createResponseOverForwarder(body, body.forwardingStream, metadata);
      } catch (reason) {
        this.failUnacknowledged(reason, true);

        try {
          await this.cancelFinalBoundaryOnFailure(body, reason);
        } catch (cleanup) {
          this.failUnacknowledged(cleanup, true);
          throw this.combinePrimaryAndBodyCleanupFailure(
            reason,
            cleanup,
            "Final response projection and body cleanup failed",
          );
        }

        throw reason;
      }
    }

    try {
      const forwarder = this.ensureNativeBodyForwarder(body);

      return this.createResponseOverForwarder(body, forwarder, metadata);
    } catch (reason) {
      this.failUnacknowledged(reason, true);

      if (body.forwardingReader) {
        try {
          await this.cancelFinalBoundaryOnFailure(body, reason);
        } catch (cleanup) {
          this.failUnacknowledged(cleanup, true);
          throw this.combinePrimaryAndBodyCleanupFailure(
            reason,
            cleanup,
            "Final response projection and body cleanup failed",
          );
        }

        throw reason;
      }

      try {
        await this.cancelFinalBoundaryOnFailure(body, reason);
      } catch (cleanup) {
        this.failUnacknowledged(cleanup, true);
      }

      return finalResponse;
    }
  }

  private enrollFinalResponse(response: Response): FinalResponseBodyV1 {
    const existing = this.responseBodies.get(response);

    if (!existing) this.assertOpen();

    const record = existing ?? this.newBodyRecord("native");
    record.frameworkPayload = true;
    let nativeBody: ReadableStream<Uint8Array> | null;

    try {
      if (!nativeResponseBodyGetter)
        throw new TypeError("The native Response body operation is unavailable");

      nativeBody = nativeReflectApply(
        nativeResponseBodyGetter,
        response,
        [],
      ) as ReadableStream<Uint8Array> | null;

      const owner = nativeBody === null ? undefined : nativeBodyOwners.get(nativeBody);

      if (owner && owner.owner !== this.bodyOwnerIdentity)
        throw new TypeError("The final response body already belongs to another request use");

      if (existing && nativeBody !== null && owner !== existing)
        throw new TypeError(
          "The final response body's stream differs from its retained body record",
        );

      if (existing) return { record: existing, stream: nativeBody };

      if (owner) {
        this.bodies.delete(record);
        this.responseBodies.set(response, owner);

        return { record: owner, stream: nativeBody };
      }

      this.associateResponseBody(record, response, nativeBody);
    } catch (reason) {
      this.failConstruction(record, reason);
      this.finishIfSettled();

      throw reason;
    }

    return { record, stream: nativeBody };
  }

  private createResponseOverForwarder(
    body: ResponseBodyRecord,
    forwarder: ReadableStream<Uint8Array>,
    metadata: ResponseInit,
  ): Response {
    const response = new NativeResponse(forwarder, metadata);

    this.responseBodies.set(response, body);

    return response;
  }

  private createBodylessMetadataResponse(metadata: ResponseInit): Response {
    const record = this.newBodyRecord("bodyless");
    record.frameworkPayload = true;

    return this.constructResponse(record, null, metadata);
  }

  private nativeResponseMetadata(response: Response): ResponseInit {
    if (
      !nativeResponseStatusGetter ||
      !nativeResponseStatusTextGetter ||
      !nativeResponseHeadersGetter
    )
      throw new TypeError("The native Response metadata operations are unavailable");

    const status = nativeReflectApply(nativeResponseStatusGetter, response, []) as number;
    const statusText = nativeReflectApply(nativeResponseStatusTextGetter, response, []) as string;
    const source = nativeReflectApply(nativeResponseHeadersGetter, response, []) as Headers;

    if (typeof nativeHeadersGetSetCookie !== "function")
      throw new TypeError("The native Headers getSetCookie operation is unavailable");

    const headers = new NativeHeaders();

    nativeReflectApply(nativeHeadersForEach, source, [
      (value: string, name: string): void => {
        if (name !== "set-cookie") nativeReflectApply(nativeHeadersAppend, headers, [name, value]);
      },
    ]);

    const setCookies = nativeReflectApply(nativeHeadersGetSetCookie, source, []) as string[];

    for (let index = 0; index < setCookies.length; index++)
      nativeReflectApply(nativeHeadersAppend, headers, ["set-cookie", setCookies[index]]);

    return { status, statusText, headers };
  }

  private nativeRequestMethod(): string {
    if (!nativeRequestMethodGetter)
      throw new TypeError("The native Request method getter is unavailable");

    return nativeReflectApply(nativeRequestMethodGetter, this.request, []) as string;
  }

  private ensureNativeBodyForwarder(body: ResponseBodyRecord): ReadableStream<Uint8Array> {
    if (body.forwardingState === "open" && body.forwardingStream) return body.forwardingStream;

    if (body.forwardingState !== "unstarted")
      throw new TypeError("The native body no longer has an unused forwarding consumer");

    const source = body.nativeBody;

    if (!source) throw new TypeError("A bodyless native response has no forwarding stream");

    if (!nativeReadableStreamGetReader)
      throw new TypeError("The native ReadableStream reader operation is unavailable");

    body.forwardingState = "opening";

    try {
      body.forwardingReader = nativeReflectApply(
        nativeReadableStreamGetReader,
        source,
        [],
      ) as ReadableStreamDefaultReader<Uint8Array>;
    } catch (reason) {
      body.readerAcquisitionFailed = true;
      body.readerAcquisitionFailure = { reason };
      body.forwardingState = "unacknowledged";
      this.failUnacknowledged(reason, true);

      throw reason;
    }

    try {
      const forwarder = new nativeReadableStream<Uint8Array>(
        {
          start: (controller) => {
            body.forwardingController = controller;
          },
          pull: (controller) => this.pullNativeBody(body, controller),
          cancel: (reason) => this.cancelNativeBodyForwarder(body, reason),
        },
        { highWaterMark: 0 },
      );
      const owner = nativeBodyOwners.get(forwarder);

      if (owner && owner !== body)
        throw new TypeError(
          "The native forwarding stream already belongs to another response body",
        );

      nativeBodyOwners.set(forwarder, body);
      body.forwardingStream = forwarder;
      body.forwardingState = "open";

      if (this.frameworkFetch?.transportEnded) {
        this.terminalizeNativeForwarder(body, undefined);
        void this.cancelBodyRecord(body, undefined);
      }

      return forwarder;
    } catch (reason) {
      body.forwardingState = "unacknowledged";
      this.failUnacknowledged(reason, true);

      throw reason;
    }
  }

  private pullNativeBody(
    body: ResponseBodyRecord,
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): Promise<void> {
    if (body.forwardingState !== "open")
      return nativeReflectApply(nativePromiseResolve, NativePromise, [undefined]) as Promise<void>;

    const reader = body.forwardingReader;

    if (!reader || !nativeReaderRead) {
      const error = new TypeError("The native response body reader is unavailable");

      body.forwardingState = "unacknowledged";
      this.failUnacknowledged(error, true);
      this.errorNativeForwarder(body, controller, error);
      try {
        void this.cancelFinalBoundaryOnFailure(body, error);
      } catch (failure) {
        this.failUnacknowledged(failure, true);
      }

      return nativeReflectApply(nativePromiseReject, NativePromise, [error]) as Promise<void>;
    }

    const pull: NativeBodyPullRecord = {
      original: { kind: "admitting" },
      callback: { kind: "admitting" },
    };

    body.forwardingPulls.push(pull);
    let original: Promise<ReadableStreamReadResult<Uint8Array>>;

    try {
      original = nativeReflectApply(nativeReaderRead, reader, []) as Promise<
        ReadableStreamReadResult<Uint8Array>
      >;
      pull.original = { kind: "pending", original };
    } catch (reason) {
      pull.original = { kind: "unacknowledged", reason: { value: reason } };
      pull.callback = { kind: "unacknowledged", reason: { value: reason } };
      body.forwardingState = "failed";
      this.failUnacknowledged(reason, true);
      this.errorNativeForwarder(body, controller, reason);
      try {
        void this.cancelFinalBoundaryOnFailure(body, reason);
      } catch (failure) {
        this.failUnacknowledged(failure, true);
      }
      this.removeNativeBodyPull(body, pull);
      this.releaseNativeBodyReader(body);

      return nativeReflectApply(nativePromiseReject, NativePromise, [reason]) as Promise<void>;
    }

    const callbackPromise = new NativePromise<void>((resolve, reject) => {
      try {
        observeOriginal(
          original,
          (result) => {
            pull.original = { kind: "fulfilled" };

            if (body.forwardingState !== "open") {
              resolve();

              return;
            }

            try {
              if (result.done) {
                nativeReflectApply(nativeControllerClose!, controller, []);
                body.forwardingState = "closed";
                if (pull.callbackPromise)
                  this.retainCompletedBodyOperation(body, pull.callbackPromise);
                this.settleFinalBoundaryOnEof(body);
              } else nativeReflectApply(nativeControllerEnqueue!, controller, [result.value]);

              resolve();
            } catch (reason) {
              body.forwardingState = "failed";
              this.failUnacknowledged(reason, true);
              this.errorNativeForwarder(body, controller, reason);

              try {
                void this.cancelFinalBoundaryOnFailure(body, reason);
              } catch (failure) {
                this.failUnacknowledged(failure, true);
              }

              reject(reason);
            }
          },
          (reason) => {
            pull.original = { kind: "rejected", reason: { value: reason }, original };
            body.forwardingState = "failed";
            this.failUnacknowledged(reason, true);
            this.errorNativeForwarder(body, controller, reason);
            try {
              void this.cancelFinalBoundaryOnFailure(body, reason);
            } catch (failure) {
              this.failUnacknowledged(failure, true);
            }
            reject(reason);
          },
          (reason) => {
            pull.original = { kind: "unacknowledged", reason: { value: reason }, original };
            body.forwardingState = "unacknowledged";
            this.failUnacknowledged(reason, true);
            this.errorNativeForwarder(body, controller, reason);
            try {
              void this.cancelFinalBoundaryOnFailure(body, reason);
            } catch (failure) {
              this.failUnacknowledged(failure, true);
            }
            reject(reason);
          },
        );
      } catch (reason) {
        pull.original = { kind: "unacknowledged", reason: { value: reason }, original };
        body.forwardingState = "unacknowledged";
        this.failUnacknowledged(reason, true);
        reject(reason);
      }
    });

    pull.callbackPromise = callbackPromise;
    pull.callback = { kind: "pending", original: callbackPromise };

    try {
      observeOriginal(
        callbackPromise,
        () => {
          pull.callback = { kind: "fulfilled", value: undefined, original: callbackPromise };
          this.releaseNativeBodyReader(body);
          this.removeNativeBodyPull(body, pull);
          this.updateFrameworkPayloadCleanup();
          this.finishIfSettled();
        },
        (reason) => {
          pull.callback = {
            kind: "rejected",
            reason: { value: reason },
            original: callbackPromise,
          };
          this.failUnacknowledged(reason, true);
          try {
            void this.cancelFinalBoundaryOnFailure(body, reason);
          } catch (failure) {
            this.failUnacknowledged(failure, true);
          }
          this.releaseNativeBodyReader(body);
          this.removeNativeBodyPull(body, pull);
          this.updateFrameworkPayloadCleanup();
          this.finishIfSettled();
        },
        (reason) => {
          pull.callback = {
            kind: "unacknowledged",
            reason: { value: reason },
            original: callbackPromise,
          };
          this.failUnacknowledged(reason, true);
          try {
            void this.cancelFinalBoundaryOnFailure(body, reason);
          } catch (failure) {
            this.failUnacknowledged(failure, true);
          }
          this.removeNativeBodyPull(body, pull);
          this.updateFrameworkPayloadCleanup();
          this.finishIfSettled();
        },
      );
    } catch (reason) {
      pull.callback = {
        kind: "unacknowledged",
        reason: { value: reason },
        original: callbackPromise,
      };
      this.failUnacknowledged(reason, true);
      try {
        void this.cancelFinalBoundaryOnFailure(body, reason);
      } catch (failure) {
        this.failUnacknowledged(failure, true);
      }
      this.removeNativeBodyPull(body, pull);
      this.finishIfSettled();
    }

    return callbackPromise;
  }

  private removeNativeBodyPull(body: ResponseBodyRecord, pull: NativeBodyPullRecord): void {
    if (pull.original.kind === "unacknowledged" || pull.callback.kind === "unacknowledged") return;

    const index = body.forwardingPulls.indexOf(pull);

    if (index !== -1) body.forwardingPulls.splice(index, 1);
  }

  private retainCompletedBodyOperation(
    body: ResponseBodyRecord,
    completedPull: Promise<void>,
  ): void {
    const completion = nativeReflectApply(nativePromiseThen, completedPull, [
      () => {
        if (body.forwardingRelease.kind === "unacknowledged")
          throw body.forwardingRelease.reason.value;
      },
    ]) as Promise<void>;

    body.completedBodyOperation = completion;

    try {
      observeOriginal(
        completion,
        () => undefined,
        (reason) => this.failUnacknowledged(reason, true),
        (reason) => this.failUnacknowledged(reason, true),
      );
    } catch (reason) {
      this.failUnacknowledged(reason, true);
    }
  }

  private settleFinalBoundaryOnEof(body: ResponseBodyRecord): void {
    const final = this.frameworkFetch;
    const original = final?.originalBody;

    if (!final || final.finalBody !== body) return;

    final.bodyCleanupRequested ??= { value: undefined };

    if (!original || original === body) return;

    try {
      void this.cancelBodyRecords([original], undefined, final.transportEnded, true);
    } catch (reason) {
      this.failUnacknowledged(reason, true);
    }
  }

  private cancelFinalBoundaryOnFailure(body: ResponseBodyRecord, reason: unknown): Promise<void> {
    const final = this.frameworkFetch;

    if (!final || final.finalBody !== body) return this.cancelBodyRecord(body, reason);

    final.bodyCleanupRequested ??= { value: reason };
    const records =
      final.originalBody && final.originalBody !== body ? [body, final.originalBody] : [body];

    return this.cancelBodyRecords(records, reason, final.transportEnded, true);
  }

  private cancelNativeBodyForwarder(body: ResponseBodyRecord, reason: unknown): Promise<void> {
    return this.cancelFinalBoundaryOnFailure(body, reason);
  }

  private errorNativeForwarder(
    body: ResponseBodyRecord,
    controller: ReadableStreamDefaultController<Uint8Array>,
    reason: unknown,
  ): void {
    if (!nativeControllerError) {
      this.failUnacknowledged(
        new TypeError("The native stream error operation is unavailable"),
        true,
      );

      return;
    }

    try {
      nativeReflectApply(nativeControllerError, controller, [reason]);
    } catch (failure) {
      this.failUnacknowledged(failure, true);
    }

    if (body.forwardingState === "open") body.forwardingState = "failed";
  }

  private terminalizeNativeForwarder(body: ResponseBodyRecord, reason: unknown): void {
    const controller = body.forwardingController;

    if (!controller || body.forwardingState !== "open") return;

    this.errorNativeForwarder(body, controller, reason);
  }

  private releaseNativeBodyReader(body: ResponseBodyRecord): void {
    const reader = body.forwardingReader;

    if (!reader || body.forwardingRelease.kind !== "missing") return;

    if (
      body.forwardingPulls.some(
        (pull) =>
          pull.original.kind === "admitting" ||
          pull.original.kind === "pending" ||
          pull.callback.kind === "admitting" ||
          pull.callback.kind === "pending",
      )
    )
      return;

    if (
      body.forwardingCancellation?.observation.kind === "admitting" ||
      body.forwardingCancellation?.observation.kind === "pending"
    )
      return;

    if (
      body.forwardingState !== "closed" &&
      body.forwardingState !== "cancelled" &&
      body.forwardingState !== "failed" &&
      body.forwardingState !== "unacknowledged"
    )
      return;

    body.forwardingRelease = { kind: "admitting" };

    try {
      if (!nativeReaderReleaseLock)
        throw new TypeError("The native reader release operation is unavailable");

      nativeReflectApply(nativeReaderReleaseLock, reader, []);
      body.forwardingRelease = { kind: "fulfilled", value: undefined };
    } catch (reason) {
      body.forwardingRelease = { kind: "unacknowledged", reason: { value: reason } };
      this.failUnacknowledged(reason, true);
    }

    this.updateFrameworkPayloadCleanup();
    this.finishIfSettled();
  }

  private cancelBodyRecord(body: ResponseBodyRecord, reason: unknown): Promise<void> {
    if (body.payloadReleased) return this.completedBodyOperation(body);

    const existing = body.forwardingCancellation;

    if (existing) return this.cancellationOperation(existing);

    if (body.forwardingState === "closed" || body.forwardingState === "cancelled")
      return this.completedBodyOperation(body);

    if (body.nativeBody === null && body.forwardingState === "unstarted")
      return this.completedBodyOperation(body);

    if (body.readerAcquisitionFailed && !this.frameworkFetch?.transportEnded)
      throw body.readerAcquisitionFailure?.reason;

    const cancellation = this.reserveBodyCancellation(body);

    if (!cancellation) return this.completedBodyOperation(body);

    return this.startBodyCancellation(
      body,
      cancellation,
      reason,
      this.frameworkFetch?.transportEnded ?? false,
    );
  }

  private reserveBodyCancellation(body: ResponseBodyRecord): CancellationRecord | undefined {
    if (body.forwardingCancellation) return body.forwardingCancellation;

    if (
      body.forwardingState === "closed" ||
      body.forwardingState === "cancelled" ||
      (body.nativeBody === null && body.forwardingState === "unstarted")
    )
      return undefined;

    let resolveAdmission!: () => void;
    let rejectAdmission!: (reason: unknown) => void;
    const admission = new NativePromise<void>((resolve, reject) => {
      resolveAdmission = resolve;
      rejectAdmission = reject;
    });
    nativeReflectApply(nativePromiseThen, admission, [undefined, () => undefined]);

    const cancellation: CancellationRecord = {
      observation: { kind: "admitting" },
      started: false,
      admission,
      resolveAdmission,
      rejectAdmission,
    };

    body.cancellations.push(cancellation);
    body.forwardingCancellation = cancellation;

    return cancellation;
  }

  private startBodyCancellation(
    body: ResponseBodyRecord,
    cancellation: CancellationRecord,
    reason: unknown,
    transportEnded: boolean,
  ): Promise<void> {
    if (cancellation.started || cancellation.observation.kind !== "admitting")
      return this.cancellationOperation(cancellation);

    cancellation.started = true;
    this.terminalizeNativeForwarder(body, reason);

    if (
      !body.forwardingReader &&
      body.nativeBody &&
      transportEnded &&
      !body.transportReaderRetryUsed
    ) {
      body.transportReaderRetryUsed = true;

      try {
        if (!nativeReadableStreamGetReader)
          throw new TypeError("The native body reader could not be retried after transport close");

        body.forwardingReader = nativeReflectApply(
          nativeReadableStreamGetReader,
          body.nativeBody,
          [],
        ) as ReadableStreamDefaultReader<Uint8Array>;
        body.readerAcquisitionFailed = false;
        body.readerAcquisitionFailure = undefined;
      } catch (failure) {
        body.readerAcquisitionFailed = true;
        body.readerAcquisitionFailure = { reason: failure };
        body.transportReaderRetryFailure = { reason: failure };
        body.forwardingState = "unacknowledged";
        cancellation.observation = { kind: "unacknowledged", reason: { value: failure } };
        cancellation.rejectAdmission(failure);
        this.failUnacknowledged(failure, true);
        this.settleResponseProductionBodyCancellation(body, { reason: failure });
        this.updateFrameworkPayloadCleanup();
        this.finishIfSettled();

        throw failure;
      }
    }

    let original: Promise<void>;

    try {
      if (body.forwardingReader) {
        if (!nativeReaderCancel)
          throw new TypeError("The native reader cancellation operation is unavailable");

        body.forwardingState = "cancelled";
        original = nativeReflectApply(nativeReaderCancel, body.forwardingReader, [
          reason,
        ]) as Promise<void>;
      } else {
        const stream = body.nativeBody;

        if (!stream || !nativeReadableStreamCancel)
          throw new TypeError("The native response cancellation operation is unavailable");

        original = nativeReflectApply(nativeReadableStreamCancel, stream, [
          reason,
        ]) as Promise<void>;
      }

      body.completedBodyOperation = original;
      cancellation.observation = { kind: "pending", original };
    } catch (failure) {
      cancellation.observation = { kind: "unacknowledged", reason: { value: failure } };
      cancellation.rejectAdmission(failure);
      body.forwardingState = "unacknowledged";
      this.failUnacknowledged(failure, true);
      this.settleResponseProductionBodyCancellation(body, { reason: failure });
      this.releaseNativeBodyReader(body);
      this.updateFrameworkPayloadCleanup();
      this.finishIfSettled();

      throw failure;
    }

    try {
      observeOriginal(
        original,
        () => {
          cancellation.observation = { kind: "fulfilled", value: undefined, original };
          cancellation.resolveAdmission();
          body.forwardingState = "cancelled";
          this.releaseNativeBodyReader(body);
          this.settleResponseProductionBodyCancellation(body);
          this.updateFrameworkPayloadCleanup();
          this.finishIfSettled();
        },
        (failure) => {
          cancellation.observation = { kind: "rejected", reason: { value: failure }, original };
          cancellation.rejectAdmission(failure);
          body.forwardingState = "unacknowledged";
          this.failUnacknowledged(failure, true);
          this.settleResponseProductionBodyCancellation(body, { reason: failure });
          this.releaseNativeBodyReader(body);
          this.updateFrameworkPayloadCleanup();
          this.finishIfSettled();
        },
        (failure) => {
          cancellation.observation = {
            kind: "unacknowledged",
            reason: { value: failure },
            original,
          };
          cancellation.rejectAdmission(failure);
          body.forwardingState = "unacknowledged";
          this.failUnacknowledged(failure, true);
          this.settleResponseProductionBodyCancellation(body, { reason: failure });
          this.releaseNativeBodyReader(body);
          this.updateFrameworkPayloadCleanup();
          this.finishIfSettled();
        },
      );
    } catch (failure) {
      cancellation.observation = { kind: "unacknowledged", reason: { value: failure }, original };
      cancellation.rejectAdmission(failure);
      body.forwardingState = "unacknowledged";
      this.failUnacknowledged(failure, true);
      this.settleResponseProductionBodyCancellation(body, { reason: failure });
      this.releaseNativeBodyReader(body);
      this.updateFrameworkPayloadCleanup();
      this.finishIfSettled();

      throw failure;
    }

    return original;
  }

  /**
   * Return the actual operation, or its reservation before a native call starts.
   * @throws {TypeError} During native invocation, when returning the reservation could create a cycle.
   */
  private cancellationOperation(cancellation: CancellationRecord): Promise<void> {
    const observation = cancellation.observation;

    if (observation.kind === "admitting" && cancellation.started) {
      const error = new TypeError(
        "Native body cancellation reentered before its original promise was available",
      );

      this.failUnacknowledged(error, true);

      throw error;
    }

    if (observation.kind === "admitting") return cancellation.admission;
    if (observation.kind === "pending") return observation.original;

    return observation.original ?? cancellation.admission;
  }

  private completedBodyOperation(body: ResponseBodyRecord): Promise<void> {
    if (!body.completedBodyOperation)
      throw new TypeError("The completed response body has no retained cleanup operation");

    return body.completedBodyOperation;
  }

  private combinePrimaryAndBodyCleanupFailure(
    primary: unknown,
    cleanup: unknown,
    message: string,
  ): unknown {
    const primaryFailures =
      primary instanceof AggregateError
        ? (nativeBodyCleanupFailures.get(primary) ?? [primary])
        : [primary];
    const cleanupFailures =
      cleanup instanceof AggregateError
        ? (nativeBodyCleanupFailures.get(cleanup) ?? [cleanup])
        : [cleanup];
    const failures: unknown[] = [];

    for (const reason of [...primaryFailures, ...cleanupFailures]) {
      if (!failures.some((failure) => Object.is(failure, reason))) failures.push(reason);
    }

    if (failures.length === 1) return failures[0];

    const aggregate = new AggregateError(failures, message);

    nativeBodyCleanupFailures.set(aggregate, failures);

    return aggregate;
  }

  private cancelOpenBodyRecords(reason: unknown, transportEnded = false): Promise<void> {
    if (this.frameworkFetch) this.frameworkFetch.bodyCleanupRequested ??= { value: reason };

    return this.cancelBodyRecords([...this.bodies], reason, transportEnded, true);
  }

  private cancelLateFrameworkBodies(): void {
    const final = this.frameworkFetch;

    if (!final?.bodyCleanupRequested) return;

    try {
      void this.cancelOpenBodyRecords(final.bodyCleanupRequested.value, final.transportEnded);
    } catch (failure) {
      this.failUnacknowledged(failure, true);
    }
  }

  private cancelBodyRecords(
    bodyRecords: readonly ResponseBodyRecord[],
    reason: unknown,
    transportEnded: boolean,
    terminalize: boolean,
  ): Promise<void> {
    const pending: Promise<void>[] = [];
    const failures: unknown[] = [];
    const uniqueBodies = [...new Set(bodyRecords)];
    const reserved: Array<{
      readonly body: ResponseBodyRecord;
      readonly cancellation: CancellationRecord;
    }> = [];
    const reservedProgressive: ResponseBodyRecord[] = [];

    for (const body of uniqueBodies) {
      if (
        body.payloadReleased ||
        body.kind !== "progressive" ||
        !body.progressiveUse ||
        body.progressiveTerminal !== "open"
      )
        continue;

      if (!body.progressiveCancelOperation) this.reserveProgressiveCancellation(body);

      if (
        body.progressiveCancelOperation?.kind === "admitting" ||
        body.progressiveCancelOperation?.kind === "pending"
      )
        reservedProgressive.push(body);
    }

    for (const body of uniqueBodies) {
      if (
        body.payloadReleased ||
        body.nativeBody === null ||
        body.nativeBody === undefined ||
        body.construction === "failed"
      )
        continue;

      const existing = body.forwardingCancellation;

      if (existing) {
        reserved.push({ body, cancellation: existing });
        continue;
      }

      if (body.forwardingState === "closed" || body.forwardingState === "cancelled") continue;
      if (body.readerAcquisitionFailed && !transportEnded) continue;

      const cancellation = this.reserveBodyCancellation(body);

      if (cancellation) reserved.push({ body, cancellation });
    }

    if (terminalize) for (const { body } of reserved) this.terminalizeNativeForwarder(body, reason);

    for (const body of reservedProgressive) {
      const progressive = body.progressive;
      const use = body.progressiveUse;

      if (progressive) {
        try {
          pending.push(
            this.startProgressiveCancellation(
              body,
              () => progressive.cancel(reason),
              progressive.settled,
              reason,
              () => progressive.failure,
            ),
          );
        } catch (failure) {
          failures.push(failure);
        }
      } else if (use) {
        try {
          pending.push(
            this.startProgressiveCancellation(body, () => use.cancel(reason), use.settled, reason),
          );
        } catch (failure) {
          failures.push(failure);
        }
      }
    }

    for (const { body, cancellation } of reserved) {
      try {
        pending.push(this.startBodyCancellation(body, cancellation, reason, transportEnded));
      } catch (failure) {
        failures.push(failure);
      }
    }

    const settled = nativeReflectApply(nativePromiseAllSettled, NativePromise, [
      pending,
    ]) as Promise<PromiseSettledResult<void>[]>;
    const cleanup = nativeReflectApply(nativePromiseThen, settled, [
      (outcomes: PromiseSettledResult<void>[]) => {
        const allFailures = [
          ...failures,
          ...outcomes.flatMap((outcome) => (outcome.status === "rejected" ? [outcome.reason] : [])),
        ];

        if (allFailures.length === 1) throw allFailures[0];
        if (allFailures.length > 1) {
          const aggregate = new AggregateError(
            allFailures,
            "Native response body cancellation failed",
          );

          nativeBodyCleanupFailures.set(aggregate, allFailures);

          throw aggregate;
        }
      },
    ]) as Promise<void>;

    try {
      observeOriginal(
        cleanup,
        () => {
          this.updateFrameworkPayloadCleanup();
          this.finishIfSettled();
        },
        (failure) => {
          this.failUnacknowledged(failure, true);
          this.updateFrameworkPayloadCleanup();
          this.finishIfSettled();
        },
        (failure) => {
          this.failUnacknowledged(failure, true);
          this.updateFrameworkPayloadCleanup();
          this.finishIfSettled();
        },
      );
    } catch (failure) {
      this.failUnacknowledged(failure, true);
      this.finishIfSettled();

      throw failure;
    }

    return cleanup;
  }

  observeResponse(original: Promise<Response | undefined>): void {
    this.assertOpen();

    if (this.response.kind !== "missing") {
      const error = new TypeError("The native response slot was observed more than once");
      this.deferFinish++;

      try {
        this.failUnacknowledged(error);

        if (this.completionMode === "platform-handoff") this.failDispatch(error);
      } finally {
        this.deferFinish--;
        this.finishIfSettled();
      }

      return;
    }

    this.response = { kind: "pending", original };

    try {
      observeOriginal(
        original,
        (response) => {
          this.deferFinish++;

          try {
            this.response = { kind: "fulfilled", value: response, original };
            if (this.platformHandoff?.kind === "awaiting-response")
              this.platformHandoff = { kind: "awaiting-handoff" };
            this.cancelUnadoptedResponseProductions(undefined);
            this.validateResponse(response);

            const handoff = this.platformHandoff;

            if (handoff?.kind === "not-handed-off") this.failDispatch(handoff.reason.value);

            if (response === undefined) this.settleOriginalProjectionAbsent();
            else if (this.frameworkFetch) {
              const body = this.responseBodies.get(response);

              if (body) {
                body.frameworkPayload = true;
                this.frameworkFetch.originalBody = body;
              }
            }

            this.cancelLateFrameworkBodies();
            this.updateFrameworkPayloadCleanup();
          } finally {
            this.deferFinish--;
            this.finishIfSettled();
          }
        },
        (reason) => {
          this.deferFinish++;

          try {
            this.response = { kind: "rejected", reason: { value: reason }, original };
            this.rejectPlatformHandoff(reason);
            this.cancelUnadoptedResponseProductions(reason);

            if (this.completionMode === "platform-handoff") {
              this.settleOriginalProjectionAbsent();
              this.failDispatch(reason);
            } else {
              this.validateResponse(undefined);
              this.settleOriginalProjectionAbsent();
            }

            this.cancelLateFrameworkBodies();
            this.updateFrameworkPayloadCleanup();
          } finally {
            this.deferFinish--;
            this.finishIfSettled();
          }
        },
        (reason) => {
          this.deferFinish++;

          try {
            this.response = { kind: "unacknowledged", reason: { value: reason }, original };
            this.rejectPlatformHandoff(reason);
            this.failOriginalProjectionObservation(reason);
            this.failUnacknowledged(reason, true);
            this.cancelUnadoptedResponseProductions(reason);

            if (this.completionMode === "platform-handoff") this.failDispatch(reason);

            this.updateFrameworkPayloadCleanup();
          } finally {
            this.deferFinish--;
            this.finishIfSettled();
          }
        },
      );
    } catch (reason) {
      this.deferFinish++;

      try {
        this.response = { kind: "unacknowledged", reason: { value: reason }, original };
        this.rejectPlatformHandoff(reason);
        this.failOriginalProjectionObservation(reason);
        this.failUnacknowledged(reason, true);
        this.cancelUnadoptedResponseProductions(reason);

        if (this.completionMode === "platform-handoff") this.failDispatch(reason);

        this.updateFrameworkPayloadCleanup();
      } finally {
        this.deferFinish--;
        this.finishIfSettled();
      }

      throw reason;
    }
  }

  enrollResponseBody(
    response: Response,
    platformFallback = false,
  ): ReadableStream<Uint8Array> | null {
    const existing = this.responseBodies.get(response);

    if (existing) {
      if (existing.payloadReleased && existing.nativeBody === undefined)
        throw new TypeError("The response body resource was already released for this request use");

      this.adoptResponseProduction(response, existing);

      return existing.nativeBody ?? null;
    }

    if (platformFallback) {
      this.assertOpen();
      const outcome = this.response;
      const handoff = this.platformHandoff;

      if (
        this.completionMode !== "platform-handoff" ||
        outcome.kind !== "fulfilled" ||
        outcome.value !== undefined ||
        handoff?.kind !== "associating" ||
        handoff.source !== response
      )
        throw new TypeError(
          "A platform fallback requires its original unclaimed outcome and handoff",
        );
    } else {
      this.assertResponseConstructionOpen();
    }

    const record = this.newBodyRecord("native");
    let nativeBody: ReadableStream<Uint8Array> | null;

    try {
      if (!nativeResponseBodyGetter)
        throw new TypeError("The native Response body operation is unavailable");

      nativeBody = nativeReflectApply(
        nativeResponseBodyGetter,
        response,
        [],
      ) as ReadableStream<Uint8Array> | null;

      const owner = nativeBody === null ? undefined : nativeBodyOwners.get(nativeBody);

      if (owner && owner.owner !== this.bodyOwnerIdentity)
        throw new TypeError("The native response body already belongs to another request use");

      if (owner) {
        this.adoptResponseProduction(response, owner);
        this.bodies.delete(record);
        this.responseBodies.set(response, owner);

        return nativeBody;
      }

      this.associateResponseBody(record, response, nativeBody);
    } catch (reason) {
      this.failConstruction(record, reason);
      this.finishIfSettled();

      throw reason;
    }

    this.adoptResponseProduction(response, record);

    this.cancelLateFrameworkBodies();
    this.finishIfSettled();

    return nativeBody;
  }

  recordPlatformResponseHandoff(source: Response): Response {
    if (this.completionMode !== "platform-handoff")
      throw new TypeError("Only an acquired platform-handoff use can record response handoff");

    const state = this.platformHandoff;

    if (state?.kind === "not-handed-off") {
      if (!this.completed) {
        try {
          this.failDispatch(state.reason.value);
        } catch (failure) {
          this.failUnacknowledged(failure, true);
        }
      }

      throw state.reason.value;
    }

    if (state?.kind === "handed-off")
      throw new TypeError("The platform response was already handed off");

    this.assertOpen();
    this.deferFinish++;

    try {
      if (state?.kind !== "awaiting-handoff" || this.requestScopeRetirement === undefined)
        throw new TypeError(
          "Platform handoff requires the acquired use and its original response outcome",
        );

      const outcome = this.response;

      if (outcome.kind !== "fulfilled")
        throw new TypeError("Platform handoff requires the original fulfilled Host outcome");
      if (outcome.value !== undefined && outcome.value !== source)
        throw new TypeError("Platform handoff requires the exact original Host response");

      this.platformHandoff = { kind: "associating", source };

      if (outcome.value === undefined && this.enrollResponseBody(source, true) === null)
        throw new TypeError("The platform fallback must retain its native body");

      const body = this.responseBodies.get(source);

      if (!body || body.owner !== this.bodyOwnerIdentity || body.payloadReleased)
        throw new TypeError("The platform response has no retained body from this request use");

      let response = source;

      if (body.kind === "native" && body.nativeBody !== null) {
        if (body.nativeBody === undefined)
          throw new TypeError("The platform response has no original body resource");

        const metadata = this.nativeResponseMetadata(source);
        const method = this.nativeRequestMethod();
        const forwarder = this.ensureNativeBodyForwarder(body);

        if (method === "HEAD") {
          try {
            void this.cancelBodyRecord(body, undefined);
          } catch (reason) {
            this.failUnacknowledged(reason, true);
          }

          response = this.constructResponse(this.newBodyRecord("bodyless"), null, metadata);
        } else {
          response = this.createResponseOverForwarder(body, forwarder, metadata);
        }
      }

      this.assertPlatformHandoffSource(source);
      if (this.staticServingProduction !== undefined)
        this.assertFinalResponseHandoffCurrent(this.view);

      this.platformHandoff = { kind: "handed-off", source, response };

      return response;
    } catch (reason) {
      this.rejectPlatformHandoff(reason);

      try {
        this.failDispatch(reason);
      } catch (failure) {
        this.failUnacknowledged(failure, true);
      }

      throw reason;
    } finally {
      this.deferFinish--;
      this.finishIfSettled();
    }
  }

  private assertPlatformHandoffSource(source: Response): void {
    const current = this.platformHandoff;

    if (current?.kind === "not-handed-off") throw current.reason.value;
    if (current?.kind !== "associating" || current.source !== source)
      throw new TypeError("The platform handoff changed during response preparation");
  }

  private rejectPlatformHandoff(reason: unknown): void {
    if (this.completionMode !== "platform-handoff") return;
    if (
      this.platformHandoff?.kind === "handed-off" ||
      this.platformHandoff?.kind === "not-handed-off"
    )
      return;

    this.platformHandoff = { kind: "not-handed-off", reason: { value: reason } };
  }

  observeDelivery(response: Response | undefined, original: Promise<void>): void {
    this.assertOpen();

    if (this.completionMode === "platform-handoff") {
      const error = new TypeError("Platform handoff cannot observe a native delivery substitute");

      this.failDispatch(error);
      throw error;
    }

    if (this.delivery.kind !== "missing") {
      this.failUnacknowledged(
        new TypeError("The native delivery slot was observed more than once"),
      );
      return;
    }

    this.delivery = { kind: "pending", original };
    this.deliveryResponse = response;

    if (response !== undefined) {
      const body = this.responseBodies.get(response);

      if (!body || body.owner !== this.bodyOwnerIdentity) {
        this.failUnacknowledged(
          new TypeError("The delivered response has no body record from this request use"),
        );
      }
    }

    try {
      observeOriginal(
        original,
        () => {
          this.delivery = { kind: "fulfilled", value: undefined, original };
          this.settleOriginalProjectionAbsent();
          this.validateDeliveryResponse();
          this.updateFrameworkPayloadCleanup();
          this.finishIfSettled();
        },
        (reason) => {
          this.delivery = { kind: "rejected", reason: { value: reason }, original };
          this.settleOriginalProjectionAbsent();
          this.failUnacknowledged(reason, true);
          this.validateDeliveryResponse();
          this.updateFrameworkPayloadCleanup();
          this.finishIfSettled();
        },
        (reason) => {
          this.delivery = { kind: "unacknowledged", reason: { value: reason }, original };
          this.failOriginalProjectionObservation(reason);
          this.failUnacknowledged(reason, true);
          this.updateFrameworkPayloadCleanup();
          this.finishIfSettled();
        },
      );
    } catch (reason) {
      this.delivery = { kind: "unacknowledged", reason: { value: reason }, original };
      this.failOriginalProjectionObservation(reason);
      this.failUnacknowledged(reason, true);
      this.updateFrameworkPayloadCleanup();
      this.finishIfSettled();
      throw reason;
    }
  }

  cancelResponseBody(response: Response, reason?: unknown): Promise<void> {
    this.assertOpen();

    const body = this.responseBodies.get(response);

    if (!body || body.owner !== this.bodyOwnerIdentity) {
      const error = new TypeError(
        "The cancelled response has no body record from this request use",
      );

      this.failUnacknowledged(error, true);

      throw error;
    }

    if (body.payloadReleased && body.nativeBody === undefined)
      return this.completedBodyOperation(body);

    const stream = body.nativeBody;

    if (!stream) {
      const error = new TypeError("A bodyless response has no native body to cancel");

      this.failUnacknowledged(error, true);

      throw error;
    }

    const owner = nativeBodyOwners.get(stream);

    if (!owner || owner.owner !== this.bodyOwnerIdentity) {
      const error = new TypeError(
        "The cancelled response body has no native owner from this request use",
      );

      this.failUnacknowledged(error, true);

      throw error;
    }

    if (this.frameworkFetch?.finalBody === owner && !owner.forwardingCancellation)
      void this.cancelFinalBoundaryOnFailure(owner, reason);

    return this.cancelBodyRecord(owner, reason);
  }

  failDispatch(reason: unknown): void {
    const semanticResponseFailure =
      this.completionMode === "platform-handoff" &&
      this.response.kind === "rejected" &&
      Object.is(this.response.reason.value, reason);

    if (this.completed && semanticResponseFailure) return;

    if (this.completed && this.unacknowledged && Object.is(this.unacknowledged.reason, reason))
      return;

    this.assertOpen();

    this.deferFinish++;

    try {
      this.rejectPlatformHandoff(reason);

      if (this.response.kind === "missing") {
        this.response = { kind: "unacknowledged", reason: { value: reason } };
        this.settleOriginalProjectionAbsent();
      }

      if (this.completionMode !== "platform-handoff" && this.delivery.kind === "missing")
        this.delivery = { kind: "unacknowledged", reason: { value: reason } };

      if (!semanticResponseFailure) {
        this.failOriginalProjectionObservation(reason);
        this.failUnacknowledged(reason);
      }

      if (
        (this.routeLoadProduction || this.staticServingProduction) &&
        !this.responseProductionFailureCleanup &&
        this.unacknowledged
      )
        this.responseProductionFailureCleanup = this.unacknowledged;

      const cleanupReason = this.responseProductionFailureCleanup
        ? this.responseProductionFailureCleanup.reason
        : reason;

      try {
        void this.cancelOpenBodyRecords(cleanupReason);
      } catch (cancelFailure) {
        this.failUnacknowledged(cancelFailure, true);
      }

      this.validateResponse(undefined);
      this.updateFrameworkPayloadCleanup();
    } finally {
      this.deferFinish--;
      this.finishIfSettled();
    }
  }

  createBlobResponse(blob: Blob, init?: ResponseInit): Response {
    this.assertResponseConstructionOpen();

    const record = this.newBodyRecord("blob");
    let ownedBlob: Blob;

    try {
      const blobSize = this.nativeBlobSize(blob);
      const blobType = this.nativeBlobType(blob);
      ownedBlob = new NativeBlob([blob], { type: blobType });

      if (this.nativeBlobSize(ownedBlob) !== blobSize)
        throw new TypeError("The native Blob clone changed its original byte length");
    } catch (reason) {
      this.failConstruction(record, reason);
      this.finishIfSettled();

      throw reason;
    }

    return this.constructResponse(record, ownedBlob, init);
  }

  createProgressiveResponse<Event>(
    source: ProgressiveSourceV1<Event>,
    options: ProgressiveResponseOptionsV1<Event>,
    init?: ResponseInit,
  ): Response {
    this.assertResponseConstructionOpen();

    const record = this.newBodyRecord("progressive");
    record.progressiveTerminal = "open";
    this.deferFinish++;

    try {
      const sourceUse = acquireProgressiveSource(source);

      record.progressiveUse = sourceUse;
      this.observeProgressiveSettled(record, sourceUse.settled);
      record.progressivePreparation = { kind: "preparing" };

      const initial = options.initial;
      const encode = options.encode;
      const limits: ProgressiveByteLimitsV1 = {
        maxBoundaryBytes: options.maxBoundaryBytes,
        maxQueuedBytes: options.maxQueuedBytes,
        maxQueuedEvents: options.maxQueuedEvents,
      };

      if (typeof encode !== "function")
        throw new TypeError("A progressive response requires the Hosting event encoder");

      const stream = this.createProgressiveStream(record);
      const response = this.constructResponse(record, stream, init);

      this.assertProgressivePreparation(record, "preparing");
      record.progressivePreparation = { kind: "claiming" };

      const progressive = claimProgressiveSource(sourceUse, encode, limits, initial);

      record.progressive = progressive;
      this.assertProgressivePreparation(record, "claiming");
      record.progressivePreparation = { kind: "claimed" };

      return response;
    } catch (reason) {
      record.progressivePreparation = { kind: "failed", reason: { value: reason } };
      record.progressiveTerminal = "failed";
      record.progressiveFailure = { reason };
      this.failConstruction(record, reason);

      if (record.progressive && record.progressiveCancelRequested) {
        // Cancellation during claim precedes the actual queue handle.
        try {
          record.progressive.cancel(reason);
        } catch (cancelFailure) {
          this.failUnacknowledged(cancelFailure, true);
        }
      }

      if (record.progressiveUse) {
        try {
          void this.cancelProgressive(record, reason);
        } catch (cancelFailure) {
          this.failUnacknowledged(cancelFailure, true);
        }
      }

      if (record.nativeBody) {
        try {
          void this.cancelBodyRecord(record, reason);
        } catch (cancelFailure) {
          this.failUnacknowledged(cancelFailure, true);
        }
      }

      throw reason;
    } finally {
      this.deferFinish--;
      this.finishIfSettled();
    }
  }

  private assertProgressivePreparation(
    body: ResponseBodyRecord,
    expected: "preparing" | "claiming",
  ): void {
    const preparation = body.progressivePreparation;

    if (preparation?.kind === "cancelled" || preparation?.kind === "failed")
      throw preparation.reason.value;
    if (body.progressiveTerminal === "failed") throw body.progressiveFailure?.reason;
    if (preparation?.kind !== expected || body.progressiveCancelRequested)
      throw new TypeError("The progressive source preparation is no longer open");

    this.assertResponseConstructionOpen();
  }

  createBodylessResponse(init?: ResponseInit): Response {
    return this.createResponse("bodyless", null, init);
  }

  private nativeBlobSize(blob: Blob): number {
    if (!blobSizeGetter) throw new TypeError("The native Blob size operation is unavailable");

    const size = nativeReflectApply(blobSizeGetter, blob, []) as number;

    if (!Number.isSafeInteger(size) || size < 0)
      throw new TypeError("The response body is not a genuine native Blob");

    return size;
  }

  private nativeBlobType(blob: Blob): string {
    if (!blobTypeGetter) throw new TypeError("The native Blob type operation is unavailable");

    const type = nativeReflectApply(blobTypeGetter, blob, []) as unknown;

    if (typeof type !== "string")
      throw new TypeError("The response body is not a genuine native Blob");

    return type;
  }

  private observeProgressiveSettled(body: ResponseBodyRecord, original: Promise<void>): void {
    body.progressiveSettled = { kind: "pending", original };

    try {
      observeOriginal(
        original,
        () => {
          body.progressiveSettled = { kind: "fulfilled", value: undefined, original };
          this.updateFrameworkPayloadCleanup();
          this.finishIfSettled();
        },
        (reason) => {
          body.progressiveSettled = { kind: "rejected", reason: { value: reason }, original };
          body.progressiveTerminal = "failed";
          body.progressiveFailure = { reason };
          this.failUnacknowledged(reason, true);
          this.updateFrameworkPayloadCleanup();
          this.finishIfSettled();
        },
        (reason) => {
          body.progressiveSettled = { kind: "unacknowledged", reason: { value: reason }, original };
          body.progressiveTerminal = "failed";
          body.progressiveFailure = { reason };
          this.failUnacknowledged(reason, true);
          this.updateFrameworkPayloadCleanup();
          this.finishIfSettled();
        },
      );
    } catch (reason) {
      body.progressiveSettled = { kind: "unacknowledged", reason: { value: reason }, original };
      body.progressiveTerminal = "failed";
      body.progressiveFailure = { reason };
      this.failConstruction(body, reason);
      this.updateFrameworkPayloadCleanup();
      this.finishIfSettled();

      throw reason;
    }
  }

  private createProgressiveStream(body: ResponseBodyRecord): ReadableStream<Uint8Array> {
    if (!nativeControllerEnqueue || !nativeControllerClose)
      throw new TypeError("The native ReadableStream controller operations are unavailable");

    const stream = new nativeReadableStream<Uint8Array>(
      {
        pull: (controller) => this.pullProgressive(body, controller),
        cancel: (reason) => this.cancelProgressive(body, reason),
      },
      { highWaterMark: 0 },
    );

    nativeBodyOwners.set(stream, body);
    body.nativeBody = stream;

    return stream;
  }

  private pullProgressive(
    body: ResponseBodyRecord,
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): Promise<void> {
    if (body.progressiveTerminal === "complete" || body.progressiveTerminal === "cancelled")
      return nativeReflectApply(nativePromiseResolve, NativePromise, [undefined]) as Promise<void>;

    if (body.progressiveTerminal === "failed")
      return nativeReflectApply(nativePromiseReject, NativePromise, [
        body.progressiveFailure?.reason,
      ]) as Promise<void>;

    if (body.progressiveCancelRequested)
      return nativeReflectApply(nativePromiseResolve, NativePromise, [undefined]) as Promise<void>;

    const progressive = body.progressive;

    if (!progressive || body.progressivePreparation?.kind !== "claimed") {
      const reason = new TypeError("The progressive body was pulled before its source was claimed");
      body.progressiveTerminal = "failed";
      body.progressiveFailure = { reason };
      this.failUnacknowledged(reason, true);

      try {
        void this.cancelProgressive(body, reason);
      } catch (cancelFailure) {
        this.failUnacknowledged(cancelFailure, true);
      }

      this.finishIfSettled();

      return nativeReflectApply(nativePromiseReject, NativePromise, [reason]) as Promise<void>;
    }

    const pull: ProgressivePullRecord = {
      original: { kind: "admitting" },
      callback: { kind: "admitting" },
    };

    body.progressivePulls.push(pull);
    let original: Promise<IteratorResult<Uint8Array>>;

    try {
      original = progressive.iterator.next();
      pull.original = { kind: "pending", original };
    } catch (reason) {
      pull.original = { kind: "unacknowledged", reason: { value: reason } };
      pull.callback = { kind: "unacknowledged", reason: { value: reason } };
      body.progressiveTerminal = "failed";
      body.progressiveFailure = { reason };
      this.failUnacknowledged(reason, true);
      this.finishIfSettled();

      return nativeReflectApply(nativePromiseReject, NativePromise, [reason]) as Promise<void>;
    }

    const pullOperation = new NativePromise<void>((resolve, reject) => {
      try {
        observeOriginal(
          original,
          (result) => {
            pull.original = { kind: "fulfilled" };

            if (body.progressiveCancelRequested) {
              resolve();
              this.finishIfSettled();

              return;
            }

            try {
              if (result.done) {
                body.progressiveTerminal = "complete";
                nativeReflectApply(nativeControllerClose!, controller, []);
              } else {
                nativeReflectApply(nativeControllerEnqueue!, controller, [result.value]);
              }

              resolve();
            } catch (reason) {
              body.progressiveTerminal = "failed";
              reject(reason);
            }

            this.finishIfSettled();
          },
          (reason) => {
            pull.original = { kind: "rejected", reason: { value: reason }, original };
            body.progressiveTerminal = "failed";
            body.progressiveFailure = { reason };

            if (body.progressiveCancelRequested) resolve();
            else reject(reason);

            this.finishIfSettled();
          },
          (reason) => {
            pull.original = { kind: "unacknowledged", reason: { value: reason }, original };
            body.progressiveTerminal = "failed";
            body.progressiveFailure = { reason };
            reject(reason);
            this.finishIfSettled();
          },
        );
      } catch (reason) {
        pull.original = { kind: "unacknowledged", reason: { value: reason }, original };
        body.progressiveTerminal = "failed";
        body.progressiveFailure = { reason };
        reject(reason);
      }
    });

    pull.callbackPromise = pullOperation;
    pull.callback = { kind: "pending", original: pullOperation };

    try {
      observeOriginal(
        pullOperation,
        () => {
          pull.callback = { kind: "fulfilled", value: undefined, original: pullOperation };
          this.removeProgressivePull(body, pull);
          this.finishIfSettled();
        },
        (reason) => {
          pull.callback = { kind: "rejected", reason: { value: reason }, original: pullOperation };
          body.progressiveFailure ??= { reason };
          this.failUnacknowledged(reason, true);
          this.finishIfSettled();
        },
        (reason) => {
          pull.callback = {
            kind: "unacknowledged",
            reason: { value: reason },
            original: pullOperation,
          };
          body.progressiveFailure ??= { reason };
          this.failUnacknowledged(reason, true);
          this.finishIfSettled();
        },
      );
    } catch (reason) {
      pull.callback = {
        kind: "unacknowledged",
        reason: { value: reason },
        original: pullOperation,
      };
      body.progressiveFailure ??= { reason };
      this.failUnacknowledged(reason, true);
      this.finishIfSettled();
    }

    return pullOperation;
  }

  private removeProgressivePull(body: ResponseBodyRecord, pull: ProgressivePullRecord): void {
    // Failed callbacks remain cancellation inputs; successful chunks leave no retained history.
    if (pull.original.kind === "unacknowledged" || pull.callback.kind !== "fulfilled") return;

    const index = body.progressivePulls.indexOf(pull);

    if (index !== -1) body.progressivePulls.splice(index, 1);
  }

  private cancelProgressive(body: ResponseBodyRecord, reason: unknown): Promise<void> {
    const progressive = body.progressive;
    const use = body.progressiveUse;

    if (!use) throw new TypeError("The progressive body has no acquired source use");

    const settled = progressive?.settled ?? use.settled;
    const cancel = (): void => {
      if (progressive) progressive.cancel(reason);
      else use.cancel(reason);
    };
    const readFailure = progressive ? () => progressive.failure : undefined;
    const existing = body.progressiveCancelOperation;

    if (existing?.kind === "pending") return existing.original;
    if (existing?.kind === "admitting" && body.progressiveCancelAdmission)
      return this.startProgressiveCancellation(body, cancel, settled, reason, readFailure);
    if (
      existing?.kind === "fulfilled" ||
      existing?.kind === "rejected" ||
      existing?.kind === "unacknowledged"
    )
      return existing.original ?? body.completedBodyOperation ?? settled;

    this.reserveProgressiveCancellation(body);

    return this.startProgressiveCancellation(body, cancel, settled, reason, readFailure);
  }

  private reserveProgressiveCancellation(body: ResponseBodyRecord): void {
    if (body.progressiveCancelOperation) return;

    let resolve!: () => void;
    let reject!: (reason: unknown) => void;
    const promise = new NativePromise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    nativeReflectApply(nativePromiseThen, promise, [undefined, () => undefined]);
    body.progressiveCancelAdmission = { promise, resolve, reject };
    body.progressiveCancelOperation = { kind: "admitting" };
  }

  private startProgressiveCancellation(
    body: ResponseBodyRecord,
    cancel: () => void,
    settledOriginal: Promise<void>,
    reason: unknown,
    readProgressiveFailure?: () => { readonly reason: unknown } | undefined,
  ): Promise<void> {
    if (body.progressiveCancelOperation?.kind === "pending")
      return body.progressiveCancelOperation.original;

    if (body.progressiveCancelRequested && body.progressiveCancelAdmission) {
      const error = new TypeError(
        "Progressive cancellation reentered before its original join was available",
      );

      this.failUnacknowledged(error, true);

      throw error;
    }

    if (body.progressiveCancelOperation?.kind !== "admitting")
      this.reserveProgressiveCancellation(body);

    const admission = body.progressiveCancelAdmission;
    if (!admission) throw new TypeError("The progressive cancellation admission was not retained");

    const preparation = body.progressivePreparation;

    if (preparation?.kind === "preparing" || preparation?.kind === "claiming")
      body.progressivePreparation = { kind: "cancelled", reason: { value: reason } };

    body.progressiveCancelRequested = true;
    let cancellationFailure: { readonly reason: unknown } | undefined;

    try {
      cancel();
    } catch (failure) {
      cancellationFailure = { reason: failure };
    }

    const originals = [
      settledOriginal,
      ...body.progressivePulls.flatMap((pull) =>
        pull.callbackPromise ? [pull.callbackPromise] : [],
      ),
    ];
    const allSettled = nativeReflectApply(nativePromiseAllSettled, NativePromise, [
      originals,
    ]) as Promise<PromiseSettledResult<void>[]>;
    const cancellation = nativeReflectApply(nativePromiseThen, allSettled, [
      (results: PromiseSettledResult<void>[]) => {
        const failures = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );

        const byteFailure = readProgressiveFailure?.();

        if (byteFailure && !failures.some((failure) => Object.is(failure, byteFailure.reason)))
          failures.push(byteFailure.reason);

        if (cancellationFailure) failures.unshift(cancellationFailure.reason);

        if (failures.length) {
          body.progressiveTerminal = "failed";
          body.progressiveFailure = {
            reason:
              failures.length === 1
                ? failures[0]
                : new AggregateError(
                    failures,
                    "Progressive response cancellation did not settle cleanly",
                  ),
          };

          throw body.progressiveFailure.reason;
        }

        body.progressiveTerminal = "cancelled";
      },
    ]) as Promise<void>;

    body.progressiveCancelOperation = { kind: "pending", original: cancellation };
    body.completedBodyOperation = cancellation;

    try {
      observeOriginal(
        cancellation,
        () => {
          body.progressiveCancelOperation = {
            kind: "fulfilled",
            value: undefined,
            original: cancellation,
          };
          body.progressiveCancelAdmission = undefined;
          admission.resolve();
          this.finishIfSettled();
        },
        (failure) => {
          body.progressiveCancelOperation = {
            kind: "rejected",
            reason: { value: failure },
            original: cancellation,
          };
          body.progressiveCancelAdmission = undefined;
          admission.reject(failure);
          body.progressiveFailure ??= { reason: failure };
          this.failUnacknowledged(failure, true);
          this.finishIfSettled();
        },
        (failure) => {
          body.progressiveCancelOperation = {
            kind: "unacknowledged",
            reason: { value: failure },
            original: cancellation,
          };
          body.progressiveCancelAdmission = undefined;
          admission.reject(failure);
          this.failUnacknowledged(failure, true);
          this.finishIfSettled();
        },
      );
    } catch (failure) {
      body.progressiveCancelOperation = {
        kind: "unacknowledged",
        reason: { value: failure },
        original: cancellation,
      };
      body.progressiveCancelAdmission = undefined;
      admission.reject(failure);
      body.progressiveFailure ??= { reason: failure };
      this.failUnacknowledged(failure, true);
    }

    return cancellation;
  }

  private createResponse(kind: ResponseBodyKind, body: Blob | null, init?: ResponseInit): Response {
    this.assertResponseConstructionOpen();

    const record = this.newBodyRecord(kind);

    return this.constructResponse(record, body, init);
  }

  private newBodyRecord(kind: ResponseBodyKind): ResponseBodyRecord {
    const record: ResponseBodyRecord = {
      owner: this.bodyOwnerIdentity,
      kind,
      construction: "constructing",
      forwardingState: "unstarted",
      forwardingPulls: [],
      forwardingRelease: { kind: "missing" },
      readerAcquisitionFailed: false,
      transportReaderRetryUsed: false,
      frameworkPayload: this.frameworkFetch !== undefined,
      payloadReleased: false,
      cancellations: [],
      progressiveSettled: { kind: "missing" },
      progressivePulls: [],
    };

    // Retain the producer record before validation or a native constructor can call out.
    this.bodies.add(record);

    return record;
  }

  private constructResponse(
    record: ResponseBodyRecord,
    body: BodyInit | null,
    init?: ResponseInit,
  ): Response {
    let response: Response;

    try {
      response = new NativeResponse(body, init);
      if (!nativeResponseBodyGetter)
        throw new TypeError("The native Response body operation is unavailable");

      const nativeBody = nativeReflectApply(
        nativeResponseBodyGetter,
        response,
        [],
      ) as ReadableStream<Uint8Array> | null;

      this.associateResponseBody(record, response, nativeBody);
    } catch (reason) {
      this.failConstruction(record, reason);

      throw reason;
    }

    if (
      this.response.kind === "unacknowledged" &&
      this.delivery.kind === "unacknowledged" &&
      record.kind !== "bodyless"
    ) {
      try {
        this.cancelResponseBody(response, this.unacknowledged?.reason);
      } catch (cancelFailure) {
        this.failUnacknowledged(cancelFailure, true);
      }
    }

    this.cancelLateFrameworkBodies();
    this.finishIfSettled();

    return response;
  }

  private associateResponseBody(
    record: ResponseBodyRecord,
    response: Response,
    nativeBody: ReadableStream<Uint8Array> | null,
  ): void {
    if (nativeBody === null) record.kind = "bodyless";

    if (nativeBody !== null) {
      const owner = nativeBodyOwners.get(nativeBody);

      if (owner && owner.owner !== this.bodyOwnerIdentity)
        throw new TypeError("The native response body already belongs to another request use");

      if (!owner) nativeBodyOwners.set(nativeBody, record);
    }

    record.response = response;
    record.nativeBody = nativeBody;
    record.construction = "constructed";
    this.responseBodies.set(response, record);
  }

  private associateResponseProduction(
    record: NativeResponseProductionRecord,
    response: Response,
  ): void {
    const responseProducer = this.responseProducers.get(response);
    if (responseProducer && responseProducer !== record)
      throw new TypeError("The exact Response already belongs to another producer slot");

    let body = this.responseBodies.get(response);

    if (body?.payloadReleased && body.nativeBody === undefined)
      throw new TypeError(
        `The ${record.kind} Response body was already released for this request use`,
      );

    if (!body) {
      const construction = this.newBodyRecord("native");

      try {
        if (!nativeResponseBodyGetter)
          throw new TypeError("The native Response body operation is unavailable");

        const nativeBody = nativeReflectApply(
          nativeResponseBodyGetter,
          response,
          [],
        ) as ReadableStream<Uint8Array> | null;
        const owner = nativeBody === null ? undefined : nativeBodyOwners.get(nativeBody);

        if (owner && owner.owner !== this.bodyOwnerIdentity)
          throw new TypeError(
            `The ${record.kind} Response body already belongs to another request use`,
          );

        if (owner) {
          this.bodies.delete(construction);
          this.responseBodies.set(response, owner);
          body = owner;
        } else {
          this.associateResponseBody(construction, response, nativeBody);
          body = construction;
        }
      } catch (reason) {
        this.failConstruction(construction, reason);
        record.retiredFailureRecorded = true;

        throw reason;
      }
    }

    if (body.responseProduction && body.responseProduction !== record) {
      const error = new TypeError(`The ${record.kind} Response body already has a producer owner`);

      this.failUnacknowledged(error, true);
      record.retiredFailureRecorded = true;

      throw error;
    }

    if (body.construction !== "constructed") {
      const error = new TypeError(
        `The ${record.kind} Response body has no completed request-use record`,
      );

      this.failUnacknowledged(error, true);
      record.retiredFailureRecorded = true;

      throw error;
    }

    body.responseProduction = record;
    record.response = response;
    record.body = body;
    this.responseProducers.set(response, record);

    if (this.adoptedResponses.has(response)) record.responseDisposition = "adopted";
    else if (body.nativeBody === null) record.responseDisposition = "bodyless";
    else if (
      body.payloadReleased ||
      body.forwardingState === "closed" ||
      body.forwardingState === "cancelled"
    ) {
      if (body.completedBodyOperation) {
        record.responseDisposition = "cancelled";
        record.cancellation = body.completedBodyOperation;
      } else {
        const failure = new TypeError(
          `The ${record.kind} Response body has no retained completion operation`,
        );

        record.responseDisposition = "failed";
        record.failure = { reason: failure };
        this.failUnacknowledged(failure, true);
        record.retiredFailureRecorded = true;
        this.failResponseProduction(record, failure, true);
      }
    } else if (body.forwardingState === "failed" || body.forwardingState === "unacknowledged") {
      const failure = body.constructionFailure
        ? body.constructionFailure.reason
        : body.readerAcquisitionFailure
          ? body.readerAcquisitionFailure.reason
          : new TypeError(`The ${record.kind} Response body is already unacknowledged`);
      record.responseDisposition = "failed";
      record.failure = { reason: failure };
      record.retiredFailureRecorded = true;
      this.failResponseProduction(record, failure, true);
    } else record.responseDisposition = "pending";

    const productionFailureCleanup = this.responseProductionFailureCleanup;

    if (productionFailureCleanup)
      this.cancelUnadoptedResponseProduction(record, productionFailureCleanup.reason);
    else if (
      this.response.kind === "fulfilled" ||
      this.response.kind === "rejected" ||
      this.response.kind === "unacknowledged"
    ) {
      const reason = this.response.kind === "fulfilled" ? undefined : this.response.reason.value;

      this.cancelUnadoptedResponseProduction(record, reason);
    }

    this.cancelLateFrameworkBodies();
    this.updateFrameworkPayloadCleanup();
    this.finishResponseProduction(record);
  }

  private adoptResponseProduction(response: Response, body: ResponseBodyRecord): void {
    const production = body.responseProduction;

    if (production && production.response !== response) {
      const error = new TypeError(`Host must adopt the exact ${production.kind} Response object`);

      this.failUnacknowledged(error, true);

      throw error;
    }

    this.adoptedResponses.add(response);

    if (production?.response === response && production.responseDisposition === "pending") {
      production.responseDisposition = "adopted";
      this.finishResponseProduction(production);
    }
  }

  private cancelUnadoptedResponseProduction(
    record: NativeResponseProductionRecord,
    reason?: unknown,
  ): void {
    if (!record.response) return;

    if (
      record.responseDisposition === "bodyless" ||
      record.responseDisposition === "adopted" ||
      record.responseDisposition === "cancelled" ||
      record.responseDisposition === "failed"
    )
      return;

    if (this.adoptedResponses.has(record.response)) {
      if (record.body) this.adoptResponseProduction(record.response, record.body);

      return;
    }

    try {
      void this.cancelUnhandedResponseProduction(record, record.response, reason);
    } catch (failure) {
      if (!record.failure) {
        record.responseDisposition = "failed";
        record.failure = { reason: failure };
        this.failResponseProduction(record, failure);
      }
    }
  }

  private cancelUnadoptedResponseProductions(reason?: unknown): void {
    if (this.routeLoadProduction)
      this.cancelUnadoptedResponseProduction(this.routeLoadProduction, reason);
    if (this.staticServingProduction)
      this.cancelUnadoptedResponseProduction(this.staticServingProduction, reason);
  }

  private settleResponseProductionBodyCancellation(
    body: ResponseBodyRecord,
    failure?: { readonly reason: unknown },
  ): void {
    const production = body.responseProduction;

    if (!production || production.responseDisposition === "adopted") return;

    const cancellation = body.forwardingCancellation?.observation;

    if (cancellation && cancellation.kind !== "admitting" && cancellation.original)
      production.cancellation = cancellation.original;

    if (failure) {
      production.responseDisposition = "failed";
      production.failure = failure;
      production.retiredFailureRecorded = true;
      if (production.retiredSettled) this.finishIfSettled();
      else this.failResponseProduction(production, failure.reason, true);

      return;
    }

    production.responseDisposition = "cancelled";
    this.finishResponseProduction(production);
  }

  private failConstruction(record: ResponseBodyRecord, reason: unknown): void {
    record.construction = "failed";

    if (record.constructionFailure && Object.is(record.constructionFailure.reason, reason)) return;

    record.constructionFailure = { reason };
    this.failUnacknowledged(reason, true);
  }

  private assertOpen(): void {
    if (this.completed) throw new TypeError("The native request use has already completed");
  }

  private assertResponseConstructionOpen(): void {
    this.assertOpen();

    if (
      this.response.kind === "fulfilled" ||
      this.response.kind === "rejected" ||
      this.response.kind === "unacknowledged"
    )
      throw new TypeError("The original response outcome is already known");
  }

  private validateResponse(response: Response | undefined): void {
    const responseBody = response === undefined ? undefined : this.responseBodies.get(response);
    const checkedBodies = new Set<ReadableStream<Uint8Array>>();

    if (response !== undefined) {
      const body = responseBody;

      if (!body || body.owner !== this.bodyOwnerIdentity) {
        this.failUnacknowledged(
          new TypeError("The response producer did not associate a body record before return"),
        );
      } else if (
        body.responseProduction?.response === response &&
        !this.adoptedResponses.has(response)
      ) {
        this.failUnacknowledged(
          new TypeError(
            `The Host did not adopt the ${body.responseProduction.kind} Response before returning it`,
          ),
        );
      }
    }

    for (const body of this.bodies) {
      if (body.payloadReleased) continue;
      if (body.construction === "failed") continue;
      if (body.construction !== "constructed") {
        this.failUnacknowledged(new TypeError("A native response body construction is incomplete"));
        continue;
      }

      if (body.kind === "bodyless" || body.nativeBody === null) continue;

      const stream = body.nativeBody;

      if (stream === undefined) {
        this.failUnacknowledged(new TypeError("A native response has no captured body resource"));
        continue;
      }

      if (checkedBodies.has(stream)) continue;

      checkedBodies.add(stream);

      if (responseBody?.owner === this.bodyOwnerIdentity && responseBody.nativeBody === stream)
        continue;

      const streamOwner = nativeBodyOwners.get(stream);

      if (!streamOwner || streamOwner.owner !== this.bodyOwnerIdentity) {
        this.failUnacknowledged(
          new TypeError("A native response body has no owner from this request use"),
        );
        continue;
      }

      if (streamOwner.cancellations.length) continue;

      if (
        [...this.bodies].some(
          (candidate) =>
            candidate.nativeBody === stream &&
            candidate.kind === "progressive" &&
            (candidate.progressiveTerminal === "failed" ||
              candidate.progressiveTerminal === "cancelled"),
        )
      )
        continue;

      this.failUnacknowledged(
        new TypeError("A constructed response body was neither returned nor cancelled"),
      );
    }
  }

  private validateDeliveryResponse(): void {
    if (this.response.kind === "rejected") {
      if (this.frameworkFetch?.kind === "node" && this.deliveryResponse === undefined) return;

      this.failUnacknowledged(
        new TypeError("The adapter received a response after dispatch rejected"),
      );

      return;
    }

    if (this.deliveryResponse === undefined) {
      if (this.response.kind === "fulfilled" && this.response.value !== undefined) {
        this.failUnacknowledged(new TypeError("The adapter omitted the original response"));
      }

      return;
    }

    if (this.response.kind === "fulfilled" && this.response.value !== this.deliveryResponse) {
      this.failUnacknowledged(new TypeError("The adapter delivered a different response object"));
    }
  }

  private updateFrameworkPayloadCleanup(): void {
    const final = this.frameworkFetch;

    if (!final || final.payloadCleanupSettled) return;
    if (!final.outcomeReadyRecorded || !final.originalProjectionSettled) return;
    if (this.response.kind === "missing" || this.response.kind === "pending") return;

    for (const observation of [
      this.response,
      this.delivery,
      final.original,
      final.originalProjection,
      final.publication,
      final.rejectionCleanup,
      final.adapterDrain,
    ]) {
      if (observation.kind === "unacknowledged")
        final.payloadCleanupFailure ??= { reason: observation.reason.value };
    }

    const transportRetryDenied =
      final.adapterDrain.kind === "rejected" || final.adapterDrain.kind === "unacknowledged";
    const transportTerminal = final.transportEnded || transportRetryDenied;

    if (final.original.kind === "pending") return;
    if (final.publication.kind === "admitting" || final.publication.kind === "pending") return;

    if (final.rejectionReason) {
      if (
        final.rejectionCleanup.kind === "missing" ||
        final.rejectionCleanup.kind === "admitting" ||
        final.rejectionCleanup.kind === "pending"
      )
        return;
    } else if (final.original.kind === "fulfilled") {
      if (!final.publicationSettled) return;
    } else if (final.original.kind === "unacknowledged") {
      if (!final.publicationSettled) return;
    } else return;

    const bodies = [...this.bodies].filter(
      (body) => body.frameworkPayload && !body.payloadReleased,
    );
    let permanentBodyFailure: { readonly reason: unknown } | undefined;

    for (const body of bodies) {
      if (body.construction === "failed") {
        permanentBodyFailure ??= { reason: body.constructionFailure?.reason };
        continue;
      }

      if (
        body.nativeBody !== null &&
        body.forwardingState !== "closed" &&
        body.forwardingState !== "cancelled" &&
        body.forwardingState !== "failed" &&
        body.forwardingState !== "unacknowledged"
      )
        return;
      if (
        body.cancellations.some(
          ({ observation }) => observation.kind === "admitting" || observation.kind === "pending",
        )
      )
        return;
      if (
        body.forwardingPulls.some(
          (pull) =>
            pull.original.kind === "admitting" ||
            pull.original.kind === "pending" ||
            pull.callback.kind === "admitting" ||
            pull.callback.kind === "pending",
        )
      )
        return;
      if (body.forwardingRelease.kind === "admitting" || body.forwardingRelease.kind === "pending")
        return;
      if (
        body.progressiveSettled.kind === "admitting" ||
        body.progressiveSettled.kind === "pending" ||
        body.progressiveCancelOperation?.kind === "admitting" ||
        body.progressiveCancelOperation?.kind === "pending" ||
        body.progressivePulls.some(
          (pull) =>
            pull.original.kind === "admitting" ||
            pull.original.kind === "pending" ||
            pull.callback.kind === "admitting" ||
            pull.callback.kind === "pending",
        )
      )
        return;
      if (body.progressiveTerminal === "open") return;

      const cancellationFailure = body.cancellations.find(
        ({ observation }) =>
          observation.kind === "rejected" || observation.kind === "unacknowledged",
      );
      const retryFailure = body.transportReaderRetryFailure ?? body.readerAcquisitionFailure;
      const releaseFailure =
        body.forwardingRelease.kind === "unacknowledged"
          ? body.forwardingRelease.reason
          : undefined;
      const progressivePullFailure = body.progressivePulls.find(
        (pull) =>
          pull.original.kind === "unacknowledged" || pull.callback.kind === "unacknowledged",
      );
      const progressiveFailure =
        body.progressiveSettled.kind === "unacknowledged"
          ? body.progressiveSettled.reason
          : body.progressiveCancelOperation?.kind === "unacknowledged"
            ? body.progressiveCancelOperation.reason
            : progressivePullFailure?.original.kind === "unacknowledged"
              ? progressivePullFailure.original.reason
              : progressivePullFailure?.callback.kind === "unacknowledged"
                ? progressivePullFailure.callback.reason
                : undefined;
      const nativePullFailure = body.forwardingPulls.find(
        (pull) =>
          pull.original.kind === "unacknowledged" || pull.callback.kind === "unacknowledged",
      );
      const nativePullReason =
        nativePullFailure?.original.kind === "unacknowledged"
          ? nativePullFailure.original.reason
          : nativePullFailure?.callback.kind === "unacknowledged"
            ? nativePullFailure.callback.reason
            : undefined;
      const cancellationReason =
        cancellationFailure?.observation.kind === "rejected" ||
        cancellationFailure?.observation.kind === "unacknowledged"
          ? cancellationFailure.observation.reason
          : undefined;
      const retryReason = retryFailure ? { value: retryFailure.reason } : undefined;
      const knownFailure =
        cancellationReason ??
        releaseFailure ??
        progressiveFailure ??
        nativePullReason ??
        retryReason ??
        (this.unacknowledged ? { value: this.unacknowledged.reason } : undefined);

      const bodyCleanupFailure = cancellationReason
        ? { reason: cancellationReason.value }
        : releaseFailure
          ? { reason: releaseFailure.value }
          : progressiveFailure
            ? { reason: progressiveFailure.value }
            : nativePullReason
              ? { reason: nativePullReason.value }
              : undefined;

      if (bodyCleanupFailure) {
        permanentBodyFailure ??= bodyCleanupFailure;
      } else if (
        (body.forwardingState === "unacknowledged" || body.readerAcquisitionFailed) &&
        !transportTerminal
      ) {
        return;
      } else if (
        transportTerminal &&
        (body.forwardingState === "unacknowledged" || body.readerAcquisitionFailed)
      ) {
        const transportFailure =
          final.adapterDrain.kind === "rejected" || final.adapterDrain.kind === "unacknowledged"
            ? final.adapterDrain.reason
            : undefined;
        const terminalFailure = knownFailure ?? transportFailure;

        permanentBodyFailure ??= terminalFailure
          ? { reason: terminalFailure.value }
          : {
              reason: new TypeError(
                "A native response body remained unacknowledged after transport cleanup",
              ),
            };
      }
    }

    if (permanentBodyFailure) {
      final.payloadCleanupFailure ??= permanentBodyFailure;
      this.rejectFrameworkPayloadCleanup(final, permanentBodyFailure.reason);

      return;
    }

    try {
      this.removeRequestAbortListener(final);
    } catch (reason) {
      final.payloadCleanupFailure ??= { reason };
      this.rejectFrameworkPayloadCleanup(final, reason);

      return;
    }

    for (const body of bodies) {
      if (
        body.forwardingCancellation?.observation.kind === "fulfilled" &&
        body.forwardingCancellation.observation.original
      )
        body.completedBodyOperation = body.forwardingCancellation.observation.original;
      else if (
        body.progressiveCancelOperation?.kind === "fulfilled" &&
        body.progressiveCancelOperation.original
      )
        body.completedBodyOperation = body.progressiveCancelOperation.original;
      else if (body.progressiveSettled.kind === "fulfilled" && body.progressiveSettled.original)
        body.completedBodyOperation = body.progressiveSettled.original;

      body.payloadReleased = true;
      body.frameworkPayload = false;
      body.forwardingReader = undefined;
      body.forwardingStream = undefined;
      body.forwardingController = undefined;
      body.forwardingPulls = [];
      body.forwardingCancellation = undefined;
      body.forwardingRelease = this.settledObservation(body.forwardingRelease);
      body.cancellations = [];
      body.progressiveSettled = this.settledObservation(body.progressiveSettled);
      body.progressiveUse = undefined;
      body.progressive = undefined;
      body.progressivePreparation = undefined;
      body.progressivePulls = [];
      if (body.progressiveCancelOperation)
        body.progressiveCancelOperation = this.settledObservation(body.progressiveCancelOperation);

      body.response = undefined;
      if (body.nativeBody !== null) body.nativeBody = undefined;
    }

    if (final.original.kind !== "unacknowledged") final.original = { kind: "missing" };
    if (final.publication.kind !== "unacknowledged") final.publication = { kind: "missing" };
    if (final.originalProjection.kind !== "unacknowledged")
      final.originalProjection = { kind: "missing" };
    final.fetchResponse = undefined;
    final.publishedResponse = undefined;
    final.nativeFinalResponse = undefined;
    final.finalResponse = undefined;
    final.originalBody = undefined;
    final.finalBody = undefined;
    final.bodyCleanupRequested = undefined;
    final.requestAbort = undefined;
    final.payloadCleanupSettled = true;

    if (final.payloadCleanupFailure) {
      final.rejectPayloadCleanup(final.payloadCleanupFailure.reason);
      return;
    }

    final.resolvePayloadCleanup();
  }

  private rejectFrameworkPayloadCleanup(final: NativeFrameworkFetchRecord, reason: unknown): void {
    if (final.payloadCleanupSettled) return;

    final.payloadCleanupFailure ??= { reason };
    final.payloadCleanupSettled = true;
    final.rejectPayloadCleanup(final.payloadCleanupFailure.reason);
  }

  private settledObservation<T>(observation: Observation<T>): Observation<T> {
    if (observation.kind === "fulfilled") return { kind: "fulfilled", value: observation.value };

    if (observation.kind === "rejected" || observation.kind === "unacknowledged")
      return { kind: observation.kind, reason: observation.reason };

    return { kind: "missing" };
  }

  private failUnacknowledged(reason: unknown, retainAdditional = false): void {
    this.rejectPlatformHandoff(reason);

    if (!this.unacknowledged) {
      this.unacknowledged = { reason };
      this.addFailure(reason);
    } else if (retainAdditional) this.addFailure(reason);

    this.finishIfSettled();
  }

  private addFailure(reason: unknown): void {
    this.failures.push({
      acquisition: this.acquisition,
      order: this.nextFailureOrder++,
      reason: { value: reason },
    });
  }

  retainUnacknowledgedOriginals(target: Set<Promise<unknown>>): void {
    const retain = (
      observation:
        | {
            readonly kind: string;
            readonly original?: Promise<unknown>;
          }
        | undefined,
    ): void => {
      if (observation?.kind === "unacknowledged" && observation.original)
        target.add(observation.original);
    };

    retain(this.response);
    retain(this.delivery);

    const routeLoad = this.routeLoadProduction;

    if (routeLoad?.originalState === "unacknowledged" && routeLoad.original)
      target.add(routeLoad.original);

    const staticServing = this.staticServingProduction;

    if (staticServing?.originalState === "unacknowledged" && staticServing.original)
      target.add(staticServing.original);

    if (this.frameworkFetch) {
      retain(this.frameworkFetch.adapterDrain);
      retain(this.frameworkFetch.original);
      retain(this.frameworkFetch.originalProjection);
      retain(this.frameworkFetch.publication);
      retain(this.frameworkFetch.rejectionCleanup);
    }

    for (const body of this.bodies) {
      retain(body.forwardingRelease);
      retain(body.progressiveSettled);
      retain(body.progressiveCancelOperation);

      for (const cancellation of body.cancellations) retain(cancellation.observation);

      for (const pull of [...body.forwardingPulls, ...body.progressivePulls]) {
        retain(pull.original);
        retain(pull.callback);
      }
    }
  }

  private finishIfSettled(): void {
    if (this.deferFinish) return;
    if (this.completed) return;

    const responsePending = this.response.kind === "pending";
    const deliveryPending = this.delivery.kind === "pending";
    const routeLoad = this.routeLoadProduction;
    const routeLoadPending =
      this.routeLoadRetirement.kind === "admitting" ||
      this.routeLoadRetirement.kind === "pending" ||
      routeLoad?.originalState === "admitted" ||
      routeLoad?.originalState === "pending" ||
      routeLoad?.responseDisposition === "pending" ||
      routeLoad?.responseDisposition === "cancelling";
    const staticServing = this.staticServingProduction;
    const staticServingPending =
      this.staticServingRetirement.kind === "admitting" ||
      this.staticServingRetirement.kind === "pending" ||
      staticServing?.originalState === "admitted" ||
      staticServing?.originalState === "pending" ||
      staticServing?.responseDisposition === "pending" ||
      staticServing?.responseDisposition === "cancelling";
    const cancellationPending = [...this.bodies].some((body) =>
      body.cancellations.some(
        ({ observation }) => observation.kind === "admitting" || observation.kind === "pending",
      ),
    );
    const progressiveWorkPending = [...this.bodies].some(
      (body) =>
        !body.payloadReleased &&
        (body.progressivePreparation?.kind === "preparing" ||
          body.progressivePreparation?.kind === "claiming" ||
          body.progressiveSettled.kind === "admitting" ||
          body.progressiveSettled.kind === "pending" ||
          body.progressiveCancelOperation?.kind === "admitting" ||
          body.progressiveCancelOperation?.kind === "pending" ||
          body.progressivePulls.some(
            (pull) =>
              pull.original.kind === "admitting" ||
              pull.original.kind === "pending" ||
              pull.callback.kind === "admitting" ||
              pull.callback.kind === "pending",
          ) ||
          body.forwardingState === "opening" ||
          body.forwardingState === "open" ||
          body.forwardingPulls.some(
            (pull) =>
              pull.original.kind === "admitting" ||
              pull.original.kind === "pending" ||
              pull.callback.kind === "admitting" ||
              pull.callback.kind === "pending",
          )),
    );

    const bunFinalPending =
      this.frameworkFetch !== undefined &&
      (this.frameworkFetch.adapterDrain.kind === "admitting" ||
        this.frameworkFetch.adapterDrain.kind === "pending" ||
        !this.frameworkFetch.outcomeReadyRecorded ||
        !this.frameworkFetch.originalProjectionSettled ||
        !this.frameworkFetch.payloadCleanupSettled ||
        this.frameworkFetch.original.kind === "pending" ||
        this.frameworkFetch.publication.kind === "admitting" ||
        this.frameworkFetch.publication.kind === "pending" ||
        this.frameworkFetch.rejectionCleanup.kind === "admitting" ||
        this.frameworkFetch.rejectionCleanup.kind === "pending");

    if (
      responsePending ||
      deliveryPending ||
      routeLoadPending ||
      staticServingPending ||
      cancellationPending ||
      progressiveWorkPending ||
      bunFinalPending
    )
      return;

    const constructionPending = [...this.bodies].some(
      (body) => !body.payloadReleased && body.construction === "constructing",
    );

    if (constructionPending) return;

    const progressiveStillOpen = [...this.bodies].some(
      (body) =>
        !body.payloadReleased &&
        body.kind === "progressive" &&
        body.construction === "constructed" &&
        body.progressiveTerminal === "open",
    );

    if (progressiveStillOpen) return;

    if (this.response.kind === "missing") return;

    const deliveryCanBeAbsent =
      this.response.kind === "rejected" || this.response.kind === "unacknowledged";

    if (this.completionMode === "platform-handoff") {
      const handoff = this.platformHandoff;

      if (handoff?.kind !== "handed-off" && handoff?.kind !== "not-handed-off") return;
    } else if (this.delivery.kind === "missing" && !deliveryCanBeAbsent) return;

    this.completed = true;

    // Record the missing transport owner only after every observed original operation settles.
    if (this.missingDeliveryReceipt) this.addFailure(this.missingDeliveryReceipt.reason);

    if (this.failures.length) {
      const failures = this.failures
        .sort((left, right) => left.order - right.order)
        .map(({ reason }) => reason.value);

      this.rejectRetired(
        failures.length === 1
          ? failures[0]
          : new AggregateError(failures, "Native request response and body cleanup failed"),
      );
    } else this.resolveRetired();

    this.changed(this);
  }
}

/** @internal Per-module request-use and requestless execution producer records. */
export class NativeHttpWorkLedger {
  private readonly byRequest = new Map<Request, NativeHttpRequestUseRecord>();
  private readonly outstanding = new Set<NativeHttpRequestUseRecord>();
  private readonly failures: RetainedFailure[] = [];
  private readonly outstandingExecutionProducers = new Set<NativeExecutionProducerRecord>();
  // Failed retirement retains unknown originals after the request-use record leaves admission.
  private readonly unacknowledgedOriginals = new Set<Promise<unknown>>();
  private closing = false;
  private nextAcquisition = 0;

  /**
   * Create an empty admission ledger for one physical native module parent.
   * @param changed Called with the exact use after its cached retirement Promise settles.
   * @param assertRequestResponseProductionAdmission Authenticates the exact current request
   * reservation for a response producer admitted by a claimed session.
   * @param executionProducerChanged Called after an execution producer leaves the ledger.
   */
  constructor(
    private readonly changed: (completedUse: NativeHttpRequestUseV1) => void,
    private readonly assertRequestResponseProductionAdmission: (
      use: NativeHttpRequestUseV1,
    ) => void,
    private readonly assertFinalResponseHandoffCurrent: (use: NativeHttpRequestUseV1) => void,
    private readonly executionProducerChanged: () => void,
  ) {}

  /** @internal Admit one static producer against its exact requestless physical child. */
  beginExecutionProducer(
    execution: object,
    lifetime: PhysicalNativeExecutionLifetime,
    observeFailedPhysicalRetirement: boolean,
  ): NativeExecutionProducerUseV1 {
    if (this.closing) throw new TypeError("The native module parent is closing");

    if (execution === null || typeof execution !== "object" || lifetime.ownerKey !== execution)
      throw new TypeError("A native execution producer requires its exact physical child");

    const record: NativeExecutionProducerRecord = {
      execution,
      lifetime,
      observeFailedPhysicalRetirement,
      state: "reserved",
      physicalState: "pending",
      completeRequested: false,
    };
    const use = Object.freeze({
      observe: (originals: NativeExecutionProducerOriginalsV1) =>
        this.observeExecutionProducer(record, originals),
      failInvocation: (reason: unknown) => this.failExecutionProducerInvocation(record, reason),
      failObservation: (reason: unknown) => this.failExecutionProducerObservation(record, reason),
      complete: () => this.completeExecutionProducer(record),
    });

    this.outstandingExecutionProducers.add(record);

    return use;
  }

  /**
   * Admit one actual entry and Request pair before dispatch.
   * @param entry The exact entry associated with this parent.
   * @param request The exact Request object to dispatch.
   * @param mode The immutable completion contract; native delivery is the default. Platform
   * handoff joins owned production and reader work without observing transport drain.
   * @returns The request's one-use response and body lifetime handle.
   * @throws {TypeError} If closing has begun, the mode is invalid, or the Request has an active use.
   */
  acquire(
    entry: object,
    request: Request,
    mode: "native-delivery" | "platform-handoff" = "native-delivery",
  ): NativeHttpRequestUseV1 {
    if (mode !== "native-delivery" && mode !== "platform-handoff")
      throw new TypeError("The native HTTP completion mode is invalid");

    return this.admit(entry, request, mode);
  }

  /**
   * Admit an actual entry and Request without an observable native delivery operation.
   * @param entry The exact entry associated with this parent.
   * @param request The exact Request object to dispatch.
   * @returns The request's response and body handle, whose retirement rejects after known work
   * settles because no transport completion can be observed.
   * @throws {TypeError} If closing has begun or the same Request already has an active use.
   */
  acquireUnacknowledged(entry: object, request: Request): NativeHttpRequestUseV1 {
    return this.admit(entry, request, "unacknowledged");
  }

  /**
   * Bind one exact physical request-scope original before its admitted use can be claimed.
   * @param entry The exact entry used to admit the request.
   * @param request The exact Request object used to admit the use.
   * @param use The exact use returned for this entry and Request pair.
   * @param original The reservation's original request-scope retirement promise.
   * @throws {TypeError} If the entry, Request, or use does not match, or if the use was claimed,
   * completed, or already bound.
   */
  bindRequestScopeRetirement(
    entry: object,
    request: Request,
    use: NativeHttpRequestUseV1,
    original: Promise<void>,
  ): void {
    const record = this.byRequest.get(request);

    if (!record || record.entry !== entry || record.view !== use)
      throw new TypeError("The exact entry, Request, and native use are required");

    record.bindRequestScopeRetirement(original);
  }

  /** @internal Check an exact active use without consuming either request claim. */
  assertRequestUse(
    entry: object,
    request: Request,
    use: NativeHttpRequestUseV1,
    requireUnclaimed = false,
  ): void {
    const record = this.byRequest.get(request);

    if (
      !record ||
      record.entry !== entry ||
      record.view !== use ||
      record.completed ||
      (requireUnclaimed && record.claimed)
    )
      throw new TypeError("The exact active native request use is required");
  }

  private admit(
    entry: object,
    request: Request,
    completionMode: NativeHttpRequestCompletionMode,
  ): NativeHttpRequestUseV1 {
    if (this.closing) throw new TypeError("The native module parent is closing");

    if (this.byRequest.has(request))
      throw new TypeError("This exact Request already has an overlapping native use");

    const record = new NativeHttpRequestUseRecord(
      this.nextAcquisition++,
      entry,
      request,
      (completed) => this.complete(completed),
      this.assertRequestResponseProductionAdmission,
      this.assertFinalResponseHandoffCurrent,
      completionMode,
    );

    this.byRequest.set(request, record);
    this.outstanding.add(record);

    return record.view;
  }

  /**
   * Claim a previously admitted exact pair at the generated request entry.
   * @param entry The same associated entry used for admission.
   * @param request The same Request object used for admission.
   * @returns The existing one-use lifetime handle.
   * @throws {TypeError} If the pair is absent, complete, or already claimed.
   */
  claim(entry: object, request: Request): NativeHttpRequestUseV1 {
    const record = this.byRequest.get(request);

    if (!record || record.entry !== entry || record.completed)
      throw new TypeError("The exact entry and Request have no admitted native use");

    if (record.claimed) {
      const error = new TypeError("The exact native request use was already claimed");

      record.view.failDispatch(error);

      throw error;
    }

    record.claimed = true;

    return record.view;
  }

  /** @internal Consume one session slot from this parent's exact already-claimed use. */
  claimSessionConstruction(entry: object, request: Request, use: NativeHttpRequestUseV1): void {
    const record = this.byRequest.get(request);

    if (
      !record ||
      record.entry !== entry ||
      record.view !== use ||
      !record.claimed ||
      record.completed
    )
      throw new TypeError(
        "A native server session requires this parent's exact claimed request use",
      );

    if (record.sessionConstructionClaimed) {
      const error = new TypeError(
        "The native request's server session construction was already claimed",
      );

      record.view.failDispatch(error);

      throw error;
    }

    record.sessionConstructionClaimed = true;
  }

  /** Stop new admissions while preserving claims for existing uses. */
  beginClose(): void {
    this.closing = true;
  }

  /** Whether any admitted response or body join is still outstanding. */
  get hasPending(): boolean {
    return this.outstanding.size !== 0 || this.outstandingExecutionProducers.size !== 0;
  }

  /** Original request cleanup causes ordered by request admission and failure attempt. */
  private observeExecutionProducer(
    record: NativeExecutionProducerRecord,
    originals: NativeExecutionProducerOriginalsV1,
  ): void {
    if (
      !this.outstandingExecutionProducers.has(record) ||
      record.state !== "reserved" ||
      originals === null ||
      typeof originals !== "object"
    )
      throw new TypeError("A native execution producer observation is one-use");

    try {
      const fields = Object.getOwnPropertyDescriptors(originals);
      const names = Reflect.ownKeys(fields);

      if (
        names.length !== 3 ||
        names.some((name) => name !== "result" && name !== "settled" && name !== "retired") ||
        !fields.result ||
        !("value" in fields.result) ||
        !fields.settled ||
        !("value" in fields.settled) ||
        !fields.retired ||
        !("value" in fields.retired)
      )
        throw new TypeError("A native execution requires its three original operation promises");

      const result = fields.result.value;
      const settled = fields.settled.value;
      const retired = fields.retired.value;

      if (
        !(result instanceof NativePromise) ||
        !(settled instanceof NativePromise) ||
        !(retired instanceof NativePromise)
      )
        throw new TypeError("A native execution requires genuine original Promises");

      if (!Object.isFrozen(originals))
        throw new TypeError("A native execution operation record must be frozen");

      record.originals = originals;
      record.state = "observing";
    } catch (reason) {
      this.failExecutionProducerObservation(record, reason);

      throw reason;
    }

    try {
      nativeReflectApply(nativePromiseThen, record.lifetime.retired, [
        () => {
          record.physicalState = "fulfilled";
          this.finishExecutionProducer(record);
        },
        (reason: unknown) => {
          record.physicalState = "rejected";
          record.failure = { reason };
          this.finishExecutionProducer(record);
        },
      ]);
    } catch (reason) {
      this.failExecutionProducerObservation(record, reason);

      throw reason;
    }
  }

  private failExecutionProducerInvocation(
    record: NativeExecutionProducerRecord,
    reason: unknown,
  ): { readonly reason: unknown } | undefined {
    if (!this.outstandingExecutionProducers.has(record) || record.state !== "reserved")
      throw new TypeError("Only an unstarted native execution producer can fail invocation");

    record.state = "invocation-failed";
    record.failure = { reason };
    if (!record.observeFailedPhysicalRetirement) return undefined;

    try {
      nativeReflectApply(nativePromiseThen, record.lifetime.retired, [
        () => {
          record.physicalState = "fulfilled";
          this.finishExecutionProducer(record);
        },
        () => {
          record.physicalState = "rejected";
          this.finishExecutionProducer(record);
        },
      ]);
    } catch (reason) {
      record.physicalState = "unacknowledged";
      record.state = "unacknowledged";
      return { reason };
    }

    return undefined;
  }

  private failExecutionProducerObservation(
    record: NativeExecutionProducerRecord,
    reason: unknown,
  ): void {
    record.state = "unacknowledged";
    record.failure = { reason };
  }

  private completeExecutionProducer(record: NativeExecutionProducerRecord): void {
    if (!this.outstandingExecutionProducers.has(record) || record.completeRequested) return;

    if (record.state === "reserved") {
      this.failExecutionProducerObservation(
        record,
        new Error("A native execution producer supplied no original operation outcome"),
      );

      return;
    }

    record.completeRequested = true;
    this.finishExecutionProducer(record);
  }

  private finishExecutionProducer(record: NativeExecutionProducerRecord): void {
    if (
      !record.completeRequested ||
      record.state === "unacknowledged" ||
      record.physicalState === "pending"
    )
      return;

    if (this.outstandingExecutionProducers.delete(record)) this.executionProducerChanged();
  }

  get retainedFailures(): readonly unknown[] {
    return [...this.failures]
      .sort((left, right) => left.acquisition - right.acquisition || left.order - right.order)
      .map(({ reason }) => reason.value);
  }

  private complete(record: NativeHttpRequestUseRecord): void {
    record.retainUnacknowledgedOriginals(this.unacknowledgedOriginals);
    this.outstanding.delete(record);
    this.failures.push(...record.failures);

    if (this.byRequest.get(record.request) === record) this.byRequest.delete(record.request);

    this.changed(record.view);
  }
}
