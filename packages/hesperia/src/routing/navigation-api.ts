import type { HesperiaNavigation, RequiredNavigationResult } from "../navigation.ts";
import { RenderFault, type Owner } from "../runtime/owner.ts";
import type { HistoryTracker } from "./history.ts";
import type { BrowserHistoryEntry } from "./browser-history.ts";
import type { RouteRenderFailureReader } from "./navigation-outcome.ts";
import { requiresDevelopmentReload } from "./development.ts";
import {
  browserHref,
  isWithinMount,
  normalizeMountPath,
  resolveNavigationTarget,
} from "./navigation-url.ts";
import { nativeNavigationFor, supportsNativeNavigation } from "./native-navigation.ts";

export interface NavigationRouter {
  navigate(
    target: string | URL,
    options: { readonly history: "push" | "replace" | "none"; readonly state?: unknown },
  ): Promise<{ readonly status: "committed" | "denied" | "cancelled"; readonly url: string }>;

  navigateWithCommit(
    target: string | URL,
    options: { readonly history: "push" | "replace" | "none"; readonly state?: unknown },
    onCommit: (entry: BrowserHistoryEntry, readRenderFailure: RouteRenderFailureReader) => void,
    reloadAdmission?: {
      readonly applicationOwner?: Owner;
      readonly signal?: AbortSignal;
      readonly onAdmitted?: () => void;
    },
  ): Promise<{ readonly status: "committed" | "denied" | "cancelled"; readonly url: string }>;

  handleNavigationEvent(
    event: NavigateEvent,
    afterCommit: (commit: () => void, readRenderFailure?: RouteRenderFailureReader) => void,
  ): Promise<{
    readonly status: "committed" | "denied" | "cancelled";
    readonly url: string;
    readonly reason?: unknown;
  }>;

  cancel(reason?: unknown): void;

  observeHistory(observer: NavigationHistoryObserver): () => void;
}

/** Internal route-history outcomes used by the History-based Navigation facade. */
export interface NavigationHistoryObserver {
  entryCommitted(entry: BrowserHistoryEntry, disposition: "push" | "replace" | "none"): void;

  traversalAccepted(entry: BrowserHistoryEntry): void;

  traversalCommitted(
    entry: BrowserHistoryEntry,
    readRenderFailure?: RouteRenderFailureReader,
  ): void;

  traversalRejected(entry: BrowserHistoryEntry | undefined, error: unknown): void;
}

export interface NavigationScheduler {
  settled(): Promise<void>;
}

export interface NavigationReservation {
  readonly window: Window;
  readonly mountPath: string;
  readonly native: boolean;
  readonly facade: HesperiaNavigation;

  setHistoryTracker(tracker: HistoryTracker): void;

  attachRouter(
    router: NavigationRouter,
    scheduler: NavigationScheduler,
    applicationOwner?: Owner,
  ): void;

  beginInitialNavigation(initial: Promise<unknown>): Promise<void>;

  /** @internal Transfer native traversal interception to the installed browser-history adapter. */
  historyAdapterInstalled(): void;

  release(reason?: unknown): void;
}

interface PendingFallbackCall {
  target: URL;
  history: "push" | "replace" | "none";
  navigationType: "push" | "replace" | "reload";
  state: unknown;
  info: unknown;
  readonly result: DeferredResult;
  committedEntry?: NavigationHistoryEntry;
  readRenderFailure?: RouteRenderFailureReader;
}

interface FallbackEntryRecord {
  key: string;
  id: string;
  index: number;
  url: string;
  state: unknown;
  entry: NavigationHistoryEntry;
}

interface PendingFallbackTraversal {
  readonly key: string;
  readonly result: DeferredResult;
  readonly signalController: AbortController;
  readonly afterCommit: readonly (() => PromiseLike<void> | void)[];
  readonly markCommitted: () => void;
  readonly markFinished: () => void;
  accepted: boolean;
}

interface DeferredResult {
  readonly value: RequiredNavigationResult;

  resolveCommitted(entry: NavigationHistoryEntry): void;

  rejectCommitted(error: unknown): void;

  resolveFinished(entry: NavigationHistoryEntry): void;

  rejectFinished(error: unknown): void;
}

interface PendingDocumentReload {
  readonly controller: AbortController;
  readonly result: DeferredResult;
}

const reservations = new WeakMap<Window, NavigationReservation>();
const devHardReloadEvent = "hesperia:dev-hard-reload";

interface DevHardReloadRequest {
  consumed: boolean;
}

/** Reserve a routed Window before any authored module is evaluated. */
export function reserveNavigation(window: Window, mountPath = "/"): NavigationReservation {
  if (reservations.has(window))
    throw new RenderFault(
      "navigation-reserved",
      "This Window already has a routed Hesperia application starting or mounted",
    );

  const normalizedMount = normalizeMountPath(mountPath);
  const reservation = new WindowNavigationReservation(window, normalizedMount);

  reservations.set(window, reservation);

  return reservation;
}

/** Resolve the shared named export to the reservation for its own module realm. */
export function navigationForCurrentWindow(): HesperiaNavigation {
  const window = (globalThis as typeof globalThis & { window?: Window }).window;

  if (!window) throw new RenderFault("navigation-inactive", "Navigation requires an active Window");

  const reservation = reservations.get(window);

  if (!reservation)
    throw new RenderFault(
      "navigation-inactive",
      "No routed Hesperia application is active in this Window",
    );

  return reservation.facade;
}

/** @internal Used by focused runtime tests and the generated bootstrap. */
export function navigationReservationFor(window: Window): NavigationReservation | undefined {
  return reservations.get(window);
}

function domException(window: Window, message: string, name: string): DOMException {
  const Constructor = (window as Window & { DOMException?: typeof DOMException }).DOMException;
  return Constructor ? new Constructor(message, name) : new DOMException(message, name);
}

function deferredResult(): DeferredResult {
  let resolveCommitted!: (entry: NavigationHistoryEntry) => void;
  let rejectCommitted!: (error: unknown) => void;
  let resolveFinished!: (entry: NavigationHistoryEntry) => void;
  let rejectFinished!: (error: unknown) => void;
  const committed = new Promise<NavigationHistoryEntry>((resolve, reject) => {
    resolveCommitted = resolve;
    rejectCommitted = reject;
  });
  const finished = new Promise<NavigationHistoryEntry>((resolve, reject) => {
    resolveFinished = resolve;
    rejectFinished = reject;
  });

  // Native Navigation marks these promises handled even when the caller ignores them.
  void committed.catch(() => undefined);

  void finished.catch(() => undefined);

  return {
    value: { committed, finished },
    resolveCommitted,
    rejectCommitted,
    resolveFinished,
    rejectFinished,
  };
}

