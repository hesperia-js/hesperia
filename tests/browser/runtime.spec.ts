import { expect, test } from "@playwright/test";

test("compiled native handles, child bindings and independent writes retain their DOM", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");
  const input = page.getByRole("textbox", { name: "Bound field" });
  await expect(input).toBeFocused();
  const originalInput = await input.elementHandle();
  const button = page.locator("main button");
  const originalButton = await button.elementHandle();
  await expect(button).toHaveText("0");
  expect(
    await button.evaluate((node) => {
      const button = node as HTMLButtonElement;
      button.click();
      const first = button.textContent;
      button.click();
      return [first, button.textContent];
    }),
  ).toEqual(["1", "2"]);
  expect(
    await originalButton!.evaluate((node) => node === document.querySelector("main button")),
  ).toBe(true);
  expect(await originalInput!.evaluate((node) => node === document.querySelector("input"))).toBe(
    true,
  );
  await page.getByRole("button", { name: "Remove application" }).click();
  await expect(page.locator("main")).toHaveCount(0);
  expect(await originalButton!.evaluate((node) => node.isConnected)).toBe(false);
  expect(errors).toEqual([]);
});
