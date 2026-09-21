import type { HistoryEntry } from "./history.ts";

/**
 * A same-document browser history entry as seen by the routing adapter.
 *
 * The Navigation API supplies `key` and `index`; the legacy adapter instead
 * receives the Hesperia position from the installed history tracker.
 */
export interface BrowserHistoryEntry {
  readonly key: string;
  readonly index: number;
  readonly url: string;
  readonly state: unknown;
  /** Logical position used only by the legacy History API adapter. */
  readonly position?: number;
  /** Hesperia tracker record retained across Navigation API destinations. */
  readonly history?: HistoryEntry;
}

/** Result returned by the router transaction handling one browser traversal. */
export interface BrowserHistoryTraversalResult {
  readonly status: "committed" | "denied" | "cancelled";
  readonly reason?: unknown;
  /** Final URL when a guard redirected the traversal transaction. */
  readonly url?: string;
  /** Terminal route presentation to run after the browser accepts the traversal. */
  readonly afterCommit?: () => void;
}

/** Internal browser-facing history adapter configuration. */
export interface BrowserHistoryAdapterOptions {
  readonly window: Window;
  /**
   * Run the route transaction for a browser-selected entry. The callback must
   * leave the current route installed until admission and preparation finish.
   */
  readonly onTraverse: (
    entry: BrowserHistoryEntry,
    signal: AbortSignal,
  ) => BrowserHistoryTraversalResult | PromiseLike<BrowserHistoryTraversalResult>;
  /** Read the Hesperia entry at the current URL for the legacy adapter. */
  readonly readEntry?: (url: string) => BrowserHistoryEntry | undefined;
  /** Called for unsupported foreign entries or unexpected adapter failures. */
  readonly onError?: (error: unknown) => void;
  /** Called after the browser accepted a committed traversal. */
  readonly onCommit?: (entry: BrowserHistoryEntry) => void;
}

/** Whether traversal is mediated by Navigation API or classic History events. */
export type BrowserHistoryMode = "navigation" | "history";

/** An installed, disposable browser traversal adapter. */
export interface BrowserHistoryAdapter {
  readonly mode: BrowserHistoryMode;
  readonly current: BrowserHistoryEntry | undefined;
  /** Tell the legacy adapter about a programmatic route commit. */
  notifyCommitted(entry: BrowserHistoryEntry): void;
  dispose(): void;
}

const unsupported = (message: string): Error =>
  new Error(`Browser history traversal is unsupported: ${message}`);

function readNavigationEntry(
  entry: NavigationHistoryEntry | NavigationDestination,
): BrowserHistoryEntry {
  return {
    key: entry.key,
    index: entry.index,
    url: entry.url ?? "",
    state: entry.getState(),
  };
}

function navigationFor(window: Window): Navigation | undefined {
  const navigation = (window as Window & { navigation?: Navigation }).navigation;
  if (!navigation || !navigation.currentEntry || typeof navigation.addEventListener !== "function")
    return undefined;
  return navigation;
}

/** Install the native Navigation API path, or the Baseline-history fallback. */
export function installBrowserHistory(
  options: BrowserHistoryAdapterOptions,
): BrowserHistoryAdapter {
  const navigation = navigationFor(options.window);
  if (navigation) return installNavigation(options, navigation);
  return installHistory(options);
}