class WindowNavigationReservation implements NavigationReservation {
  readonly window: Window;
  readonly mountPath: string;
  readonly native: boolean;
  readonly facade: HesperiaNavigation;
  private readonly nativeNavigation: Navigation | undefined;
  private readonly fallbackTarget: EventTarget;
  private readonly fallbackRecords = new Map<string, FallbackEntryRecord>();
  private nextFallbackEntryId = 0;
  private fallbackCurrentKey: string | undefined;
  private router: NavigationRouter | undefined;
  private scheduler: NavigationScheduler | undefined;
  private applicationOwner: Owner | undefined;
  private tracker: HistoryTracker | undefined;
  private removeHistoryTrackerObserver: (() => void) | undefined;
  private disposed = false;
  private startup = true;
  private historyAdapterOwnsTraversals = false;
  private initialStarted!: () => void;
  private readonly initialGate = new Promise<void>((resolve) => {
    this.initialStarted = resolve;
  });
  private latestStartup: Promise<unknown> | undefined;
  private pendingFallback: PendingFallbackCall | undefined;
  private activeFallbackCall: PendingFallbackCall | undefined;
  private activeFallbackController: AbortController | undefined;
  private fallbackTransition: NavigationTransition | null = null;
  private fallbackActivation: NavigationActivation | null = null;
  private pendingFallbackTraversal: PendingFallbackTraversal | undefined;
  private removeRouterObserver: (() => void) | undefined;
  private readonly nativeNavigateListener: ((event: Event) => void) | undefined;
  private readonly devHardReloadRequestListener: ((event: Event) => void) | undefined;
  private readonly pendingDevHardReloads = new Map<object, DevHardReloadRequest>();
  private pendingDocumentReload: PendingDocumentReload | undefined;

  constructor(window: Window, mountPath: string) {
    this.window = window;
    this.mountPath = mountPath;
    this.native = supportsNativeNavigation(window);
    this.nativeNavigation = nativeNavigationFor(window);
    const EventTargetConstructor = (window as Window & { EventTarget?: typeof EventTarget })
      .EventTarget;
    this.fallbackTarget = EventTargetConstructor ? new EventTargetConstructor() : new EventTarget();

    if (!this.native) {
      const initial = this.recordFallbackEntry(
        {
          key: `hesperia-fallback-${window.location.href}`,
          index: 0,
          url: window.location.href,
          state: window.history.state,
        },
        { current: true },
      );
      const timing = window.performance.getEntriesByType("navigation")[0] as
        | PerformanceNavigationTiming
        | undefined;
      this.fallbackActivation = {
        from: null,
        entry: initial.entry,
        navigationType:
          timing?.type === "reload"
            ? "reload"
            : timing?.type === "back_forward"
              ? "traverse"
              : "push",
      };
    }

    this.facade = this.createFacade();
    this.nativeNavigateListener = this.nativeNavigation
      ? (event) => this.handleNativeNavigate(event as NavigateEvent)
      : undefined;
    this.devHardReloadRequestListener = (event) => this.handleDevHardReloadRequest(event);

    this.window.addEventListener(devHardReloadEvent, this.devHardReloadRequestListener);

    if (this.nativeNavigation) {
      this.nativeNavigation.addEventListener("navigate", this.nativeNavigateListener!);
    }
  }

  setHistoryTracker(tracker: HistoryTracker): void {
    this.assertActive();

    this.removeHistoryTrackerObserver?.();

    this.tracker = tracker;
    const tracked = tracker.read();

    if (!this.native && tracked) {
      const current = this.fallbackCurrentKey
        ? this.fallbackRecords.get(this.fallbackCurrentKey)
        : undefined;

      if (current) this.fallbackRecords.delete(current.key);

      const initial = this.recordFallbackEntry(
        {
          key: `hesperia-${tracked.trackerId}-${tracked.id}`,
          index: tracked.position,
          url: tracked.url,
          state: tracked.state,
        },
        { current: true, preserve: current, apiState: tracked.navigationState },
      );
      initial.state = tracked.navigationState;

      if (this.fallbackActivation)
        this.fallbackActivation = { ...this.fallbackActivation, entry: initial.entry };
    }

    this.removeHistoryTrackerObserver = tracker.observeNativeWrites((entry, disposition) => {
      if (this.native || this.disposed) return;

      this.recordFallbackEntry(
        {
          key: `hesperia-${entry.trackerId}-${entry.id}`,
          index: entry.position,
          url: entry.url,
          state: entry.state,
        },
        {
          current: true,
          prune: disposition === "push",
          notify: true,
          navigationType: disposition,
          apiState: entry.navigationState,
        },
      );
    });
  }

  attachRouter(
    router: NavigationRouter,
    scheduler: NavigationScheduler,
    applicationOwner?: Owner,
  ): void {
    this.assertActive();

    this.router = router;
    this.scheduler = scheduler;
    this.applicationOwner = applicationOwner;

    this.removeRouterObserver?.();

    this.removeRouterObserver = router.observeHistory({
      entryCommitted: (entry, disposition) => {
        if (this.native) return;

        const type = this.activeFallbackCall?.navigationType;
        const tracked = this.tracker?.read(entry.url);

        this.recordFallbackEntry(entry, {
          current: true,
          prune: disposition === "push",
          notify: disposition !== "none" && type !== "reload",
          navigationType: type ?? (disposition === "none" ? undefined : disposition),
          apiState: this.activeFallbackCall
            ? this.activeFallbackCall.state
            : tracked?.navigationState,
        });
      },
      traversalAccepted: (entry) => {
        if (this.native) return;

        const tracked = this.tracker?.read(entry.url);
        const record = this.recordFallbackEntry(entry, {
          current: true,
          notify: true,
          navigationType: "traverse",
          apiState: tracked?.navigationState,
        });
        const pending = this.pendingFallbackTraversal;

        if (!pending) return;

        if (pending.signalController.signal.aborted) return;

        if (pending.key !== record.key) {
          this.pendingFallbackTraversal = undefined;

          pending.signalController.abort(
            this.abortError("Traversal reached a different history entry"),
          );

          this.rejectFallback(
            pending.result,
            this.abortError("Traversal reached a different history entry"),
          );

          return;
        }

        pending.accepted = true;

        pending.result.resolveCommitted(record.entry);

        pending.markCommitted();
      },
      traversalCommitted: (entry, readRenderFailure) => {
        if (this.native) return;

        const tracked = this.tracker?.read(entry.url);
        const record = this.recordFallbackEntry(entry, {
          current: true,
          apiState: tracked?.navigationState,
        });
        const pending = this.pendingFallbackTraversal;

        if (!pending || pending.key !== record.key) return;

        this.pendingFallbackTraversal = undefined;

        void (async () => {
          try {
            for (const handler of pending.afterCommit) await handler();

            await this.scheduler?.settled();

            if (pending.signalController.signal.aborted) return;

            const failure = readRenderFailure?.();

            if (failure) {
              pending.result.rejectFinished(failure.error);

              this.dispatchFallback("navigateerror", { error: failure.error });

              return;
            }

            pending.result.resolveFinished(record.entry);

            pending.markFinished();

            this.dispatchFallback("navigatesuccess", {});
          } catch (error) {
            pending.result.rejectFinished(error);

            this.dispatchFallback("navigateerror", { error });
          }
        })();
      },
      traversalRejected: (entry, error) => {
        if (this.native) return;

        const pending = this.pendingFallbackTraversal;

        if (!pending || (entry && pending.key !== entry.key)) return;

        this.pendingFallbackTraversal = undefined;

        pending.signalController.abort(error);

        if (pending.accepted) pending.result.rejectFinished(error);
        else this.rejectFallback(pending.result, error);

        this.dispatchFallback("navigateerror", { error });
      },
    });
  }

