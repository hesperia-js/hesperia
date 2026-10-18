import { expect, test } from "bun:test";
import { resolveAppConfiguration } from "../../packages/hesperia/src/application.ts";

test("application cache configuration preserves zero and rejects unusable limits", () => {
  expect(resolveAppConfiguration({})).toStrictEqual({ pageCacheSize: 5 });

  expect(resolveAppConfiguration({ pageCacheSize: 0 })).toStrictEqual({ pageCacheSize: 0 });

  expect(resolveAppConfiguration({ pageCacheSize: 12 })).toStrictEqual({ pageCacheSize: 12 });

  class CacheConfiguration {
    readonly pageCacheSize = 12;
  }

  for (const value of [
    new CacheConfiguration(),
    Object.assign(Object.create(null), { pageCacheSize: 12 }),
  ]) {
    expect(resolveAppConfiguration(value)).toStrictEqual({ pageCacheSize: 12 });
  }

  for (const pageCacheSize of [-1, 1.5, NaN, Infinity, 2 ** 53, "5", null, true]) {
    expect(() => resolveAppConfiguration({ pageCacheSize })).toThrow(
      "pageCacheSize must be a nonnegative safe integer",
    );
  }

  expect(() => resolveAppConfiguration({ cachePageSize: 5 })).toThrow(
    "Unknown application setting: cachePageSize",
  );

  for (const value of [null, [], "configuration", undefined]) {
    expect(() => resolveAppConfiguration(value)).toThrow(
      "app.config.ts must default-export a configuration object",
    );
  }
});
