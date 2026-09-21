import { signal } from "aeolia";
import type { Accessor } from "../client.ts";
import { RenderFault } from "../runtime/owner.ts";

/** Hesperia's immutable query snapshot, using the platform's URL parsing and read semantics. */
export interface ReadonlyQueryParams<K extends string = string> extends Iterable<[string, string]> {
  /** Number of key/value entries, including repeated keys. */
  readonly size: number;
  /** First value for a key, or null when absent. */
  get(name: K): string | null;
  /** Every value for a key in query order. */
  getAll(name: K): string[];
  /** Whether a key, optionally with a matching value, occurs. */
  has(name: K, value?: string): boolean;
  /** Iterate keys, retaining repeated entries. */
  keys(): IterableIterator<string>;
  /** Iterate values in query order. */
  values(): IterableIterator<string>;
  /** Iterate key/value entries in query order. */
  entries(): IterableIterator<[string, string]>;
  /** Visit entries with this immutable view as the third argument. */
  forEach(
    callback: (value: string, key: string, view: ReadonlyQueryParams<K>) => void,
    thisArg?: unknown,
  ): void;
  /** Serialize using URLSearchParams's application/x-www-form-urlencoded encoding. */
  toString(): string;
}

/** Build an immutable query value without exposing the underlying mutable URLSearchParams. */
export function readonlyQueryParams(search: string): ReadonlyQueryParams {
  const params = new URLSearchParams(search);
  const deny = () => {
    throw new RenderFault(
      "query-readonly",
      "Query parameters change through navigation, not the read-only view",
    );
  };
  const view: ReadonlyQueryParams = Object.freeze({
    size: params.size,
    get: (name: string) => params.get(name),
    getAll: (name: string) => params.getAll(name),
    has: (name: string, value?: string) =>
      value === undefined ? params.has(name) : params.has(name, value),
    keys: () => params.keys(),
    values: () => params.values(),
    entries: () => params.entries(),
    [Symbol.iterator]: () => params.entries(),
    forEach(
      callback: (value: string, key: string, view: ReadonlyQueryParams) => void,
      thisArg?: unknown,
    ) {
      params.forEach((value, key) => callback.call(thisArg, value, key, view));
    },
    toString: () => params.toString(),
    append: deny,
    delete: deny,
    set: deny,
    sort: deny,
  });
  return view;
}

/**
 * Owner-controlled reactive query view; its updater is retained only by the navigation runtime.
 * @param search - Initial platform query string, with or without its leading question mark.
 * @param signalLifetime - Revokes the view when its route lifetime ends.
 * @param cleaning - Permits reads while the revoked route's owner is running cleanup.
 * @returns A reactive reader and runtime updater. Reads return immutable snapshots;
 * equivalent serialized updates do not publish a new value.
 */
export function createQueryParams(
  search: string,
  signalLifetime: AbortSignal,
  cleaning: () => boolean = () => false,
): { readonly read: Accessor<ReadonlyQueryParams>; readonly update: (search: string) => void } {
  const source = signal(readonlyQueryParams(search));
  const assertLive = () => {
    if (signalLifetime.aborted && !cleaning())
      throw new RenderFault("disposed", "The query view belongs to a disposed route");
  };
  return {
    read() {
      assertLive();
      return source.get();
    },
    update(next) {
      assertLive();
      if (source.get().toString() !== new URLSearchParams(next).toString())
        source.set(readonlyQueryParams(next));
    },
  };
}
