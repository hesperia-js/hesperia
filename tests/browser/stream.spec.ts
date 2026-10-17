import { expect, test } from "@playwright/test";

test("compiled imported feeds share a stream, release it after final departure, and reopen it", async ({
  page,
}) => {
  const errors: string[] = [];

  page.on("pageerror", (error) => errors.push(error.message));

  await page.clock.install();

  await page.goto("/stream");

  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");

  const stats = () =>
    page.evaluate(() =>
      (
        globalThis as unknown as {
          streamFixture: { streamStats(): { opens: number; aborts: number } };
        }
      ).streamFixture.streamStats(),
    );

  const first = page.locator('[data-consumer="first"]');
  const second = page.locator('[data-consumer="second"]');
  const firstHistory = page.locator('[data-history="first"]');
  const secondHistory = page.locator('[data-history="second"]');
  const firstTotal = page.locator('[data-total="first"]');
  const secondTotal = page.locator('[data-total="second"]');

  expect(await stats()).toEqual({ opens: 1, aborts: 0 });

  await expect(first).toHaveText("opening:empty");

  await expect(second).toHaveText("opening:empty");

  await expect(firstHistory).toHaveText("");

  await expect(secondHistory).toHaveText("");

  await expect(firstTotal).toHaveText("0");

  await expect(secondTotal).toHaveText("0");

  await page.getByRole("button", { name: "Emit one" }).click();

  await expect(first).toHaveText("live:1");

  await expect(second).toHaveText("live:1");

  await expect(firstHistory).toHaveText("1");

  await expect(secondHistory).toHaveText("1");

  await expect(firstTotal).toHaveText("1");

  await expect(secondTotal).toHaveText("1");

  await page.getByRole("button", { name: "Emit one" }).click();

  await expect(firstHistory).toHaveText("1,1");

  await expect(secondHistory).toHaveText("1,1");

  await expect(firstTotal).toHaveText("2");

  await expect(secondTotal).toHaveText("2");

  expect(await stats()).toEqual({ opens: 1, aborts: 0 });

  const retained = await second.elementHandle();

  expect(retained).not.toBeNull();

  await page.getByRole("button", { name: "Remove first" }).click();

  await expect(first).toHaveCount(0);

  await page.clock.fastForward(1100);

  await page.getByRole("button", { name: "Emit two" }).click();

  await expect(second).toHaveText("live:2");

  await expect(secondHistory).toHaveText("1,1,2");

  await expect(secondTotal).toHaveText("4");

  expect(
    await retained!.evaluate((node) => node === document.querySelector('[data-consumer="second"]')),
  ).toBe(true);

  expect(await stats()).toEqual({ opens: 1, aborts: 0 });

  await page.getByRole("button", { name: "Restore first" }).click();

  await expect(first).toHaveText("live:2");

  await expect(firstHistory).toHaveText("");

  await expect(firstTotal).toHaveText("0");

  await expect(secondHistory).toHaveText("1,1,2");

  await page.getByRole("button", { name: "Emit one" }).click();

  await expect(firstHistory).toHaveText("1");

  await expect(firstTotal).toHaveText("1");

  await expect(secondHistory).toHaveText("1,1,2,1");

  await expect(secondTotal).toHaveText("5");

  expect(await stats()).toEqual({ opens: 1, aborts: 0 });

  await page.getByRole("button", { name: "Remove first" }).click();

  await expect(first).toHaveCount(0);

  await page.getByRole("button", { name: "Remove second" }).click();

  await expect(second).toHaveCount(0);

  await page.clock.fastForward(1100);

  await expect.poll(stats).toEqual({ opens: 1, aborts: 1 });

  await page.getByRole("button", { name: "Restore second" }).click();

  await expect.poll(stats).toEqual({ opens: 2, aborts: 1 });

  await page.getByRole("button", { name: "Emit one" }).click();

  await expect(second).toHaveText("live:1");

  await expect(secondHistory).toHaveText("1");

  await expect(secondTotal).toHaveText("1");

  expect(await retained!.evaluate((node) => node.isConnected)).toBe(false);

  await expect(page.locator("html")).not.toHaveAttribute("data-fault");

  expect(errors).toEqual([]);
});
