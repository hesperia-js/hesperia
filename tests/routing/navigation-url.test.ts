import { expect, test } from "bun:test";
import {
  browserHref,
  isWithinMount,
  normalizeMountPath,
  resolveNavigationTarget,
} from "../../packages/hesperia/src/routing/navigation-url.ts";

test("mount paths normalize without losing segment boundaries", () => {
  expect(normalizeMountPath()).toBe("/");

  expect(normalizeMountPath("/dashboard/")).toBe("/dashboard");

  expect(isWithinMount("/dashboard", "/dashboard")).toBe(true);

  expect(isWithinMount("/dashboard/todos", "/dashboard")).toBe(true);

  expect(isWithinMount("/dashboards", "/dashboard")).toBe(false);

  expect(() => normalizeMountPath("/dashboard?x=1")).toThrow();

  expect(() => normalizeMountPath("/dashboard/%2fadmin")).toThrow();
});

test("application URL resolution applies only the accepted leading-slash mount rule", () => {
  const mount = "/dashboard";
  const current = "https://example.test/dashboard/todos/42";

  const href = (value: string) =>
    browserHref(resolveNavigationTarget(value, current, mount), current);

  expect(href("/todos")).toBe("/dashboard/todos");

  expect(href("/dashboard/reports")).toBe("/dashboard/dashboard/reports");

  expect(href("./edit")).toBe("/dashboard/todos/edit");

  expect(href("?sort=newest")).toBe("/dashboard/todos/42?sort=newest");

  expect(href("#details")).toBe("/dashboard/todos/42#details");

  expect(href("https://help.example.test/guide")).toBe("https://help.example.test/guide");

  expect(() => resolveNavigationTarget("../../outside", current, mount)).toThrow(
    /leaves the application mount/,
  );
});

test("root mount keeps ordinary root-relative and relative URLs unchanged", () => {
  const current = "https://example.test/todos/42";

  expect(browserHref(resolveNavigationTarget("/new", current, "/"), current)).toBe("/new");

  expect(browserHref(resolveNavigationTarget("../new", current, "/"), current)).toBe("/new");
});
