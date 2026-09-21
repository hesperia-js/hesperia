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
}

/** Shared internal history operations for generated startup and Router. */
export interface HistoryTracker {
  /** Read the metadata and author state of the current physical entry. */
  read(url?: string, state?: unknown): HistoryEntry | undefined;
  /** Prepare metadata for a write without changing the browser history. */
  create(url: string, state: unknown, disposition: HistoryDisposition): HistoryEntry | undefined;
  /** Apply a prepared write after the route has installed successfully. */
  apply(entry: HistoryEntry, disposition: HistoryDisposition): HistoryEntry | undefined;
  /** Release this caller's lease on the native method patch. */
  release(): void;
}

interface HistoryEnvelope {
  readonly state: unknown;
  readonly __hesperiaHistory: {
    readonly trackerId: string;
    readonly id: number;
    readonly position: number;
  };
}

interface WindowRecord {
  readonly trackerIds: Set<string>;
  tracker?: SharedHistoryTracker;
}

const windows = new WeakMap<Window, WindowRecord>();
let nextTrackerId = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function readEnvelope(
  value: unknown,
  url: string,
  trackerIds: ReadonlySet<string>,
): HistoryEntry | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !Object.prototype.hasOwnProperty.call(value, "__hesperiaHistory") ||
    !Object.prototype.hasOwnProperty.call(value, "state")
  )
    return undefined;
  const metadata = value.__hesperiaHistory;
  if (!isRecord(metadata)) return undefined;
  const trackerId = metadata.trackerId;
  const id = metadata.id;
  const position = metadata.position;
  if (
    typeof trackerId !== "string" ||
    !trackerIds.has(trackerId) ||
    typeof id !== "number" ||
    !Number.isSafeInteger(id) ||
    typeof position !== "number" ||
    !Number.isSafeInteger(position)
  )
    return undefined;
  return { trackerId, id, position, url, state: value.state };
}

function envelope(entry: HistoryEntry): HistoryEnvelope {
  return {
    // Keep author state first. Native structured cloning can execute author
    // getters that make a nested history write before metadata is read.
    state: entry.state,
    __hesperiaHistory: {
      trackerId: entry.trackerId,
      id: entry.id,
      position: entry.position,
    },
  };
}

/**
 * Install or join the shared native history tracker for one browser window.
 *
 * Native `history.state` consequently contains the Hesperia envelope. The
 * author payload is available through `HistoryEntry.state`; native calls keep
 * their normal return values and synchronous errors, and a lease release is
 * idempotent for its caller.
 */
export function installHistoryTracking(window: Window): HistoryTracker {
  let record = windows.get(window);
  if (!record) {
    record = { trackerIds: new Set<string>() };
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
  readonly #trackerId = `history-${++nextTrackerId}`;
  readonly #pushState: History["pushState"];
  readonly #replaceState: History["replaceState"];
  readonly #pushWrapper: History["pushState"];
  readonly #replaceWrapper: History["replaceState"];
  readonly #pushDescriptor: PropertyDescriptor | undefined;
  readonly #replaceDescriptor: PropertyDescriptor | undefined;
  #leases = 0;
  #nextEntryId = 0;

  constructor(window: Window, record: WindowRecord) {
    this.#window = window;
    this.#history = window.history;
    this.#record = record;
    this.#pushState = this.#history.pushState;
    this.#replaceState = this.#history.replaceState;
    this.#pushDescriptor = Object.getOwnPropertyDescriptor(this.#history, "pushState");
    this.#replaceDescriptor = Object.getOwnPropertyDescriptor(this.#history, "replaceState");
    this.#record.trackerIds.add(this.#trackerId);
    const initial = this.#read();
    if (initial) {
      this.#nextEntryId = initial.id;
    } else {
      const baseline: HistoryEntry = {
        trackerId: this.#trackerId,
        id: 1,
        position: 0,
        url: this.#window.location.href,
        state: this.#history.state,
      };
      // Stamp the physical entry before application startup. This preserves
      // an arbitrary initial author state while giving later pushes a base.
      Reflect.apply(this.#replaceState, this.#history, [
        envelope(baseline),
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
      let wrapped: HistoryEnvelope | undefined;
      if (nativeArgs.length > 0) {
        wrapped = this.#lazyEnvelope(args[0], disposition, this.#window.location.href);
        nativeArgs[0] = wrapped;
      }
      // Preserve the original argument count so native missing-argument errors
      // remain observable.
      Reflect.apply(
        disposition === "push" ? this.#pushState : this.#replaceState,
        history,
        nativeArgs,
      );
      if (wrapped) this.#accept();
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
      release: () => {
        if (released) return;
        released = true;
        this.release();
      },
    };
  }

  read(url = this.#window.location.href, state = this.#history.state): HistoryEntry | undefined {
    return this.#read(url, state);
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
    this.#accept();
    return this.#read(actual.url) ?? actual;
  }

  release(): void {
    if (this.#leases === 0) return;
    this.#leases--;
    if (this.#leases !== 0) return;
    if (this.#record.tracker === this) this.#record.tracker = undefined;
    if (this.#history.pushState === this.#pushWrapper)
      restore(this.#history, "pushState", this.#pushDescriptor);
    if (this.#history.replaceState === this.#replaceWrapper)
      restore(this.#history, "replaceState", this.#replaceDescriptor);
  }

  #read(
    url = this.#window.location.href,
    physicalState = this.#history.state,
  ): HistoryEntry | undefined {
    return readEnvelope(physicalState, url, this.#record.trackerIds);
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
    };
  }

  #accept(): void {
    const actual = this.#read();
    this.#nextEntryId = Math.max(this.#nextEntryId, actual?.id ?? 0);
  }

  #lazyEnvelope(state: unknown, disposition: "push" | "replace", url: string): HistoryEnvelope {
    let candidate: HistoryEntry | undefined;
    const getCandidate = () =>
      (candidate ??= this.#candidate(this.#read(), url, state, disposition));
    const metadata: HistoryEnvelope["__hesperiaHistory"] = {
      get trackerId() {
        return getCandidate().trackerId;
      },
      get id() {
        return getCandidate().id;
      },
      get position() {
        return getCandidate().position;
      },
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
