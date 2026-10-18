/** @typedef {import("playwright").Page} Page */
/** @typedef {import("playwright").Route} Route */
/** @typedef {import("./routing-public-flows.d.mts").BrowserEngineName} BrowserEngineName */
/** @typedef {import("./routing-public-flows.d.mts").BrowserPageRole} BrowserPageRole */
/** @typedef {import("./routing-public-flows.d.mts").BrowserPageCoverageConfig} BrowserPageCoverageConfig */
/** @typedef {import("./routing-public-flows.d.mts").BrowserPageCoverageContext} BrowserPageCoverageContext */
/** @typedef {import("./routing-public-flows.d.mts").BrowserPageCoverageCapture} BrowserPageCoverageCapture */
/** @typedef {import("./routing-public-flows.d.mts").BrowserReloadStateObservation} BrowserReloadStateObservation */
/** @typedef {import("./routing-public-flows.d.mts").ReloadAttemptOutcome} ReloadAttemptOutcome */
/** @typedef {import("./routing-public-flows.d.mts").ReloadActionResult} ReloadActionResult */
/** @typedef {import("./routing-public-flows.d.mts").ReloadActionOutcome} ReloadActionOutcome */
/** @typedef {import("./routing-public-flows.d.mts").ReloadDepartureOutcome} ReloadDepartureOutcome */
/** @typedef {import("./routing-public-flows.d.mts").ReloadSignal} ReloadSignal */
/** @typedef {import("./routing-public-flows.d.mts").BrowserNavigationReloadResult} BrowserNavigationReloadResult */
/** @typedef {import("./routing-public-flows.d.mts").RoutingPublicFlowsRuntimeConfig} RoutingPublicFlowsRuntimeConfig */
/** @typedef {import("./routing-public-flows.d.mts").RoutingPublicFixture} RoutingPublicFixture */
/** @typedef {import("./routing-public-flows.d.mts").CoverageFile} CoverageFile */

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

/** @type {RoutingPublicFlowsRuntimeConfig} */
const runtimeConfig = JSON.parse(await readFile(process.argv[2], "utf8"));

const { playwrightModuleUrl, serverUrl } = runtimeConfig;

const { chromium, firefox, webkit } = /** @type {typeof import("playwright")} */ (
  await import(playwrightModuleUrl)
);

/** @type {BrowserPageCoverageConfig | null | undefined} */
const browserCoverage = runtimeConfig.browserCoverage;

/** @type {BrowserPageCoverageCapture[]} */
const browserCoverageCaptures = [];

/**
 * @param {BrowserEngineName} engine
 * @param {string} browserVersion
 * @param {BrowserPageRole} pageRole
 * @param {number} documentOrdinal
 * @returns {BrowserPageCoverageContext}
 */
function createCaptureContext(engine, browserVersion, pageRole, documentOrdinal) {
  return {
    runId: /** @type {BrowserPageCoverageConfig} */ (browserCoverage).runId,
    ownerId: /** @type {BrowserPageCoverageConfig} */ (browserCoverage).ownerId,
    platform: /** @type {BrowserPageCoverageConfig} */ (browserCoverage).platform,
    populationFingerprint: /** @type {BrowserPageCoverageConfig} */ (browserCoverage)
      .populationFingerprint,
    engine,
    browserVersion,
    pageRole,
    documentOrdinal,
    captureId: engine + ":" + pageRole + ":" + documentOrdinal,
    captureProcessId: process.pid,
  };
}

/** @param {Record<string, CoverageFile>} coverage */
function hasCounterHits(coverage) {
  return Object.values(coverage).some(
    (file) =>
      Object.values(file.s ?? {}).some((count) => count > 0) ||
      Object.values(file.f ?? {}).some((count) => count > 0) ||
      Object.values(file.b ?? {}).some((counts) => counts.some((count) => count > 0)),
  );
}

/** @param {Record<string, CoverageFile>} coverage @param {string} label */
function assertCounterSnapshot(coverage, label) {
  assert.ok(
    coverage && typeof coverage === "object" && !Array.isArray(coverage),
    label + " coverage map is malformed",
  );

  assert.ok(Object.keys(coverage).length > 0, label + " coverage map is empty");

  assert.ok(hasCounterHits(coverage), label + " did not execute an instrumented authored source");
}

/** @param {Record<string, CoverageFile>} before @param {Record<string, CoverageFile>} after */
function countersInclude(before, after) {
  for (const [source, file] of Object.entries(before)) {
    const finalFile = after[source];

    assert.ok(finalFile, "pagehide omitted pre-navigation source " + source);

    for (const [unit, count] of Object.entries(file.s ?? {}))
      assert.ok(
        finalFile.s?.[unit] >= count,
        "pagehide lost statement counter " + source + ":" + unit,
      );

    for (const [unit, count] of Object.entries(file.f ?? {}))
      assert.ok(
        finalFile.f?.[unit] >= count,
        "pagehide lost function counter " + source + ":" + unit,
      );

    for (const [unit, counts] of Object.entries(file.b ?? {}))
      counts.forEach((count, index) =>
        assert.ok(
          finalFile.b?.[unit]?.[index] >= count,
          "pagehide lost branch counter " + source + ":" + unit + ":" + index,
        ),
      );
  }
}

/** @param {Page} page @param {BrowserEngineName} engineName @param {BrowserPageRole} pageRole */
async function installPageCoverage(page, engineName, pageRole) {
  if (!browserCoverage) return undefined;

  const storageKey =
    "hesperia-browser-coverage:" + browserCoverage.runId + ":" + engineName + ":" + pageRole;

  await page.addInitScript(
    ({ variable, key }) => {
      /** @type {Record<string, unknown>} */ (globalThis)[variable] = {};

      globalThis.__hesperiaCoverageDocumentCapture = undefined;

      window.addEventListener(
        "pagehide",
        () => {
          const context = globalThis.__hesperiaCoverageDocumentCapture;

          if (context === undefined) return;

          const coverage = /** @type {Record<string, CoverageFile>} */ (
            /** @type {Record<string, unknown>} */ (globalThis)[variable]
          );

          if (!coverage || typeof coverage !== "object")
            throw new Error("Pagehide has no browser coverage map");

          sessionStorage.setItem(
            key,
            JSON.stringify({
              ...context,
              format: "hesperia-browser-page-coverage",
              capturePhase: "pagehide",
              href: location.href,
              timeOrigin: performance.timeOrigin,
              coverage: JSON.parse(JSON.stringify(coverage)),
            }),
          );
        },
        { once: true },
      );
    },
    { variable: browserCoverage.coverageVariable, key: storageKey },
  );

  return storageKey;
}

/**
 * @param {Page} page
 * @param {string} storageKey
 * @param {BrowserPageCoverageContext} context
 */
async function armPagehideCapture(page, storageKey, context) {
  const before = await page.evaluate(
    ({ variable, context }) => {
      const coverage = /** @type {Record<string, CoverageFile>} */ (
        /** @type {Record<string, unknown>} */ (globalThis)[variable]
      );

      return {
        href: location.href,
        timeOrigin: performance.timeOrigin,
        coverage: JSON.parse(JSON.stringify(coverage)),
        context: { ...context, documentTimeOrigin: performance.timeOrigin },
      };
    },
    {
      variable: /** @type {BrowserPageCoverageConfig} */ (browserCoverage).coverageVariable,
      context,
    },
  );

  assertCounterSnapshot(before.coverage, context.captureId + " pre-navigation");

  const armed = await page.evaluate(
    ({ context, key }) => {
      if (sessionStorage.getItem(key) !== null)
        throw new Error("Browser document still has an undrained pagehide capture");

      if (globalThis.__hesperiaCoverageDocumentCapture !== undefined)
        throw new Error("Browser document already has an armed pagehide capture");

      globalThis.__hesperiaCoverageDocumentCapture = context;

      return true;
    },
    { context: before.context, key: storageKey },
  );

  assert.equal(armed, true);

  return before;
}

/**
 * @param {Page} page
 * @param {string} storageKey
 * @param {Awaited<ReturnType<typeof armPagehideCapture>>} before
 * @param {number} currentDocumentTimeOrigin
 */
