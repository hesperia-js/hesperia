import { expect, test } from "@playwright/test";

interface NativeEventsHarness {
  readonly deliveries: Array<{
    readonly id: string;
    readonly thisId: string;
    readonly thisIsCurrentTarget: boolean;
    readonly targetId: string | null;
    readonly currentTargetId: string | null;
    readonly eventIsExpected: boolean;
  }>;
  readonly captureOrder: string[];

  plainClick(): boolean;

  dispatchCancellation(id: "passive-probe" | "active-probe"): {
    readonly dispatchResult: boolean;
    readonly defaultPrevented: boolean;
  };

  recreate(): Promise<void>;

  dispose(): void;
}

declare global {
  interface Window {
    hesperiaNativeEvents: NativeEventsHarness;
  }
}

test("plain native handlers receive the dispatched Event and element as this", async ({ page }) => {
  const errors: string[] = [];

  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/native-events");

  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");

  expect(await page.evaluate(() => window.hesperiaNativeEvents.plainClick())).toBe(true);

  expect(await page.evaluate(() => window.hesperiaNativeEvents.deliveries)).toStrictEqual([
    {
      id: "plain-handler",
      thisId: "plain-handler",
      thisIsCurrentTarget: true,
      targetId: "plain-handler",
      currentTargetId: "plain-handler",
      eventIsExpected: true,
    },
  ]);

  expect(errors).toStrictEqual([]);
});

test("helper imports and literal pairs keep shared once behavior native and per element", async ({
  page,
}) => {
  await page.goto("/native-events");

  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");

  await expect(page.locator("main")).toHaveAttribute("data-events-helpers-match", "true");

  await page.locator("#shared-once-a").click();

  await page.locator("#shared-once-a").click();

  await page.locator("#shared-once-b").click();

  await page.locator("#shared-once-b").click();

  await page.locator("#client-once").click();

  await page.locator("#client-once").click();

  await page.locator("#literal-once").click();

  await page.locator("#literal-once").click();

  expect(await page.evaluate(() => window.hesperiaNativeEvents.deliveries)).toStrictEqual([
    {
      id: "shared-once-a",
      thisId: "shared-once-a",
      thisIsCurrentTarget: true,
      targetId: "shared-once-a",
      currentTargetId: "shared-once-a",
      eventIsExpected: false,
    },
    {
      id: "shared-once-b",
      thisId: "shared-once-b",
      thisIsCurrentTarget: true,
      targetId: "shared-once-b",
      currentTargetId: "shared-once-b",
      eventIsExpected: false,
    },
    {
      id: "client-once",
      thisId: "client-once",
      thisIsCurrentTarget: true,
      targetId: "client-once",
      currentTargetId: "client-once",
      eventIsExpected: false,
    },
    {
      id: "literal-once",
      thisId: "literal-once",
      thisIsCurrentTarget: true,
      targetId: "literal-once",
      currentTargetId: "literal-once",
      eventIsExpected: false,
    },
  ]);
});

test("capture helpers preserve native capture and bubbling order", async ({ page }) => {
  await page.goto("/native-events");

  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");

  await page.locator("#capture-target").click();

  expect(await page.evaluate(() => window.hesperiaNativeEvents.captureOrder)).toStrictEqual([
    "outer-capture",
    "inner-capture",
    "target-bubble",
    "ancestor-bubble",
  ]);
});

test("passive preventDefault is ignored while the default listener cancels", async ({ page }) => {
  await page.goto("/native-events");

  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");

  expect(
    await page.evaluate(() => window.hesperiaNativeEvents.dispatchCancellation("passive-probe")),
  ).toStrictEqual({ dispatchResult: true, defaultPrevented: false });

  expect(
    await page.evaluate(() => window.hesperiaNativeEvents.dispatchCancellation("active-probe")),
  ).toStrictEqual({ dispatchResult: false, defaultPrevented: true });
});

test("disposing releases old listeners and a recreated component gets fresh once state", async ({
  page,
}) => {
  const errors: string[] = [];

  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/native-events");

  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");

  const oldPlainButton = await page.locator("#plain-handler").elementHandle();

  expect(oldPlainButton).not.toBeNull();

  const oldOnceButton = await page.locator("#shared-once-a").elementHandle();

  expect(oldOnceButton).not.toBeNull();

  await page.evaluate(() => window.hesperiaNativeEvents.plainClick());

  await oldOnceButton!.click();

  await oldOnceButton!.click();

  await page.evaluate(() => window.hesperiaNativeEvents.recreate());

  await expect(page.locator("#shared-once-a")).toHaveCount(1);

  const oldState = await oldPlainButton!.evaluate((node) => {
    const before = window.hesperiaNativeEvents.deliveries.length;
    return {
      connected: node.isConnected,
      dispatchResult: node.dispatchEvent(new MouseEvent("click", { bubbles: true })),
      newDeliveries: window.hesperiaNativeEvents.deliveries.length - before,
    };
  });

  expect(oldState).toStrictEqual({ connected: false, dispatchResult: true, newDeliveries: 0 });

  await page.evaluate(() => window.hesperiaNativeEvents.plainClick());

  await page.locator("#shared-once-a").click();

  await page.locator("#shared-once-a").click();

  expect(
    await page.evaluate(() => window.hesperiaNativeEvents.deliveries.map(({ id }) => id)),
  ).toStrictEqual(["plain-handler", "shared-once-a", "plain-handler", "shared-once-a"]);

  expect(errors).toStrictEqual([]);
});

test("a callback-level shared once guard incorrectly suppresses the second element", async ({
  page,
}) => {
  await page.goto("/native-events");

  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");

  const delivered = await page.evaluate(() => {
    const first = document.createElement("button");
    first.id = "broken-shared-once-a";
    const second = document.createElement("button");
    second.id = "broken-shared-once-b";
    const calls: string[] = [];
    let alreadyCalled = false;

    const callback = (event: Event) => {
      if (alreadyCalled) return;

      alreadyCalled = true;

      calls.push((event.currentTarget as HTMLElement).id);
    };

    first.addEventListener("click", callback);

    second.addEventListener("click", callback);

    document.body.append(first, second);

    first.click();

    second.click();

    first.remove();

    second.remove();

    return calls;
  });

  expect(delivered).toStrictEqual(["broken-shared-once-a"]);
});
