import { expect, test } from "@playwright/test";

interface LifecycleHarness {
  lifecycleEvents(): readonly string[];

  bindingState(): { readonly published: boolean; readonly current: boolean };

  streamStats(): { readonly opens: number; readonly aborts: number };

  queryRequestCount(key: string): number;

  queryCleanupCount(key: string): number;

  waitForStreamStats(opens: number, aborts: number): Promise<void>;

  waitForQueryCleanups(key: string, count: number): Promise<void>;

  waitForQueryRequests(key: string, count: number): Promise<void>;

  resolveQuery(key: string, value: string): void;

  rejectQuery(key: string, reason: unknown): void;

  errors(): readonly string[];

  waitForErrors(count: number): Promise<readonly string[]>;

  settled(): Promise<void>;

  dispose(): void;
}

declare global {
  interface Window {
    hesperiaLifecycle: LifecycleHarness;
  }
}

test("compiled mount orders effects, publishes a native binding, and cleans up by owner", async ({
  page,
}) => {
  const pageErrors: string[] = [];

  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/lifecycle?mode=lifecycle");

  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");

  const initial = [
    "run:left.child:first:0",
    "run:left.child:second:0",
    "run:left:first:0",
    "run:left:second:0",
    "run:right.child:first:0",
    "run:right.child:second:0",
    "run:right:first:0",
    "run:right:second:0",
    "run:binding:ready",
    "run:root:first:0",
    "run:root:second:0",
  ];

  expect(await page.evaluate(() => window.hesperiaLifecycle.lifecycleEvents())).toEqual(initial);

  expect(await page.evaluate(() => window.hesperiaLifecycle.bindingState())).toEqual({
    published: true,
    current: true,
  });

  const input = page.locator("#bound-input");
  const originalInput = await input.elementHandle();

  expect(originalInput).not.toBeNull();

  await input.fill("uncontrolled browser value");

  await page.getByRole("button", { name: "Advance revision" }).click();

  await page.evaluate(() => window.hesperiaLifecycle.settled());

  const update = [
    "cleanup:left.child:first:0",
    "run:left.child:first:1",
    "cleanup:left.child:second:0",
    "run:left.child:second:1",
    "cleanup:left:first:0",
    "run:left:first:1",
    "cleanup:left:second:0",
    "run:left:second:1",
    "cleanup:right.child:first:0",
    "run:right.child:first:1",
    "cleanup:right.child:second:0",
    "run:right.child:second:1",
    "cleanup:right:first:0",
    "run:right:first:1",
    "cleanup:right:second:0",
    "run:right:second:1",
    "cleanup:root:first:0",
    "run:root:first:1",
    "cleanup:root:second:0",
    "run:root:second:1",
  ];

  expect(await page.evaluate(() => window.hesperiaLifecycle.lifecycleEvents())).toEqual([
    ...initial,
    ...update,
  ]);

  await expect(input).toHaveValue("uncontrolled browser value");

  expect(
    await originalInput!.evaluate((node) => node === document.querySelector("#bound-input")),
  ).toBe(true);

  expect(await page.evaluate(() => window.hesperiaLifecycle.bindingState())).toEqual({
    published: true,
    current: true,
  });

  await page.evaluate(() => window.hesperiaLifecycle.dispose());

  const finalCleanup = [
    "cleanup:root:second:1",
    "cleanup:root:first:1",
    "cleanup:left:second:1",
    "cleanup:left:first:1",
    "cleanup:left.child:second:1",
    "cleanup:left.child:first:1",
    "cleanup:right:second:1",
    "cleanup:right:first:1",
    "cleanup:right.child:second:1",
    "cleanup:right.child:first:1",
    "cleanup:binding:ready",
  ];

  expect(await page.evaluate(() => window.hesperiaLifecycle.lifecycleEvents())).toEqual([
    ...initial,
    ...update,
    ...finalCleanup,
  ]);

  expect(await page.evaluate(() => window.hesperiaLifecycle.errors())).toEqual([]);

  expect(pageErrors).toEqual([]);
});

