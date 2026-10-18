import { expect, test, type ElementHandle } from "@playwright/test";

async function isCurrentNativeNode(
  original: ElementHandle<Element>,
  selector: string,
): Promise<boolean> {
  return original.evaluate((node, query) => node === document.querySelector(query), selector);
}

test("reactive text updates keep the native button and uncontrolled input", async ({ page }) => {
  const errors: string[] = [];

  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/identity");

  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");

  const counter = page.locator("#counter");
  const note = page.locator("#draft-note");
  const originalCounter = await counter.elementHandle();
  const originalNote = await note.elementHandle();

  expect(originalCounter).not.toBeNull();

  expect(originalNote).not.toBeNull();

  await note.fill("unsaved browser value");

  await counter.click();

  await counter.click();

  await expect(counter).toHaveText("Count: 2");

  await expect(note).toHaveValue("unsaved browser value");

  expect(await isCurrentNativeNode(originalCounter!, "#counter")).toBe(true);

  expect(await isCurrentNativeNode(originalNote!, "#draft-note")).toBe(true);

  expect(errors).toStrictEqual([]);
});

test("the native identity witness rejects a deliberately replaced node", async ({ page }) => {
  await page.goto("/identity");

  const original = await page.locator("#counter").elementHandle();

  expect(original).not.toBeNull();

  await page.evaluate(() => {
    const node = document.querySelector("#counter");

    if (!node) throw new Error("The counter is missing");

    node.replaceWith(node.cloneNode(true));
  });

  expect(await isCurrentNativeNode(original!, "#counter")).toBe(false);
});
