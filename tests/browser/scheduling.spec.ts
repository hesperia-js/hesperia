import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

async function openScheduling(page: Page): Promise<void> {
  await page.clock.install({ time: new Date("2026-10-21T12:00:00Z") });

  await page.goto("/scheduling");

  await expect(page.locator("html")).toHaveAttribute("data-fixture", "scheduling");

  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");

  await expect(page.locator("html[data-fault]")).toHaveCount(0);

  await page.clock.pauseAt(new Date("2026-10-21T12:01:00Z"));
}

const aborted = {
  status: "rejected",
  name: "AbortError",
  code: "ABORT_ERR",
  cause: "first queued callback aborted",
};

for (const portableFollower of [true, false]) {
  test(`browser throttle stops later queued callbacks after abort (${portableFollower ? "native follower" : "older-host listener"})`, async ({
    page,
  }) => {
    const errors: string[] = [];

    page.on("pageerror", (error) => errors.push(error.message));

    if (!portableFollower) {
      await page.addInitScript(() => {
        Object.defineProperty(AbortSignal, "any", { configurable: true, value: undefined });
      });
    }

    await openScheduling(page);

    await page.locator("#queue-throttle").click();

    expect(JSON.parse((await page.locator("#throttle-state").textContent()) ?? "")).toStrictEqual({
      anySupported: portableFollower,
      activeCount: 2,
      pendingCount: 3,
    });

    await page.clock.runFor(1_000);

    await expect(page.locator("#throttle-outcomes")).not.toHaveText("");

    if (portableFollower) {
      await expect(page.locator("#abort-observation")).toHaveText("0");
    }

    expect(JSON.parse((await page.locator("#callback-events").textContent()) ?? "")).toStrictEqual([
      "throttle-start:0",
      "throttle-start:1",
      "throttle-start:2",
      "original-signal-aborted",
    ]);

    expect(
      JSON.parse((await page.locator("#throttle-outcomes").textContent()) ?? ""),
    ).toStrictEqual({
      calls: [
        { status: "fulfilled", value: 0 },
        { status: "fulfilled", value: 2 },
        { status: "fulfilled", value: 4 },
        aborted,
        aborted,
      ],
      future: [aborted],
      activeCount: 0,
      pendingCount: 0,
    });

    expect(errors).toStrictEqual([]);

    await expect(page.locator("html[data-fault]")).toHaveCount(0);
  });
}

test("compiled cleanup cancels explicit utility lifetime while unbound and active callbacks retain theirs", async ({
  page,
}) => {
  const errors: string[] = [];

  page.on("pageerror", (error) => errors.push(error.message));

  await openScheduling(page);

  await page.locator("#queue-lifetimes").click();

  expect(JSON.parse((await page.locator("#lifetime-controls").textContent()) ?? "")).toStrictEqual({
    sameWrapper: true,
    samePending: true,
    pendingCount: 1,
  });

  await page.locator("#remove-scheduling").click();

  await expect(page.locator("html")).toHaveAttribute("data-disposed", "true");

  await expect(page.locator("#queue-lifetimes")).toHaveCount(0);

  await page.clock.runFor(1_000);

  await page.locator("#release-active").click();

  await expect(page.locator("#lifetime-results")).toContainText("active-result");

  expect(JSON.parse((await page.locator("#lifetime-results").textContent()) ?? "")).toStrictEqual({
    owned: {
      status: "rejected",
      name: "AbortError",
      code: "ABORT_ERR",
      cause: "component removed",
    },
    unbound: { status: "fulfilled", value: "unbound-result" },
    active: { status: "fulfilled", value: "active-result" },
  });

  expect(JSON.parse((await page.locator("#callback-events").textContent()) ?? "")).toStrictEqual([
    "active-start",
    "component-cleanup",
    "unbound-start",
  ]);

  expect(errors).toStrictEqual([]);

  await expect(page.locator("html[data-fault]")).toHaveCount(0);
});
