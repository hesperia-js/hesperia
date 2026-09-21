import { expect, test } from "@playwright/test";

test("named and anonymous function components keep ownership through recursion and prop updates", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/functions");
  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");
  expect(await page.locator("html").getAttribute("data-fault")).toBeNull();
  await expect(page.locator("#tree-leaf")).toHaveText("leaf");
  await expect(page.locator(".tree-label")).toHaveText(["first", "first", "first"]);
  const input = await page.locator("#function-field").elementHandle();
  const leaf = await page.locator("#tree-leaf").elementHandle();
  await expect(page.locator("#deferred-function-field")).toHaveAttribute("data-effect", "ready");
  const deferred = await page.locator("#deferred-function-field").elementHandle();
  if (!input || !leaf) throw new Error("Function components did not render their native elements");
  if (!deferred) throw new Error("Async function component did not resume and render");
  await page.locator("#update-functions").click();
  await expect(page.locator(".tree-label")).toHaveText(["SECOND", "SECOND", "SECOND"]);
  await expect(page.locator("#function-field")).toHaveValue("SECOND");
  await expect(page.locator("#deferred-function-field")).toHaveValue("SECOND");
  expect(
    await deferred.evaluate(
      (element) => element === document.querySelector("#deferred-function-field"),
    ),
  ).toBe(true);
  expect(
    await input.evaluate((element) => element === document.querySelector("#function-field")),
  ).toBe(true);
  expect(await leaf.evaluate((element) => element === document.querySelector("#tree-leaf"))).toBe(
    true,
  );
  expect(
    await page.evaluate(() => {
      const fixture = (
        globalThis as unknown as {
          functionsFixture: { bodyExecutions(): string[]; directCallFault: unknown };
        }
      ).functionsFixture;
      return { bodies: fixture.bodyExecutions(), fault: fixture.directCallFault };
    }),
  ).toStrictEqual({
    bodies: ["field", "tree", "tree", "tree", "deferred"],
    fault: "component-direct-call",
  });
  expect(errors).toStrictEqual([]);
  expect(await page.locator("html").getAttribute("data-fault")).toBeNull();
});