function installNavigation(
  options: BrowserHistoryAdapterOptions,
  navigation: Navigation,
): BrowserHistoryAdapter {
  let disposed = false;
  let generation = 0;
  let current = readNavigationEntry(navigation.currentEntry!);
  const states = new Map<string, unknown>([[current.key, current.state]]);
  const logicalEntries = new Map<string, BrowserHistoryEntry>();
  const trackedCurrent = options.readEntry?.(current.url);
  if (trackedCurrent) {
    current = { ...current, state: trackedCurrent.state, position: trackedCurrent.position };
    states.set(current.key, current.state);
    logicalEntries.set(current.key, trackedCurrent);
  }
  let restoringKey: string | undefined;
  const listener = (event: NavigateEvent) => {
    if (
      disposed ||
      event.navigationType !== "traverse" ||
      !event.destination.sameDocument ||
      !event.canIntercept
    )
      return;
    const destinationRecord = readNavigationEntry(event.destination);
    const logical = logicalEntries.get(destinationRecord.key);
    const destination = logical
      ? {
          ...destinationRecord,
          state: logical.state,
          position: logical.position,
          history: logical.history,
        }
      : states.has(destinationRecord.key)
        ? { ...destinationRecord, state: states.get(destinationRecord.key) }
        : destinationRecord;
    if (destination.key === restoringKey) {
      restoringKey = undefined;
      current = destination;
      return;
    }
    if (destination.key === current.key) return;
    const transaction = ++generation;
    let precommitted = false;
    let committed = false;
    let redirectedUrl: string | undefined;
    let redirectedState: unknown;
    let afterCommit: (() => void) | undefined;
    const run = () => {
      // Navigation API state and classic history state are separate records.
      // Retain the logical entry explicitly before a precommit traversal;
      // after a physical traversal the classic tracker can read it directly.
      const tracked = !logical && !precommitted ? options.readEntry?.(destination.url) : undefined;
      const effective = tracked
        ? {
            ...destination,
            state: tracked.state,
            position: tracked.position,
            history: tracked.history,
          }
        : destination;
      if (tracked) states.set(effective.key, effective.state);
      return options.onTraverse(effective, event.signal);
    };
    const finish = () => {
      if (committed || disposed || transaction !== generation || event.signal.aborted) return;
      committed = true;
      const complete = (entry: BrowserHistoryEntry) => {
        if (disposed || transaction !== generation || event.signal.aborted) return;
        try {
          afterCommit?.();
        } catch (error) {
          options.onError?.(error);
          return;
        }
        if (disposed || transaction !== generation || event.signal.aborted) return;
        options.onCommit?.(entry);
      };
      const afterNavigationTransition = (entry: BrowserHistoryEntry) => {
        // A Navigation API handler runs before the user agent finishes applying
        // fragment focus and persisted scroll restoration. Wait for the
        // transition rather than presenting from the precommit handler, or the
        // browser can immediately blur the route's terminal focus target.
        const transition = (
          navigation as Navigation & {
            readonly transition?: { readonly finished: Promise<unknown> } | null;
          }
        ).transition;
        if (!transition) {
          complete(entry);
          return;
        }
        void transition.finished.then(
          () => complete(entry),
          (error) => {
            if (!disposed && transaction === generation && !event.signal.aborted)
              options.onError?.(error);
          },
        );
      };
      // Some Navigation API implementations expose redirect() but leave a
      // traversal at its original physical URL. Replace that one entry after
      // the route transaction so the address and managed history agree without
      // creating an extra entry.
      if (redirectedUrl && options.window.location.href !== redirectedUrl) {
        try {
          options.window.history.replaceState(redirectedState, "", redirectedUrl);
        } catch (error) {
          options.onError?.(error);
        }
      }
      const physical = navigation.currentEntry;
      if (redirectedUrl) {
        current = { ...current, url: redirectedUrl, state: redirectedState };
        states.set(current.key, current.state);
        afterNavigationTransition(current);
        return;
      }
      const committedEntry =
        physical && (physical.key !== current.key || physical.url !== current.url)
          ? readNavigationEntry(physical)
          : destination;
      const state = states.has(committedEntry.key)
        ? states.get(committedEntry.key)
        : committedEntry.state;
      current = { ...committedEntry, state };
      states.set(current.key, current.state);
      const logicalCommitted = logicalEntries.get(current.key);
      afterNavigationTransition(logicalCommitted ?? current);
    };
    const restore = () => {
      const delta = current.index - destination.index;
      if (delta === 0) return;
      restoringKey = current.key;
      try {
        options.window.history.go(delta);
      } catch (error) {
        restoringKey = undefined;
        options.onError?.(error);
      }
    };
    try {
      event.intercept({
        focusReset: "manual",
        scroll: "manual",
        // Precommit keeps the old physical entry and address bar in place while
        // the Router runs guards, departure checks, and detached preparation.
        precommitHandler: async (controller) => {
          precommitted = true;
          const result = await run();
          if (disposed || transaction !== generation || event.signal.aborted)
            throw new DOMException("Navigation superseded", "AbortError");
          if (result.status !== "committed")
            throw result.reason ?? new DOMException("Navigation denied", "AbortError");
          afterCommit = result.afterCommit;
          if (result.url && result.url !== destination.url) {
            redirectedUrl = result.url;
            redirectedState = destination.state;
            try {
              controller.redirect(result.url);
            } catch (error) {
              options.onError?.(error);
            }
            controller.addHandler(finish);
            return;
          }
          controller.addHandler(finish);
        },
        // Engines without precommit support call this after the physical entry
        // changes. Keep the outgoing route mounted until the same transaction
        // succeeds, then restore an exact native entry index on veto.
        handler: async () => {
          if (precommitted) return;
          try {
            const result = await run();
            if (disposed || transaction !== generation || event.signal.aborted) return;
            if (result.status === "committed") {
              afterCommit = result.afterCommit;
              if (result.url && result.url !== destination.url) {
                redirectedUrl = result.url;
                redirectedState = destination.state;
              }
              finish();
            } else restore();
          } catch (error) {
            if (disposed || transaction !== generation || event.signal.aborted) return;
            options.onError?.(error);
            restore();
          }
        },
      });
    } catch (error) {
      options.onError?.(error);
    }
  };
  navigation.addEventListener("navigate", listener);
  return {
    mode: "navigation",
    get current() {
      return current;
    },
    notifyCommitted(entry) {
      const physical = navigation.currentEntry;
      if (!physical) {
        current = entry;
        states.set(current.key, current.state);
        return;
      }
      const physicalEntry = readNavigationEntry(physical);
      logicalEntries.set(physicalEntry.key, entry);
      current = { ...physicalEntry, state: entry.state, position: entry.index };
      states.set(current.key, current.state);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      generation++;
      navigation.removeEventListener("navigate", listener);
    },
  };
}

