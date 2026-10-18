import { expect, test } from "@playwright/test";
import {
  browserCssCoverageOwnerIds,
  browserCssCoverageScenariosByOwnerId,
  type BrowserCssCoveragePageOwnerId,
} from "../../scripts/ci/browser-css-coverage-contract.ts";

declare global {
  interface Window {
    routeHostFixture: {
      navigate(path: string): Promise<string>;

      damageNestedLayout(): void;

      query(value: string): void;

      beginSlow(): Promise<void>;

      pendingResult(): Promise<string>;

      releaseSlow(): Promise<void>;

      snapshot(): { events: string[]; errors: string[] };
    };
  }
}

async function captureRouteHostCoverage(
  page: import("@playwright/test").Page,
  ownerId: BrowserCssCoveragePageOwnerId,
): Promise<void> {
  const runId = process.env.HESPERIA_BROWSER_COVERAGE_RUN_ID;

  if (!runId) return;

  const populationFingerprint = process.env.HESPERIA_BROWSER_COVERAGE_POPULATION;

  if (!populationFingerprint) {
    throw new Error("Route-host browser coverage is missing its source population identity");
  }

  const response = await page.evaluate(
    async ({ runId, populationFingerprint, ownerId, scenario, pid }) => {
      const result = await fetch("/__coverage/browser-css-page", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runId,
          populationFingerprint,
          ownerId,
          scenario,
          pid,
          coverage: Reflect.get(globalThis, "__hesperiaCoverage__"),
        }),
      });
      return { status: result.status, body: await result.text() };
    },
    {
      runId,
      populationFingerprint,
      ownerId,
      scenario: browserCssCoverageScenariosByOwnerId[ownerId],
      pid: process.pid,
    },
  );

  expect(response).toStrictEqual({ status: 204, body: "" });
}

test("with page caching disabled, compiled layouts retain state while pages and query inputs change", async ({
  page,
}) => {
  const errors: string[] = [];

  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/route-host");

  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");

  const frame = await page.locator("#route-frame").elementHandle();
  const nested = await page.locator("#nested-frame").elementHandle();
  const firstPage = await page.locator("#route-page").elementHandle();

  if (!frame || !nested || !firstPage) throw new Error("Initial route tree is missing");

  await page.locator("#layout-count").click();

  await expect(page.locator("#layout-count")).toHaveText("Layout count: 1");

  expect(await page.evaluate(() => window.routeHostFixture.navigate("/nested/two"))).toBe(
    "committed",
  );

  await expect(page.locator("#route-field")).toHaveValue("/nested/two");

  expect(await frame.evaluate((node) => node === document.querySelector("#route-frame"))).toBe(
    true,
  );

  expect(await nested.evaluate((node) => node === document.querySelector("#nested-frame"))).toBe(
    true,
  );

  expect(await firstPage.evaluate((node) => node.isConnected)).toBe(false);

  await expect(page.locator("#layout-count")).toHaveText("Layout count: 1");

  expect(
    await page.evaluate(() => {
      const node = document.querySelector("#route-page");

      window.routeHostFixture.query("details");

      return {
        retained: node === document.querySelector("#route-page"),
        query: document.querySelector("#route-query")?.textContent,
      };
    }),
  ).toStrictEqual({ retained: true, query: "details" });

  const retained = await page.evaluate(() => window.routeHostFixture.snapshot());

  expect(retained.events.filter((event) => event === "body:frame")).toHaveLength(1);

  expect(retained.events.filter((event) => event === "body:nested")).toHaveLength(1);

  expect(retained.events.filter((event) => event === "children:nested")).toHaveLength(2);

  expect(retained.events).toContain("cleanup:/nested/one:true");

  expect(retained.events).toContain("effect:/nested/two:true");

  expect(await page.evaluate(() => window.routeHostFixture.navigate("/outside"))).toBe("committed");

  expect(await frame.evaluate((node) => node === document.querySelector("#route-frame"))).toBe(
    true,
  );

  expect(await nested.evaluate((node) => node.isConnected)).toBe(false);

  await expect(page.locator("#layout-count")).toHaveText("Layout count: 1");

  const departed = await page.evaluate(() => window.routeHostFixture.snapshot());

  expect(departed.events.filter((event) => event === "cleanup:nested")).toHaveLength(1);

  expect(departed.events).not.toContain("cleanup:frame");

  expect(departed.errors).toStrictEqual([]);

  expect(errors).toStrictEqual([]);

  await captureRouteHostCoverage(page, browserCssCoverageOwnerIds.routeHostRetainedLayouts);
});

