import { expect, test } from "@playwright/test";

declare global {
  interface Window {
    errorBoundaryFixture: {
      snapshot(): { events: string[]; errors: string[] };

      dispose(): void;
    };
  }
}

test("compiled error views replace failed content, preserve native siblings, and forward their own faults", async ({
  page,
}) => {
  const errors: string[] = [];

  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/error-boundary");

  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");

  const sibling = await page.locator("#error-sibling").elementHandle();

  if (!sibling) throw new Error("The sibling was not mounted");

  await page.locator("#error-sibling").fill("preserved native value");

  await page.locator("#fail-content").click();

  await expect(page.locator("#error-message")).toHaveText("Content failed");

  await expect(page.locator("#error-content-field")).toHaveCount(0);

  await expect(page.locator("#error-sibling")).toHaveValue("preserved native value");

  expect(await sibling.evaluate((node) => node === document.getElementById("error-sibling"))).toBe(
    true,
  );

  expect(await page.evaluate(() => window.errorBoundaryFixture.snapshot())).toStrictEqual({
    events: ["content cleanup:true", "error effect:true"],
    errors: [],
  });

  await page.locator("#fail-error").click();

  await expect(page.locator("#outer-error")).toHaveText("Error view failed");

  await expect(page.locator("#error-message")).toHaveCount(0);

  expect(await page.evaluate(() => window.errorBoundaryFixture.snapshot())).toStrictEqual({
    events: [
      "content cleanup:true",
      "error effect:true",
      "error effect:true",
      "error cleanup:true",
    ],
    errors: [],
  });

  await page.evaluate(() => window.errorBoundaryFixture.dispose());

  await expect(page.locator("#app")).toBeEmpty();

  expect(errors).toStrictEqual([]);
});
