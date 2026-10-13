import { expect, test, type Page, type Route } from "@playwright/test";
import {
  browserCssCoverageOwnerIds,
  browserCssCoverageScenariosByOwnerId,
} from "../../scripts/ci/browser-css-coverage-contract.ts";

type AsyncPageCoverageOwnerId =
  | typeof browserCssCoverageOwnerIds.asyncAwaited
  | typeof browserCssCoverageOwnerIds.asyncRequiredBinding
  | typeof browserCssCoverageOwnerIds.asyncRecovery;

async function captureAsyncPageCoverage(
  page: Page,
  ownerId: AsyncPageCoverageOwnerId,
): Promise<void> {
  const runId = process.env.HESPERIA_BROWSER_COVERAGE_RUN_ID;

  if (!runId) return;

  const populationFingerprint = process.env.HESPERIA_BROWSER_COVERAGE_POPULATION;

  if (!populationFingerprint) {
    throw new Error("Browser async page coverage is missing its source population identity");
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

interface AsyncFixture {
  readonly errors: readonly string[];
  readonly independentErrors: readonly string[];
  readonly events: readonly string[];
  readonly awaitedChildBodies: number;
  readonly refusedChildBodies: number;
  readonly recovery: RecoverySnapshot;

  dispose(): void;
}

interface RecoverySnapshot {
  readonly parentBodies: number;
  readonly childBodies: number;
  readonly outsideBodies: number;
  readonly probeReady: boolean;
  readonly errors: readonly string[];
  readonly lifecycle: {
    readonly parentEffects: number;
    readonly childEffects: number;
    readonly parentDisposals: number;
    readonly childDisposals: number;
    readonly outsideEffects: number;
    readonly probeHandlerCalls: number;
    readonly probeHandlerFaults: number;
    readonly probeHandlerFaultKind: string;
    readonly probeTaskRuns: number;
    readonly probeTaskFaults: number;
    readonly probeTaskFaultKind: string;
  };
}

interface AsyncRecoveryControl {
  beginReset(kind: "bridge" | "graph"): number;

  resetState(id: number): {
    readonly status: string;
    readonly error?: { readonly name: string; readonly message: string };
  };

  resetIdentity(name: string): {
    readonly graphApi: boolean;
    readonly key: boolean;
    readonly graph: boolean;
    readonly value: boolean;
    readonly currentValue: string | undefined;
    readonly resetVersion: number;
  };

  savedQueryValue(name: string): string | undefined;

  savedSourceState(name: string): {
    readonly status: string | undefined;
    readonly pending: boolean | undefined;
    readonly value?: string;
    readonly valueIsUndefined: boolean;
  };

  probeDisposedViewSource(name: string): { readonly threw: boolean; readonly kind?: string };

  probeStaleAccessor(name: string): { readonly threw: boolean; readonly kind?: string };
}

interface AsyncCacheControl {
  navigateAway(): Promise<string>;
}

interface HeldRequest {
  readonly route: Route;
  readonly release: () => void;
}

test("awaited child composition commits descendant effects before the parent", async ({ page }) => {
  await page.goto("/async");

  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");

  await expect(page.locator("#awaiting-parent")).toContainText("awaited child");

  await expect(page.locator("#awaited-input")).toBeFocused();

  const fixture = await page.evaluate(
    () => (globalThis as unknown as { asyncFixture: AsyncFixture }).asyncFixture,
  );

  expect(fixture.events).toEqual(["child-effect", "parent-effect"]);

  expect(fixture.awaitedChildBodies).toBe(1);

  expect(fixture.errors).toEqual([]);

  await page.evaluate(() =>
    (globalThis as unknown as { asyncFixture: AsyncFixture }).asyncFixture.dispose(),
  );

  await expect(page.locator("#awaiting-parent")).toHaveCount(0);

  await expect(page.locator("#awaited-input")).toHaveCount(0);

  await captureAsyncPageCoverage(page, browserCssCoverageOwnerIds.asyncAwaited);
});

test("an independently composed async child rejects a required binding before its body", async ({
  page,
}) => {
  await page.goto("/async");

  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");

  const fixture = await page.evaluate(
    () => (globalThis as unknown as { asyncFixture: AsyncFixture }).asyncFixture,
  );

  expect(fixture.refusedChildBodies).toBe(0);

  expect(fixture.independentErrors).toEqual([
    "An async component requires an enclosing async boundary",
  ]);

  await expect(page.locator("#refused-child")).toHaveCount(0);

  await expect(page.locator("#awaiting-parent")).toContainText("awaited child");

  await page.evaluate(() =>
    (globalThis as unknown as { asyncFixture: AsyncFixture }).asyncFixture.dispose(),
  );

  await captureAsyncPageCoverage(page, browserCssCoverageOwnerIds.asyncRequiredBinding);
});

test("reset recovers consumed async sources and leaves unrelated rendered owners live", async ({
  page,
}) => {
  const attempts = new Map<string, number>();
  const pendingRequests = new Map<string, HeldRequest>();
  const requestWaiters = new Map<string, ((request: HeldRequest) => void)[]>();

  const waitForRequest = (key: string): Promise<HeldRequest> => {
    const pending = pendingRequests.get(key);

    if (pending) {
      pendingRequests.delete(key);

      return Promise.resolve(pending);
    }

    return new Promise((resolve) => {
      const waiters = requestWaiters.get(key) ?? [];

      waiters.push(resolve);

      requestWaiters.set(key, waiters);
    });
  };

  const fulfillHeld = async (held: HeldRequest, value: string | null): Promise<void> => {
    try {
      await held.route.fulfill({ json: { value } });
    } finally {
      held.release();
    }
  };

  const abortHeld = async (held: HeldRequest): Promise<void> => {
    try {
      await held.route.abort("failed").catch(() => undefined);
    } finally {
      held.release();
    }
  };

  const failHeld = async (held: HeldRequest, status: number, body: string): Promise<void> => {
    try {
      await held.route.fulfill({ status, body, contentType: "text/plain" });
    } finally {
      held.release();
    }
  };

  await page.route("**/api/async-recovery/**", async (route) => {
    const name = new URL(route.request().url()).pathname.split("/").pop()!;
    const attempt = (attempts.get(name) ?? 0) + 1;

    attempts.set(name, attempt);

    const key = `${name}:${attempt}`;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const request = { route, release };
    const waiters = requestWaiters.get(key) ?? [];
    const waiter = waiters.shift();

    if (waiter) waiter(request);
    else pendingRequests.set(key, request);

    await held;
  });

  const initialParent = waitForRequest("parent:1");
  const initialProbe = waitForRequest("probe:1");
  const navigation = page.goto("/async?reset=1");
  const [parentA, probeA] = await Promise.all([initialParent, initialProbe]);

  await Promise.all([fulfillHeld(parentA, "A-parent"), fulfillHeld(probeA, "A-probe")]);

  const childA = await waitForRequest("child:1");

  await fulfillHeld(childA, null);

  await navigation;

  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");

  await expect(page.locator("#recovery-parent-value")).toHaveText("A-parent");

  await expect(page.locator("#recovery-child-value")).toHaveText("undefined");

  await expect(page.locator("#recovery-probe-handler-result")).toHaveText("idle");

  const outside = await page.locator("#recovery-outside").elementHandle();

  if (!outside) throw new Error("The unrelated recovery sibling is missing");

  await page.locator("#recovery-parent-local").click();

  await page.locator("#recovery-child-local").click();

  await page.locator("#recovery-outside button").first().click();

  await expect(page.locator("#recovery-parent-local")).toHaveText("parent:1");

  await expect(page.locator("#recovery-child-local")).toHaveText("child:1");

  await expect(page.locator("#recovery-outside button").first()).toHaveText("outside:1");

  const initial = await page.evaluate(
    () => (globalThis as unknown as { asyncFixture: AsyncFixture }).asyncFixture.recovery,
  );

  expect(initial).toMatchObject({
    parentBodies: 1,
    childBodies: 1,
    outsideBodies: 1,
    probeReady: true,
    errors: [],
    lifecycle: {
      parentEffects: 1,
      childEffects: 1,
      outsideEffects: 1,
      parentDisposals: 0,
      childDisposals: 0,
      probeHandlerCalls: 0,
      probeTaskRuns: 0,
    },
  });

  const parentB = waitForRequest("parent:2");
  const childB = waitForRequest("child:2");
  const resetB = await page.evaluate(() =>
    (
      globalThis as unknown as { asyncRecoveryControl: AsyncRecoveryControl }
    ).asyncRecoveryControl.beginReset("bridge"),
  );
  const [heldParentB, heldChildB] = await Promise.all([parentB, childB]);

  await expect(page.locator("#recovery-parent-loading")).toBeVisible();

  await expect(page.locator("#recovery-parent-value")).toHaveCount(0);

  await fulfillHeld(heldParentB, "B-parent");

  await expect
    .poll(async () => {
      const state = await page.evaluate(() =>
        (
          globalThis as unknown as { asyncRecoveryControl: AsyncRecoveryControl }
        ).asyncRecoveryControl.savedSourceState("parent"),
      );
      return state;
    })
    .toMatchObject({ status: "ready", pending: false, value: "B-parent" });

  await expect
    .poll(async () => {
      const state = await page.evaluate(
        (id) =>
          (
            globalThis as unknown as { asyncRecoveryControl: AsyncRecoveryControl }
          ).asyncRecoveryControl.resetState(id),
        resetB,
      );
      return state.status;
    })
    .toBe("pending");

  const parentC = waitForRequest("parent:3");
  const childC = waitForRequest("child:3");
  const resetC = await page.evaluate(() =>
    (
      globalThis as unknown as { asyncRecoveryControl: AsyncRecoveryControl }
    ).asyncRecoveryControl.beginReset("graph"),
  );
  const [heldParentC, heldChildC] = await Promise.all([parentC, childC]);

  expect(
    await page.evaluate(
      (id) =>
        (
          globalThis as unknown as { asyncRecoveryControl: AsyncRecoveryControl }
        ).asyncRecoveryControl.resetState(id),
      resetB,
    ),
  ).toMatchObject({ status: "rejected", error: { name: "AbortError" } });

  expect(heldParentB.route.request().url()).toContain("parent");

  expect(heldChildB.route.request().url()).toContain("child");

  const retainedIdentity = await page.evaluate(() => {
    const control = (globalThis as unknown as { asyncRecoveryControl: AsyncRecoveryControl })
      .asyncRecoveryControl;
    return {
      parent: control.resetIdentity("parent"),
      child: control.resetIdentity("child"),
    };
  });

  expect(retainedIdentity.parent).toMatchObject({
    graphApi: true,
    key: true,
    graph: true,
    value: true,
  });

  expect(retainedIdentity.child).toMatchObject({
    graphApi: true,
    key: true,
    graph: true,
    value: true,
  });

  const oldParentAccessor = await page.evaluate(() =>
    (
      globalThis as unknown as { asyncRecoveryControl: AsyncRecoveryControl }
    ).asyncRecoveryControl.probeStaleAccessor("parent"),
  );
  const oldParentSourceGetter = await page.evaluate(() =>
    (
      globalThis as unknown as { asyncRecoveryControl: AsyncRecoveryControl }
    ).asyncRecoveryControl.probeDisposedViewSource("parent"),
  );

  expect(oldParentAccessor.threw).toBe(true);

  expect(oldParentSourceGetter.threw).toBe(true);

  const unavailableProbe = await page.evaluate(() =>
    (
      globalThis as unknown as { asyncRecoveryControl: AsyncRecoveryControl }
    ).asyncRecoveryControl.probeStaleAccessor("probe"),
  );

  expect(unavailableProbe).toMatchObject({ threw: true, kind: "query-reset-unavailable" });

  await page.locator("#recovery-probe-handler").click();

  await page.locator("#recovery-probe-task").click();

  await expect(page.locator("#recovery-probe-handler-result")).toHaveText("fault");

  await expect(page.locator("#recovery-probe-task-result")).toHaveText("fault");

  const pendingRecovery = await page.evaluate(
    () => (globalThis as unknown as { asyncFixture: AsyncFixture }).asyncFixture.recovery,
  );

  expect(pendingRecovery).toMatchObject({
    parentBodies: 1,
    childBodies: 1,
    outsideBodies: 1,
    lifecycle: {
      parentEffects: 1,
      childEffects: 1,
      outsideEffects: 1,
      parentDisposals: 1,
      childDisposals: 1,
      probeHandlerCalls: 1,
      probeHandlerFaults: 1,
      probeHandlerFaultKind: "query-reset-unavailable",
      probeTaskRuns: 1,
      probeTaskFaults: 1,
      probeTaskFaultKind: "query-reset-unavailable",
    },
  });

  expect(
    await page.evaluate((node) => node === document.querySelector("#recovery-outside"), outside),
  ).toBe(true);

  expect(attempts.get("probe")).toBe(1);

  await fulfillHeld(heldChildC, null);

  await expect
    .poll(async () => {
      const state = await page.evaluate(() =>
        (
          globalThis as unknown as { asyncRecoveryControl: AsyncRecoveryControl }
        ).asyncRecoveryControl.savedSourceState("child"),
      );
      return state;
    })
    .toMatchObject({ status: "ready", pending: false, valueIsUndefined: true });

  await expect
    .poll(async () => {
      const state = await page.evaluate(
        (id) =>
          (
            globalThis as unknown as { asyncRecoveryControl: AsyncRecoveryControl }
          ).asyncRecoveryControl.resetState(id),
        resetC,
      );
      return state.status;
    })
    .toBe("pending");

  await expect(page.locator("#recovery-parent-loading")).toBeVisible();

  await fulfillHeld(heldParentC, "C-parent");

  await expect
    .poll(async () => {
      const state = await page.evaluate(
        (id) =>
          (
            globalThis as unknown as { asyncRecoveryControl: AsyncRecoveryControl }
          ).asyncRecoveryControl.resetState(id),
        resetC,
      );
      return state.status;
    })
    .toBe("fulfilled");

  await expect(page.locator("#recovery-parent-value")).toHaveText("C-parent");

  await expect(page.locator("#recovery-child-value")).toHaveText("undefined");

  await expect(page.locator("#recovery-parent-local")).toHaveText("parent:0");

  await expect(page.locator("#recovery-child-local")).toHaveText("child:0");

  const recovered = await page.evaluate(
    () => (globalThis as unknown as { asyncFixture: AsyncFixture }).asyncFixture.recovery,
  );

  expect(recovered).toMatchObject({
    parentBodies: 2,
    childBodies: 2,
    outsideBodies: 1,
    probeReady: true,
    errors: [],
    lifecycle: {
      parentEffects: 2,
      childEffects: 2,
      outsideEffects: 1,
      parentDisposals: 1,
      childDisposals: 1,
      probeHandlerCalls: 1,
      probeHandlerFaults: 1,
      probeHandlerFaultKind: "query-reset-unavailable",
      probeTaskRuns: 1,
      probeTaskFaults: 1,
      probeTaskFaultKind: "query-reset-unavailable",
    },
  });

  expect(attempts.get("child")).toBe(3);

  expect(attempts.get("probe")).toBe(1);

  const savedValues = await page.evaluate(() => {
    const control = (globalThis as unknown as { asyncRecoveryControl: AsyncRecoveryControl })
      .asyncRecoveryControl;
    return {
      parent: control.savedQueryValue("parent"),
      child: control.savedQueryValue("child"),
      probe: control.savedQueryValue("probe"),
    };
  });

  expect(savedValues).toEqual({ parent: "C-parent", child: undefined, probe: undefined });

  expect(
    await page.evaluate((node) => node === document.querySelector("#recovery-outside"), outside),
  ).toBe(true);

  await page.locator("#recovery-parent-local").click();

  await expect(page.locator("#recovery-parent-local")).toHaveText("parent:1");

  expect(
    (
      await page.evaluate(
        () => (globalThis as unknown as { asyncFixture: AsyncFixture }).asyncFixture.recovery,
      )
    ).parentBodies,
  ).toBe(2);

  expect(
    await page.evaluate(async () =>
      (
        globalThis as unknown as { asyncCacheControl: AsyncCacheControl }
      ).asyncCacheControl.navigateAway(),
    ),
  ).toBe("committed");

  await expect(page.locator("#async-cache-away")).toBeVisible();

  expect(attempts.get("parent")).toBe(3);

  expect(attempts.get("child")).toBe(3);

  expect(
    await page.evaluate(
      () => (globalThis as unknown as { asyncFixture: AsyncFixture }).asyncFixture.recovery,
    ),
  ).toMatchObject({ parentBodies: 2, childBodies: 2 });

  const parkedReset = await page.evaluate(() =>
    (
      globalThis as unknown as { asyncRecoveryControl: AsyncRecoveryControl }
    ).asyncRecoveryControl.beginReset("graph"),
  );

  await expect
    .poll(async () =>
      page.evaluate(
        (id) =>
          (
            globalThis as unknown as { asyncRecoveryControl: AsyncRecoveryControl }
          ).asyncRecoveryControl.resetState(id).status,
        parkedReset,
      ),
    )
    .toBe("fulfilled");

  expect(attempts.get("parent")).toBe(3);

  expect(attempts.get("child")).toBe(3);

  const restoredParent = waitForRequest("parent:4");
  const restoredChild = waitForRequest("child:4");

  await page.evaluate(() => window.history.back());

  const [heldParentD, heldChildD] = await Promise.all([restoredParent, restoredChild]);

  await expect(page.locator("#recovery-parent-loading")).toBeVisible();

  await expect(page.locator("#recovery-parent-value")).toHaveCount(0);

  await expect(page.locator("#recovery-child-value")).toHaveCount(0);

  await Promise.all([fulfillHeld(heldParentD, "D-parent"), fulfillHeld(heldChildD, "D-child")]);

  await expect(page.locator("#recovery-parent-value")).toHaveText("D-parent");

  await expect(page.locator("#recovery-child-value")).toHaveText("D-child");

  await expect(page.locator("#recovery-parent-local")).toHaveText("parent:0");

  await expect(page.locator("#recovery-child-local")).toHaveText("child:0");

  expect(
    await page.evaluate(
      () => (globalThis as unknown as { asyncFixture: AsyncFixture }).asyncFixture.recovery,
    ),
  ).toMatchObject({
    parentBodies: 3,
    childBodies: 3,
    lifecycle: { parentDisposals: 2, childDisposals: 2 },
  });

  expect(
    await page.evaluate((node) => node === document.querySelector("#recovery-outside"), outside),
  ).toBe(true);

  const failedParent = waitForRequest("parent:5");
  const failedChild = waitForRequest("child:5");
  const failedReset = await page.evaluate(() =>
    (
      globalThis as unknown as { asyncRecoveryControl: AsyncRecoveryControl }
    ).asyncRecoveryControl.beginReset("graph"),
  );
  const [heldParentE, heldChildE] = await Promise.all([failedParent, failedChild]);

  await expect(page.locator("#recovery-parent-loading")).toBeVisible();

  await expect(page.locator("#recovery-parent-value")).toHaveCount(0);

  await expect(page.locator("#recovery-child-value")).toHaveCount(0);

  await fulfillHeld(heldParentE, "E-parent");

  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          globalThis as unknown as { asyncRecoveryControl: AsyncRecoveryControl }
        ).asyncRecoveryControl.savedQueryValue("parent"),
      ),
    )
    .toBe("E-parent");

  await expect(page.locator("#recovery-parent-loading")).toBeVisible();

  await expect(page.locator("#recovery-parent-value")).toHaveCount(0);

  await expect(page.locator("#recovery-child-value")).toHaveCount(0);

  await failHeld(heldChildE, 503, "fresh child refresh failed");

  await expect
    .poll(async () =>
      page.evaluate(
        (id) =>
          (
            globalThis as unknown as { asyncRecoveryControl: AsyncRecoveryControl }
          ).asyncRecoveryControl.resetState(id),
        failedReset,
      ),
    )
    .toMatchObject({
      status: "rejected",
      error: { name: "Error", message: "fresh child refresh failed" },
    });

  await expect(page.locator("#recovery-parent-value")).toHaveCount(0);

  await expect(page.locator("#recovery-child-value")).toHaveCount(0);

  const failedRecovery = await page.evaluate(
    () => (globalThis as unknown as { asyncFixture: AsyncFixture }).asyncFixture.recovery,
  );

  expect(failedRecovery.errors).toContain("fresh child refresh failed");

  expect(
    await page.evaluate(() =>
      (
        globalThis as unknown as { asyncRecoveryControl: AsyncRecoveryControl }
      ).asyncRecoveryControl.savedQueryValue("parent"),
    ),
  ).toBe("E-parent");

  expect(attempts.get("parent")).toBe(5);

  expect(attempts.get("child")).toBe(5);

  await abortHeld(heldChildB);

  await page.evaluate(() =>
    (globalThis as unknown as { asyncFixture: AsyncFixture }).asyncFixture.dispose(),
  );

  await captureAsyncPageCoverage(page, browserCssCoverageOwnerIds.asyncRecovery);
});
