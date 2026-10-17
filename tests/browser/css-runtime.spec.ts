import { expect, test } from "@playwright/test";
import {
  browserCssCoverageOwnerIds,
  browserCssCoverageScenariosByOwnerId,
  type BrowserCssCoveragePageOwnerId,
} from "../../scripts/ci/browser-css-coverage-contract.ts";

type CssRuntimeHarness = {
  mountDirect(target: Element, name: string): void;

  mountBlue(target: Element, name: string): void;

  mountConditional(target: Element, name: string, includeChild: boolean): void;

  mountOrdered(target: Element, name: string, reversed: boolean): Promise<void>;

  mountNested(target: Element, name: string): void;

  exerciseRootReleaseBound(name: string): Promise<{
    readonly initialRegistrations: number;
    readonly afterSwitches: number;
    readonly afterHeadRetirement: number;
    readonly afterReactivation: number;
    readonly redMediaBeforeDispose: string | null;
    readonly redMediaAfterDispose: string | null;
  }>;

  replaceHeadThenDispose(name: string): {
    readonly faultCount: number;
    readonly oldHeadLinkCount: number;
  };

  mountDocument(): void;

  settle(name: string): Promise<"resolved" | "rejected">;

  dispose(name: string): void;

  disposeAll(): void;

  settleFailed(name: string): Promise<{ readonly sameFault: boolean; readonly kind?: string }>;

  suspendNested(): void;

  resumeNested(): void;

  startRevisionSupersession(): Promise<{ readonly status: string; readonly kind?: string }>;

  publishSupersedingRevision(): Promise<void>;

  retainRevisionPreload(): Promise<void>;

  releaseRevisionPreload(): void;

  prepareRevisionWithLateBlue(): Promise<{ readonly status: string; readonly kind?: string }>;

  failRevision(): Promise<{ readonly status: string; readonly kind?: string }>;

  preloadOriginalDocumentHead(): Promise<void>;

  snapshot(): {
    readonly effects: readonly string[];
    readonly faults: readonly { readonly name: string; readonly kind?: string }[];
    readonly unhandled: readonly string[];
    readonly directButtons: readonly HTMLButtonElement[];
    readonly documentSnapshot?: { readonly display: string; readonly color: string };
    readonly oldHeadDetached: boolean;
    readonly oldHeadLeaseCount: number;
    readonly leaseCount: number;
    readonly validLeaseMembership: boolean;
  };
};

declare global {
  interface Window {
    __cssRuntimeHarness: CssRuntimeHarness;
    __cssRuntimeUnhandled: string[];
    __cssRuntimeRevisionNode?: HTMLButtonElement;
    __cssRuntimeRevisionEffects?: number;
  }
}

async function openFixture(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/css-runtime", { waitUntil: "domcontentloaded" });

  await expect.poll(() => page.evaluate(() => Boolean(window.__cssRuntimeHarness))).toBe(true);
}