  historyAdapterInstalled(): void {
    this.assertActive();

    this.historyAdapterOwnsTraversals = true;
  }

  async beginInitialNavigation(initial: Promise<unknown>): Promise<void> {
    this.assertActive();

    this.latestStartup = initial;

    void initial.catch(() => undefined);

    this.initialStarted();

    const queued = this.pendingFallback;
    this.pendingFallback = undefined;

    if (queued) this.latestStartup = this.runFallback(queued);

    while (this.startup) {
      const current: Promise<unknown> | undefined = this.latestStartup;

      if (!current) break;

      await current;

      await Promise.resolve();

      if (this.latestStartup === current) break;
    }

    this.startup = false;
  }

  release(
    reason: unknown = domException(
      this.window,
      "The routed application was disposed",
      "AbortError",
    ),
  ): void {
    if (this.disposed) return;

    this.disposed = true;

    this.nativeNavigation?.removeEventListener("navigate", this.nativeNavigateListener!);

    if (this.devHardReloadRequestListener)
      this.window.removeEventListener(devHardReloadEvent, this.devHardReloadRequestListener);

    this.pendingDevHardReloads.clear();

    const pendingReload = this.pendingDocumentReload;

    if (pendingReload) {
      this.pendingDocumentReload = undefined;

      pendingReload.controller.abort(reason);

      this.rejectFallback(pendingReload.result, reason);
    }

    this.removeRouterObserver?.();

    this.removeRouterObserver = undefined;

    this.removeHistoryTrackerObserver?.();

    this.removeHistoryTrackerObserver = undefined;

    this.router?.cancel(reason);

    if (this.pendingFallback) this.rejectFallback(this.pendingFallback.result, reason);

    this.pendingFallback = undefined;

    this.activeFallbackController?.abort(reason);

    if (this.activeFallbackCall) this.rejectFallback(this.activeFallbackCall.result, reason);

    this.activeFallbackCall = undefined;
    this.activeFallbackController = undefined;

    if (this.pendingFallbackTraversal)
      this.rejectFallback(this.pendingFallbackTraversal.result, reason);

    this.pendingFallbackTraversal?.signalController.abort(reason);

    this.pendingFallbackTraversal = undefined;

    if (reservations.get(this.window) === this) reservations.delete(this.window);
  }

  private assertActive(): void {
    if (this.disposed)
      throw new RenderFault("navigation-inactive", "The routed application was disposed");
  }

  private resolve(target: string | URL): URL {
    return resolveNavigationTarget(target, this.window.location.href, this.mountPath);
  }

  private createFacade(): HesperiaNavigation {
    const target = this.nativeNavigation ?? this.fallbackTarget;
    const facade = new Proxy(target, {
      get: (current, property) => {
        this.assertActive();

        if (property === "href")
          return (destination: string | URL) =>
            browserHref(this.resolve(destination), this.window.location.href);

        if (property === "navigate")
          return (destination: string | URL, options?: NavigationNavigateOptions) =>
            this.navigate(destination, options);

        if (property === "reload")
          return (options?: NavigationReloadOptions) => this.reloadDocument(options);

        if (!this.nativeNavigation) return this.fallbackProperty(property);

        if (property === "back" || property === "forward" || property === "traverseTo") {
          const method = Reflect.get(current, property, current) as unknown;
          return typeof method === "function"
            ? (...args: unknown[]) => {
                this.cancelPendingDocumentReload(
                  this.abortError("A newer navigation superseded reload admission"),
                );

                return Reflect.apply(method, current, args);
              }
            : method;
        }

        const value = Reflect.get(current, property, current) as unknown;

        if (
          property === "onnavigate" ||
          property === "onnavigatesuccess" ||
          property === "onnavigateerror" ||
          property === "oncurrententrychange"
        )
          return value;

        return typeof value === "function" ? value.bind(current) : value;
      },
      set: (current, property, value) => {
        this.assertActive();

        if (!this.nativeNavigation) return this.setFallbackProperty(property, value);

        return Reflect.set(current, property, value, current);
      },
      has: (current, property) =>
        property === "href" ||
        (!this.nativeNavigation &&
          [
            "addEventListener",
            "removeEventListener",
            "dispatchEvent",
            "navigate",
            "reload",
            "entries",
            "currentEntry",
            "updateCurrentEntry",
            "transition",
            "activation",
            "canGoBack",
            "canGoForward",
            "back",
            "forward",
            "traverseTo",
            "onnavigate",
            "onnavigatesuccess",
            "onnavigateerror",
            "oncurrententrychange",
          ].includes(property as string)) ||
        Reflect.has(current, property),
    });
    return facade as HesperiaNavigation;
  }

  private fallbackProperty(property: PropertyKey): unknown {
    if (property === "addEventListener")
      return this.fallbackTarget.addEventListener.bind(this.fallbackTarget);

    if (property === "removeEventListener")
      return this.fallbackTarget.removeEventListener.bind(this.fallbackTarget);

    if (property === "dispatchEvent")
      return this.fallbackTarget.dispatchEvent.bind(this.fallbackTarget);

    if (property === "entries") return () => this.fallbackEntries();

    if (property === "currentEntry") return this.fallbackCurrentEntry();

    if (property === "canGoBack") return this.fallbackCanGo(-1);

    if (property === "canGoForward") return this.fallbackCanGo(1);

    if (property === "transition") return this.fallbackTransition;

    if (property === "activation") return this.fallbackActivation;

    if (property === "reload")
      return (options?: NavigationReloadOptions) => this.reloadDocument(options);

    if (property === "back")
      return (options?: NavigationOptions) => this.traverseFallback(-1, options);

    if (property === "forward")
      return (options?: NavigationOptions) => this.traverseFallback(1, options);

    if (property === "traverseTo")
      return (key: string, options?: NavigationOptions) => this.traverseToFallback(key, options);

    if (property === "updateCurrentEntry")
      return (options: NavigationUpdateCurrentEntryOptions) =>
        this.updateFallbackState(options.state);

    if (
      property === "onnavigate" ||
      property === "onnavigatesuccess" ||
      property === "onnavigateerror" ||
      property === "oncurrententrychange"
    )
      return (this as unknown as Record<string, unknown>)[`handler:${property.slice(2)}`] ?? null;

    return undefined;
  }

