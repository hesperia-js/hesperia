import { describe, expect, test } from "bun:test";
import { canonicalizeMountURL } from "../../packages/hosting/src/internal/mount.ts";

describe("canonicalizeMountURL", () => {
  test("normalizes the root and one trailing slash", () => {
    expect(canonicalizeMountURL("/")).toBe("/");

    expect(canonicalizeMountURL("/dashboard/")).toBe("/dashboard");

    expect(canonicalizeMountURL("/dashboard")).toBe("/dashboard");
  });

  test("saves raw Unicode in canonical URL form and is stable on re-entry", () => {
    const saved = canonicalizeMountURL("/café/影");

    expect(saved).toBe("/caf%C3%A9/%E5%BD%B1");

    expect(canonicalizeMountURL(saved)).toBe(saved);
  });

  test("accepts only canonical percent-encoded segments", () => {
    expect(canonicalizeMountURL("/team%20docs")).toBe("/team%20docs");

    expect(canonicalizeMountURL("/team%20docs/child")).toBe("/team%20docs/child");

    expect(canonicalizeMountURL("/team%20docs/")).toBe("/team%20docs");

    for (const path of ["/team%2fdocs", "/team%2Fdocs", "/team%2520docs", "/team%41"]) {
      expect(() => canonicalizeMountURL(path)).toThrow(TypeError);
    }
  });

  test("uses the browser pathname representation for path punctuation", () => {
    expect(canonicalizeMountURL("/@team/:scope+a")).toBe("/@team/:scope+a");

    expect(canonicalizeMountURL("/caret^name")).toBe("/caret%5Ename");

    expect(canonicalizeMountURL("/caret%5Ename")).toBe("/caret%5Ename");

    expect(() => canonicalizeMountURL("/%40team")).toThrow(TypeError);
  });

  test("rejects origins, delimiters, empty and traversal segments", () => {
    for (const path of [
      "dashboard",
      "//other.example/dashboard",
      "https://other.example/dashboard",
      "/dashboard?x=1",
      "/dashboard#fragment",
      "/dashboard\\child",
      "/dashboard//child",
      "/dashboard/.",
      "/dashboard/..",
      "/dashboard/%2E",
      "/dashboard/%2E%2E",
      "/dashboard/%2Fchild",
      "/dashboard/%5Cchild",
      "/dashboard/%3Fchild",
      "/dashboard/%23child",
      "/dashboard/%25child",
      "/dashboard/%",
      "/dashboard/%C0%AF",
      "/dashboard/\u0000child",
      "/dashboard/\ud800",
    ]) {
      expect(() => canonicalizeMountURL(path)).toThrow(TypeError);
    }
  });
});