async function captureBrowserPageCoverage(
  page: import("@playwright/test").Page,
  ownerId: BrowserCssCoveragePageOwnerId,
): Promise<void> {
  const runId = process.env.HESPERIA_BROWSER_COVERAGE_RUN_ID;

  if (!runId) return;

  const populationFingerprint = process.env.HESPERIA_BROWSER_COVERAGE_POPULATION;

  if (!populationFingerprint) {
    throw new Error("Browser CSS page coverage is missing its source population identity");
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

test("unready direct mounts reveal the same text and elements in their final host slots", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  let releaseRed!: () => void;
  const redGate = new Promise<void>((resolve) => (releaseRed = resolve));
  let routedRedRequestCount = 0;

  await page.route("**/css/red.css", async (route) => {
    const requestIndex = routedRedRequestCount++;

    try {
      await redGate;

      await route.fulfill({
        status: 200,
        contentType: "text/css",
        body: ".css-red-node { color: rgb(220, 0, 0); }",
      });
    } catch (error) {
      if (requestIndex !== 0) throw error;
    }
  });

  page.on("pageerror", (error) => pageErrors.push(error.message));

  await openFixture(page);

  let redRequestCount = 0;

  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/css/red.css") redRequestCount++;
  });

  const firstRequest = page.waitForRequest(
    (request) => new URL(request.url()).pathname === "/css/red.css",
  );

  await page.evaluate(() => {
    const harness = window.__cssRuntimeHarness;

    harness.mountDirect(document.querySelector("#first-target")!, "first");

    harness.mountDirect(document.querySelector("#second-target")!, "second");
  });

  await firstRequest;
  const hidden = await page.evaluate(() => {
    const target = document.querySelector("#first-target")!;
    const button = target.querySelector(".css-red-node") as HTMLButtonElement;
    const wrapper = button.parentElement!;
    return {
      existingElement: target.firstChild === document.querySelector("#existing-element"),
      existingText: target.childNodes[1]?.textContent,
      wrapperDisplay: getComputedStyle(wrapper).display,
      buttonVisible: button.getClientRects().length > 0,
      effects: window.__cssRuntimeHarness.snapshot().effects,
      links: [...document.head.querySelectorAll("link[data-hesperia-style-id]")].map((link) => ({
        id: link.getAttribute("data-hesperia-style-id"),
        media: (link as HTMLLinkElement).sheet?.media.mediaText,
      })),
    };
  });

  expect(hidden.existingElement).toBe(true);

  expect(hidden.existingText).toBe("existing text");

  expect(hidden.wrapperDisplay).toBe("none");

  expect(hidden.buttonVisible).toBe(false);

  expect(hidden.effects).toStrictEqual([]);

  expect(hidden.links.filter(({ id }) => id === "css-red")).toHaveLength(1);

  expect(redRequestCount).toBe(1);

  const oldHead = await page.locator("head").elementHandle();

  expect(oldHead).not.toBeNull();

  await page.evaluate(() => {
    const oldHead = document.head;

    oldHead.parentNode!.replaceChild(document.createElement("head"), oldHead);
  });

  const redStylesheetHref = new URL("/css/red.css", page.url()).href;

  await page.waitForFunction((expectedHref) => {
    const links = [...document.head.querySelectorAll<HTMLLinkElement>("link[href]")].filter(
      (link) => link.href === expectedHref,
    );
    return links.length === 1;
  }, redStylesheetHref);

  await page.evaluate(() => {
    const harness = window.__cssRuntimeHarness;

    void harness.settle("first").then((status) => {
      document.documentElement.dataset.firstDirectMountSettlement = status;
    });

    void harness.settle("second").then((status) => {
      document.documentElement.dataset.secondDirectMountSettlement = status;
    });
  });

  expect(await oldHead!.evaluate((head) => head.isConnected)).toBe(false);

  const replacementPending = await page.evaluate((expectedHref) => {
    const first = document.querySelector("#first-target .css-red-node") as HTMLButtonElement;
    const second = document.querySelector("#second-target .css-red-node") as HTMLButtonElement;
    return {
      firstConnected: first.isConnected,
      secondConnected: second.isConnected,
      firstVisible: first.getClientRects().length > 0,
      secondVisible: second.getClientRects().length > 0,
      effects: window.__cssRuntimeHarness.snapshot().effects,
      firstSettlement: document.documentElement.dataset.firstDirectMountSettlement ?? null,
      secondSettlement: document.documentElement.dataset.secondDirectMountSettlement ?? null,
      links: [...document.head.querySelectorAll<HTMLLinkElement>("link[href]")]
        .map((link) => link.href)
        .filter((href) => href === expectedHref),
    };
  }, redStylesheetHref);

  expect(replacementPending.firstConnected).toBe(true);

  expect(replacementPending.secondConnected).toBe(true);

  expect(replacementPending.firstVisible).toBe(false);

  expect(replacementPending.secondVisible).toBe(false);

  expect(replacementPending.effects).toStrictEqual([]);

  expect(replacementPending.firstSettlement).toBeNull();

  expect(replacementPending.secondSettlement).toBeNull();

  expect(replacementPending.links).toStrictEqual([redStylesheetHref]);

  releaseRed();

  await page.evaluate(async () => {
    const harness = window.__cssRuntimeHarness;

    await Promise.all([harness.settle("first"), harness.settle("second")]);
  });

  expect(await page.locator("html").getAttribute("data-first-direct-mount-settlement")).toBe(
    "resolved",
  );

  expect(await page.locator("html").getAttribute("data-second-direct-mount-settlement")).toBe(
    "resolved",
  );

  const revealed = await page.evaluate(() => {
    const harness = window.__cssRuntimeHarness;
    const first = document.querySelector("#first-target")!;
    const firstButton = first.querySelector(".css-red-node") as HTMLButtonElement;
    const secondButton = document.querySelector(
      "#second-target .css-red-node",
    ) as HTMLButtonElement;
    const nodes = [...first.childNodes].map((node) => ({
      type: node.nodeType,
      name: node.nodeName,
      text: node.textContent,
    }));
    const styles = [firstButton, secondButton].map((node) => getComputedStyle(node).color);
    const snapshot = harness.snapshot();
    return {
      nodes,
      styles,
      effects: snapshot.effects,
      sameNativeButton: firstButton === snapshot.directButtons[0],
      sameSecondNativeButton: secondButton === snapshot.directButtons[1],
      wrapperCount: first.querySelectorAll("[data-hesperia-pending]").length,
      firstChildSelector: firstButton.matches(":first-child"),
    };
  });

  expect(revealed.nodes.map(({ name }) => name)).toStrictEqual(["I", "#text", "#text", "BUTTON"]);

  expect(revealed.nodes[1]?.text).toBe("existing text");

  expect(revealed.nodes[2]?.text).toBe("new range first:");

  expect(revealed.styles).toStrictEqual(["rgb(220, 0, 0)", "rgb(220, 0, 0)"]);

  expect(revealed.effects).toStrictEqual(["first:first-target", "second:second-target"]);

  expect(revealed.sameNativeButton).toBe(true);

  expect(revealed.sameSecondNativeButton).toBe(true);

  expect(revealed.wrapperCount).toBe(0);

  expect(revealed.firstChildSelector).toBe(false);

  await page.evaluate(() => window.__cssRuntimeHarness.dispose("first"));

  expect(
    await page
      .locator("#second-target .css-red-node")
      .evaluate((node) => getComputedStyle(node).color),
  ).toBe("rgb(220, 0, 0)");

  await page.evaluate(() => window.__cssRuntimeHarness.dispose("second"));

  expect(await page.locator("head link[data-hesperia-style-id='css-red']").count()).toBe(0);

  expect(pageErrors).toStrictEqual([]);

  await page.evaluate(() => window.__cssRuntimeHarness.disposeAll());

  await captureBrowserPageCoverage(page, browserCssCoverageOwnerIds.page);
});

