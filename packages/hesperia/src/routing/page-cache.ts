/** A retained route lifetime that can be suspended, resumed, and destroyed. */
export interface PageCacheValue {
  /** Remove reactive delivery and detach the retained route from its outlet. */
  readonly park: () => void;
  /** Reattach the retained route and resume its reactive delivery. */
  readonly restore: () => void;
  /** Destroy the retained route and cancel its owned work. */
  readonly dispose: (reason?: unknown) => void;
}

/**
 * FIFO retention for history-keyed route lifetimes.
 *
 * A value may have several keys when query-only history entries share one
 * component instance. Aliases do not consume additional capacity; the value
 * is evicted only after its first insertion reaches the front of the queue.
 */
export class PageCache<K, V extends PageCacheValue> {
  private readonly entries = new Map<K, V>();
  private readonly keys = new Map<V, Set<K>>();
  private readonly order: V[] = [];
  private capacity: number;

  /** Create a cache with a non-negative FIFO capacity. */
  constructor(limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 0)
      throw new RangeError("A page-cache limit must be a non-negative safe integer");

    this.capacity = limit;
  }

  /** Number of distinct retained route lifetimes, excluding aliases. */
  get size(): number {
    return this.order.length;
  }

  /** Current maximum number of retained route lifetimes. */
  get limit(): number {
    return this.capacity;
  }

  /** Find a retained route by any of its history keys. */
  get(key: K): V | undefined {
    return this.entries.get(key);
  }

  /** Associate another history key; dispose any displaced page that loses its last alias. */
  alias(key: K, value: V): void {
    if (!this.keys.has(value)) throw new Error("Cannot alias a route that is not retained");

    const previous = this.entries.get(key);

    if (previous === value) return;

    if (previous) this.removeKey(key, previous);

    this.entries.set(key, value);

    this.keys.get(value)!.add(key);

    if (previous && !this.keys.has(previous)) previous.dispose();
  }

  /** Retain a route and evict the earliest retained route when capacity overflows. */
  add(key: K, value: V): void {
    if (this.capacity === 0) return;

    const previous = this.entries.get(key);

    if (previous === value) return;

    if (previous) this.removeKey(key, previous);

    const existingKeys = this.keys.get(value);

    if (existingKeys) {
      this.entries.set(key, value);

      existingKeys.add(key);

      if (previous && !this.keys.has(previous)) previous.dispose();

      return;
    }

    this.entries.set(key, value);

    this.keys.set(value, new Set([key]));

    this.order.push(value);

    const removed: V[] = previous && !this.keys.has(previous) ? [previous] : [];

    while (this.order.length > this.capacity) {
      const oldest = this.order[0]!;

      this.removeValue(oldest, false);

      removed.push(oldest);
    }

    this.disposeValues(removed);
  }

  /** Remove one history alias without destroying the retained route. */
  removeKey(key: K, expected?: V): void {
    const value = this.entries.get(key);

    if (!value || (expected && value !== expected)) return;

    this.entries.delete(key);

    const aliases = this.keys.get(value);

    aliases?.delete(key);

    if (aliases?.size === 0) this.removeValue(value, false);
  }

  /** Remove and destroy one retained route lifetime. */
  delete(value: V, reason?: unknown): void {
    if (!this.keys.has(value)) return;

    this.removeValue(value, true, reason);
  }

  /** @internal Destroy retained pages whose development dependencies were removed. */
  deleteMatching(predicate: (value: V) => boolean, reason?: unknown): void {
    const removed = this.order.filter(predicate);

    for (const value of removed) this.removeValue(value, false);

    this.disposeValues(removed, reason);
  }

  /** Remove a retained route without destroying it, for immediate restoration. */
  release(value: V): void {
    this.removeValue(value, false);
  }

  /** Destroy every retained lifetime; aggregate cleanup failures after all aliases are released. */
  clear(reason?: unknown): void {
    const removed = this.order.slice();

    this.entries.clear();

    this.keys.clear();

    this.order.length = 0;

    this.disposeValues(removed, reason);
  }

  /** Change capacity, evicting earliest routes immediately when it shrinks. */
  setLimit(limit: number, reason?: unknown): void {
    if (!Number.isSafeInteger(limit) || limit < 0)
      throw new RangeError("A page-cache limit must be a non-negative safe integer");

    this.capacity = limit;
    const removed: V[] = [];

    while (this.order.length > limit) {
      const oldest = this.order[0]!;

      this.removeValue(oldest, false);

      removed.push(oldest);
    }

    this.disposeValues(removed, reason);
  }

  private removeValue(value: V, destroy: boolean, reason?: unknown): void {
    const aliases = this.keys.get(value);

    if (!aliases) return;

    for (const key of aliases) this.entries.delete(key);

    this.keys.delete(value);

    const index = this.order.indexOf(value);

    if (index >= 0) this.order.splice(index, 1);

    if (destroy) value.dispose(reason);
  }

  private disposeValues(values: readonly V[], reason?: unknown): void {
    const errors: unknown[] = [];

    for (const value of values) {
      try {
        value.dispose(reason);
      } catch (error) {
        errors.push(error);
      }
    }

    if (errors.length) throw new AggregateError(errors, "Cached page cleanup failed");
  }
}
