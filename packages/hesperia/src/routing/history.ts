import { RenderFault } from "../runtime/owner.ts";
import { isNonNullObject } from "../utils.ts";

/** The history operation used by a route transaction. */
export type HistoryDisposition = "push" | "replace" | "none";

/** Internal record stored in a browser history entry. */
export interface HistoryEntry {
  /** Tracker lease identity that created or adopted this record. */
  readonly trackerId: string;
  /** Identity retained by replace and changed by push. */
  readonly id: number;
  /** Logical physical position used to branch pushes after traversal. */
  readonly position: number;
  /** URL associated with the route transaction or physical entry. */
  readonly url: string;
  /** Author-supplied state, after native structured cloning when read back. */
  readonly state: unknown;
  /** Navigation API state, persisted separately from classic History state. */
  readonly navigationState: unknown;
}

/** Shared internal history operations for generated startup and Router. */
export interface HistoryTracker {
  /** Read the metadata and author state of the current physical entry. */
  read(url?: string, state?: unknown): HistoryEntry | undefined;

  /** Prepare metadata for a write without changing the browser history. */
  create(url: string, state: unknown, disposition: HistoryDisposition): HistoryEntry | undefined;

  /** Apply a prepared write after the route has installed successfully. */
  apply(entry: HistoryEntry, disposition: HistoryDisposition): HistoryEntry | undefined;

  /** Replace only the Navigation API state on the current physical entry. */
  updateNavigationState(state: unknown): HistoryEntry | undefined;

  /** Observe author calls to the patched native pushState and replaceState methods. */
  observeNativeWrites(
    observer: (entry: HistoryEntry, disposition: "push" | "replace") => void,
  ): () => void;

  /** Release this caller's lease on the native method patch. */
  release(): void;
}

interface HistoryEnvelope {
  readonly state: unknown;
  readonly __hesperiaHistory: {
    readonly version: 2;
    readonly trackerId: string;
    readonly id: number;
    readonly position: number;
    readonly origin: string;
    readonly url: string;
    readonly navigationState: unknown;
  };
}

interface WindowRecord {
  tracker?: SharedHistoryTracker;
}

const windows = new WeakMap<Window, WindowRecord>();
const historyStateGetters = new WeakMap<History, () => unknown>();
const projectedHistory = new WeakSet<History>();
const projectedPopStatePrototypes = new WeakSet<object>();
const projectedPopStateWindows = new WeakSet<Window>();

function readEnvelope(
  value: unknown,
  url: string,
  origin: string,
  requireCurrentUrl = true,
): HistoryEntry | undefined {
  if (!isNonNullObject(value)) return undefined;

  if (
    !Object.prototype.hasOwnProperty.call(value, "__hesperiaHistory") ||
    !Object.prototype.hasOwnProperty.call(value, "state") ||
    Object.getOwnPropertyNames(value).length !== 2
  )
    return undefined;

  const metadata = value.__hesperiaHistory;

  if (!isNonNullObject(metadata)) return undefined;

  if (Object.getOwnPropertyNames(metadata).length !== 7) return undefined;

  const version = metadata.version;
  const trackerId = metadata.trackerId;
  const id = metadata.id;
  const position = metadata.position;
  const entryOrigin = metadata.origin;
  const entryUrl = metadata.url;

  if (
    version !== 2 ||
    typeof trackerId !== "string" ||
    !/^hesperia-history-v2:[a-f0-9]{32}$/.test(trackerId) ||
    typeof id !== "number" ||
    !Number.isSafeInteger(id) ||
    typeof position !== "number" ||
    !Number.isSafeInteger(position) ||
    position < 0 ||
    entryOrigin !== origin ||
    typeof entryUrl !== "string"
  )
    return undefined;

  try {
    const normalizedUrl = new URL(entryUrl).href;

    if (new URL(entryUrl).origin !== origin || (requireCurrentUrl && normalizedUrl !== url))
      return undefined;
  } catch {
    return undefined;
  }

  return {
    trackerId,
    id,
    position,
    url,
    state: value.state,
    navigationState: metadata.navigationState,
  };
}

function envelope(entry: HistoryEntry, origin: string, baseUrl: string): HistoryEnvelope {
  let url = entry.url;

  try {
    url = new URL(entry.url, baseUrl).href;
  } catch {
    // The native method remains responsible for reporting an invalid URL.
  }

  return {
    // Keep author state first. Native structured cloning can execute author
    // getters that make a nested history write before metadata is read.
    state: entry.state,
    __hesperiaHistory: {
      version: 2,
      trackerId: entry.trackerId,
      id: entry.id,
      position: entry.position,
      origin,
      url,
      navigationState: entry.navigationState,
    },
  };
}