test("disposing an unready direct mount prevents late CSS from revealing nodes or running effects", async ({
  page,
}) => {
  let releaseCss!: () => void;
  const cssGate = new Promise<void>((resolve) => (releaseCss = resolve));
  let responseFinished!: () => void;
  const responseDone = new Promise<void>((resolve) => (responseFinished = resolve));

  await page.route("**/css/red.css", async (route) => {
    await cssGate;

    try {
      await route.fulfill({
        status: 200,
        contentType: "text/css",
        body: ".css-red-node { color: rgb(220, 0, 0); }",
      });
    } catch {
      // Disposing the final lease may detach the pending link before this response is released.
    } finally {
      responseFinished();
    }
  });

  await openFixture(page);

  const request = page.waitForRequest((item) => new URL(item.url()).pathname === "/css/red.css");

  await page.evaluate(() =>
    window.__cssRuntimeHarness.mountDirect(
      document.querySelector("#first-target")!,
      "disposed-before-css",
    ),
  );

  await request;

  await page.evaluate(() => window.__cssRuntimeHarness.dispose("disposed-before-css"));

  const disposed = await page.evaluate(() => ({
    pendingWrapper: Boolean(document.querySelector("#first-target [data-hesperia-pending]")),
    buttonConnected: Boolean(document.querySelector("#first-target .css-red-node")?.isConnected),
    effects: window.__cssRuntimeHarness.snapshot().effects,
    faults: window.__cssRuntimeHarness.snapshot().faults,
    links: document.head.querySelectorAll("link[data-hesperia-style-id='css-red']").length,
  }));

  expect(disposed).toStrictEqual({
    pendingWrapper: false,
    buttonConnected: false,
    effects: [],
    faults: [],
    links: 0,
  });

  releaseCss();

  await responseDone;

  await expect
    .poll(() => page.evaluate(() => window.__cssRuntimeHarness.snapshot().effects.length))
    .toBe(0);

  expect(await page.locator("#first-target .css-red-node").count()).toBe(0);

  expect(await page.locator("head link[data-hesperia-style-id='css-red']").count()).toBe(0);

  await page.evaluate(() => window.__cssRuntimeHarness.disposeAll());
});

