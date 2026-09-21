import { expect, test } from "@playwright/test";

test("compiled callback prop types preserve accessor behavior and child lifetime", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/props");
  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");
  await expect(page.locator("#optional-callback")).toHaveText("first");
  await expect(page.locator("#nullable-callback")).toHaveText("first");
  await expect(page.locator("#required-callback")).toHaveText("required");
  await expect(page.locator("#named-prop")).toHaveText("own value");
  const child = await page.locator("#prop-child").elementHandle();
  if (!child) throw new Error("The compiled child was not rendered");
  await page.locator("#clear-callback").click();
  await expect(page.locator("#optional-callback")).toHaveText("absent");
  await expect(page.locator("#nullable-callback")).toHaveText("absent");
  await page.locator("#replace-callback").click();
  await expect(page.locator("#optional-callback")).toHaveText("second");
  await expect(page.locator("#nullable-callback")).toHaveText("second");
  expect(await child.evaluate((element) => element === document.querySelector("#prop-child"))).toBe(
    true,
  );
  expect(
    await page.evaluate(() =>
      (
        globalThis as unknown as {
          propsFixture: { childBodies(): number };
        }
      ).propsFixture.childBodies(),
    ),
  ).toBe(1);
  expect(await page.locator("html").getAttribute("data-fault")).toBeNull();
  expect(errors).toStrictEqual([]);
});
