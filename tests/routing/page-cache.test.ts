import { expect, test } from "bun:test";
import { PageCache, type PageCacheValue } from "../../packages/hesperia/src/routing/page-cache.ts";

function page(label: string, events: string[]): PageCacheValue {
  return {
    park: () => events.push(`park:${label}`),
    restore: () => events.push(`restore:${label}`),
    dispose: (reason) => events.push(`dispose:${label}:${String(reason ?? "none")}`),
  };
}

test("retains distinct pages in insertion order and evicts the oldest first", () => {
  const events: string[] = [];
  const cache = new PageCache<number, PageCacheValue>(2);
  const first = page("first", events);
  const second = page("second", events);
  const third = page("third", events);

  cache.add(1, first);

  cache.add(2, second);

  cache.add(3, third);

  expect(cache.size).toBe(2);

  expect(cache.get(1)).toBeUndefined();

  expect(cache.get(2)).toBe(second);

  expect(cache.get(3)).toBe(third);

  expect(events).toStrictEqual(["dispose:first:none"]);
});

test("query-only aliases share one retained page and do not consume another slot", () => {
  const events: string[] = [];
  const cache = new PageCache<number, PageCacheValue>(1);
  const route = page("route", events);

  cache.add(10, route);

  cache.alias(11, route);

  expect(cache.size).toBe(1);

  expect(cache.get(10)).toBe(route);

  expect(cache.get(11)).toBe(route);

  cache.delete(route, "evicted");

  expect(cache.get(10)).toBeUndefined();

  expect(cache.get(11)).toBeUndefined();

  expect(events).toStrictEqual(["dispose:route:evicted"]);
});

test("zero capacity disables retention without invoking disposal for an unretained page", () => {
  const events: string[] = [];
  const cache = new PageCache<number, PageCacheValue>(0);
  const route = page("route", events);

  cache.add(1, route);

  expect(cache.size).toBe(0);

  expect(cache.get(1)).toBeUndefined();

  expect(events).toStrictEqual([]);
});

test("removing the last alias releases the cache slot without destroying the page", () => {
  const events: string[] = [];
  const cache = new PageCache<number, PageCacheValue>(2);
  const route = page("route", events);

  cache.add(1, route);

  cache.alias(2, route);

  cache.removeKey(1);

  expect(cache.get(2)).toBe(route);

  cache.removeKey(2);

  expect(cache.size).toBe(0);

  expect(events).toStrictEqual([]);
});

test("reassigning an entry disposes its old page only after its last history alias is gone", () => {
  const events: string[] = [];
  const cache = new PageCache<number, PageCacheValue>(3);
  const previous = page("previous", events);
  const next = page("next", events);

  cache.add(1, previous);

  cache.alias(2, previous);

  cache.add(1, next);

  expect(cache.get(2)).toBe(previous);

  expect(events).toStrictEqual([]);

  cache.alias(2, next);

  expect(cache.size).toBe(1);

  expect(cache.get(1)).toBe(next);

  expect(cache.get(2)).toBe(next);

  expect(events).toStrictEqual(["dispose:previous:none"]);
});

test("cache teardown releases every page even when an author cleanup throws", () => {
  const events: string[] = [];
  const cache = new PageCache<number, PageCacheValue>(3);
  const error = new Error("cleanup");

  cache.add(1, {
    ...page("first", events),

    dispose() {
      events.push("first failed");

      throw error;
    },
  });

  cache.add(2, page("second", events));

  cache.add(3, page("third", events));

  let caught: unknown;

  try {
    cache.clear("closed");
  } catch (failure) {
    caught = failure;
  }

  expect(caught).toBeInstanceOf(AggregateError);

  expect((caught as AggregateError).errors).toStrictEqual([error]);

  expect(events).toStrictEqual(["first failed", "dispose:second:closed", "dispose:third:closed"]);

  expect(cache.size).toBe(0);

  expect(cache.get(2)).toBeUndefined();

  cache.clear();

  expect(events).toHaveLength(3);
});