const cssFailureCases = [
  {
    title:
      "CSS failure is reported once and rejects a later settled call without unhandled rejection",
    kind: "element",
    requestPath: "/css/red.css",
    applicationName: "failure",
  },
  {
    title: "Document CSS failure keeps the shell hidden and rejects the same settled fault",
    kind: "document",
    requestPath: "/css/document.css",
    applicationName: "document",
  },
] as const;

for (const failureCase of cssFailureCases) {
  test(failureCase.title, async ({ page }) => {
    const pageErrors: string[] = [];

    await page.route(`**${failureCase.requestPath}`, (route) => route.abort("failed"));

    page.on("pageerror", (error) => pageErrors.push(error.message));

    await openFixture(page);

    const request = page.waitForRequest(
      (item) => new URL(item.url()).pathname === failureCase.requestPath,
    );

    await page.evaluate((kind) => {
      const harness = window.__cssRuntimeHarness;

      if (kind === "element") {
        harness.mountDirect(document.querySelector("#first-target")!, "failure");
      } else {
        harness.mountDocument();
      }
    }, failureCase.kind);

    await request;

    await expect
      .poll(() => page.evaluate(() => window.__cssRuntimeHarness.snapshot().faults.length))
      .toBe(1);

    const beforeSettled = await page.evaluate((kind) => {
      const snapshot = window.__cssRuntimeHarness.snapshot();

      if (kind === "element") {
        const target = document.querySelector("#first-target")!;
        return {
          kind,
          pendingWrapper: Boolean(target.querySelector("[data-hesperia-pending]")),
          buttonConnected: Boolean(target.querySelector(".css-red-node")?.isConnected),
          visible:
            (target.querySelector(".css-red-node") as HTMLElement).getClientRects().length > 0,
          effects: snapshot.effects,
          unhandled: snapshot.unhandled,
          faults: snapshot.faults,
        };
      }

      const button = document.querySelector(".css-document-node") as HTMLElement;
      return {
        kind,
        bodyId: document.body.id,
        bodyDisplay: getComputedStyle(document.body).display,
        buttonConnected: button.isConnected,
        visible: button.getClientRects().length > 0,
        effects: snapshot.effects,
        unhandled: snapshot.unhandled,
        faults: snapshot.faults,
      };
    }, failureCase.kind);

    if (beforeSettled.kind === "element") {
      expect(beforeSettled.pendingWrapper).toBe(true);

      expect(beforeSettled.buttonConnected).toBe(true);
    } else {
      expect(beforeSettled.bodyId).toBe("css-document-body");

      expect(beforeSettled.bodyDisplay).toBe("none");

      expect(beforeSettled.buttonConnected).toBe(true);
    }

    expect(beforeSettled.visible).toBe(false);

    expect(beforeSettled.effects).toStrictEqual([]);

    expect(beforeSettled.unhandled).toStrictEqual([]);

    expect(beforeSettled.faults).toHaveLength(1);

    expect(beforeSettled.faults[0]?.kind).toBe("stylesheet-load");

    expect(pageErrors).toStrictEqual([]);

    const settled = await page.evaluate(
      (name) => window.__cssRuntimeHarness.settleFailed(name),
      failureCase.applicationName,
    );

    expect(settled).toStrictEqual({ sameFault: true, kind: "stylesheet-load" });

    expect(pageErrors).toStrictEqual([]);

    await page.evaluate(() => window.__cssRuntimeHarness.disposeAll());

    await captureBrowserPageCoverage(
      page,
      failureCase.kind === "document"
        ? browserCssCoverageOwnerIds.documentFailure
        : browserCssCoverageOwnerIds.elementFailure,
    );
  });
}