test("with page caching disabled, a damaged layout is recreated after cleanup while its intact ancestor survives", async ({
  page,
}) => {
  const errors: string[] = [];

  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/route-host");

  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");

  const frame = await page.locator("#route-frame").elementHandle();
  const nested = await page.locator("#nested-frame").elementHandle();

  if (!frame || !nested) throw new Error("Initial layouts are missing");

  await page.locator("#layout-count").click();

  await page.evaluate(() => window.routeHostFixture.damageNestedLayout());

  expect(await page.evaluate(() => window.routeHostFixture.navigate("/nested/two"))).toBe(
    "committed",
  );

  await expect(page.locator("#route-field")).toHaveValue("/nested/two");

  expect(await frame.evaluate((node) => node === document.querySelector("#route-frame"))).toBe(
    true,
  );

  expect(await nested.evaluate((node) => node.isConnected)).toBe(false);

  await expect(page.locator("#layout-count")).toHaveText("Layout count: 1");

  const result = await page.evaluate(() => window.routeHostFixture.snapshot());

  expect(result.events.filter((event) => event === "body:nested")).toHaveLength(2);

  expect(result.events.filter((event) => event === "body:frame")).toHaveLength(1);

  expect(result.events.indexOf("cleanup:nested")).toBeLessThan(
    result.events.lastIndexOf("body:nested"),
  );

  expect(result.events).toContain("cleanup:/nested/one:true");

  expect(result.events).toContain("effect:/nested/two:true");

  expect(result.events).not.toContain("cleanup:frame");

  expect(result.errors).toStrictEqual([]);

  expect(errors).toStrictEqual([]);

  await captureRouteHostCoverage(page, browserCssCoverageOwnerIds.routeHostRecoveredLayout);
});

test("a query update cancels detached route preparation without running its effects", async ({
  page,
}) => {
  const errors: string[] = [];

  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/route-host");

  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");

  const current = await page.locator("#route-page").elementHandle();

  if (!current) throw new Error("Initial page is missing");

  await page.evaluate(() => window.routeHostFixture.beginSlow());

  await expect(page.locator("#route-field")).toHaveValue("/nested/one");

  const prepared = await page.evaluate(() => window.routeHostFixture.snapshot());

  expect(prepared.events).toContain("body:/nested/slow");

  expect(prepared.events.some((event) => event.startsWith("effect:/nested/slow:"))).toBe(false);

  await page.evaluate(() => window.routeHostFixture.query("latest"));

  expect(await page.evaluate(() => window.routeHostFixture.pendingResult())).toBe("cancelled");

  expect(await current.evaluate((node) => node === document.querySelector("#route-page"))).toBe(
    true,
  );

  await expect(page.locator("#route-query")).toHaveText("latest");

  const cancelled = await page.evaluate(() => window.routeHostFixture.snapshot());

  expect(cancelled.events).toContain("cleanup:/nested/slow:false");

  expect(cancelled.events).not.toContain("cleanup:/nested/one:true");

  await page.evaluate(() => window.routeHostFixture.releaseSlow());

  await expect(page.locator("#route-field")).toHaveValue("/nested/one");

  const released = await page.evaluate(() => window.routeHostFixture.snapshot());

  expect(released.events.some((event) => event.startsWith("effect:/nested/slow:"))).toBe(false);

  expect(released.errors).toStrictEqual([]);

  expect(errors).toStrictEqual([]);

  await captureRouteHostCoverage(page, browserCssCoverageOwnerIds.routeHostCancelledPreparation);
});
