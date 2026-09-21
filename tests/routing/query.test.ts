import { expect, test } from "bun:test";
import { readonlyQueryParams } from "../../src/routing/query.ts";

test("readonly query snapshots retain URL encoding, repeated entries, and destructurable read methods", () => {
  const query = readonlyQueryParams("name=Ana+Mar%C3%ADa&tag=one&tag=two&empty=");
  const { get, getAll, has, keys, values, entries, forEach, toString } = query;
  expect(query.size).toBe(4);
  expect(get("name")).toBe("Ana María");
  expect(get("absent")).toBeNull();
  expect(getAll("tag")).toStrictEqual(["one", "two"]);
  expect(has("tag", "two")).toBe(true);
  expect(has("tag", "missing")).toBe(false);
  expect(has("empty")).toBe(true);
  expect([...keys()]).toStrictEqual(["name", "tag", "tag", "empty"]);
  expect([...values()]).toStrictEqual(["Ana María", "one", "two", ""]);
  expect([...entries()]).toStrictEqual([...query]);
  const observed: string[] = [];
  const receiver = {};
  forEach(function (this: object, value, name, view) {
    expect(this).toBe(receiver);
    expect(view).toBe(query);
    observed.push(`${name}:${value}`);
  }, receiver);
  expect(observed).toStrictEqual(["name:Ana María", "tag:one", "tag:two", "empty:"]);
  expect(toString()).toBe("name=Ana+Mar%C3%ADa&tag=one&tag=two&empty=");
  for (const method of ["append", "delete", "set", "sort"] as const)
    expect(() => Reflect.get(query, method)("tag", "bad")).toThrow("read-only");
  expect(getAll("tag")).toStrictEqual(["one", "two"]);
});
