import { expect, test } from "@playwright/test";

interface RawFixture {
  readonly errors: readonly string[];
  readonly supportsTrustedTypes: boolean;

  replace(): void;

  untrusted(): void;

  trusted(): void;

  dispose(): void;
}

test("raw hosts and fragments use native parser context and remove complete regions", async ({
  page,
}) => {
  await page.goto("/raw");

  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");

  await expect(page.locator("tbody > tr > td")).toHaveText("one");

  await expect(page.locator("select > option")).toHaveText("One");

  const result = await page.evaluate(() => {
    const fixture = (globalThis as unknown as { rawFixture: RawFixture }).rawFixture;
    const oldHost = document.querySelector("article")!;
    const oldRow = document.querySelector("tr")!;
    const oldOption = document.querySelector("option")!;

    fixture.replace();

    const replacement = {
      hostChanged: oldHost !== document.querySelector("article"),
      oldDetached: [oldHost, oldRow, oldOption].every((node) => !node.isConnected),
      rows: [...document.querySelectorAll("tbody > tr > td")].map((node) => node.textContent),
      options: [...document.querySelectorAll("select > option")].map((node) => node.textContent),
      hostText: document.querySelector("article")!.textContent,
      errors: [...fixture.errors],
    };

    fixture.dispose();

    return { ...replacement, empty: document.getElementById("app")!.childNodes.length === 0 };
  });

  expect(result).toEqual({
    hostChanged: true,
    oldDetached: true,
    rows: ["two", "three"],
    options: ["Two"],
    hostText: "Second",
    errors: [],
    empty: true,
  });
});

test("raw HTML preserves browser Trusted Types enforcement", async ({ page }) => {
  await page.goto("/raw?trusted");

  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");

  const supports = await page.evaluate(
    () => (globalThis as unknown as { rawFixture: RawFixture }).rawFixture.supportsTrustedTypes,
  );

  test.skip(!supports, "This engine does not expose Trusted Types");

  await expect(page.locator("article")).toHaveText("Trusted");

  const rejected = await page.evaluate(() => {
    const fixture = (globalThis as unknown as { rawFixture: RawFixture }).rawFixture;

    fixture.untrusted();

    return { errors: [...fixture.errors], html: document.getElementById("app")!.innerHTML };
  });

  expect(rejected.errors.length).toBeGreaterThan(0);

  expect(rejected.html).not.toContain("Rejected");

  await page.evaluate(() =>
    (globalThis as unknown as { rawFixture: RawFixture }).rawFixture.trusted(),
  );

  await expect(page.locator("article")).toHaveText("Accepted");
});