test("conditional owner styles stay inactive until the conditional Owner is mounted", async ({
  page,
}) => {
  await openFixture(page);

  await page.evaluate(() =>
    window.__cssRuntimeHarness.mountConditional(
      document.querySelector("#conditional-target")!,
      "without-conditional-child",
      false,
    ),
  );

  expect(
    await page.evaluate(() => window.__cssRuntimeHarness.settle("without-conditional-child")),
  ).toBe("resolved");

  const preloaded = await page.evaluate(() => ({
    ids: [...document.head.querySelectorAll<HTMLLinkElement>("link[data-hesperia-style-id]")].map(
      (link) => ({ id: link.dataset.hesperiaStyleId, media: link.sheet?.media.mediaText }),
    ),
    blueChildren: document.querySelectorAll(".css-blue-node").length,
    targetHTML: document.querySelector("#conditional-target")?.innerHTML,
    faults: window.__cssRuntimeHarness.snapshot().faults,
    redColor: (() => {
      const node = document.querySelector(
        "#without-conditional-child-conditional-shell.css-red-node",
      );
      return node ? getComputedStyle(node).color : null;
    })(),
  }));

  expect(preloaded.ids.map(({ id }) => id)).toStrictEqual(["css-red", "css-blue"]);

  expect(preloaded.ids.find(({ id }) => id === "css-blue")?.media).toBe("not all");

  expect(preloaded.blueChildren).toBe(0);

  expect(preloaded.redColor).toBe("rgb(220, 0, 0)");

  await page.evaluate(() =>
    window.__cssRuntimeHarness.mountConditional(
      document.querySelector("#conditional-target")!,
      "with-conditional-child",
      true,
    ),
  );

  expect(
    await page.evaluate(() => window.__cssRuntimeHarness.settle("with-conditional-child")),
  ).toBe("resolved");

  expect(
    await page
      .locator("#with-conditional-child-conditional-shell .css-blue-node")
      .evaluate((node) => getComputedStyle(node).color),
  ).toBe("rgb(0, 0, 220)");

  await page.evaluate(() => window.__cssRuntimeHarness.dispose("with-conditional-child"));

  expect(
    await page
      .locator("head link[data-hesperia-style-id='css-blue']")
      .evaluate((link) => (link as HTMLLinkElement).sheet?.media.mediaText),
  ).toBe("not all");

  expect(
    await page
      .locator("#without-conditional-child-conditional-shell.css-red-node")
      .evaluate((node) => getComputedStyle(node).color),
  ).toBe("rgb(220, 0, 0)");

  await page.evaluate(() => window.__cssRuntimeHarness.dispose("without-conditional-child"));

  await page.evaluate(() => window.__cssRuntimeHarness.disposeAll());
});

test("reversed style compositions reverse the cascade order for one selected root", async ({
  page,
}) => {
  await openFixture(page);

  await page.evaluate(async () => {
    await window.__cssRuntimeHarness.mountOrdered(
      document.querySelector("#ordered-target")!,
      "forward-order",
      false,
    );
  });

  expect(
    await page
      .locator("#ordered-target .order-node")
      .evaluate((node) => getComputedStyle(node).color),
  ).toBe("rgb(0, 0, 220)");

  await page.evaluate(() => window.__cssRuntimeHarness.dispose("forward-order"));

  await page.evaluate(async () => {
    await window.__cssRuntimeHarness.mountOrdered(
      document.querySelector("#ordered-target")!,
      "reverse-order",
      true,
    );
  });

  expect(
    await page
      .locator("#ordered-target .order-node")
      .evaluate((node) => getComputedStyle(node).color),
  ).toBe("rgb(220, 0, 0)");

  await page.evaluate(() => window.__cssRuntimeHarness.dispose("reverse-order"));

  await page.evaluate(() => window.__cssRuntimeHarness.disposeAll());
});