async function drainPagehideCapture(page, storageKey, before, currentDocumentTimeOrigin) {
  const stored = await page.evaluate((key) => {
    const value = sessionStorage.getItem(key);

    if (value !== null) sessionStorage.removeItem(key);

    return { value, cleared: sessionStorage.getItem(key) === null };
  }, storageKey);

  assert.equal(
    stored.cleared,
    true,
    before.context.captureId + " did not clear its pagehide record",
  );

  assert.equal(
    typeof stored.value,
    "string",
    before.context.captureId + " did not persist pagehide counters",
  );

  /** @type {BrowserPageCoverageCapture} */
  const capture = JSON.parse(/** @type {string} */ (stored.value));

  assert.equal(capture.format, "hesperia-browser-page-coverage");

  for (const key of /** @type {readonly (keyof BrowserPageCoverageContext)[]} */ ([
    "runId",
    "ownerId",
    "platform",
    "populationFingerprint",
    "engine",
    "browserVersion",
    "pageRole",
    "documentOrdinal",
    "captureId",
    "captureProcessId",
    "documentTimeOrigin",
  ]))
    assert.equal(
      capture[key],
      before.context[key],
      before.context.captureId + " pagehide provenance mismatch: " + key,
    );

  assert.equal(
    capture.href,
    before.href,
    before.context.captureId + " pagehide changed the old document URL",
  );

  assert.equal(
    capture.timeOrigin,
    before.timeOrigin,
    before.context.captureId + " pagehide changed the old document identity",
  );

  assert.notEqual(
    currentDocumentTimeOrigin,
    capture.timeOrigin,
    before.context.captureId + " did not identify a replaced document",
  );

  assertCounterSnapshot(capture.coverage, before.context.captureId + " pagehide");

  countersInclude(before.coverage, capture.coverage);

  browserCoverageCaptures.push(capture);
}

/** @param {Page} page @param {BrowserPageCoverageContext} context */
async function captureCurrentDocument(page, context) {
  /** @type {BrowserPageCoverageCapture} */
  const capture = await page.evaluate(
    ({ variable, context }) => ({
      ...context,
      format: "hesperia-browser-page-coverage",
      capturePhase: "final",
      href: location.href,
      timeOrigin: performance.timeOrigin,
      coverage: JSON.parse(
        JSON.stringify(
          /** @type {Record<string, CoverageFile>} */ (
            /** @type {Record<string, unknown>} */ (globalThis)[variable]
          ),
        ),
      ),
    }),
    {
      variable: /** @type {BrowserPageCoverageConfig} */ (browserCoverage).coverageVariable,
      context,
    },
  );

  assertCounterSnapshot(capture.coverage, context.captureId + " final");

  browserCoverageCaptures.push(capture);
}

