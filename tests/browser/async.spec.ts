import { expect, test } from "@playwright/test";

interface AsyncFixture {
  readonly errors: readonly string[];
  readonly independentErrors: readonly string[];
  readonly events: readonly string[];
  readonly awaitedChildBodies: number;
  readonly refusedChildBodies: number;
  dispose(): void;
}

test("awaited child composition commits descendant effects before the parent", async ({ page }) => {
  await page.goto("/async");
  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");
  await expect(page.locator("#awaiting-parent")).toContainText("awaited child");
  await expect(page.locator("#awaited-input")).toBeFocused();
  const fixture = await page.evaluate(
    () => (globalThis as unknown as { asyncFixture: AsyncFixture }).asyncFixture,
  );
  expect(fixture.events).toEqual(["child-effect", "parent-effect"]);
  expect(fixture.awaitedChildBodies).toBe(1);
  expect(fixture.errors).toEqual([]);
  await page.evaluate(() =>
    (globalThis as unknown as { asyncFixture: AsyncFixture }).asyncFixture.dispose(),
  );
  await expect(page.locator("#awaiting-parent")).toHaveCount(0);
  await expect(page.locator("#awaited-input")).toHaveCount(0);
});

test("an independently composed async child rejects a required binding before its body", async ({
  page,
}) => {
  await page.goto("/async");
  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");
  const fixture = await page.evaluate(
    () => (globalThis as unknown as { asyncFixture: AsyncFixture }).asyncFixture,
  );
  expect(fixture.refusedChildBodies).toBe(0);
  expect(fixture.independentErrors).toEqual([
    "An async component requires an enclosing async boundary",
  ]);
  await expect(page.locator("#refused-child")).toHaveCount(0);
  await expect(page.locator("#awaiting-parent")).toContainText("awaited child");
  await page.evaluate(() =>
    (globalThis as unknown as { asyncFixture: AsyncFixture }).asyncFixture.dispose(),
  );
});
