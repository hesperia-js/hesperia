import { expect, test } from "@playwright/test";

interface EmbedProbeMessage {
  readonly name: string;
  readonly childOrigin: string;
  readonly parentAccess: string;
  readonly eventOrigin: string;
}

interface EmbedBrowserProbe {
  readonly messages: readonly EmbedProbeMessage[];
  readonly loads: { readonly dynamic: number; readonly strict: number };
  readonly errors: readonly unknown[];

  setSandbox(tokens: string): Promise<void>;

  remember(): void;

  identity(): {
    readonly bindingStable: boolean;
    readonly wrapperNodeStable: boolean;
    readonly frameReplaced: boolean;
  };

  dispose(): void;
}

declare global {
  interface Window {
    embedProbe: EmbedBrowserProbe;
  }
}

test("Embed applies native sandboxing and preserves its sized bound wrapper across permission replacement", async ({
  page,
}) => {
  const pageErrors: string[] = [];

  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/embed-browser");

  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");

  await page.waitForFunction(
    () => window.embedProbe.loads.dynamic >= 1 && window.embedProbe.loads.strict >= 1,
  );

  const strictFrame = page.frame({ name: "strict" });
  const dynamicFrame = page.frame({ name: "dynamic" });

  if (!strictFrame || !dynamicFrame) throw new Error("Expected both Embed browsing contexts");

  expect(await page.locator('iframe[name="strict"]').getAttribute("sandbox")).toBe("");

  expect(await strictFrame.evaluate(() => document.documentElement.dataset.embedScriptRan)).toBe(
    undefined,
  );

  expect(await dynamicFrame.evaluate(() => document.documentElement.dataset.embedScriptRan)).toBe(
    "yes",
  );

  expect(await dynamicFrame.evaluate(() => location.origin)).toBe("null");

  expect(await page.evaluate(() => window.embedProbe.messages)).toContainEqual({
    type: "hesperia-embed-proof",
    name: "dynamic",
    childOrigin: "null",
    parentAccess: "denied",
    eventOrigin: "null",
  });

  expect(
    await page.evaluate(() =>
      window.embedProbe.messages.some((message) => message.name === "strict"),
    ),
  ).toBe(false);

  await page.evaluate(() => window.embedProbe.remember());

  const beforeSize = await page.locator('iframe[name="dynamic"]').evaluate((frame) => {
    const wrapper = frame.parentElement!;
    const rect = wrapper.getBoundingClientRect();
    return {
      width: wrapper.style.width,
      height: wrapper.style.height,
      frameWidth: (frame as HTMLIFrameElement).style.width,
      rectWidth: rect.width,
      rectHeight: rect.height,
    };
  });

  expect(beforeSize).toStrictEqual({
    width: "320px",
    height: "180px",
    frameWidth: "100%",
    rectWidth: 320,
    rectHeight: 180,
  });

  await page.evaluate(() => window.embedProbe.setSandbox("allow-scripts allow-same-origin"));

  await page.waitForFunction(
    () =>
      window.embedProbe.loads.dynamic >= 2 &&
      window.embedProbe.messages.filter((message) => message.name === "dynamic").length >= 2 &&
      document.documentElement.dataset.embedUnsafeAccess === "dynamic",
  );

  const replacedFrame = page.frame({ name: "dynamic" });

  if (!replacedFrame) throw new Error("The replacement Embed frame was not found");

  const permissionOrigin = await page.evaluate(() => location.origin);

  expect(await replacedFrame.evaluate(() => document.documentElement.dataset.embedScriptRan)).toBe(
    "yes",
  );

  expect(await page.evaluate(() => window.embedProbe.messages)).toContainEqual({
    type: "hesperia-embed-proof",
    name: "dynamic",
    childOrigin: "null",
    parentAccess: "allowed",
    eventOrigin: permissionOrigin,
  });

  expect(await page.locator('iframe[name="dynamic"]').getAttribute("sandbox")).toBe(
    "allow-scripts allow-same-origin",
  );

  expect(await page.evaluate(() => window.embedProbe.identity())).toStrictEqual({
    bindingStable: true,
    wrapperNodeStable: true,
    frameReplaced: true,
  });

  const afterSize = await page.locator('iframe[name="dynamic"]').evaluate((frame) => {
    const wrapper = frame.parentElement!;
    const rect = wrapper.getBoundingClientRect();
    return {
      width: wrapper.style.width,
      height: wrapper.style.height,
      rectWidth: rect.width,
      rectHeight: rect.height,
    };
  });

  expect(afterSize).toStrictEqual({
    width: "320px",
    height: "180px",
    rectWidth: 320,
    rectHeight: 180,
  });

  expect(await page.evaluate(() => window.embedProbe.errors)).toStrictEqual([]);

  expect(pageErrors).toStrictEqual([]);

  await page.evaluate(() => window.embedProbe.dispose());
});
