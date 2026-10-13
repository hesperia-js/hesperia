import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { projectPublicValues } from "../../packages/tooling/src/public-values.ts";

test("nested public data keeps undefined, non-finite numbers and immutable browser copies", async () => {
  const original = {
    SETTINGS: {
      values: ["ready", undefined, Infinity, -Infinity, NaN, { enabled: true }],
      missing: null,
    },
    Δ: "greek-start",
    _δ: "underscore-start",
    dollar$part: "dollar-continuation",
    has_name: "underscore-continuation",
    "cafe\u0301": "combining-mark",
    "join\u200Cname": "zero-width-non-joiner",
    "join\u200Dname": "zero-width-joiner",
  };
  const projected = projectPublicValues(original);
  original.SETTINGS.values[0] = "changed";

  expect(projected.values.SETTINGS).toStrictEqual({
    values: ["ready", undefined, Infinity, -Infinity, NaN, { enabled: true }],
    missing: null,
  });

  expect(projected.browser).toContain("undefined");

  expect(projected.browser).toContain("Infinity");

  expect(projected.declaration).toContain('readonly ["ready", undefined, number, number, number');

  const root = await mkdtemp(join(tmpdir(), "hesperia-public-"));

  try {
    const filename = join(root, "public.mjs");

    await writeFile(filename, projected.browser);

    const browser = await import(pathToFileURL(filename).href);

    expect(browser.SETTINGS.values).toStrictEqual([
      "ready",
      undefined,
      Infinity,
      -Infinity,
      NaN,
      { enabled: true },
    ]);

    expect(browser.Δ).toBe("greek-start");

    expect(browser._δ).toBe("underscore-start");

    expect(browser["dollar$part"]).toBe("dollar-continuation");

    expect(browser.has_name).toBe("underscore-continuation");

    expect(browser["cafe\u0301"]).toBe("combining-mark");

    expect(browser["join\u200Cname"]).toBe("zero-width-non-joiner");

    expect(browser["join\u200Dname"]).toBe("zero-width-joiner");

    expect(Object.isFrozen(browser.SETTINGS.values)).toBe(true);

    expect(Object.isFrozen(browser.SETTINGS.values[5])).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("public data rejects cycles, accessors, class instances, symbols and unsupported leaves", () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;

  expect(() => projectPublicValues({ CYCLE: cycle })).toThrow("cycle");

  expect(() => projectPublicValues({ CLASS: new Date() })).toThrow("plain objects");

  expect(() => projectPublicValues({ FN: () => true })).toThrow("public data values");

  expect(() => projectPublicValues({ BIG: 1n })).toThrow("public data values");

  expect(() => projectPublicValues({ SYM: Symbol("private") })).toThrow("public data values");

  const accessed = Object.defineProperty({}, "secret", {
    enumerable: true,

    get() {
      return "no";
    },
  });

  expect(() => projectPublicValues({ ACCESSED: accessed })).toThrow("accessors");

  const hidden = Object.defineProperty({}, "secret", { value: () => true });

  expect(() => projectPublicValues({ HIDDEN: hidden })).toThrow("hidden properties");

  expect(() => projectPublicValues(Object.defineProperty({}, "HIDDEN", { value: 1 }))).toThrow(
    "hidden properties",
  );

  const array = ["visible"] as string[] & { secret?: string };
  array.secret = "hidden";

  expect(() => projectPublicValues({ ARRAY: array })).toThrow("named array properties");

  expect(() => projectPublicValues({ default: 1 })).toThrow("Invalid public export name");

  expect(() => projectPublicValues({ class: 1 })).toThrow("Invalid public export name");
});