  private setFallbackProperty(property: PropertyKey, value: unknown): boolean {
    if (
      property === "onnavigate" ||
      property === "onnavigatesuccess" ||
      property === "onnavigateerror" ||
      property === "oncurrententrychange"
    ) {
      const type = property.slice(2);
      const previous = (this as unknown as Record<string, unknown>)[`handler:${type}`] as
        | EventListener
        | null
        | undefined;

      if (previous) this.fallbackTarget.removeEventListener(type, previous);

      if (typeof value === "function") {
        const listener = value as EventListener;
        (this as unknown as Record<string, unknown>)[`handler:${type}`] = listener;

        this.fallbackTarget.addEventListener(type, listener);
      } else (this as unknown as Record<string, unknown>)[`handler:${type}`] = null;

      return true;
    }

    return false;
  }

  private nativeResult(target: URL, options?: NavigationNavigateOptions): RequiredNavigationResult {
    if (requiresDevelopmentReload(this.window, target))
      return this.reloadDocument(options, {
        target,
        history: options?.history === "replace" ? "replace" : "push",
      });

    const native = this.nativeNavigation;

    if (!native) throw new RenderFault("navigation-inactive", "Native Navigation is unavailable");

    const result = native.navigate(target.href, options);
    return result as RequiredNavigationResult;
  }

  private navigateDocument(
    target: URL,
    options?: NavigationNavigateOptions,
  ): RequiredNavigationResult {
    const result = deferredResult();

    try {
      const location = this.window.location;

      if (options?.history === "replace") location.replace(target.href);
      else location.assign(target.href);
    } catch (error) {
      this.rejectFallback(result, error);
    }

    return result.value;
  }

  private navigate(
    target: string | URL,
    options?: NavigationNavigateOptions,
  ): RequiredNavigationResult {
    this.assertActive();

    const url = this.resolve(target);

    this.cancelPendingDocumentReload(
      this.abortError("A newer navigation superseded reload admission"),
    );

    if (this.nativeNavigation) return this.nativeResult(url, options);

    if (url.origin !== this.window.location.origin || !isWithinMount(url.pathname, this.mountPath))
      return this.navigateDocument(url, options);

    if (requiresDevelopmentReload(this.window, url))
      return this.reloadDocument(options, {
        target: url,
        history: options?.history === "replace" ? "replace" : "push",
      });

    const history = options?.history === "replace" ? "replace" : "push";
    let state: unknown;

    try {
      state = options && "state" in options ? structuredClone(options.state) : undefined;
    } catch (error) {
      const result = deferredResult();

      this.rejectFallback(result, error);

      return result.value;
    }

    const result = deferredResult();
    const call: PendingFallbackCall = {
      target: url,
      history,
      navigationType: history,
      state,
      info: options?.info,
      result,
    };

    if (!this.router || this.startup) {
      if (this.pendingFallback)
        this.rejectFallback(
          this.pendingFallback.result,
          this.abortError("A newer navigation superseded this intent"),
        );

      this.pendingFallback = call;
      return result.value;
    }

    void this.runFallback(call);

    return result.value;
  }

  private reloadDocument(
    options?: NavigationReloadOptions,
    destination?: { readonly target: URL; readonly history: "push" | "replace" },
  ): RequiredNavigationResult {
    this.assertActive();

    const result = deferredResult();
    const controller = new AbortController();
    const pending = { controller, result };
    let state: unknown;
    let stateProvided = false;
    let info: unknown;
    let infoProvided = false;

    try {
      stateProvided = options != null && "state" in options;

      if (stateProvided) state = structuredClone(options!.state);

      infoProvided = options != null && "info" in options;

      if (infoProvided) info = options!.info;
    } catch (error) {
      this.rejectFallback(result, error);

      return result.value;
    }

    const nativeOptions: NavigationReloadOptions | undefined =
      stateProvided || infoProvided
        ? {
            ...(stateProvided ? { state } : {}),
            ...(infoProvided ? { info } : {}),
          }
        : undefined;

    this.cancelPendingDocumentReload(this.abortError("A newer reload superseded this request"));

    this.pendingDocumentReload = pending;

    void this.runDocumentReload(pending, stateProvided, state, nativeOptions, destination);

    return result.value;
  }

  private async runDocumentReload(
    pending: PendingDocumentReload,
    stateProvided: boolean,
    state: unknown,
    nativeOptions: NavigationReloadOptions | undefined,
    destination?: { readonly target: URL; readonly history: "push" | "replace" },
  ): Promise<void> {
    try {
      await this.waitForDocumentReloadStartup(pending);

      if (this.pendingDocumentReload !== pending) return;

      const router = this.router;

      if (!router) throw this.abortError("The routed application is not ready to reload");

      const admission = await router.navigateWithCommit(
        this.window.location.href,
        { history: "none", state: stateProvided ? state : undefined },
        () => undefined,
        {
          applicationOwner: this.applicationOwner,
          signal: pending.controller.signal,
          onAdmitted: () => {
            if (this.pendingDocumentReload !== pending)
              throw this.abortError("Document reload admission was superseded");

            this.pendingDocumentReload = undefined;

            if (destination) {
              if (destination.history === "replace")
                this.window.location.replace(destination.target.href);
              else this.window.location.assign(destination.target.href);

              return;
            }

            if (this.nativeNavigation) {
              const nativeResult = this.nativeNavigation.reload(
                nativeOptions,
              ) as RequiredNavigationResult;

              void nativeResult.committed.then(
                pending.result.resolveCommitted,
                pending.result.rejectCommitted,
              );

              void nativeResult.finished.then(
                pending.result.resolveFinished,
                pending.result.rejectFinished,
              );

              return;
            }

            if (stateProvided) {
              const updated = this.tracker?.updateNavigationState(state);
              const current = this.fallbackCurrentKey
                ? this.fallbackRecords.get(this.fallbackCurrentKey)
                : undefined;

              if (current) current.state = updated?.navigationState ?? state;
            }

            this.window.location.reload();
          },
        },
      );

      if (admission.status !== "committed")
        throw this.abortError("Document reload was denied or superseded");
    } catch (error) {
      if (this.pendingDocumentReload === pending) this.pendingDocumentReload = undefined;

      this.rejectFallback(pending.result, error);
    }
  }

  private async waitForDocumentReloadStartup(pending: PendingDocumentReload): Promise<void> {
    const wait = async <T>(promise: PromiseLike<T>): Promise<T> => {
      if (pending.controller.signal.aborted) throw pending.controller.signal.reason;

      let removeAbort: (() => void) | undefined;

      try {
        return await Promise.race([
          Promise.resolve(promise),
          new Promise<never>((_, reject) => {
            const abort = () => reject(pending.controller.signal.reason);

            pending.controller.signal.addEventListener("abort", abort, { once: true });

            removeAbort = () => pending.controller.signal.removeEventListener("abort", abort);
          }),
        ]);
      } finally {
        removeAbort?.();
      }
    };

    await wait(this.initialGate);

    while (this.startup) {
      const current = this.latestStartup;

      if (!current) break;

      await wait(current);

      await Promise.resolve();

      if (this.latestStartup === current) break;
    }
  }