test("root style release cleanup stays bounded across vector switches and head replacement", async ({
  page,
}) => {
  await openFixture(page);

  await page.evaluate(() =>
    window.__cssRuntimeHarness.mountDirect(
      document.querySelector("#ordered-target")!,
      "release-bound",
    ),
  );

  expect(await page.evaluate(() => window.__cssRuntimeHarness.settle("release-bound"))).toBe(
    "resolved",
  );

  const result = await page.evaluate(() =>
    window.__cssRuntimeHarness.exerciseRootReleaseBound("release-bound"),
  );

  expect(result.afterSwitches).toBe(result.initialRegistrations);

  expect(result.afterHeadRetirement).toBe(result.initialRegistrations);

  expect(result.afterReactivation).toBe(result.initialRegistrations);

  expect(result.redMediaBeforeDispose).toBe("all");

  expect(result.redMediaAfterDispose).toBe("not all");

  await page.evaluate(() => window.__cssRuntimeHarness.disposeAll());
});

test("disposing a mounted root after head replacement skips detached stylesheet mutation", async ({
  page,
}) => {
  await openFixture(page);

  await page.evaluate(() =>
    window.__cssRuntimeHarness.mountDirect(
      document.querySelector("#first-target")!,
      "detached-head-dispose",
    ),
  );

  expect(
    await page.evaluate(() => window.__cssRuntimeHarness.settle("detached-head-dispose")),
  ).toBe("resolved");

  const result = await page.evaluate(() =>
    window.__cssRuntimeHarness.replaceHeadThenDispose("detached-head-dispose"),
  );

  expect(result.faultCount).toBe(0);

  expect(result.oldHeadLinkCount).toBe(0);
});

test("Document mount waits on its installed head and releases preloaded old-head links", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  let releaseCss!: () => void;
  const cssGate = new Promise<void>((resolve) => (releaseCss = resolve));
  let responseFinished!: () => void;
  const responseDone = new Promise<void>((resolve) => (responseFinished = resolve));

  page.on("pageerror", (error) => pageErrors.push(error.message));

  await openFixture(page);

  await page.evaluate(() => window.__cssRuntimeHarness.preloadOriginalDocumentHead());

  const before = await page.evaluate(() => ({
    oldLinks: document.head.querySelectorAll("link[data-hesperia-style-id]").length,
  }));

  expect(before.oldLinks).toBe(1);

  await page.route("**/css/document.css", async (route) => {
    await cssGate;

    try {
      await route.fulfill({
        status: 200,
        contentType: "text/css",
        body: ".css-document-node { color: rgb(80, 0, 160); }",
      });
    } finally {
      responseFinished();
    }
  });

  const newHeadRequest = page.waitForRequest(
    (request) => new URL(request.url()).pathname === "/css/document.css",
  );

  await page.evaluate(() => window.__cssRuntimeHarness.mountDocument());

  await newHeadRequest;
  const pending = await page.evaluate(() => ({
    bodyDisplay: getComputedStyle(document.body).display,
    bodyHasNewShell: document.body.id === "css-document-body",
    buttonVisible: document.querySelector(".css-document-node")!.getClientRects().length > 0,
    effects: window.__cssRuntimeHarness.snapshot().effects,
    linkCount: document.head.querySelectorAll("link[data-hesperia-style-id]").length,
  }));

  expect(pending.bodyDisplay).toBe("none");

  expect(pending.bodyHasNewShell).toBe(true);

  expect(pending.buttonVisible).toBe(false);

  expect(pending.effects).toStrictEqual([]);

  expect(pending.linkCount).toBe(1);

  releaseCss();

  await responseDone;

  expect(await page.evaluate(() => window.__cssRuntimeHarness.settle("document"))).toBe("resolved");

  const ready = await page.evaluate(() => {
    const snapshot = window.__cssRuntimeHarness.snapshot();
    return {
      bodyDisplay: getComputedStyle(document.body).display,
      documentSnapshot: snapshot.documentSnapshot,
      oldHeadDetached: snapshot.oldHeadDetached,
      oldHeadLeaseCount: snapshot.oldHeadLeaseCount,
      linkHead:
        document.head.querySelector("link[data-hesperia-style-id]")?.parentNode === document.head,
      button: document.querySelector(".css-document-node"),
      knownButton: snapshot.directButtons.at(-1),
    };
  });

  expect(ready.bodyDisplay).toBe("grid");

  expect(ready.documentSnapshot).toStrictEqual({ display: "grid", color: "rgb(80, 0, 160)" });

  expect(ready.oldHeadDetached).toBe(true);

  expect(ready.oldHeadLeaseCount).toBe(0);

  expect(ready.linkHead).toBe(true);

  expect(ready.button).toBe(ready.knownButton);

  expect(pageErrors).toStrictEqual([]);

  await page.evaluate(() => window.__cssRuntimeHarness.disposeAll());

  await captureBrowserPageCoverage(page, browserCssCoverageOwnerIds.document);
});