function installHistory(options: BrowserHistoryAdapterOptions): BrowserHistoryAdapter {
  if (!options.readEntry) throw new Error("The legacy browser history adapter requires readEntry");
  let disposed = false;
  let restoringPosition: number | undefined;
  let current = options.readEntry(options.window.location.href);
  let pending: AbortController | undefined;

  const listener = () => {
    if (disposed) return;
    const destination = options.readEntry!(options.window.location.href);
    if (restoringPosition !== undefined && destination?.position === restoringPosition) {
      restoringPosition = undefined;
      current = destination;
      return;
    }
    if (!destination || current?.position === undefined || destination.position === undefined) {
      options.onError?.(unsupported("the traversed entry has no tracked position"));
      return;
    }
    pending?.abort();
    const controller = new AbortController();
    pending = controller;
    const previous = current;
    let hashChanged = false;
    if (previous) {
      try {
        hashChanged =
          new URL(previous.url, options.window.location.href).hash !==
          new URL(destination.url, options.window.location.href).hash;
      } catch {
        hashChanged = false;
      }
    }
    let hashObserved = !hashChanged;
    let accepted: BrowserHistoryTraversalResult | undefined;
    let removeHashBarrier = () => undefined;
    const completeCommitted = () => {
      if (
        !accepted ||
        (accepted.afterCommit && !hashObserved) ||
        disposed ||
        controller.signal.aborted ||
        pending !== controller
      )
        return;
      removeHashBarrier();
      try {
        accepted.afterCommit?.();
      } catch (error) {
        if (pending === controller) pending = undefined;
        options.onError?.(error);
        return;
      }
      if (disposed || controller.signal.aborted || pending !== controller) return;
      pending = undefined;
      current = destination;
      options.onCommit?.(destination);
    };
    if (hashChanged) {
      const onHashChange = (event: Event) => {
        const newUrl = (event as HashChangeEvent).newURL;
        if (newUrl) {
          try {
            const expected = new URL(destination.url, options.window.location.href);
            const actual = new URL(newUrl, expected.href);
            if (
              actual.origin !== expected.origin ||
              actual.pathname !== expected.pathname ||
              actual.search !== expected.search ||
              actual.hash !== expected.hash
            )
              return;
          } catch {
            return;
          }
        }
        hashObserved = true;
        removeHashBarrier();
        completeCommitted();
      };
      removeHashBarrier = () => {
        options.window.removeEventListener("hashchange", onHashChange);
        controller.signal.removeEventListener("abort", removeHashBarrier);
      };
      // Install this before starting the async route transaction. A guard can
      // outlive the browser's hashchange event on a legacy traversal.
      options.window.addEventListener("hashchange", onHashChange);
      controller.signal.addEventListener("abort", removeHashBarrier, { once: true });
      if (controller.signal.aborted) removeHashBarrier();
    }
    void Promise.resolve()
      .then(() => options.onTraverse!(destination, controller.signal))
      .then(
        (result) => {
          if (disposed || controller.signal.aborted || pending !== controller) return;
          if (result.status === "committed") {
            accepted = result;
            completeCommitted();
            return;
          }
          removeHashBarrier();
          pending = undefined;
          const delta = current!.position! - destination.position!;
          if (delta === 0) return;
          restoringPosition = current!.position;
          try {
            options.window.history.go(delta);
          } catch (error) {
            restoringPosition = undefined;
            options.onError?.(error);
          }
        },
        (error) => {
          if (disposed || controller.signal.aborted || pending !== controller) return;
          removeHashBarrier();
          pending = undefined;
          options.onError?.(error);
          const delta = current!.position! - destination!.position!;
          if (delta === 0) return;
          restoringPosition = current!.position;
          try {
            options.window.history.go(delta);
          } catch (restoreError) {
            restoringPosition = undefined;
            options.onError?.(restoreError);
          }
        },
      );
  };
  options.window.addEventListener("popstate", listener);
  return {
    mode: "history",
    get current() {
      return current;
    },
    notifyCommitted(entry) {
      current = entry;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      pending?.abort();
      options.window.removeEventListener("popstate", listener);
    },
  };
}
