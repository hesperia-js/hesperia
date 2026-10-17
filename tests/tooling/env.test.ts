import { expect, test } from "bun:test";
import { env } from "../../packages/hesperia/src/env.ts";

const textKey = "HESPERIA_COVERAGE_ENV_TEXT";
const numberKey = "HESPERIA_COVERAGE_ENV_NUMBER";
const booleanKey = "HESPERIA_COVERAGE_ENV_BOOLEAN";

function withValue<T>(key: string, value: string | undefined, work: () => T): T {
  const previous = process.env[key];

  if (value === undefined) delete process.env[key];
  else process.env[key] = value;

  try {
    return work();
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
}

test("the public env reader distinguishes missing, empty, and optional strings", () => {
  withValue(textKey, undefined, () => {
    expect(() => env(textKey)).toThrow(`${textKey} env variable must be defined`);

    expect(env(textKey, "fallback")).toBe("fallback");

    expect(env(textKey, undefined, true)).toBeUndefined();
  });

  withValue(textKey, "", () => {
    expect(env(textKey, "fallback")).toBe("fallback");

    expect(env(textKey, undefined, true)).toBe("");
  });

  withValue(textKey, "present", () => expect(env(textKey)).toBe("present"));
});

test("the numeric reader retains Number conversion and optional absence", () => {
  withValue(numberKey, undefined, () => {
    expect(env.num(numberKey, 3000)).toBe(3000);

    expect(env.num(numberKey, undefined, true)).toBeUndefined();
  });

  withValue(numberKey, "", () => expect(env.num(numberKey, 3000)).toBe(3000));

  withValue(numberKey, "0x10", () => expect(env.num(numberKey, 0)).toBe(16));

  withValue(numberKey, "Infinity", () => expect(env.num(numberKey, 0)).toBe(Infinity));

  withValue(numberKey, "invalid", () =>
    expect(() => env.num(numberKey, 0)).toThrow(
      `${numberKey} env variable must be a number got invalid`,
    ),
  );
});

test("the boolean reader defaults to false and rejects values outside true or false", () => {
  withValue(booleanKey, undefined, () => {
    expect(env.bool(booleanKey)).toBe(false);

    expect(env.bool(booleanKey, true)).toBe(true);
  });

  withValue(booleanKey, "", () => expect(env.bool(booleanKey, true)).toBe(true));

  withValue(booleanKey, "TrUe", () => expect(env.bool(booleanKey)).toBe(true));

  withValue(booleanKey, "FaLsE", () => expect(env.bool(booleanKey, true)).toBe(false));

  withValue(booleanKey, "yes", () =>
    expect(() => env.bool(booleanKey)).toThrow(
      `${booleanKey} env variable must be 'true' or 'false' got yes`,
    ),
  );
});