function nativeGetter(target: object, property: PropertyKey): (() => unknown) | undefined {
  let prototype = Object.getPrototypeOf(target) as object | null;

  while (prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, property);

    if (descriptor?.get) return descriptor.get as () => unknown;

    prototype = Object.getPrototypeOf(prototype) as object | null;
  }

  return undefined;
}

function tokenFor(window: Window): string {
  const bytes = new Uint8Array(16);

  try {
    window.crypto.getRandomValues(bytes);
  } catch {
    for (let index = 0; index < bytes.length; index++)
      bytes[index] = Math.floor(Math.random() * 256);
  }

  return `hesperia-history-v2:${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function projectState(value: unknown, origin: string, url: string): unknown {
  if (!isNonNullObject(value)) return value;

  const candidate = value as Record<string, unknown>;
  const metadata = candidate.__hesperiaHistory;

  if (!isNonNullObject(metadata) || typeof metadata.origin !== "string") return value;

  const entry = readEnvelope(value, url, origin);
  return entry ? entry.state : value;
}

function installStateProjection(window: Window): () => unknown {
  const history = window.history;
  let getNativeState = historyStateGetters.get(history);

  if (!getNativeState) {
    getNativeState = nativeGetter(history, "state");

    if (!getNativeState)
      throw new RenderFault("history-state-unavailable", "History.state has no native getter");

    historyStateGetters.set(history, getNativeState);
  }

  if (!projectedHistory.has(history)) {
    Object.defineProperty(history, "state", {
      configurable: true,
      enumerable: false,

      get() {
        const value = Reflect.apply(getNativeState!, history, []);
        return projectState(value, window.location.origin, window.location.href);
      },
    });

    projectedHistory.add(history);
  }

  if (!projectedPopStateWindows.has(window)) {
    const constructor = (window as Window & { PopStateEvent?: typeof PopStateEvent }).PopStateEvent;
    const prototype = constructor?.prototype;
    const descriptor = prototype ? Object.getOwnPropertyDescriptor(prototype, "state") : undefined;

    if (
      prototype &&
      descriptor?.get &&
      descriptor.configurable &&
      !projectedPopStatePrototypes.has(prototype)
    ) {
      const getNativeEventState = descriptor.get;

      Object.defineProperty(prototype, "state", {
        ...descriptor,

        get() {
          return projectState(
            Reflect.apply(getNativeEventState, this, []),
            window.location.origin,
            window.location.href,
          );
        },
      });

      projectedPopStatePrototypes.add(prototype);
    }

    // Some DOM implementations create synthetic PopStateEvent.state as an own
    // data property. Project it before ordinary listeners observe the event.
    window.addEventListener(
      "popstate",
      (event) => {
        const value = (event as PopStateEvent).state;
        const eventWindow = (event.currentTarget as Window | null) ?? window;
        const projected = projectState(
          value,
          eventWindow.location.origin,
          eventWindow.location.href,
        );

        if (projected === value) return;

        try {
          Object.defineProperty(event, "state", {
            configurable: true,
            enumerable: true,
            writable: true,
            value: projected,
          });
        } catch {
          // Native event properties can be non-configurable in older DOMs.
        }
      },
      true,
    );

    projectedPopStateWindows.add(window);
  }

  return () => Reflect.apply(getNativeState!, history, []);
}

/**
 * Install or join the shared native history tracker for one browser window.
 *
 * The physical entry contains a private envelope, while the History and
 * PopStateEvent state accessors expose only its author payload. Those read
 * projections last for the Window lifetime because older entries cannot be
 * enumerated and unwrapped safely during tracker release. Native write patches
 * still end with their final tracker lease.
 */
export function installHistoryTracking(window: Window): HistoryTracker {
  installStateProjection(window);

  let record = windows.get(window);

  if (!record) {
    record = {};

    windows.set(window, record);
  }

  const tracker = record.tracker ?? new SharedHistoryTracker(window, record);
  record.tracker = tracker;
  return tracker.lease();
}

class SharedHistoryTracker {
  readonly #window: Window;

  readonly #history: History;

  readonly #record: WindowRecord;

  readonly #trackerId: string;

  readonly #getNativeState: () => unknown;

  readonly #pushState: History["pushState"];

  readonly #replaceState: History["replaceState"];

  readonly #pushWrapper: History["pushState"];

  readonly #replaceWrapper: History["replaceState"];

  readonly #pushDescriptor: PropertyDescriptor | undefined;

  readonly #replaceDescriptor: PropertyDescriptor | undefined;

  #leases = 0;

  #nextEntryId = 0;

  readonly #nativeWriteObservers = new Set<
    (entry: HistoryEntry, disposition: "push" | "replace") => void
  >();

  constructor(window: Window, record: WindowRecord) {
    this.#window = window;
    this.#history = window.history;
    this.#record = record;
    this.#getNativeState = installStateProjection(window);
    this.#pushState = this.#history.pushState;
    this.#replaceState = this.#history.replaceState;
    this.#pushDescriptor = Object.getOwnPropertyDescriptor(this.#history, "pushState");
    this.#replaceDescriptor = Object.getOwnPropertyDescriptor(this.#history, "replaceState");
    const physicalState = this.#getNativeState();
    const initial = readEnvelope(
      physicalState,
      this.#window.location.href,
      this.#window.location.origin,
    );
    this.#trackerId = initial?.trackerId ?? tokenFor(this.#window);

    if (initial) {
      this.#nextEntryId = initial.id;
    } else {
      const baseline: HistoryEntry = {
        trackerId: this.#trackerId,
        id: 1,
        position: 0,
        url: this.#window.location.href,
        state: physicalState,
        navigationState: undefined,
      };

      // Stamp the physical entry before application startup. This preserves
      // an arbitrary initial author state while giving later pushes a base.
      Reflect.apply(this.#replaceState, this.#history, [
        envelope(baseline, this.#window.location.origin, this.#window.location.href),
        "",
        this.#window.location.href,
      ]);

      this.#nextEntryId = 1;
    }

    const writeNative = (
      history: History,
      disposition: "push" | "replace",
      args: unknown[],
    ): void => {
      if (history !== this.#history) {
        Reflect.apply(disposition === "push" ? this.#pushState : this.#replaceState, history, args);

        return;
      }

      const nativeArgs = [...args];

      if (nativeArgs.length > 1) nativeArgs[1] = `${nativeArgs[1]}`;

      let url = () => this.#window.location.href;

      if (nativeArgs.length > 2 && nativeArgs[2] !== undefined && nativeArgs[2] !== null) {
        const urlArgument = `${nativeArgs[2]}`;
        nativeArgs[2] = urlArgument;
        let resolvedUrl: string | undefined;
        url = () => {
          if (resolvedUrl !== undefined) return resolvedUrl;

          const baseUrl = this.#window.location.href;

          try {
            resolvedUrl =
              urlArgument === ""
                ? this.#window.document.URL
                : new URL(urlArgument, this.#window.document.baseURI).href;
          } catch {
            resolvedUrl = baseUrl;
          }

          return resolvedUrl;
        };
      }

      let wrapped: HistoryEnvelope | undefined;

      if (nativeArgs.length > 0) {
        wrapped = this.#lazyEnvelope(args[0], disposition, url);
        nativeArgs[0] = wrapped;
      }

      // Preserve the original argument count so native missing-argument errors
      // remain observable.
      Reflect.apply(
        disposition === "push" ? this.#pushState : this.#replaceState,
        history,
        nativeArgs,
      );

      if (wrapped) {
        const writtenUrl = wrapped.__hesperiaHistory.url;

        this.#accept(writtenUrl);

        this.#notifyNativeWrite(disposition, writtenUrl);
      }
    };

    this.#pushWrapper = function (this: History, ...args: unknown[]): void {
      return writeNative(this, "push", args);
    } as History["pushState"];
    this.#replaceWrapper = function (this: History, ...args: unknown[]): void {
      return writeNative(this, "replace", args);
    } as History["replaceState"];

    Object.defineProperty(this.#history, "pushState", {
      configurable: true,
      enumerable: this.#pushDescriptor?.enumerable ?? false,
      writable: true,
      value: this.#pushWrapper,
    });

    Object.defineProperty(this.#history, "replaceState", {
      configurable: true,
      enumerable: this.#replaceDescriptor?.enumerable ?? false,
      writable: true,
      value: this.#replaceWrapper,
    });
  }

  lease(): HistoryTracker {
    this.#leases++;
    let released = false;
    return {
      read: (url, state) => this.read(url, state),
      create: (url, state, disposition) => this.create(url, state, disposition),
      apply: (entry, disposition) => this.apply(entry, disposition),
      updateNavigationState: (state) => this.updateNavigationState(state),
      observeNativeWrites: (observer) => this.observeNativeWrites(observer),
      release: () => {
        if (released) return;

        released = true;

        this.release();
      },
    };
  }

  read(url = this.#window.location.href, state = this.#getNativeState()): HistoryEntry | undefined {
    return this.#read(url, state);
  }

  observeNativeWrites(
    observer: (entry: HistoryEntry, disposition: "push" | "replace") => void,
  ): () => void {
    this.#nativeWriteObservers.add(observer);

    return () => this.#nativeWriteObservers.delete(observer);
  }

  create(url: string, state: unknown, disposition: HistoryDisposition): HistoryEntry | undefined {
    const current = this.#read();

    if (disposition === "none") return current ? { ...current, url } : undefined;

    return this.#candidate(current, url, state, disposition);
  }

  apply(entry: HistoryEntry, disposition: HistoryDisposition): HistoryEntry | undefined {
    const current = this.#read();

    if (disposition === "none") return current ? { ...current, url: entry.url } : entry;

    // Re-read immediately before the native write. An install hook may have
    // made a direct native write after create() prepared the route.
    const actual = this.#candidate(current, entry.url, entry.state, disposition);
    const wrapped = this.#lazyEnvelope(entry.state, disposition, actual.url);

    Reflect.apply(disposition === "push" ? this.#pushState : this.#replaceState, this.#history, [
      wrapped,
      "",
      actual.url,
    ]);

    this.#accept(wrapped.__hesperiaHistory.url);

    return this.#read(actual.url) ?? actual;
  }

  updateNavigationState(state: unknown): HistoryEntry | undefined {
    const current = this.#read();

    if (!current) return undefined;

    const updated: HistoryEntry = { ...current, navigationState: state };

    Reflect.apply(this.#replaceState, this.#history, [
      envelope(updated, this.#window.location.origin, this.#window.location.href),
      "",
      this.#window.location.href,
    ]);

    this.#accept(this.#window.location.href);

    return this.#read();
  }

  release(): void {
    if (this.#leases === 0) return;

    this.#leases--;

    if (this.#leases !== 0) return;

    if (this.#record.tracker === this) this.#record.tracker = undefined;

    this.#nativeWriteObservers.clear();

    if (this.#history.pushState === this.#pushWrapper)
      restore(this.#history, "pushState", this.#pushDescriptor);

    if (this.#history.replaceState === this.#replaceWrapper)
      restore(this.#history, "replaceState", this.#replaceDescriptor);
  }

  #read(
    url = this.#window.location.href,
    physicalState = this.#getNativeState(),
  ): HistoryEntry | undefined {
    return readEnvelope(physicalState, url, this.#window.location.origin);
  }

  #candidate(
    current: HistoryEntry | undefined,
    url: string,
    state: unknown,
    disposition: "push" | "replace",
  ): HistoryEntry {
    const position =
      disposition === "replace" ? (current?.position ?? 0) : (current?.position ?? -1) + 1;
    const id =
      disposition === "replace" && current
        ? current.id
        : Math.max(this.#nextEntryId, current?.id ?? 0) + 1;
    return {
      trackerId: disposition === "replace" && current ? current.trackerId : this.#trackerId,
      id,
      position,
      url,
      state,
      navigationState: undefined,
    };
  }

  #accept(expectedUrl: string): void {
    const currentUrl = this.#window.location.href;
    const physical = this.#getNativeState();
    let actual = readEnvelope(physical, currentUrl, this.#window.location.origin, false);

    if (!actual) return;

    if (
      isNonNullObject(physical) &&
      isNonNullObject(physical.__hesperiaHistory) &&
      physical.__hesperiaHistory.url !== currentUrl &&
      physical.__hesperiaHistory.url !== expectedUrl
    ) {
      actual = { ...actual, url: currentUrl };

      Reflect.apply(this.#replaceState, this.#history, [
        envelope(actual, this.#window.location.origin, this.#window.location.href),
        "",
        currentUrl,
      ]);
    }

    this.#nextEntryId = Math.max(this.#nextEntryId, actual.id);
  }

  #notifyNativeWrite(disposition: "push" | "replace", url: string): void {
    const entry = this.#read(url);

    if (!entry) return;

    for (const observer of this.#nativeWriteObservers) {
      try {
        observer(entry, disposition);
      } catch {
        // A route observer must not change the native History method's result.
      }
    }
  }

  #lazyEnvelope(
    state: unknown,
    disposition: "push" | "replace",
    url: string | (() => string),
  ): HistoryEnvelope {
    const resolveUrl = typeof url === "string" ? () => url : url;
    let candidate: HistoryEntry | undefined;

    const getCandidate = () =>
      (candidate ??= this.#candidate(this.#read(), resolveUrl(), state, disposition));

    const window = this.#window;
    const metadata: HistoryEnvelope["__hesperiaHistory"] = {
      version: 2,

      get trackerId() {
        return getCandidate().trackerId;
      },

      get id() {
        return getCandidate().id;
      },

      get position() {
        return getCandidate().position;
      },

      origin: this.#window.location.origin,

      get url() {
        try {
          return new URL(getCandidate().url, window.location.href).href;
        } catch {
          return getCandidate().url;
        }
      },

      navigationState: undefined,
    };
    const wrapped: HistoryEnvelope = {
      state,
      __hesperiaHistory: metadata,
    };
    return wrapped;
  }
}

function restore(
  history: History,
  name: "pushState" | "replaceState",
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) Object.defineProperty(history, name, descriptor);
  else delete (history as unknown as Record<string, unknown>)[name];
}