  private cancelPendingDocumentReload(reason: unknown): void {
    const pending = this.pendingDocumentReload;

    if (!pending) return;

    this.pendingDocumentReload = undefined;

    pending.controller.abort(reason);

    this.rejectFallback(pending.result, reason);
  }

  private async runFallback(call: PendingFallbackCall): Promise<unknown> {
    const router = this.router;

    if (!router) return undefined;

    if (this.activeFallbackCall && this.activeFallbackCall !== call) {
      const reason = this.abortError("A newer navigation superseded this intent");

      this.activeFallbackController?.abort(reason);

      this.rejectFallback(this.activeFallbackCall.result, reason);
    }

    if (this.pendingFallbackTraversal) {
      const reason = this.abortError("A newer navigation superseded this traversal");

      this.pendingFallbackTraversal.signalController.abort(reason);

      this.rejectFallback(this.pendingFallbackTraversal.result, reason);

      this.pendingFallbackTraversal = undefined;
    }

    const signalController = new AbortController();
    this.activeFallbackCall = call;
    this.activeFallbackController = signalController;
    const issued = this.createFallbackNavigateEvent(
      call.target,
      call.navigationType,
      call.state,
      call.info,
      signalController.signal,
    );

    if (issued.event.defaultPrevented) {
      signalController.abort(this.abortError("Navigation was prevented"));

      this.rejectFallback(call.result, this.abortError("Navigation was prevented"));

      if (this.activeFallbackCall === call) {
        this.activeFallbackCall = undefined;
        this.activeFallbackController = undefined;
      }

      return undefined;
    }

    this.beginFallbackTransition(
      () => issued.event.navigationType,
      issued.event.destination,
      call.result.value,
    );

    try {
      const precommitController = {
        redirect: (url: string | URL, options?: NavigationNavigateOptions) =>
          issued.redirect(url, options),
        addHandler: (handler: () => PromiseLike<void> | void) => {
          issued.afterCommit.push(handler);
        },
      } as NavigationPrecommitController;

      for (const handler of issued.beforeCommit) await handler(precommitController);

      if (signalController.signal.aborted) throw signalController.signal.reason;

      const redirected = issued.resolved;
      call.target = redirected.target;
      call.navigationType = redirected.navigationType as "push" | "replace" | "reload";
      call.history =
        redirected.navigationType === "reload"
          ? "none"
          : (redirected.navigationType as "push" | "replace");
      call.state = redirected.state;
      call.info = redirected.info;

      if (
        this.tracker &&
        call.navigationType !== "reload" &&
        call.target.href === this.window.location.href &&
        call.target.href.includes("#")
      ) {
        const prepared = this.tracker.create(call.target.href, null, call.history);

        if (!prepared)
          throw new RenderFault("history-entry", "The unchanged fragment has no tracked entry");

        this.tracker.apply(prepared, call.history);

        const updated = this.tracker.updateNavigationState(call.state);
        const tracked = updated ?? this.tracker.read(call.target.href);
        const record = tracked
          ? this.recordFallbackEntry(
              {
                key: `hesperia-${tracked.trackerId}-${tracked.id}`,
                index: tracked.position,
                url: tracked.url,
                state: tracked.state,
              },
              {
                current: true,
                prune: call.history === "push",
                apiState: tracked.navigationState,
              },
            )
          : this.fallbackRecordForUrl(call.target.href, call.state);
        record.state = tracked ? tracked.navigationState : call.state;
        const entry = record.entry;
        call.committedEntry = entry;

        call.result.resolveCommitted(entry);

        issued.markCommitted();

        for (const handler of issued.afterCommit) await handler();

        await this.scheduler?.settled();

        if (signalController.signal.aborted) throw signalController.signal.reason;

        call.result.resolveFinished(entry);

        issued.markFinished();

        this.dispatchFallback("navigatesuccess", {});

        return { status: "committed", url: call.target.href };
      }

      const result = await router.navigateWithCommit(
        call.target,
        { history: call.history, state: null },
        (entry, readRenderFailure) => {
          this.tracker?.updateNavigationState(call.state);

          call.committedEntry = this.fallbackRecords.get(entry.key)?.entry;
          call.readRenderFailure = readRenderFailure;
        },
      );

      if (result.status !== "committed") {
        this.rejectFallback(call.result, this.abortError("Navigation was denied or superseded"));

        this.dispatchFallback("navigateerror", {
          error: this.abortError("Navigation was denied or superseded"),
        });

        return result;
      }

      if (signalController.signal.aborted) throw signalController.signal.reason;

      const tracked = this.tracker?.read(result.url);
      const record = tracked
        ? this.recordFallbackEntry(
            {
              key: `hesperia-${tracked.trackerId}-${tracked.id}`,
              index: tracked.position,
              url: tracked.url,
              state: tracked.state,
            },
            { current: true, prune: true, apiState: tracked.navigationState },
          )
        : this.fallbackRecordForUrl(result.url, call.state);
      record.state = tracked ? tracked.navigationState : call.state;

      if (call.navigationType === "reload") {
        this.dispatchCurrentEntryChange("reload", record.entry);
      }

      const entry = record.entry;

      call.result.resolveCommitted(entry);

      issued.markCommitted();

      for (const handler of issued.afterCommit) await handler();

      await this.scheduler?.settled();

      const failure = call.readRenderFailure?.();

      if (failure) {
        call.result.rejectFinished(failure.error);

        this.dispatchFallback("navigateerror", { error: failure.error });

        return result;
      }

      call.result.resolveFinished(entry);

      issued.markFinished();

      this.dispatchFallback("navigatesuccess", {});

      return result;
    } catch (error) {
      signalController.abort(error);

      if (call.committedEntry) {
        call.result.resolveCommitted(call.committedEntry);

        call.result.rejectFinished(error);
      } else this.rejectFallback(call.result, error);

      this.dispatchFallback("navigateerror", { error });

      return undefined;
    } finally {
      if (this.activeFallbackCall === call) {
        this.activeFallbackCall = undefined;
        this.activeFallbackController = undefined;
      }
    }
  }

  private fallbackCurrentEntry(): NavigationHistoryEntry | null {
    const current = this.fallbackCurrentKey
      ? this.fallbackRecords.get(this.fallbackCurrentKey)
      : undefined;

    if (current) return current.entry;

    return this.fallbackRecordForUrl(this.window.location.href, this.window.history.state).entry;
  }

  private fallbackEntries(): NavigationHistoryEntry[] {
    return [...this.fallbackRecords.values()]
      .sort((left, right) => left.index - right.index)
      .map(({ entry }) => entry);
  }

  private fallbackCanGo(delta: -1 | 1): boolean {
    const current = this.fallbackCurrentKey
      ? this.fallbackRecords.get(this.fallbackCurrentKey)
      : undefined;

    if (!current) return false;

    return [...this.fallbackRecords.values()].some((entry) =>
      delta < 0 ? entry.index < current.index : entry.index > current.index,
    );
  }