for (const engine of [chromium, firefox, webkit]) {
  const browser = await engine.launch();

  try {
    const page = await browser.newPage();

    if (engine.name() === "webkit") {
      await page.addInitScript(() => {
        Object.defineProperty(window, "NavigationPrecommitController", {
          configurable: true,
          value: undefined,
        });
      });
    }

    const mainStorageKey = await installPageCoverage(page, engine.name(), "main");

    /** @type {string[]} */
    const errors = [];

    page.on("pageerror", (error) => errors.push(error.stack ?? error.message));

    /** @type {Route[]} */
    const sharedRequests = [];

    /** @type {(route: Route) => void} */
    let resolveInitial;

    /** @type {Promise<Route>} */
    const initialRequest = new Promise((resolve) => (resolveInitial = resolve));

    /** @type {(route: Route) => void} */
    let resolveUpdated;

    /** @type {Promise<Route>} */
    const updatedRequest = new Promise((resolve) => (resolveUpdated = resolve));

    let releaseShared = false;

    /** @type {Route[]} */
    const pendingShared = [];

    /** @type {Route | undefined} */
    let updateRequest;

    /** @type {(route: Route) => void} */
    let resolveMutation;

    /** @type {Promise<Route>} */
    const mutationRequest = new Promise((resolve) => (resolveMutation = resolve));

    await page.route("**/api/message/**", (route) => {
      const name = new URL(route.request().url()).pathname.split("/").pop();

      if (name === "shared") {
        sharedRequests.push(route);

        if (sharedRequests.length === 1) resolveInitial(route);
        else if (releaseShared) return route.fulfill({ json: { message: "updated while parked" } });
        else {
          pendingShared.push(route);

          if (sharedRequests.length === 2) resolveUpdated(route);
        }

        return;
      }

      return route.continue();
    });

    await page.route("**/api/update", (route) => {
      updateRequest = route;

      resolveMutation(route);
    });

    const startupPage = await browser.newPage();

    await installPageCoverage(startupPage, engine.name(), "startup");

    try {
      /** @type {(route: Route) => void} */
      let resolveInitialRoute;

      /** @type {Promise<Route>} */
      const initialRouteRequest = new Promise((resolve) => (resolveInitialRoute = resolve));

      await startupPage.route("**/api/message/**", (route) => {
        const name = new URL(route.request().url()).pathname.split("/").pop();

        if (name === "startup") return resolveInitialRoute(route);

        if (name === "shared") return route.fulfill({ json: { message: "startup shell" } });

        return route.continue();
      });

      await startupPage.goto(new URL("startup", serverUrl).href, { waitUntil: "commit" });

      const heldStartupQuery = await initialRouteRequest;

      await startupPage.locator("#update-shared").waitFor();

      await startupPage.evaluate(() => {
        const fixture = globalThis.routingPublicFixture;

        const nativeNavigation = window.navigation;

        nativeNavigation?.addEventListener("navigate", (event) => {
          fixture.reloadTimeline.push(
            "native:" + event.navigationType + ":" + (event.destination.url ?? "null"),
          );
        });

        window.addEventListener("beforeunload", () => {
          fixture.reloadTimeline.push("beforeunload");

          sessionStorage.setItem(
            "routing-public-reload",
            JSON.stringify({
              trace: fixture.reloadTrace,
              timeline: fixture.reloadTimeline,
            }),
          );
        });

        fixture.reloadObserverReady = true;

        sessionStorage.removeItem("routing-public-reload");

        fixture.reloadEnabled = true;

        fixture.reloadAllowed = false;

        fixture.reloadOutcome = undefined;

        fixture.reloadCommittedOutcome = undefined;

        fixture.reloadFinishedOutcome = undefined;

        fixture.reloadTrace.length = 0;

        fixture.reloadTimeline.length = 0;

        fixture.startReload?.();
      });

      await startupPage.waitForFunction(() => globalThis.routingPublicFixture.reloadObserverReady);

      const reloadWaitingForStartup = await startupPage.evaluate(() => ({
        timeOrigin: performance.timeOrigin,
        outcome: globalThis.routingPublicFixture.reloadOutcome,
        trace: [...globalThis.routingPublicFixture.reloadTrace],
        timeline: [...globalThis.routingPublicFixture.reloadTimeline],
        persisted: sessionStorage.getItem("routing-public-reload"),
        routeMounted: Boolean(document.querySelector("#startup")),
        shellMounted: Boolean(document.querySelector("#update-shared")),
      }));

      assert.equal(
        reloadWaitingForStartup.outcome,
        undefined,
        "Authored reload waits for initial route startup",
      );

      assert.deepEqual(
        reloadWaitingForStartup.trace,
        [],
        "Startup reload does not snapshot owners before route mount",
      );

      assert.equal(
        reloadWaitingForStartup.timeline.some((item) => item.startsWith("native:reload:")),
        false,
        "Startup reload dispatches no native reload while the initial route request is held",
      );

      assert.equal(
        reloadWaitingForStartup.timeline.includes("beforeunload"),
        false,
        "Startup reload does not unload while the initial route request is held",
      );

      assert.equal(
        reloadWaitingForStartup.persisted,
        null,
        "Startup reload did not persist an unload before the initial route mounted",
      );

      assert.equal(
        reloadWaitingForStartup.routeMounted,
        false,
        "Initial route remains held by its real request",
      );

      assert.equal(
        reloadWaitingForStartup.shellMounted,
        true,
        "Authored reload starts from the mounted application shell",
      );

      await heldStartupQuery.fulfill({ json: { message: "startup query ready" } });

      await startupPage.locator("#startup").waitFor();

      await startupPage.waitForFunction(() => {
        const fixture = globalThis.routingPublicFixture;

        return (
          fixture.reloadTrace.includes("layout:started") ||
          fixture.reloadOutcome !== undefined ||
          sessionStorage.getItem("routing-public-reload") !== null
        );
      });

      const reloadWaitingForMountedCheck = await startupPage.evaluate(() => ({
        timeOrigin: performance.timeOrigin,
        routeMounted: Boolean(document.querySelector("#startup")),
        layoutMounted: Boolean(document.querySelector("#route-layout")),
        outcome: globalThis.routingPublicFixture.reloadOutcome,
        committed: globalThis.routingPublicFixture.reloadCommittedOutcome,
        finished: globalThis.routingPublicFixture.reloadFinishedOutcome,
        trace: [...globalThis.routingPublicFixture.reloadTrace],
        timeline: [...globalThis.routingPublicFixture.reloadTimeline],
      }));

      assert.equal(
        reloadWaitingForMountedCheck.routeMounted,
        true,
        "Initial route mounted before departure admission",
      );

      assert.equal(
        reloadWaitingForMountedCheck.layoutMounted,
        true,
        "Initial layout mounted before departure admission",
      );

      assert.equal(
        reloadWaitingForMountedCheck.trace.includes("layout:started"),
        true,
        "Startup reload reached the mounted layout check: " +
          JSON.stringify(reloadWaitingForMountedCheck),
      );

      assert.equal(
        reloadWaitingForMountedCheck.outcome,
        undefined,
        "Authored reload waits for the mounted layout check",
      );

      assert.deepEqual(
        reloadWaitingForMountedCheck.trace.filter((item) => item.endsWith(":started")).sort(),
        ["app:started", "layout:started", "page:started"],
        "Startup reload checks the mounted shell, layout, and initial page",
      );

      assert.equal(
        reloadWaitingForMountedCheck.timeline.some((item) => item.startsWith("native:reload:")),
        false,
        "Startup reload has not dispatched while a mounted check is held",
      );

      assert.equal(
        reloadWaitingForMountedCheck.timeline.includes("beforeunload"),
        false,
        "Startup reload has not unloaded while a mounted check is held",
      );

      await startupPage.evaluate(() => globalThis.routingPublicFixture.releaseReload?.());

      await startupPage.waitForFunction(
        () => globalThis.routingPublicFixture.reloadOutcome === "rejected",
      );

      const startupVeto = await startupPage.evaluate(() => ({
        timeOrigin: performance.timeOrigin,
        committed: globalThis.routingPublicFixture.reloadCommittedOutcome,
        finished: globalThis.routingPublicFixture.reloadFinishedOutcome,
        trace: [...globalThis.routingPublicFixture.reloadTrace],
        timeline: [...globalThis.routingPublicFixture.reloadTimeline],
        persisted: sessionStorage.getItem("routing-public-reload"),
      }));

      assert.equal(
        startupVeto.timeOrigin,
        reloadWaitingForStartup.timeOrigin,
        "Startup veto kept the original document",
      );

      assert.deepEqual(
        startupVeto.trace.filter((item) => item.endsWith(":settled")).sort(),
        ["app:settled", "layout:settled", "page:settled"],
        "Every mounted startup departure check settled before veto",
      );

      assert.equal(
        startupVeto.committed,
        "AbortError",
        "Startup veto rejected committed with AbortError",
      );

      assert.equal(
        startupVeto.finished,
        "AbortError",
        "Startup veto rejected finished with AbortError",
      );

      assert.equal(
        startupVeto.timeline.some((item) => item.startsWith("native:reload:")),
        false,
        "Startup veto emitted no native reload event",
      );

      assert.equal(
        startupVeto.timeline.includes("beforeunload"),
        false,
        "Startup veto emitted no document unload",
      );

      assert.equal(startupVeto.persisted, null, "Startup veto did not persist an unload trace");

      if (browserCoverage)
        await captureCurrentDocument(
          startupPage,
          createCaptureContext(engine.name(), browser.version(), "startup", 0),
        );
    } finally {
      await startupPage.close();
    }

    const supersessionPage = await browser.newPage();

    await installPageCoverage(supersessionPage, engine.name(), "supersession");

    try {
      await supersessionPage.route("**/api/message/**", (route) => {
        const name = new URL(route.request().url()).pathname.split("/").pop();

        if (name === "shared") return route.fulfill({ json: { message: "supersession shell" } });

        return route.continue();
      });

      await supersessionPage.goto(serverUrl);

      await supersessionPage.locator("#home").waitFor();

      await supersessionPage.locator("#allow-leave").click();

      const beforeSupersession = await supersessionPage.evaluate(() => {
        const fixture = globalThis.routingPublicFixture;

        fixture.reloadReferences = {
          document,
          html: document.documentElement,
          layout: document.querySelector("#route-layout"),
          page: document.querySelector("#home"),
        };

        sessionStorage.removeItem("routing-public-reload");

        const nativeNavigation = window.navigation;

        nativeNavigation?.addEventListener("navigate", (event) => {
          if (event.navigationType === "reload")
            fixture.reloadTimeline.push(
              "native:reload:" + (event.info == null ? "none" : String(event.info)),
            );
        });

        window.addEventListener("beforeunload", () => {
          fixture.reloadTimeline.push("beforeunload");

          sessionStorage.setItem(
            "routing-public-reload",
            JSON.stringify({
              trace: fixture.reloadTrace,
              timeline: fixture.reloadTimeline,
            }),
          );
        });

        fixture.reloadObserverReady = true;

        fixture.reloadEnabled = true;

        fixture.reloadAllowed = true;

        fixture.reloadOutcome = undefined;

        fixture.reloadTrace.length = 0;

        fixture.reloadTimeline.length = 0;

        fixture.releaseReload = undefined;

        fixture.startReload?.();

        return { timeOrigin: performance.timeOrigin };
      });

      await supersessionPage.waitForFunction(() =>
        globalThis.routingPublicFixture.reloadTrace.includes("layout:started"),
      );

      const heldChecks = await supersessionPage.evaluate(() =>
        [...globalThis.routingPublicFixture.reloadTrace]
          .filter((item) => item.endsWith(":started"))
          .sort(),
      );

      assert.deepEqual(
        heldChecks,
        ["app:started", "editor:started", "layout:started", "page:started"],
        "Superseded reload reached every mounted Home departure check",
      );

      await supersessionPage.evaluate(() => {
        globalThis.routingPublicFixture.reloadEnabled = false;
      });

      await supersessionPage.locator("#home-target").click();

      await supersessionPage.locator("#target").waitFor();

      await supersessionPage.waitForURL("**/target");

      await supersessionPage.waitForFunction(
        () =>
          globalThis.routingPublicFixture.reloadCommittedOutcome === "AbortError" &&
          globalThis.routingPublicFixture.reloadFinishedOutcome === "AbortError",
      );

      const supersededBeforeRelease = await supersessionPage.evaluate(() => ({
        timeOrigin: performance.timeOrigin,
        url: location.href,
        sameDocument: document === globalThis.routingPublicFixture.reloadReferences?.document,
        sameHtml:
          document.documentElement === globalThis.routingPublicFixture.reloadReferences?.html,
        sameLayout:
          document.querySelector("#route-layout") ===
          globalThis.routingPublicFixture.reloadReferences?.layout,
        committed: globalThis.routingPublicFixture.reloadCommittedOutcome,
        finished: globalThis.routingPublicFixture.reloadFinishedOutcome,
        trace: [...globalThis.routingPublicFixture.reloadTrace],
        timeline: [...globalThis.routingPublicFixture.reloadTimeline],
        persisted: sessionStorage.getItem("routing-public-reload"),
      }));

      assert.equal(
        new URL(supersededBeforeRelease.url).pathname,
        "/target",
        "Newer link navigation committed before the old guard was released",
      );

      assert.equal(
        supersededBeforeRelease.timeOrigin,
        beforeSupersession.timeOrigin,
        "Newer route navigation retained the same document",
      );

      assert.equal(
        supersededBeforeRelease.sameDocument,
        true,
        "Newer route navigation retained the actual Document object",
      );

      assert.equal(
        supersededBeforeRelease.sameHtml,
        true,
        "Newer route navigation retained the shell node",
      );

      assert.equal(
        supersededBeforeRelease.sameLayout,
        true,
        "Newer route navigation retained the layout node",
      );

      assert.equal(
        supersededBeforeRelease.committed,
        "AbortError",
        "Superseded reload committed rejected with AbortError",
      );

      assert.equal(
        supersededBeforeRelease.finished,
        "AbortError",
        "Superseded reload finished rejected with AbortError",
      );

      assert.equal(
        supersededBeforeRelease.trace.includes("layout:settled"),
        false,
        "Old layout guard remains held after the newer route succeeds",
      );

      assert.equal(
        supersededBeforeRelease.timeline.some((item) => item.startsWith("native:reload:")),
        false,
        "Superseded reload emitted no native reload event before release",
      );

      assert.equal(
        supersededBeforeRelease.timeline.includes("beforeunload"),
        false,
        "Superseded reload caused no unload before release",
      );

      assert.equal(
        supersededBeforeRelease.persisted,
        null,
        "Superseded reload persisted no unload trace before release",
      );

      await supersessionPage.evaluate(() => globalThis.routingPublicFixture.releaseReload?.());

      await supersessionPage.waitForFunction(() =>
        globalThis.routingPublicFixture.reloadTrace.includes("layout:settled"),
      );

      const supersededAfterRelease = await supersessionPage.evaluate(() => ({
        timeOrigin: performance.timeOrigin,
        url: location.href,
        sameDocument: document === globalThis.routingPublicFixture.reloadReferences?.document,
        sameHtml:
          document.documentElement === globalThis.routingPublicFixture.reloadReferences?.html,
        sameLayout:
          document.querySelector("#route-layout") ===
          globalThis.routingPublicFixture.reloadReferences?.layout,
        committed: globalThis.routingPublicFixture.reloadCommittedOutcome,
        finished: globalThis.routingPublicFixture.reloadFinishedOutcome,
        timeline: [...globalThis.routingPublicFixture.reloadTimeline],
        persisted: sessionStorage.getItem("routing-public-reload"),
      }));

      assert.equal(
        new URL(supersededAfterRelease.url).pathname,
        "/target",
        "Releasing the stale guard kept the newer route",
      );

      assert.equal(
        supersededAfterRelease.timeOrigin,
        beforeSupersession.timeOrigin,
        "Releasing the stale guard kept the original document",
      );

      assert.equal(
        supersededAfterRelease.sameDocument,
        true,
        "Releasing the stale guard kept the actual Document object",
      );

      assert.equal(
        supersededAfterRelease.sameHtml,
        true,
        "Releasing the stale guard kept the shell node",
      );

      assert.equal(
        supersededAfterRelease.sameLayout,
        true,
        "Releasing the stale guard kept the layout node",
      );

      assert.equal(
        supersededAfterRelease.committed,
        "AbortError",
        "Committed stayed rejected after the held check settled",
      );

      assert.equal(
        supersededAfterRelease.finished,
        "AbortError",
        "Finished stayed rejected after the held check settled",
      );

      assert.equal(
        supersededAfterRelease.timeline.some((item) => item.startsWith("native:reload:")),
        false,
        "Releasing the stale guard emitted no native reload event",
      );

      assert.equal(
        supersededAfterRelease.timeline.includes("beforeunload"),
        false,
        "Releasing the stale guard caused no document unload",
      );

      assert.equal(
        supersededAfterRelease.persisted,
        null,
        "Releasing the stale guard persisted no unload trace",
      );

      if (browserCoverage)
        await captureCurrentDocument(
          supersessionPage,
          createCaptureContext(engine.name(), browser.version(), "supersession", 0),
        );
    } finally {
      await supersessionPage.close();
    }

    await page.goto(serverUrl);

    await page.locator("#home").waitFor();

    assert.equal(await page.locator("#home").getAttribute("data-bodies"), "1", "Home body count");

    assert.equal(await page.locator("#guard-mounted").count(), 1, "Guard child mounted");

    await page.locator("#home-target").click();

    await page.waitForFunction(() => globalThis.routingPublicFixture.beforeLeaveChecks === 1);

    assert.equal(new URL(page.url()).pathname, "/", "Dirty navigation vetoed");

    assert.equal(await page.locator("#target").count(), 0, "Vetoed target absent");

    assert.equal(
      await page.evaluate(() => globalThis.routingPublicFixture.beforeLeaveChecks),
      1,
      "Veto callback count",
    );

    await page.locator("#allow-leave").click();

    await page.locator("#home-target").click();

    await page.locator("#target").waitFor();

    assert.equal(
      await page.evaluate(() => globalThis.routingPublicFixture.beforeLeaveChecks),
      2,
      "Allowed callback count",
    );

    await page.evaluate(() => history.back());

    await page.locator("#home").waitFor();

    const home = await page.locator("#home").elementHandle();

    if (!home) throw new Error("Cached Home page is missing");

    await page.locator("#remove-guard").click();

    await page.locator("#guard-removed").waitFor();

    await page.locator("#home-target").click();

    await page.locator("#target").waitFor();

    assert.equal(
      await page.evaluate(() => globalThis.routingPublicFixture.beforeLeaveChecks),
      2,
      "Released callback count",
    );

    await page.locator("#target-after").click();

    await page.locator("#after").waitFor();

    await page.locator("#nav-cached").click();

    const initial = await initialRequest;

    await initial.fulfill({ json: { message: "initial" } });

    await page.locator("#cached").waitFor();

    assert.equal(
      await page.locator("#cached-message").textContent(),
      "initial",
      "Initial shared value",
    );

    const cached = await page.locator("#cached").elementHandle();

    if (!cached) throw new Error("Cached page is missing");

    const bodyCount = await page.locator("#cached").getAttribute("data-bodies");

    const cachedEffect = await page.locator("#cached-effect").elementHandle();

    if (!cachedEffect) throw new Error("Cached effect marker is missing");

    assert.equal(await cachedEffect.getAttribute("data-runs"), "1");

    assert.equal(await cachedEffect.getAttribute("data-value"), "initial", "Initial effect value");

    await page.locator("#cached-parking").click();

    await page.locator("#parking").waitFor();

    await page.locator("#update-shared").click();

    await mutationRequest;

    if (!updateRequest) throw new Error("The shared update request was not observed");

    await updateRequest.fulfill({ json: { ok: true } });

    await updatedRequest;

    releaseShared = true;

    for (const request of pendingShared.splice(0))
      await request.fulfill({ json: { message: "updated while parked" } });

    try {
      await page.waitForFunction(
        () => document.querySelector("#shared-shell")?.textContent === "updated while parked",
        null,
        { timeout: 3000 },
      );
    } catch (error) {
      throw new Error(
        "Shared shell did not refresh: text=" +
          (await page.locator("#shared-shell").textContent()) +
          "; requests=" +
          sharedRequests.length +
          "; cached=" +
          (await page.locator("#cached").count()),
        { cause: error },
      );
    }

    await page.waitForFunction(() => globalThis.routingPublicFixture.sharedUpdateDone);

    assert.equal(
      await page.evaluate((node) => node.querySelector("#cached-message")?.textContent, cached),
      "initial",
      "Parked DOM remained unchanged",
    );

    assert.equal(await cachedEffect.getAttribute("data-runs"), "1", "Parked effect did not rerun");

    assert.equal(
      await cachedEffect.getAttribute("data-value"),
      "initial",
      "Parked effect value remained unchanged",
    );

    assert.equal(await cachedEffect.getAttribute("data-cleanups"), "1", "Parked cleanup count");

    await page.evaluate(() => history.back());

    await page.locator("#cached").waitFor();

    assert.equal(
      await page.evaluate((node) => node === document.querySelector("#cached"), cached),
      true,
      "Cached node identity",
    );

    assert.equal(
      await page.locator("#cached").getAttribute("data-bodies"),
      bodyCount,
      "Cached body count",
    );

    assert.equal(
      await page.locator("#cached-message").textContent(),
      "updated while parked",
      "Shared value after restore",
    );

    assert.equal(await cachedEffect.getAttribute("data-runs"), "2", "Restored effect reran");

    assert.equal(
      await cachedEffect.getAttribute("data-value"),
      "updated while parked",
      "Restored effect saw current value",
    );

    assert.equal(
      await cachedEffect.getAttribute("data-cleanups"),
      "1",
      "Restored effect did not duplicate cleanup",
    );

    await page.locator("#nav-blocked").click();

    await page.waitForFunction(() =>
      globalThis.routingPublicFixture.navigationResults.some(
        (result) => result.url.endsWith("/blocked") && result.status === "denied",
      ),
    );

    assert.equal(new URL(page.url()).pathname, "/cached", "False route guard veto");

    assert.equal(await page.locator("#blocked").count(), 0, "Blocked page was not prepared");

    assert.equal(
      await page.evaluate(() => globalThis.routingPublicFixture.blockedBodies),
      0,
      "Blocked page body did not run",
    );

    await page.locator("#nav-redirect").click();

    await page.locator("#after").waitFor();

    await page.waitForFunction(() =>
      globalThis.routingPublicFixture.navigationResults.some(
        (result) => result.url.endsWith("/after") && result.status === "committed",
      ),
    );

    assert.equal(new URL(page.url()).pathname, "/after", "Redirect guard target");

    assert.equal(await page.locator("#redirect").count(), 0, "Redirect page was not prepared");

    assert.equal(
      await page.evaluate(() => globalThis.routingPublicFixture.redirectBodies),
      0,
      "Redirect page body did not run",
    );

    await page.locator("#nav-user").click();

    await page.locator("#user").waitFor();

    assert.equal(new URL(page.url()).pathname, "/users/one", "Parameterized route path");

    assert.equal(await page.locator("#user").getAttribute("data-param"), "one");

    assert.equal(await page.locator("#user").getAttribute("data-tab"), "first");

    const userOne = await page.locator("#user").elementHandle();

    if (!userOne) throw new Error("Parameterized page is missing");

    await page.locator("#user-tab-second").click();

    await page.waitForURL("**/users/one?tab=second");

    await page.waitForFunction(
      () => document.querySelector("#user")?.getAttribute("data-tab") === "second",
    );

    assert.equal(
      await page.evaluate((node) => node === document.querySelector("#user"), userOne),
      true,
      "Anchor query update retained page identity",
    );

    await page.evaluate(() => {
      const fixture =
        /** @type {RoutingPublicFixture & { router: NonNullable<RoutingPublicFixture["router"]> }} */ (
          globalThis.routingPublicFixture
        );

      fixture.router.updateQuery("tab", "third", { history: "push" });
    });

    await page.waitForFunction(
      () => document.querySelector("#user")?.getAttribute("data-tab") === "third",
    );

    assert.equal(new URL(page.url()).pathname, "/users/one", "Query update path");

    assert.equal(new URL(page.url()).search, "?tab=third", "Query update URL");

    assert.equal(
      await page.evaluate((node) => node === document.querySelector("#user"), userOne),
      true,
      "Query update retained page identity",
    );

    await page.locator("#user-two").click();

    await page.waitForURL("**/users/two?tab=third");

    await page.waitForFunction(
      () => document.querySelector("#user")?.getAttribute("data-param") === "two",
    );

    assert.equal(new URL(page.url()).pathname, "/users/two", "Changed parameter path");

    assert.equal(await page.locator("#user").getAttribute("data-param"), "two");

    assert.equal(await page.locator("#user").getAttribute("data-tab"), "third");

    assert.equal(
      await page.evaluate((node) => node !== document.querySelector("#user"), userOne),
      true,
      "Changed parameter remounted page",
    );

    await page.locator("#nav-missing").click();

    await page.locator("#not-found").waitFor();

    assert.equal(new URL(page.url()).pathname, "/missing", "Not-found route path");

    assert.equal(await page.locator("#not-found").textContent(), "Not found");

    assert.equal(await page.locator("#user").count(), 0, "Not-found replaced page");

    const nativeRendering = await page.evaluate(() => globalThis.routingPublicFixture.reloadNative);

    assert.equal(
      nativeRendering,
      engine.name() !== "webkit",
      "Expected native Navigation mode for render-failure proof",
    );

    if (nativeRendering) {
      const renderFailure = await page.evaluate(async () => {
        const fixture = globalThis.routingPublicFixture;

        let nativeEvent = false;

        window.navigation.addEventListener(
          "navigate",
          (event) => {
            nativeEvent =
              event instanceof NavigateEvent &&
              event.navigationType === "push" &&
              event.destination.sameDocument === false &&
              new URL(event.destination.url).pathname === "/broken";
          },
          { once: true },
        );

        const navigation = fixture.navigation.navigate("/broken");

        const finished = navigation.finished.then(
          () => ({ status: "fulfilled", sameError: false }),
          (error) => ({ status: "rejected", sameError: error === fixture.renderFailure }),
        );

        const committed = await navigation.committed;

        const completion = await finished;

        return {
          nativeEvent,
          committedUrl: committed.url,
          currentEntryUrl: /** @type {NonNullable<typeof fixture.navigation.currentEntry>} */ (
            fixture.navigation.currentEntry
          ).url,
          sameEntry:
            /** @type {NonNullable<typeof fixture.navigation.currentEntry>} */ (
              fixture.navigation.currentEntry
            ).key === committed.key,
          finishedStatus: completion.status,
          sameError: completion.sameError,
          boundary: document.querySelector("#render-error")?.textContent,
        };
      });

      assert.equal(
        renderFailure.nativeEvent,
        true,
        "Failing destination used native Navigation interception",
      );

      assert.equal(
        new URL(/** @type {string} */ (renderFailure.committedUrl)).pathname,
        "/broken",
        "Failed rendering retained its committed destination",
      );

      assert.equal(
        renderFailure.currentEntryUrl,
        renderFailure.committedUrl,
        "Rendering failure preserved the committed URL",
      );

      assert.equal(
        renderFailure.sameEntry,
        true,
        "Rendering failure preserved the committed entry",
      );

      assert.equal(
        renderFailure.boundary,
        "Error: native navigation render failed",
        "The route boundary displayed the rendering failure",
      );

      assert.equal(
        renderFailure.finishedStatus,
        "rejected",
        "Native finished rejected despite boundary presentation",
      );

      assert.equal(
        renderFailure.sameError,
        true,
        "Native finished rejected with the original rendering error",
      );
    }

    await page.locator("#nav-home").click();

    await page.locator("#home").waitFor();

    await page.locator("#allow-leave").click();

    await page.locator("#bump-shell-state").click();

    await page.locator("#bump-layout-state").click();

    await page.locator("#bump-page-state").click();

    await page.waitForFunction(() =>
      ["#shell-state", "#layout-state", "#page-state"].every(
        (selector) => document.querySelector(selector)?.textContent === "1",
      ),
    );

    await page.evaluate(() => {
      const fixture = globalThis.routingPublicFixture;

      fixture.reloadReferences = {
        document,
        html: document.documentElement,
        layout: document.querySelector("#route-layout"),
        page: document.querySelector("#home"),
      };
    });

    const beforeReload = await page.evaluate(() => ({
      timeOrigin: performance.timeOrigin,
      url: location.href,
      app: document.documentElement.getAttribute("data-app-instance"),
      layout: document.querySelector("#route-layout")?.getAttribute("data-layout-instance"),
      page: document.querySelector("#home")?.getAttribute("data-home-instance"),
      states: ["#shell-state", "#layout-state", "#page-state"].map(
        (selector) => document.querySelector(selector)?.textContent,
      ),
      native: globalThis.routingPublicFixture.reloadNative,
    }));

    assert.equal(
      beforeReload.native,
      engine.name() !== "webkit",
      "Expected native Navigation mode",
    );

    assert.deepEqual(
      beforeReload.states,
      ["1", "1", "1"],
      "All component state changed before reload",
    );

    await page.evaluate(() => {
      const fixture = globalThis.routingPublicFixture;

      const nativeNavigation = window.navigation;

      nativeNavigation?.addEventListener("navigate", (event) => {
        if (event.navigationType === "reload")
          fixture.reloadTimeline.push(
            "native:reload:" + (event.info == null ? "none" : String(event.info)),
          );
      });

      window.addEventListener("beforeunload", () => {
        fixture.reloadTimeline.push("beforeunload");

        sessionStorage.setItem(
          "routing-public-reload",
          JSON.stringify({
            trace: fixture.reloadTrace,
            timeline: fixture.reloadTimeline,
          }),
        );
      });

      fixture.reloadObserverReady = true;
    });

    await page.waitForFunction(() => globalThis.routingPublicFixture.reloadObserverReady);

    await page.evaluate(() => {
      const fixture = globalThis.routingPublicFixture;

      fixture.reloadEnabled = true;

      fixture.reloadAllowed = false;

      fixture.reloadOutcome = undefined;

      fixture.reloadTrace.length = 0;

      fixture.reloadTimeline.length = 0;

      fixture.startReload?.();
    });

    await page.waitForFunction(() =>
      ["app", "layout", "page"].every((name) =>
        globalThis.routingPublicFixture.reloadTrace.includes(name + ":started"),
      ),
    );

    const deniedWhileHeld = await page.evaluate(() => ({
      timeOrigin: performance.timeOrigin,
      app: document.documentElement.getAttribute("data-app-instance"),
      layout: document.querySelector("#route-layout")?.getAttribute("data-layout-instance"),
      page: document.querySelector("#home")?.getAttribute("data-home-instance"),
      sameDocument: document === globalThis.routingPublicFixture.reloadReferences?.document,
      sameHtml: document.documentElement === globalThis.routingPublicFixture.reloadReferences?.html,
      sameLayout:
        document.querySelector("#route-layout") ===
        globalThis.routingPublicFixture.reloadReferences?.layout,
      samePage:
        document.querySelector("#home") === globalThis.routingPublicFixture.reloadReferences?.page,
      states: ["#shell-state", "#layout-state", "#page-state"].map(
        (selector) => document.querySelector(selector)?.textContent,
      ),
      outcome: globalThis.routingPublicFixture.reloadOutcome,
      trace: [...globalThis.routingPublicFixture.reloadTrace],
      timeline: [...globalThis.routingPublicFixture.reloadTimeline],
    }));

    assert.equal(
      deniedWhileHeld.timeOrigin,
      beforeReload.timeOrigin,
      "Held checks kept the same document",
    );

    assert.equal(deniedWhileHeld.app, beforeReload.app, "Held checks kept the same shell");

    assert.equal(deniedWhileHeld.layout, beforeReload.layout, "Held checks kept the same layout");

    assert.equal(deniedWhileHeld.page, beforeReload.page, "Held checks kept the same page");

    assert.equal(
      deniedWhileHeld.sameDocument,
      true,
      "Held checks retained the actual Document object",
    );

    assert.equal(deniedWhileHeld.sameHtml, true, "Held checks retained the actual shell node");

    assert.equal(deniedWhileHeld.sameLayout, true, "Held checks retained the actual layout node");

    assert.equal(deniedWhileHeld.samePage, true, "Held checks retained the actual page node");

    assert.deepEqual(
      deniedWhileHeld.states,
      ["1", "1", "1"],
      "Held checks retained component state",
    );

    assert.equal(
      deniedWhileHeld.outcome,
      undefined,
      "Reload remains pending while a check is held",
    );

    assert.equal(
      deniedWhileHeld.trace.includes("layout:settled"),
      false,
      "Layout check is still held",
    );

    assert.equal(
      deniedWhileHeld.timeline.some((item) => item.startsWith("native:reload:")),
      false,
      "No reload event while held",
    );

    assert.equal(
      deniedWhileHeld.timeline.includes("beforeunload"),
      false,
      "No document unload while held",
    );

    await page.evaluate(() => globalThis.routingPublicFixture.releaseReload?.());

    await page.waitForFunction(() => globalThis.routingPublicFixture.reloadOutcome === "rejected");

    const denied = await page.evaluate(() => ({
      timeOrigin: performance.timeOrigin,
      url: location.href,
      app: document.documentElement.getAttribute("data-app-instance"),
      layout: document.querySelector("#route-layout")?.getAttribute("data-layout-instance"),
      page: document.querySelector("#home")?.getAttribute("data-home-instance"),
      sameDocument: document === globalThis.routingPublicFixture.reloadReferences?.document,
      sameHtml: document.documentElement === globalThis.routingPublicFixture.reloadReferences?.html,
      sameLayout:
        document.querySelector("#route-layout") ===
        globalThis.routingPublicFixture.reloadReferences?.layout,
      samePage:
        document.querySelector("#home") === globalThis.routingPublicFixture.reloadReferences?.page,
      states: ["#shell-state", "#layout-state", "#page-state"].map(
        (selector) => document.querySelector(selector)?.textContent,
      ),
      trace: [...globalThis.routingPublicFixture.reloadTrace],
      timeline: [...globalThis.routingPublicFixture.reloadTimeline],
    }));

    assert.equal(denied.timeOrigin, beforeReload.timeOrigin, "Veto kept the same document");

    assert.equal(denied.url, beforeReload.url, "Veto kept the current URL");

    assert.equal(denied.app, beforeReload.app, "Veto kept shell identity");

    assert.equal(denied.layout, beforeReload.layout, "Veto kept layout identity");

    assert.equal(denied.page, beforeReload.page, "Veto kept page identity");

    assert.equal(denied.sameDocument, true, "Veto retained the actual Document object");

    assert.equal(denied.sameHtml, true, "Veto retained the actual shell node");

    assert.equal(denied.sameLayout, true, "Veto retained the actual layout node");

    assert.equal(denied.samePage, true, "Veto retained the actual page node");

    assert.deepEqual(denied.states, ["1", "1", "1"], "Veto retained shell, layout and page state");

    assert.equal(
      denied.timeline.some((item) => item.startsWith("native:reload:")),
      false,
      "Veto emitted no reload event",
    );

    assert.equal(
      denied.timeline.includes("beforeunload"),
      false,
      "Veto emitted no document unload",
    );

    assert.deepEqual(
      denied.trace.filter((item) => item.endsWith(":started")).sort(),
      ["app:started", "editor:started", "layout:started", "page:started"],
      "Each application layer checked once",
    );

    assert.deepEqual(
      denied.trace.filter((item) => item.endsWith(":settled")).sort(),
      ["app:settled", "editor:settled", "layout:settled", "page:settled"],
      "Every check settled before veto completed",
    );

    await page.evaluate(() => {
      const fixture = globalThis.routingPublicFixture;

      fixture.reloadAllowed = true;

      fixture.reloadOutcome = undefined;

      fixture.reloadTrace.length = 0;

      fixture.reloadTimeline.length = 0;

      fixture.releaseReload = undefined;

      fixture.startReload?.();
    });

    await page.waitForFunction(() =>
      ["app", "layout", "page"].every((name) =>
        globalThis.routingPublicFixture.reloadTrace.includes(name + ":started"),
      ),
    );

    const allowedWhileHeld = await page.evaluate(() => ({
      timeOrigin: performance.timeOrigin,
      sameDocument: document === globalThis.routingPublicFixture.reloadReferences?.document,
      sameHtml: document.documentElement === globalThis.routingPublicFixture.reloadReferences?.html,
      sameLayout:
        document.querySelector("#route-layout") ===
        globalThis.routingPublicFixture.reloadReferences?.layout,
      samePage:
        document.querySelector("#home") === globalThis.routingPublicFixture.reloadReferences?.page,
      states: ["#shell-state", "#layout-state", "#page-state"].map(
        (selector) => document.querySelector(selector)?.textContent,
      ),
      outcome: globalThis.routingPublicFixture.reloadOutcome,
      timeline: [...globalThis.routingPublicFixture.reloadTimeline],
    }));

    assert.equal(
      allowedWhileHeld.timeOrigin,
      beforeReload.timeOrigin,
      "Allowed checks waited before reload",
    );

    assert.equal(allowedWhileHeld.sameDocument, true, "Allowed checks held the original Document");

    assert.equal(allowedWhileHeld.sameHtml, true, "Allowed checks held the original shell node");

    assert.equal(allowedWhileHeld.sameLayout, true, "Allowed checks held the original layout node");

    assert.equal(allowedWhileHeld.samePage, true, "Allowed checks held the original page node");

    assert.deepEqual(
      allowedWhileHeld.states,
      ["1", "1", "1"],
      "Allowed checks retained component state",
    );

    assert.equal(
      allowedWhileHeld.outcome,
      undefined,
      "Allowed reload remains pending while a check is held",
    );

    assert.equal(
      allowedWhileHeld.timeline.some((item) => item.startsWith("native:reload:")),
      false,
      "No reload before all checks allow",
    );

    assert.equal(
      allowedWhileHeld.timeline.includes("beforeunload"),
      false,
      "No unload before all checks allow",
    );

    const authoredReloadBefore = browserCoverage
      ? await armPagehideCapture(
          page,
          /** @type {string} */ (mainStorageKey),
          createCaptureContext(engine.name(), browser.version(), "main", 0),
        )
      : undefined;

    const reload = page.waitForNavigation({ waitUntil: "domcontentloaded" });

    await page.evaluate(() => globalThis.routingPublicFixture.releaseReload?.());

    await reload;

    await page.locator("#home").waitFor();

    if (browserCoverage) {
      const newDocumentTimeOrigin = await page.evaluate(() => performance.timeOrigin);

      await drainPagehideCapture(
        page,
        /** @type {string} */ (mainStorageKey),
        /** @type {Awaited<ReturnType<typeof armPagehideCapture>>} */ (authoredReloadBefore),
        newDocumentTimeOrigin,
      );
    }

    /** @type {BrowserReloadStateObservation & { native: boolean; persisted: { trace: string[]; timeline: string[] } }} */
    const afterReload = await page.evaluate(() => ({
      timeOrigin: performance.timeOrigin,
      app: document.documentElement.getAttribute("data-app-instance"),
      layout: document.querySelector("#route-layout")?.getAttribute("data-layout-instance"),
      page: document.querySelector("#home")?.getAttribute("data-home-instance"),
      states: ["#shell-state", "#layout-state", "#page-state"].map(
        (selector) => document.querySelector(selector)?.textContent,
      ),
      native: globalThis.routingPublicFixture.reloadNative,
      persisted: JSON.parse(sessionStorage.getItem("routing-public-reload") ?? "null"),
    }));

    assert.ok(afterReload.persisted, "Real reload persisted its departure trace");

    assert.notEqual(
      afterReload.timeOrigin,
      beforeReload.timeOrigin,
      "Allowed reload replaced the document",
    );

    assert.notEqual(afterReload.app, beforeReload.app, "Allowed reload recreated the shell");

    assert.notEqual(afterReload.layout, beforeReload.layout, "Allowed reload recreated the layout");

    assert.notEqual(afterReload.page, beforeReload.page, "Allowed reload recreated the page");

    assert.deepEqual(
      afterReload.states,
      ["0", "0", "0"],
      "New document created fresh shell, layout and page state",
    );

    assert.equal(afterReload.native, beforeReload.native, "Reload mode remained consistent");

    assert.deepEqual(
      afterReload.persisted.trace
        .filter(/** @param {string} item */ (item) => item.endsWith(":settled"))
        .sort(),
      ["app:settled", "editor:settled", "layout:settled", "page:settled"],
    );

    assert.deepEqual(
      afterReload.persisted.trace
        .filter(/** @param {string} item */ (item) => item.endsWith(":started"))
        .sort(),
      ["app:started", "editor:started", "layout:started", "page:started"],
    );

    const unloadIndex = afterReload.persisted.timeline.indexOf("beforeunload");

    assert.notEqual(unloadIndex, -1, "A real document unload was observed");

    for (const name of ["app", "editor", "layout", "page"])
      assert.ok(
        afterReload.persisted.timeline.indexOf(name + ":settled") < unloadIndex,
        name + " departure completed before document unload",
      );

    const authoredReloadEventIndex = afterReload.persisted.timeline.indexOf(
      "native:reload:public-routing-authored-reload",
    );

    if (beforeReload.native)
      assert.notEqual(
        authoredReloadEventIndex,
        -1,
        "Native reload forwarded its authored info token",
      );

    const observedReloadEventIndex = afterReload.persisted.timeline.findIndex(
      /** @param {string} item */ (item) => item.startsWith("native:reload:"),
    );

    if (observedReloadEventIndex !== -1)
      for (const name of ["app", "editor", "layout", "page"])
        assert.ok(
          afterReload.persisted.timeline.indexOf(name + ":settled") < observedReloadEventIndex,
          name + " departure completed before native reload event",
        );

    await page.locator("#guard-mounted").waitFor();

    await page.locator("#bump-shell-state").click();

    await page.locator("#bump-layout-state").click();

    await page.locator("#bump-page-state").click();

    await page.waitForFunction(() =>
      ["#shell-state", "#layout-state", "#page-state"].every(
        (selector) => document.querySelector(selector)?.textContent === "1",
      ),
    );

    await page.evaluate(() => {
      const fixture = globalThis.routingPublicFixture;

      fixture.reloadEnabled = true;

      fixture.reloadAllowed = false;

      fixture.reloadHoldLayout = false;

      fixture.reloadTrace.length = 0;

      fixture.reloadTimeline.length = 0;

      sessionStorage.removeItem("routing-public-reload");

      window.navigation?.addEventListener("navigate", (event) => {
        if (event.navigationType === "reload")
          fixture.reloadTimeline.push(
            "native:reload:" + (event.info == null ? "none" : String(event.info)),
          );
      });

      window.addEventListener("beforeunload", () => {
        fixture.reloadTimeline.push("beforeunload");

        sessionStorage.setItem(
          "routing-public-reload",
          JSON.stringify({
            trace: fixture.reloadTrace,
            timeline: fixture.reloadTimeline,
          }),
        );
      });
    });

    /** @returns {Promise<BrowserReloadStateObservation>} */
    const readBrowserReloadState = () =>
      page.evaluate(() => ({
        timeOrigin: performance.timeOrigin,
        app: document.documentElement.getAttribute("data-app-instance"),
        layout: document.querySelector("#route-layout")?.getAttribute("data-layout-instance"),
        page: document.querySelector("#home")?.getAttribute("data-home-instance"),
        states: ["#shell-state", "#layout-state", "#page-state"].map(
          (selector) => document.querySelector(selector)?.textContent,
        ),
        trace: [...globalThis.routingPublicFixture.reloadTrace],
        timeline: [...globalThis.routingPublicFixture.reloadTimeline],
        persisted: JSON.parse(sessionStorage.getItem("routing-public-reload") ?? "null"),
      }));

    const beforeBrowserReload = await readBrowserReloadState();

    assert.deepEqual(
      beforeBrowserReload.states,
      ["1", "1", "1"],
      "Browser API reload starts with live application state",
    );

    const browserReloadBefore = browserCoverage
      ? await armPagehideCapture(
          page,
          /** @type {string} */ (mainStorageKey),
          createCaptureContext(engine.name(), browser.version(), "main", 1),
        )
      : undefined;

    /** @type {Promise<ReloadAttemptOutcome>} */
    const reloadAttempt = page.waitForNavigation({ waitUntil: "domcontentloaded" }).then(
      () => ({ kind: "navigation-completed" }),
      (error) => ({ kind: "navigation-failed", message: String(error) }),
    );

    /** @type {Promise<ReloadActionOutcome>} */
    const reloadAction = page
      .evaluate(() => {
        /** @param {"committed" | "finished"} promise @param {unknown} error */
        const recordRejection = (promise, error) => {
          globalThis.routingPublicFixture.reloadTimeline.push(
            "browser-api-reload-error:" + promise + ":" + String(error),
          );
        };

        try {
          const result = window.navigation.reload();

          void (
            /** @type {BrowserNavigationReloadResult} */ (result).committed.catch((error) =>
              recordRejection("committed", error),
            )
          );

          void (
            /** @type {BrowserNavigationReloadResult} */ (result).finished.catch((error) =>
              recordRejection("finished", error),
            )
          );

          return /** @type {ReloadActionResult} */ ({ kind: "requested" });
        } catch (error) {
          return /** @type {ReloadActionResult} */ ({ kind: "threw", message: String(error) });
        }
      })
      .then(
        (result) => /** @type {ReloadActionOutcome} */ ({ kind: "action-returned", result }),
        (error) => /** @type {ReloadActionOutcome} */ ({
          kind: "evaluation-rejected",
          message: String(error),
        }),
      );

    /** @type {Promise<ReloadDepartureOutcome>} */
    const departureChecks = page
      .waitForFunction(() => {
        const trace = globalThis.routingPublicFixture?.reloadTrace;

        return trace !== undefined && trace.length > 0;
      })
      .then(
        () => ({ kind: "departures" }),
        () => ({ kind: "document-changed" }),
      );

    /** @type {ReloadSignal} */
    let reloadSignal = await Promise.race([reloadAttempt, departureChecks, reloadAction]);

    let evaluationError;

    if (reloadSignal.kind === "action-returned") {
      if (reloadSignal.result.kind !== "requested") {
        reloadSignal = { kind: "action-failed", message: reloadSignal.result.message };
      } else {
        reloadSignal = await Promise.race([reloadAttempt, departureChecks]);
      }
    } else if (reloadSignal.kind === "evaluation-rejected") {
      evaluationError = reloadSignal.message;

      reloadSignal = await Promise.race([reloadAttempt, departureChecks]);
    }

    if (reloadSignal.kind === "navigation-completed" && evaluationError === undefined) {
      const actionOutcome = await reloadAction;

      if (actionOutcome.kind === "evaluation-rejected") {
        evaluationError = actionOutcome.message;
      } else if (actionOutcome.result.kind !== "requested") {
        reloadSignal = { kind: "action-failed", message: actionOutcome.result.message };
      }
    }

    if (reloadSignal.kind === "navigation-completed" && evaluationError !== undefined) {
      assert.match(
        evaluationError,
        /execution context.*(?:destroyed|replaced)|cannot find context/iu,
        "A rejected browser action evaluation is tolerated only when the real navigation replaced its context. " +
          JSON.stringify({ evaluationError }),
      );
    }

    if (reloadSignal.kind === "navigation-failed") {
      const departureSignal = await departureChecks;

      if (departureSignal.kind === "departures") reloadSignal = departureSignal;
    }

    if (reloadSignal.kind === "departures") {
      /** @type {BrowserReloadStateObservation} */
      const observedDuringDeparture = await readBrowserReloadState().catch(async (error) => {
        try {
          await page.locator("#home").waitFor();

          return await readBrowserReloadState();
        } catch (recoveryError) {
          return {
            captureError: String(recoveryError),
            initialCaptureError: String(error),
          };
        }
      });

      const observedTrace =
        observedDuringDeparture.persisted?.trace ?? observedDuringDeparture.trace ?? [];

      assert.deepEqual(
        {
          trace: observedTrace,
          sameDocument: observedDuringDeparture.timeOrigin === beforeBrowserReload.timeOrigin,
          sameApp: observedDuringDeparture.app === beforeBrowserReload.app,
          sameLayout: observedDuringDeparture.layout === beforeBrowserReload.layout,
          samePage: observedDuringDeparture.page === beforeBrowserReload.page,
          states: observedDuringDeparture.states,
        },
        {
          trace: [],
          sameDocument: false,
          sameApp: false,
          sameLayout: false,
          samePage: false,
          states: ["0", "0", "0"],
        },
        "Browser API reload must not run mounted departure checks or remain in the old document. " +
          JSON.stringify({ before: beforeBrowserReload, observed: observedDuringDeparture }),
      );
    }

    if (reloadSignal.kind !== "navigation-completed") {
      /** @type {BrowserReloadStateObservation} */
      const observedAfterFailure = await readBrowserReloadState().catch(async (error) => {
        try {
          await page.locator("#home").waitFor();

          return await readBrowserReloadState();
        } catch (recoveryError) {
          return {
            captureError: String(recoveryError),
            initialCaptureError: String(error),
          };
        }
      });

      assert.equal(
        reloadSignal.kind,
        "navigation-completed",
        "Browser API reload did not complete a document navigation. " +
          JSON.stringify({
            before: beforeBrowserReload,
            reload: reloadSignal,
            evaluationError,
            observed: observedAfterFailure,
          }),
      );
    }

    await page.locator("#home").waitFor();

    if (browserCoverage) {
      const newDocumentTimeOrigin = await page.evaluate(() => performance.timeOrigin);

      await drainPagehideCapture(
        page,
        /** @type {string} */ (mainStorageKey),
        /** @type {Awaited<ReturnType<typeof armPagehideCapture>>} */ (browserReloadBefore),
        newDocumentTimeOrigin,
      );
    }

    const afterBrowserReload = await readBrowserReloadState();

    assert.ok(afterBrowserReload.persisted, "Browser API reload persisted its unload trace");

    assert.notEqual(
      afterBrowserReload.timeOrigin,
      beforeBrowserReload.timeOrigin,
      "Browser API reload replaced the document",
    );

    assert.notEqual(
      afterBrowserReload.app,
      beforeBrowserReload.app,
      "Browser API reload recreated the shell",
    );

    assert.notEqual(
      afterBrowserReload.layout,
      beforeBrowserReload.layout,
      "Browser API reload recreated the layout",
    );

    assert.notEqual(
      afterBrowserReload.page,
      beforeBrowserReload.page,
      "Browser API reload recreated the page",
    );

    assert.deepEqual(
      afterBrowserReload.states,
      ["0", "0", "0"],
      "Browser API reload reset application state",
    );

    assert.deepEqual(
      afterBrowserReload.persisted.trace,
      [],
      "Browser API reload bypassed all Hesperia departure checks. " +
        JSON.stringify({ before: beforeBrowserReload, current: afterBrowserReload }),
    );

    assert.deepEqual(
      afterBrowserReload.persisted.timeline,
      ["native:reload:none", "beforeunload"],
      "The browser Navigation API emitted its reload event before unloading without Hesperia departure callbacks",
    );

    if (browserCoverage)
      await captureCurrentDocument(
        page,
        createCaptureContext(engine.name(), browser.version(), "main", 2),
      );

    assert.deepEqual(errors, []);

    console.log(
      engine.name() + " public routing flows and authored and browser API reload verified",
    );
  } catch (error) {
    throw new Error(engine.name() + " public routing flow failed", { cause: error });
  } finally {
    await browser.close();
  }
}

if (browserCoverage) {
  const expectedCaptureIds = [];

  for (const engine of ["chromium", "firefox", "webkit"])
    expectedCaptureIds.push(
      engine + ":main:0",
      engine + ":main:1",
      engine + ":main:2",
      engine + ":startup:0",
      engine + ":supersession:0",
    );

  const actualCaptureIds = browserCoverageCaptures.map((capture) => capture.captureId).sort();

  assert.equal(
    new Set(actualCaptureIds).size,
    expectedCaptureIds.length,
    "Browser document coverage capture IDs are duplicated",
  );

  assert.deepEqual(
    actualCaptureIds,
    expectedCaptureIds.sort(),
    "Browser document coverage capture set is incomplete or foreign",
  );

  await writeFile(
    browserCoverage.receiptPath,
    JSON.stringify({
      format: "hesperia-browser-page-coverage-captures",
      version: 1,
      runId: browserCoverage.runId,
      ownerId: browserCoverage.ownerId,
      platform: browserCoverage.platform,
      populationFingerprint: browserCoverage.populationFingerprint,
      builds: browserCoverage.builds,
      captures: browserCoverageCaptures,
    }),
  );
}
