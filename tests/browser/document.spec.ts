import { expect, test } from "@playwright/test";

test("document installation replaces the native shell and activates its bound input", async ({
  page,
}) => {
  const errors: string[] = [];

  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/document");

  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");

  await expect(page.locator("html")).toHaveCount(1);

  await expect(page.locator("body")).toHaveCount(1);

  await expect(page).toHaveTitle("Document shell");

  await expect(page.locator("#shell-input")).toBeFocused();

  const input = await page.locator("#shell-input").elementHandle();

  if (!input) throw new Error("Document shell input is missing");

  await page.locator("#shell-update").click();

  await expect(page.locator("#shell-input")).toHaveValue("second");

  expect(await input.evaluate((node) => node === document.querySelector("#shell-input"))).toBe(
    true,
  );

  expect(
    await page.evaluate(() => {
      const fixture = (
        globalThis as unknown as {
          documentFixture: { previous: Element; errors: unknown[]; effects: number };
        }
      ).documentFixture;
      return {
        removed: fixture.previous.parentNode === null,
        errors: fixture.errors,
        effects: fixture.effects,
      };
    }),
  ).toStrictEqual({ removed: true, errors: [], effects: 1 });

  expect(errors).toStrictEqual([]);
});