test("two mounted owners share one stream until the configured idle expiry", async ({ page }) => {
  const pageErrors: string[] = [];

  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.clock.install({ time: new Date("2026-01-01T08:00:00.000Z") });

  await page.goto("/lifecycle?mode=stream");

  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");

  const first = page.locator('[data-consumer="first"]');
  const second = page.locator('[data-consumer="second"]');

  expect(await page.evaluate(() => window.hesperiaLifecycle.streamStats())).toEqual({
    opens: 1,
    aborts: 0,
  });

  await page.clock.pauseAt(new Date("2026-01-01T10:00:00.000Z"));

  expect(await page.evaluate(() => window.hesperiaLifecycle.streamStats())).toEqual({
    opens: 1,
    aborts: 0,
  });

  await expect(first).toHaveText("opening:empty");

  await expect(second).toHaveText("opening:empty");

  const originalSecond = await second.elementHandle();

  expect(originalSecond).not.toBeNull();

  await page.getByRole("button", { name: "Emit one" }).click();

  await expect(first).toHaveText("live:1");

  await expect(second).toHaveText("live:1");

  expect(await page.evaluate(() => window.hesperiaLifecycle.streamStats())).toEqual({
    opens: 1,
    aborts: 0,
  });

  await page.getByRole("button", { name: "Remove first consumer" }).click();

  await expect(first).toHaveCount(0);

  await page.clock.runFor(60);

  expect(await page.evaluate(() => window.hesperiaLifecycle.streamStats())).toEqual({
    opens: 1,
    aborts: 0,
  });

  await page.getByRole("button", { name: "Emit two" }).click();

  await expect(second).toHaveText("live:2");

  expect(
    await originalSecond!.evaluate(
      (node) => node === document.querySelector('[data-consumer="second"]'),
    ),
  ).toBe(true);

  await page.getByRole("button", { name: "Remove second consumer" }).click();

  await expect(second).toHaveCount(0);

  expect(await page.evaluate(() => window.hesperiaLifecycle.streamStats())).toEqual({
    opens: 1,
    aborts: 0,
  });

  await page.clock.runFor(49);

  expect(await page.evaluate(() => window.hesperiaLifecycle.streamStats())).toEqual({
    opens: 1,
    aborts: 0,
  });

  await page.clock.runFor(1);

  await page.evaluate(() => window.hesperiaLifecycle.waitForStreamStats(1, 1));

  expect(await page.evaluate(() => window.hesperiaLifecycle.streamStats())).toEqual({
    opens: 1,
    aborts: 1,
  });

  await page.getByRole("button", { name: "Remount first consumer" }).click();

  await page.evaluate(() => window.hesperiaLifecycle.waitForStreamStats(2, 1));

  await expect(first).toHaveText("opening:empty");

  expect(await page.evaluate(() => window.hesperiaLifecycle.streamStats())).toEqual({
    opens: 2,
    aborts: 1,
  });

  await page.getByRole("button", { name: "Emit three" }).click();

  await expect(first).toHaveText("live:3");

  await page.evaluate(() => window.hesperiaLifecycle.dispose());

  expect(pageErrors).toEqual([]);
});

test("AsyncBoundary keeps its fallback until a pending query succeeds", async ({ page }) => {
  const pageErrors: string[] = [];

  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/lifecycle?mode=query-success");

  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");

  await expect(page.locator("#query-fallback")).toHaveText("Waiting for the query");

  await page.evaluate(() => window.hesperiaLifecycle.waitForQueryRequests("query-success", 1));

  expect(
    await page.evaluate(() => window.hesperiaLifecycle.queryRequestCount("query-success")),
  ).toBe(1);

  await page.evaluate(() =>
    window.hesperiaLifecycle.resolveQuery("query-success", "query result ready"),
  );

  await expect(page.locator("#query-result")).toHaveText("query result ready");

  await page.evaluate(() => window.hesperiaLifecycle.settled());

  expect(await page.evaluate(() => window.hesperiaLifecycle.errors())).toEqual([]);

  expect(pageErrors).toEqual([]);

  await page.evaluate(() => window.hesperiaLifecycle.dispose());

  expect(
    await page.evaluate(() => window.hesperiaLifecycle.queryCleanupCount("query-success")),
  ).toBe(1);
});

test("an initial query failure reaches mount onError and releases the waiting owner", async ({
  page,
}) => {
  const pageErrors: string[] = [];

  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/lifecycle?mode=query-failure");

  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");

  await expect(page.locator("#query-fallback")).toHaveText("Waiting for the query");

  await page.evaluate(() => window.hesperiaLifecycle.waitForQueryRequests("query-failure", 1));

  expect(
    await page.evaluate(() => window.hesperiaLifecycle.queryCleanupCount("query-failure")),
  ).toBe(0);

  const errors = page.evaluate(() => window.hesperiaLifecycle.waitForErrors(1));

  await page.evaluate(() =>
    window.hesperiaLifecycle.rejectQuery("query-failure", new Error("controlled query failure")),
  );

  expect(await errors).toEqual(["controlled query failure"]);

  await page.evaluate(() => window.hesperiaLifecycle.waitForQueryCleanups("query-failure", 1));

  expect(
    await page.evaluate(() => window.hesperiaLifecycle.queryCleanupCount("query-failure")),
  ).toBe(1);

  expect(pageErrors).toEqual([]);

  await page.evaluate(() => window.hesperiaLifecycle.dispose());

  expect(
    await page.evaluate(() => window.hesperiaLifecycle.queryCleanupCount("query-failure")),
  ).toBe(1);
});