  private earlyFallbackError(message: string): RequiredNavigationResult {
    const result = deferredResult();

    this.rejectFallback(result, domException(this.window, message, "InvalidStateError"));

    return result.value;
  }

  private traverseFallback(delta: number, options?: NavigationOptions): RequiredNavigationResult {
    const current = this.fallbackCurrentKey
      ? this.fallbackRecords.get(this.fallbackCurrentKey)
      : undefined;

    if (!current) return this.earlyFallbackError("No current history entry exists");

    const target = [...this.fallbackRecords.values()].find(
      (entry) => entry.index === current.index + delta,
    );

    if (!target)
      return this.earlyFallbackError("No tracked history entry exists in that direction");

    this.cancelPendingDocumentReload(
      this.abortError("A newer traversal superseded reload admission"),
    );

    const result = deferredResult();

    this.startFallbackTraversal(target, result, options);

    return result.value;
  }

  private traverseToFallback(key: string, options?: NavigationOptions): RequiredNavigationResult {
    const target = this.fallbackRecords.get(key);

    if (!target) return this.earlyFallbackError(`No NavigationHistoryEntry exists for key ${key}`);

    const current = this.fallbackCurrentKey
      ? this.fallbackRecords.get(this.fallbackCurrentKey)
      : undefined;

    if (!current) return this.earlyFallbackError("No current history entry exists");

    if (target.key === current.key) {
      const result = deferredResult();

      result.resolveCommitted(current.entry);

      result.resolveFinished(current.entry);

      return result.value;
    }

    this.cancelPendingDocumentReload(
      this.abortError("A newer traversal superseded reload admission"),
    );

    const result = deferredResult();

    this.startFallbackTraversal(target, result, options);

    return result.value;
  }

  private startFallbackTraversal(
    target: FallbackEntryRecord,
    result: DeferredResult,
    options?: NavigationOptions,
  ): void {
    if (!this.router || this.startup) {
      this.rejectFallback(result, this.abortError("Navigation is not ready"));

      return;
    }

    if (this.pendingFallbackTraversal) {
      this.pendingFallbackTraversal.signalController.abort(
        this.abortError("A newer traversal superseded this intent"),
      );

      this.rejectFallback(
        this.pendingFallbackTraversal.result,
        this.abortError("A newer traversal superseded this intent"),
      );
    }

    const signalController = new AbortController();
    const issued = this.createFallbackNavigateEvent(
      new URL(target.url),
      "traverse",
      target.state,
      options?.info,
      signalController.signal,
      target,
    );

    if (issued.event.defaultPrevented) {
      signalController.abort(this.abortError("Navigation was prevented"));

      this.rejectFallback(result, this.abortError("Navigation was prevented"));

      return;
    }

    this.pendingFallbackTraversal = {
      key: target.key,
      result,
      signalController,
      afterCommit: issued.afterCommit,
      markCommitted: issued.markCommitted,
      markFinished: issued.markFinished,
      accepted: false,
    };

    this.beginFallbackTransition(() => "traverse", issued.event.destination, result.value);

    const current = this.fallbackCurrentKey
      ? this.fallbackRecords.get(this.fallbackCurrentKey)
      : undefined;

    if (!current) {
      this.pendingFallbackTraversal = undefined;

      this.rejectFallback(
        result,
        domException(this.window, "No current history entry exists", "InvalidStateError"),
      );

      return;
    }

    void (async () => {
      const precommitController = {
        redirect: (url: string | URL, redirectOptions?: NavigationNavigateOptions) =>
          issued.redirect(url, redirectOptions),
        addHandler: (handler: () => PromiseLike<void> | void) => {
          issued.afterCommit.push(handler);
        },
      } as NavigationPrecommitController;

      try {
        for (const handler of issued.beforeCommit) await handler(precommitController);

        if (this.pendingFallbackTraversal?.result !== result) return;

        this.window.history.go(target.index - current.index);
      } catch (error) {
        this.pendingFallbackTraversal = undefined;

        signalController.abort(error);

        this.rejectFallback(result, error);
      }
    })();
  }

  private fallbackRecordForUrl(url: string, state: unknown): FallbackEntryRecord {
    const tracked = this.tracker?.read(url);

    if (tracked)
      return this.recordFallbackEntry(
        {
          key: `hesperia-${tracked.trackerId}-${tracked.id}`,
          index: tracked.position,
          url: tracked.url,
          state: tracked.state,
        },
        { current: url === this.window.location.href, apiState: tracked.navigationState },
      );

    const current = this.fallbackCurrentKey
      ? this.fallbackRecords.get(this.fallbackCurrentKey)
      : undefined;
    return this.recordFallbackEntry(
      {
        key: `hesperia-fallback-${url}`,
        index: current?.index ?? 0,
        url,
        state,
      },
      { current: url === this.window.location.href },
    );
  }

  private recordFallbackEntry(
    entry: BrowserHistoryEntry,
    options: {
      readonly current?: boolean;
      readonly prune?: boolean;
      readonly notify?: boolean;
      readonly navigationType?: "push" | "replace" | "reload" | "traverse" | null;
      readonly apiState?: unknown;
      readonly preserve?: FallbackEntryRecord;
    } = {},
  ): FallbackEntryRecord {
    const previousCurrent = this.fallbackCurrentKey
      ? this.fallbackRecords.get(this.fallbackCurrentKey)
      : undefined;
    const existing = this.fallbackRecords.get(entry.key);
    const navigationType =
      options.navigationType ?? (previousCurrent?.key === entry.key ? "replace" : "push");
    const replaced = options.notify && navigationType === "replace" && existing === previousCurrent;
    let record = replaced ? undefined : (existing ?? options.preserve);

    if (!record) {
      const backing: FallbackEntryRecord = {
        key: entry.key,
        id: `hesperia-entry-${++this.nextFallbackEntryId}`,
        index: entry.index,
        url: entry.url,
        state: options.apiState,
        entry: undefined as unknown as NavigationHistoryEntry,
      };
      const EventTargetConstructor = (this.window as Window & { EventTarget?: typeof EventTarget })
        .EventTarget;
      const entryTarget = EventTargetConstructor ? new EventTargetConstructor() : new EventTarget();
      let ondispose: EventListener | null = null;

      Object.defineProperties(entryTarget, {
        key: { get: () => backing.key },
        id: { get: () => backing.id },
        index: {
          get: () => (this.fallbackRecords.get(backing.key) === backing ? backing.index : -1),
        },
        url: { get: () => backing.url },
        sameDocument: { get: () => true },
        getState: { value: () => structuredClone(backing.state) },
        ondispose: {
          get: () => ondispose,
          set: (handler: unknown) => {
            if (ondispose) entryTarget.removeEventListener("dispose", ondispose);

            ondispose = typeof handler === "function" ? (handler as EventListener) : null;

            if (ondispose) entryTarget.addEventListener("dispose", ondispose);
          },
        },
      });

      backing.entry = entryTarget as NavigationHistoryEntry;
      record = backing;
    }

    const disposed: FallbackEntryRecord[] = [];

    if (options.prune && previousCurrent && entry.index > previousCurrent.index) {
      for (const [key, candidate] of this.fallbackRecords) {
        if (key !== entry.key && candidate.index >= entry.index) {
          this.fallbackRecords.delete(key);

          disposed.push(candidate);
        }
      }
    }

    if (replaced && previousCurrent) disposed.push(previousCurrent);

    const changed =
      options.notify && (replaced || previousCurrent !== record || navigationType === "reload");
    record.key = entry.key;
    record.index = entry.index;
    record.url = entry.url;

    if (Object.prototype.hasOwnProperty.call(options, "apiState")) record.state = options.apiState;

    this.fallbackRecords.set(record.key, record);

    if (options.current) this.fallbackCurrentKey = record.key;

    if (options.current && changed && previousCurrent) {
      this.dispatchCurrentEntryChange(navigationType, previousCurrent.entry);

      for (const old of disposed) old.entry.dispatchEvent(this.createEvent("dispose"));
    }

    return record;
  }