test("suspending a parent and its child releases the shared style reference once", async ({
  page,
}) => {
  await openFixture(page);

  await page.evaluate(() =>
    window.__cssRuntimeHarness.mountNested(document.querySelector("#nested-target")!, "nested"),
  );

  expect(await page.evaluate(() => window.__cssRuntimeHarness.settle("nested"))).toBe("resolved");

  const activeColor = await page
    .locator("#nested-css-root .css-red-node")
    .evaluate((node) => getComputedStyle(node).color);

  expect(activeColor).toBe("rgb(220, 0, 0)");

  await page.evaluate(() => window.__cssRuntimeHarness.suspendNested());

  const suspendedColor = await page
    .locator("#nested-css-root .css-red-node")
    .evaluate((node) => getComputedStyle(node).color);

  expect(suspendedColor).not.toBe("rgb(220, 0, 0)");

  await page.evaluate(() => window.__cssRuntimeHarness.resumeNested());

  const resumedColor = await page
    .locator("#nested-css-root .css-red-node")
    .evaluate((node) => getComputedStyle(node).color);

  expect(resumedColor).toBe("rgb(220, 0, 0)");

  expect(await page.evaluate(() => window.__cssRuntimeHarness.snapshot().faults)).toStrictEqual([]);

  await page.evaluate(() => window.__cssRuntimeHarness.disposeAll());
});

test("a superseded revision rejects while its shared replacement response is still held", async ({
  page,
}) => {
  let releaseNext!: () => void;
  const nextGate = new Promise<void>((resolve) => (releaseNext = resolve));
  let routeFinished!: () => void;
  const finished = new Promise<void>((resolve) => (routeFinished = resolve));

  await page.route("**/css/red-next.css", async (route) => {
    await nextGate;

    try {
      await route.fulfill({
        status: 200,
        contentType: "text/css",
        body: ".css-red-node { color: rgb(0, 180, 0); }",
      });
    } catch {
      // The replaced revision may cancel its request while the newer attempt retains the same group.
    } finally {
      routeFinished();
    }
  });

  await openFixture(page);

  await page.evaluate(() =>
    window.__cssRuntimeHarness.mountDirect(document.querySelector("#first-target")!, "revision"),
  );

  expect(await page.evaluate(() => window.__cssRuntimeHarness.settle("revision"))).toBe("resolved");

  await page.evaluate(() => window.__cssRuntimeHarness.retainRevisionPreload());

  await page.evaluate(() => {
    const node = document.querySelector("#first-target .css-red-node") as HTMLButtonElement;
    node.textContent = "retained local state";
    window.__cssRuntimeRevisionNode = node;
    window.__cssRuntimeRevisionEffects = window.__cssRuntimeHarness.snapshot().effects.length;
  });

  const nextRequest = page.waitForRequest(
    (request) => new URL(request.url()).pathname === "/css/red-next.css",
  );
  const outcome = await page.evaluate(() => window.__cssRuntimeHarness.startRevisionSupersession());
  await nextRequest;

  expect(outcome).toStrictEqual({ status: "rejected", kind: "style-revision-superseded" });

  expect(
    await page
      .locator("#first-target .css-red-node")
      .evaluate((node) => getComputedStyle(node).color),
  ).toBe("rgb(220, 0, 0)");

  releaseNext();

  await finished;

  await page.evaluate(() => window.__cssRuntimeHarness.publishSupersedingRevision());

  expect(
    await page
      .locator("#first-target .css-red-node")
      .evaluate((node) => getComputedStyle(node).color),
  ).toBe("rgb(0, 180, 0)");

  expect(
    await page.evaluate(() => {
      const node = document.querySelector("#first-target .css-red-node") as HTMLButtonElement;
      return {
        sameNode: node === window.__cssRuntimeRevisionNode,
        text: node.textContent,
        effects: window.__cssRuntimeHarness.snapshot().effects.length,
        oldEffectCount: window.__cssRuntimeRevisionEffects,
      };
    }),
  ).toStrictEqual({
    sameNode: true,
    text: "retained local state",
    effects: 1,
    oldEffectCount: 1,
  });

  expect(await page.locator("head link[data-hesperia-style-id='css-red']").count()).toBe(1);

  expect(await page.evaluate(() => window.__cssRuntimeHarness.snapshot())).toMatchObject({
    leaseCount: 2,
    validLeaseMembership: true,
  });

  await page.evaluate(() => window.__cssRuntimeHarness.releaseRevisionPreload());

  expect(await page.evaluate(() => window.__cssRuntimeHarness.snapshot())).toMatchObject({
    leaseCount: 1,
    validLeaseMembership: true,
  });

  await page.evaluate(() => window.__cssRuntimeHarness.disposeAll());
});