  private updateFallbackState(state: unknown): void {
    const cloned = structuredClone(state);
    const current = this.fallbackCurrentKey
      ? this.fallbackRecords.get(this.fallbackCurrentKey)
      : undefined;

    if (!current) throw new RenderFault("navigation-inactive", "No tracked current entry exists");

    current.state = this.tracker?.updateNavigationState(cloned)?.navigationState ?? cloned;

    this.dispatchCurrentEntryChange(null, current.entry);
  }

  private dispatchCurrentEntryChange(
    navigationType: "push" | "replace" | "reload" | "traverse" | null,
    from: NavigationHistoryEntry,
  ): void {
    const event = this.createEvent("currententrychange");

    Object.defineProperties(event, {
      navigationType: { value: navigationType, enumerable: true },
      from: { value: from, enumerable: true },
    });

    this.fallbackTarget.dispatchEvent(event);
  }

  private abortError(message: string): DOMException {
    return domException(this.window, message, "AbortError");
  }

  private rejectFallback(result: DeferredResult, error: unknown): void {
    result.rejectCommitted(error);

    result.rejectFinished(error);
  }

  private dispatchFallback(type: string, detail: unknown): void {
    const event = this.createEvent(type);

    if (detail !== null && typeof detail === "object")
      for (const [name, value] of Object.entries(detail))
        Object.defineProperty(event, name, { value, enumerable: true });

    this.fallbackTarget.dispatchEvent(event);
  }

  private createEvent(type: string, init?: EventInit): Event {
    const EventConstructor = (this.window as Window & { Event?: typeof Event }).Event;
    return EventConstructor ? new EventConstructor(type, init) : new Event(type, init);
  }

  private createFallbackNavigateEvent(
    target: URL,
    navigationType: "push" | "replace" | "reload" | "traverse",
    state: unknown,
    info: unknown,
    signal: AbortSignal,
    destinationEntry?: FallbackEntryRecord,
  ): {
    readonly event: NavigateEvent;
    readonly beforeCommit: Array<
      (controller: NavigationPrecommitController) => PromiseLike<void> | void
    >;
    readonly afterCommit: Array<() => PromiseLike<void> | void>;

    redirect(url: string | URL, options?: NavigationNavigateOptions): void;

    markCommitted(): void;

    markFinished(): void;

    readonly resolved: {
      readonly target: URL;
      readonly navigationType: "push" | "replace" | "reload" | "traverse";
      readonly state: unknown;
      readonly info: unknown;
    };
  } {
    const beforeCommit: Array<
      (controller: NavigationPrecommitController) => PromiseLike<void> | void
    > = [];
    const afterCommit: Array<() => PromiseLike<void> | void> = [];
    let resolvedTarget = target;
    let resolvedType = navigationType;
    let resolvedState = state;
    let resolvedInfo = info;
    const current = new URL(this.window.location.href);
    const hashChange =
      current.origin === target.origin &&
      current.pathname === target.pathname &&
      current.search === target.search &&
      current.hash !== target.hash;
    const destination = {
      get url() {
        return resolvedTarget.href;
      },

      key: destinationEntry?.key ?? "",
      id: destinationEntry?.id ?? "",
      index: destinationEntry?.index ?? -1,
      sameDocument:
        navigationType === "traverse" ||
        hashChange ||
        (current.href === target.href && target.href.includes("#")),
      getState: () => structuredClone(resolvedState),
    } as NavigationDestination;
    const event = this.createEvent("navigate", { cancelable: true }) as NavigateEvent;
    let dispatching = true;
    let intercepted = false;
    let committed = false;
    let scrolled = false;
    let finished = false;
    let manualScroll = false;

    Object.defineProperties(event, {
      navigationType: { get: () => resolvedType, enumerable: true },
      destination: { value: destination, enumerable: true },
      canIntercept: { value: true, enumerable: true },
      userInitiated: { value: false, enumerable: true },
      hashChange: { value: hashChange, enumerable: true },
      signal: { value: signal, enumerable: true },
      formData: { value: null, enumerable: true },
      downloadRequest: { value: null, enumerable: true },
      info: { get: () => resolvedInfo, enumerable: true },
      hasUAVisualTransition: { value: false, enumerable: true },
      sourceElement: { value: null, enumerable: true },
      intercept: {
        value: (options: NavigationInterceptOptions = {}) => {
          if (!dispatching)
            throw domException(
              this.window,
              "Navigation interception has already started",
              "InvalidStateError",
            );

          intercepted = true;

          if (options.scroll === "manual") manualScroll = true;
          else if (options.scroll === "after-transition") manualScroll = false;

          if (options.precommitHandler) beforeCommit.push(options.precommitHandler);

          if (options.handler) afterCommit.push(options.handler);
        },
      },
      scroll: {
        value: () => {
          if (!intercepted || !committed || scrolled || finished)
            throw domException(
              this.window,
              "Navigation cannot be scrolled now",
              "InvalidStateError",
            );

          scrolled = true;

          if (resolvedType === "traverse" || resolvedType === "reload") return;

          if (resolvedTarget.hash) {
            const rawId = resolvedTarget.hash.slice(1);
            let id = rawId;

            try {
              id = decodeURIComponent(rawId);
            } catch {
              // A malformed escape is still a valid fragment string.
            }

            const anchor = this.window.document.getElementById(id);

            if (anchor) {
              anchor.scrollIntoView();

              return;
            }
          }

          this.window.scrollTo(0, 0);
        },
      },
    });

    this.fallbackTarget.dispatchEvent(event);

    dispatching = false;
    return {
      event,
      beforeCommit,
      afterCommit,
      markCommitted: () => {
        committed = true;
      },
      markFinished: () => {
        finished = true;

        if (!manualScroll) scrolled = true;
      },
      redirect: (url, options) => {
        if (resolvedType !== "push" && resolvedType !== "replace")
          throw domException(
            this.window,
            "Only push and replace navigations can redirect",
            "InvalidStateError",
          );

        resolvedTarget = this.resolve(url);

        if (options?.history === "push" || options?.history === "replace")
          resolvedType = options.history;

        if (options && Object.prototype.hasOwnProperty.call(options, "state"))
          resolvedState = structuredClone(options.state);

        if (options && Object.prototype.hasOwnProperty.call(options, "info"))
          resolvedInfo = options.info;
      },

      get resolved() {
        return {
          target: resolvedTarget,
          navigationType: resolvedType,
          state: resolvedState,
          info: resolvedInfo,
        };
      },
    };
  }

  private beginFallbackTransition(
    navigationType: () => "push" | "replace" | "reload" | "traverse",
    destination: NavigationDestination,
    result: RequiredNavigationResult,
  ): void {
    const from = this.fallbackCurrentEntry();

    if (!from) return;

    const transition = {
      get navigationType() {
        return navigationType();
      },

      from,
      to: destination,
      committed: result.committed.then(() => undefined),
      finished: result.finished.then(() => undefined),
    } as NavigationTransition;

    void transition.committed.catch(() => undefined);

    void transition.finished.catch(() => undefined);

    this.fallbackTransition = transition;

    void transition.finished.then(
      () => {
        if (this.fallbackTransition === transition) this.fallbackTransition = null;
      },
      () => {
        if (this.fallbackTransition === transition) this.fallbackTransition = null;
      },
    );
  }

  private handleDevHardReloadRequest(event: Event): void {
    if (this.disposed) return;

    const detail = (
      event as CustomEvent<{
        sourceRemoval?: unknown;
        target?: unknown;
        history?: unknown;
        result?: RequiredNavigationResult;
      }>
    ).detail;

    if (detail?.sourceRemoval === true) {
      event.preventDefault();

      const target =
        typeof detail.target === "string"
          ? new URL(detail.target, this.window.location.href)
          : undefined;
      const result = this.reloadDocument(
        undefined,
        target && target.href !== this.window.location.href
          ? { target, history: detail.history === "replace" ? "replace" : "push" }
          : undefined,
      );
      detail.result = result;

      void result.committed.catch(() => undefined);

      void result.finished.catch((error: unknown) => {
        if (
          typeof error === "object" &&
          error !== null &&
          "name" in error &&
          error.name === "AbortError"
        )
          return;

        const Constructor = (this.window as Window & { CustomEvent: typeof CustomEvent })
          .CustomEvent;

        this.window.dispatchEvent(new Constructor("hesperia:warning", { detail: String(error) }));
      });

      return;
    }

    if (!this.nativeNavigation) return;

    const token = {};
    const request = { consumed: false };

    this.pendingDevHardReloads.set(token, request);

    try {
      const result = this.nativeNavigation.reload({ info: token });

      void result.committed?.catch(() => this.pendingDevHardReloads.delete(token));

      void result.finished?.catch(() => this.pendingDevHardReloads.delete(token));
    } catch {
      this.pendingDevHardReloads.delete(token);

      return;
    }

    if (!request.consumed) {
      this.pendingDevHardReloads.delete(token);

      return;
    }

    event.preventDefault();
  }

  private handleNativeNavigate(event: NavigateEvent): void {
    const destination = event.destination;

    if (
      event.navigationType !== "reload" &&
      event.navigationType !== "traverse" &&
      destination.sameDocument &&
      !event.hashChange
    )
      return;

    this.cancelPendingDocumentReload(
      this.abortError("A browser navigation superseded reload admission"),
    );

    const info = event.info;

    if (event.navigationType === "reload" && info !== null && typeof info === "object") {
      const request = this.pendingDevHardReloads.get(info);

      if (request) {
        this.pendingDevHardReloads.delete(info);

        request.consumed = true;
        return;
      }
    }

    if (event.navigationType === "reload") return;

    if (this.disposed || !event.canIntercept || destination.url === null) return;

    const target = new URL(destination.url);

    if (requiresDevelopmentReload(this.window, target)) {
      event.intercept({
        focusReset: "manual",
        scroll: "manual",
        precommitHandler: async () => {
          await this.initialGate;
          const router = this.router;

          if (!router) throw this.abortError("Application startup failed");

          const admission = await router.navigateWithCommit(
            this.window.location.href,
            { history: "none" },
            () => undefined,
            { applicationOwner: this.applicationOwner, signal: event.signal },
          );

          if (admission.status !== "committed")
            throw this.abortError("Document reload was denied or superseded");
        },
        handler: () => {
          const result = this.nativeNavigation!.reload();

          void result.committed?.catch(() => undefined);

          void result.finished?.catch((error: unknown) => {
            if (
              typeof error === "object" &&
              error !== null &&
              "name" in error &&
              error.name === "AbortError"
            )
              return;

            const Constructor = (this.window as Window & { CustomEvent: typeof CustomEvent })
              .CustomEvent;

            this.window.dispatchEvent(
              new Constructor("hesperia:warning", { detail: String(error) }),
            );
          });
        },
      });

      return;
    }

    if (
      target.origin !== this.window.location.origin ||
      !isWithinMount(target.pathname, this.mountPath)
    )
      return;

    if (event.navigationType === "traverse" && this.historyAdapterOwnsTraversals) return;

    let outcome: Awaited<ReturnType<NavigationRouter["handleNavigationEvent"]>> | undefined;
    let presentation: (() => void) | undefined;
    let readRenderFailure: RouteRenderFailureReader | undefined;
    let running: Promise<void> | undefined;

    const run = (): Promise<void> => {
      if (running) return running;

      running = (async () => {
        await this.initialGate;
        const router = this.router;

        if (!router) throw this.abortError("Application startup failed");

        const work = router.handleNavigationEvent(event, (commit, readFailure) => {
          presentation = commit;
          readRenderFailure = readFailure;
        });

        if (this.startup) this.latestStartup = work;

        outcome = await work;

        if (outcome.status !== "committed")
          throw this.abortError("Navigation was denied or superseded");
      })();
      return running;
    };

    const complete = async () => {
      if (!outcome) await run();

      presentation?.();

      await this.scheduler?.settled();

      const failure = readRenderFailure?.();

      if (failure) throw failure.error;
    };

    try {
      const options: NavigationInterceptOptions = {
        focusReset: "manual",
        scroll: "manual",
        handler: complete,
      };

      if (event.cancelable) options.precommitHandler = run;

      event.intercept(options);
    } catch (error) {
      const CustomEventConstructor = (
        this.window as Window & {
          CustomEvent?: typeof CustomEvent;
        }
      ).CustomEvent;

      if (CustomEventConstructor)
        this.window.dispatchEvent(
          new CustomEventConstructor("hesperia:navigation-error", { detail: error }),
        );
    }
  }
}