test("revision publish fails closed when a new vector is retained after staging", async ({
  page,
}) => {
  await openFixture(page);

  await page.evaluate(() =>
    window.__cssRuntimeHarness.mountDirect(document.querySelector("#first-target")!, "late-vector"),
  );

  expect(await page.evaluate(() => window.__cssRuntimeHarness.settle("late-vector"))).toBe(
    "resolved",
  );

  const outcome = await page.evaluate(() =>
    window.__cssRuntimeHarness.prepareRevisionWithLateBlue(),
  );

  expect(outcome).toStrictEqual({ status: "rejected", kind: "style-revision-stale" });

  expect(
    await page
      .locator("#first-target .css-red-node")
      .evaluate((node) => getComputedStyle(node).color),
  ).toBe("rgb(220, 0, 0)");

  expect(
    await page
      .locator("#blue-target .css-blue-node")
      .evaluate((node) => getComputedStyle(node).color),
  ).toBe("rgb(0, 0, 220)");

  await page.evaluate(() => window.__cssRuntimeHarness.disposeAll());
});

test("a failed CSS-only revision leaves old styles, native nodes, and local state active", async ({
  page,
}) => {
  await page.route("**/css/red-next.css", (route) => route.abort("failed"));

  await openFixture(page);

  await page.evaluate(() =>
    window.__cssRuntimeHarness.mountDirect(
      document.querySelector("#first-target")!,
      "failed-revision",
    ),
  );

  expect(await page.evaluate(() => window.__cssRuntimeHarness.settle("failed-revision"))).toBe(
    "resolved",
  );

  await page.evaluate(() => {
    const node = document.querySelector("#first-target .css-red-node") as HTMLButtonElement;
    node.textContent = "unchanged after failed revision";
    window.__cssRuntimeRevisionNode = node;
    window.__cssRuntimeRevisionEffects = window.__cssRuntimeHarness.snapshot().effects.length;
  });

  const request = page.waitForRequest(
    (item) => new URL(item.url()).pathname === "/css/red-next.css",
  );
  const outcome = await page.evaluate(() => window.__cssRuntimeHarness.failRevision());
  await request;

  expect(outcome).toStrictEqual({ status: "rejected", kind: "stylesheet-load" });

  expect(
    await page.evaluate(() => {
      const node = document.querySelector("#first-target .css-red-node") as HTMLButtonElement;
      return {
        color: getComputedStyle(node).color,
        sameNode: node === window.__cssRuntimeRevisionNode,
        text: node.textContent,
        effects: window.__cssRuntimeHarness.snapshot().effects.length,
        oldEffectCount: window.__cssRuntimeRevisionEffects,
        links: [
          ...document.head.querySelectorAll<HTMLLinkElement>("link[data-hesperia-style-id]"),
        ].map((link) => ({
          href: new URL(link.href).pathname,
          media: link.sheet?.media.mediaText,
        })),
      };
    }),
  ).toStrictEqual({
    color: "rgb(220, 0, 0)",
    sameNode: true,
    text: "unchanged after failed revision",
    effects: 1,
    oldEffectCount: 1,
    links: [{ href: "/css/red.css", media: "all" }],
  });

  await page.evaluate(() => window.__cssRuntimeHarness.disposeAll());
});
