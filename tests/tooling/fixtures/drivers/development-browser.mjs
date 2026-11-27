import { browserLaunchOptions } from "../../../support/browser-launch.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";

const publicationTag =
  /<script type="module" src="[^"]*\/client\.js\?publication=([0-9a-f-]{36})"><\/script>/u;
const documentSampleLimit = 16384;
const timeoutSampleMillis = 750;
const sseArmMillis = 250;

/** @param {string} url @param {AbortSignal} signal */
async function sampleServedPublication(url, signal) {
  try {
    const response = await fetch(url, {
      headers: { accept: "text/html" },
      redirect: "manual",
      signal,
    });
    const status = response.status;
    const contentType = response.headers.get("content-type")?.slice(0, 80) ?? null;

    if (status !== 200 || !contentType?.toLowerCase().startsWith("text/html") || !response.body) {
      void response.body?.cancel().catch(() => {});
      return { status, contentType, state: "document-unavailable" };
    }

    const reader = response.body.getReader();
    const output = new Uint8Array(documentSampleLimit);
    let length = 0;
    let ended = false;

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          ended = true;
          break;
        }

        if (length + value.byteLength > output.byteLength)
          return { status, contentType, state: "body-over-limit" };

        output.set(value, length);
        length += value.byteLength;
      }

      const publication = new TextDecoder()
        .decode(output.subarray(0, length))
        .match(publicationTag)?.[1];

      return {
        status,
        contentType,
        state: publication ? "publication-observed" : "publication-tag-absent",
        publication,
      };
    } finally {
      if (!ended) void reader.cancel().catch(() => {});

      reader.releaseLock();
    }
  } catch (error) {
    return { state: "unavailable", error: String(error).slice(0, 160) };
  }
}

/** @param {Page} page @param {string | undefined} eventsUrl */
async function observePublicationEvents(page, eventsUrl) {
  /** @type {{kind: string, publication: string}[]} */
  const events = [];
  /** @type {Set<string>} */
  const requests = new Set();
  let dropped = 0;
  let status = "attaching";
  let reloadListener = "attaching";
  /** @type {boolean[]} */
  const hardReloadDefaultPrevented = [];
  let hardReloadEventsDropped = 0;

  page.on("console", (message) => {
    const text = message.text();

    if (
      text !== "observer-hard-reload-default true" &&
      text !== "observer-hard-reload-default false"
    )
      return;
    if (hardReloadDefaultPrevented.length === 8) {
      hardReloadEventsDropped++;
      return;
    }

    hardReloadDefaultPrevented.push(text.endsWith(" true"));
  });

  const reloadAttachment = page
    .addInitScript(() => {
      window.addEventListener(
        "hesperia:dev-hard-reload",
        (event) =>
          queueMicrotask(() =>
            console.debug("observer-hard-reload-default", event.defaultPrevented),
          ),
        { capture: true, passive: true },
      );
    })
    .then(
      () => {
        reloadListener = "armed";
      },
      () => {
        reloadListener = "unavailable";
      },
    );

  const attachment = page
    .context()
    .newCDPSession(page)
    .then(async (session) => {
      session.on("Network.requestWillBeSent", (event) => {
        if (event.request.url !== eventsUrl) return;
        if (requests.size === 8 && !requests.has(event.requestId)) {
          dropped++;
          return;
        }

        requests.add(event.requestId);
      });
      session.on("Network.eventSourceMessageReceived", (event) => {
        if (!requests.has(event.requestId)) return;
        if (events.length === 12) {
          dropped++;
          return;
        }

        let kind = "message";

        try {
          const message = JSON.parse(event.data);

          if (message === "reload") kind = "reload";
          else if (message?.type === "current") kind = "current";
          else if (message?.type === "style-revision") kind = "style-revision";
          else if (message?.type === "source-removal") kind = "source-removal";
          else if (typeof message === "string") kind = "diagnostic";
        } catch {}

        events.push({ kind, publication: event.eventId.slice(0, 64) });
      });

      await session.send("Network.enable");
      status = "armed";
    })
    .catch(() => {
      status = "unavailable";
    });

  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const armLimit = new Promise((resolve) => {
    timer = setTimeout(() => resolve(undefined), sseArmMillis);
  });

  try {
    await Promise.race([Promise.all([attachment, reloadAttachment]), armLimit]);
  } finally {
    clearTimeout(timer);
  }

  return () => ({
    status,
    streams: requests.size,
    events: [...events],
    dropped,
    reloadListener,
    hardReloadDefaultPrevented: [...hardReloadDefaultPrevented],
    hardReloadEventsDropped,
  });
}

/** @typedef {import("playwright").Browser} Browser */
/** @typedef {import("playwright").Page} Page */
/** @typedef {import("playwright").Request} Request */

/**
 * @typedef {object} BrowserEntry
 * @property {Browser} browser
 * @property {string} name
 * @property {string[]} errors
 * @property {Page} [page]
 * @property {boolean} [hasNativeRouteInterception]
 * @property {number} [initialTimeOrigin]
 * @property {Promise<Request>} [documentReload]
 * @property {string} [developmentClientUrl]
 * @property {string} [eventStreamUrl]
 */

const [playwrightModuleUrl, applicationUrl, routePath, secondPageSource] = process.argv.slice(2);

const { chromium, firefox, webkit } = /** @type {typeof import("playwright")} */ (
  await import(playwrightModuleUrl)
);

/** @type {BrowserEntry[]} */
const opened = [];
/** @type {Array<() => void>} */
const releaseEventStreams = [];
let eventStreamsReleased = false;

/** @param {string} name */
function markMilestone(name) {
  try {
    writeSync(2, `${name}\n`);
  } catch {
    return;
  }
}

try {
  for (const engine of [chromium, firefox, webkit]) {
    const browser = await engine.launch(browserLaunchOptions(engine.name()));

    /** @type {BrowserEntry} */
    const entry = { browser, name: engine.name(), errors: [] };

    opened.push(entry);

    const page = await browser.newPage();
    entry.page = page;

    let releaseEventStream = () => {};
    const eventStreamGate = new Promise(
      /** @param {(value?: void) => void} resolve */ (resolve) => {
        releaseEventStream = resolve;
      },
    );
    releaseEventStreams.push(releaseEventStream);

    let observeEventStreamHold = () => {};
    const eventStreamHeld = new Promise(
      /** @param {(value?: void) => void} resolve */ (resolve) => {
        observeEventStreamHold = resolve;
      },
    );
    const clientScriptRequest = page.waitForRequest((request) =>
      new URL(request.url()).pathname.endsWith("/client.js"),
    );
    const eventStreamRequest = page.waitForRequest((request) =>
      new URL(request.url()).pathname.endsWith("/events"),
    );

    await page.route("**/events", async (route) => {
      observeEventStreamHold();

      await eventStreamGate;

      await route.continue();
    });

    page.on("pageerror", (error) => entry.errors.push(error.message));

    const warning = page.waitForEvent("console", {
      predicate: (message) => message.type() === "warning" && message.text().includes("unsafeBind"),
    });
    const forwarded = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/_hesperia/warnings" &&
        response.request().method() === "POST" &&
        Boolean(response.request().postData()?.includes("unsafeBind")),
    );

    await page.goto(applicationUrl);

    const [clientRequest, heldEventRequest] = await Promise.all([
      clientScriptRequest,
      eventStreamRequest,
    ]);

    await eventStreamHeld;

    const developmentClientUrl = clientRequest.url();
    const eventStreamUrl = heldEventRequest.url();

    entry.developmentClientUrl = developmentClientUrl;
    entry.eventStreamUrl = eventStreamUrl;

    assert.equal(
      eventStreamUrl,
      new URL("./events", developmentClientUrl).href,
      "Development client used its mounted event URL",
    );

    await page.waitForFunction(() => document.querySelector("#version")?.textContent === "first");

    assert.match((await warning).text(), /unsafeBind/);

    const response = await forwarded;

    assert.equal(response.status(), 204, "Development server accepted the browser warning");

    assert.match(response.request().postData() ?? "", /unsafeBind/);

    await page.locator("#count").click();

    assert.equal(await page.locator("#count").textContent(), "1");

    await page.evaluate(() => {
      globalThis.beforeReloadMarker = true;
    });

    const hasNativeRouteInterception = await page.evaluate(
      () =>
        typeof window.navigation?.reload === "function" &&
        typeof window.NavigateEvent?.prototype?.intercept === "function" &&
        typeof window.NavigationPrecommitController === "function",
    );

    await page.evaluate(() => {
      window.sessionStorage.removeItem("hesperia-dev-reload-ack");

      window.addEventListener(
        "hesperia:dev-hard-reload",
        (event) => {
          window.sessionStorage.setItem("hesperia-dev-reload-ack", String(event.defaultPrevented));
        },
        { once: true },
      );
    });

    entry.hasNativeRouteInterception = hasNativeRouteInterception;
    entry.initialTimeOrigin = await page.evaluate(() => performance.timeOrigin);
  }

  const publicationEntry = opened[0];

  if (!publicationEntry) throw new Error("No browser is available for publication observation");

  const publicationPage = await publicationEntry.browser.newPage();
  const publicationEvents = await observePublicationEvents(
    publicationPage,
    publicationEntry.eventStreamUrl,
  );

  publicationPage.on("pageerror", (error) => publicationEntry.errors.push(error.message));

  const publicationClientRequest = publicationPage.waitForRequest((request) =>
    new URL(request.url()).pathname.endsWith("/client.js"),
  );
  const publicationEventRequest = publicationPage.waitForRequest((request) =>
    new URL(request.url()).pathname.endsWith("/events"),
  );
  const publicationEventResponse = publicationPage.waitForResponse(
    (response) => new URL(response.url()).pathname.endsWith("/events") && response.status() === 200,
  );

  await publicationPage.goto(applicationUrl);

  await publicationPage.waitForFunction(
    () => document.querySelector("#version")?.textContent === "first",
  );

  const [publicationClient, publicationRequest, publicationResponse] = await Promise.all([
    publicationClientRequest,
    publicationEventRequest,
    publicationEventResponse,
  ]);

  assert.equal(
    publicationRequest.url(),
    new URL("./events", publicationClient.url()).href,
    "Publication observer used its mounted event URL",
  );
  const heldEventStreamUrl = publicationEntry.eventStreamUrl;

  if (!heldEventStreamUrl) throw new Error("Browser event stream URL was not captured");

  assert.equal(publicationRequest.url(), heldEventStreamUrl);
  assert.equal(publicationResponse.url(), publicationRequest.url());

  const applicationOrigin = new URL(applicationUrl).origin;
  const clientPath = new URL(publicationClient.url()).pathname;
  const initialPublication = new URL(publicationClient.url()).searchParams
    .get("publication")
    ?.slice(0, 64);

  assert.ok(initialPublication, "Publication observer received the initial revision");

  const initialObserverTimeOrigin = await publicationPage.evaluate(() => performance.timeOrigin);
  const routeDiagnostic =
    "Route module src/routes/nested/+page.tsx must default-export a component";
  const invalidRouteOutcome = Promise.race([
    publicationPage
      .waitForEvent("console", {
        predicate: (message) =>
          message.type() === "error" && message.text().endsWith(routeDiagnostic),
        timeout: 30000,
      })
      .then(() => "rejected"),
    publicationPage
      .waitForEvent("pageerror", {
        predicate: (error) => error.message === routeDiagnostic,
        timeout: 30000,
      })
      .then(() => "published"),
  ]);
  void invalidRouteOutcome.catch(() => {});

  await writeFile(routePath, "");

  const invalidRouteDisposition = await invalidRouteOutcome;
  const afterInvalidRoute = await publicationPage.evaluate(() => ({
    timeOrigin: performance.timeOrigin,
    version: document.querySelector("#version")?.textContent ?? null,
  }));
  const servedDocument = await fetch(applicationUrl, { headers: { accept: "text/html" } });
  assert.equal(servedDocument.status, 200);
  const servedPublication = (await servedDocument.text()).match(publicationTag)?.[1];

  assert.equal(
    invalidRouteDisposition,
    "rejected",
    "The route without a default reached the browser: " +
      JSON.stringify({
        initialPublication,
        initialObserverTimeOrigin,
        servedPublication,
        afterInvalidRoute,
        routeDiagnostic,
      }),
  );
  assert.equal(
    servedPublication,
    initialPublication,
    "A rejected route edit retains the served revision",
  );
  assert.equal(
    afterInvalidRoute.timeOrigin,
    initialObserverTimeOrigin,
    "The browser kept its document",
  );
  assert.equal(afterInvalidRoute.version, "first", "The previous route stayed visible");

  /**
   * @typedef {{
   *   id: number, kind: "document" | "client", path: string, redirectedFrom?: number,
   *   publication?: string, status?: number, contentType?: string,
   *   finished?: boolean, failure?: string
   * }} ReloadRequest
   */
  /** @type {Map<import("playwright").Request, ReloadRequest>} */
  const reloadRequests = new Map();
  /** @type {WeakMap<import("playwright").Request, import("playwright").Response>} */
  const reloadResponses = new WeakMap();
  let reloadRequestsDropped = 0;
  let reservedNavigationSeen = false;
  /** @type {string[]} */
  const pageErrors = [];
  let pageErrorsDropped = 0;
  /** @type {import("playwright").Request | undefined} */
  let selectedNavigation;
  let bodyState = "waiting-for-finish";
  /** @type {string | undefined} */
  let injectedPublication;

  function readFinishedResponse() {
    if (!selectedNavigation || bodyState !== "waiting-for-finish") return;
    if (!reloadRequests.get(selectedNavigation)?.finished) return;
    try {
      const response = reloadResponses.get(selectedNavigation);
      const headers = response?.headers();
      const length = Number(headers?.["content-length"] ?? NaN);
      const encoding = headers?.["content-encoding"]?.toLowerCase();
      if (
        !response ||
        !Number.isSafeInteger(length) ||
        length <= 0 ||
        length > documentSampleLimit ||
        (encoding && encoding !== "identity")
      ) {
        bodyState = "size-or-encoding-unavailable";
        return;
      }
      bodyState = "reading";
      void response
        .body()
        .then((body) => {
          if (body.length > documentSampleLimit) {
            bodyState = "body-over-limit";
            return;
          }
          const tag = body.toString("utf8").match(publicationTag);
          injectedPublication = tag?.[1];
          bodyState = injectedPublication ? "publication-observed" : "publication-tag-absent";
        })
        .catch(() => {
          bodyState = "read-unavailable";
        });
    } catch {
      bodyState = "read-unavailable";
    }
  }

  publicationPage.on("pageerror", (error) => {
    if (pageErrors.length === 8) {
      pageErrorsDropped++;
      return;
    }
    pageErrors.push(error.message.slice(0, 160));
  });
  publicationPage.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== applicationOrigin) return;
    const kind =
      request.isNavigationRequest() && request.resourceType() === "document"
        ? "document"
        : url.pathname === clientPath
          ? "client"
          : undefined;
    if (!kind) return;
    if (kind === "client") {
      try {
        if (request.frame() !== publicationPage.mainFrame()) return;
      } catch {
        return;
      }
    }
    const reservesSlot =
      kind === "document" && url.pathname === "/nested" && !reservedNavigationSeen;
    const limit = reservedNavigationSeen || reservesSlot ? 16 : 15;
    if (reloadRequests.size === limit) {
      reloadRequestsDropped++;
      return;
    }
    if (reservesSlot) reservedNavigationSeen = true;
    const previous = request.redirectedFrom();
    reloadRequests.set(request, {
      id: reloadRequests.size + 1,
      kind,
      path: url.pathname.slice(0, 120),
      redirectedFrom: previous ? reloadRequests.get(previous)?.id : undefined,
      publication:
        kind === "client" ? url.searchParams.get("publication")?.slice(0, 64) : undefined,
    });
  });
  publicationPage.on("response", (response) => {
    const request = response.request();
    const row = reloadRequests.get(request);
    if (!row) return;
    row.status = response.status();
    row.contentType = response.headers()["content-type"]?.slice(0, 80);
    reloadResponses.set(request, response);
  });
  publicationPage.on("requestfinished", (request) => {
    const row = reloadRequests.get(request);
    if (row) row.finished = true;
    if (request === selectedNavigation) readFinishedResponse();
  });
  publicationPage.on("requestfailed", (request) => {
    const row = reloadRequests.get(request);
    if (row) row.failure = request.failure()?.errorText.slice(0, 120);
  });

  const publicationDocumentReload = publicationPage.waitForRequest(
    (request) =>
      request.isNavigationRequest() &&
      request.resourceType() === "document" &&
      new URL(request.url()).pathname === "/nested",
    { timeout: 30000 },
  );

  await writeFile(routePath, secondPageSource);

  const publishedDocumentRequest = await publicationDocumentReload.catch(async (error) => {
    if (error instanceof Error && error.name === "TimeoutError") {
      try {
        const navigationAtTimeout = {
          requests: [...reloadRequests.values()].map((row) => ({ ...row })),
          dropped: reloadRequestsDropped,
          pageErrors: [...pageErrors],
          pageErrorsDropped,
          sse: publicationEvents(),
        };
        const signal = AbortSignal.timeout(timeoutSampleMillis);
        const [routeReadback, currentServed] = await Promise.all([
          readFile(routePath, { signal })
            .then((bytes) => ({
              bytes: bytes.length,
              sha256: createHash("sha256").update(bytes).digest("hex"),
              matchesSecond: bytes.equals(Buffer.from(secondPageSource)),
            }))
            .catch((reason) => ({ state: "unavailable", error: String(reason).slice(0, 160) })),
          sampleServedPublication(applicationUrl, signal),
        ]);

        markMilestone(
          "observer-reload-request-timeout " +
            JSON.stringify({
              initialPublication,
              lastGoodPublication: servedPublication,
              routeReadback,
              navigationAtTimeout,
              currentServedAfterTimeout: currentServed,
            }),
        );
      } catch (failure) {
        markMilestone("observer-reload-request-probe-unavailable " + String(failure).slice(0, 160));
      }
    }

    throw error;
  });

  assert.equal(publishedDocumentRequest.isNavigationRequest(), true);

  selectedNavigation = publishedDocumentRequest;
  readFinishedResponse();
  try {
    await publicationPage.waitForFunction(
      () => document.querySelector("#version")?.textContent === "second",
    );
  } catch (error) {
    try {
      const selected = reloadRequests.get(publishedDocumentRequest);
      markMilestone(
        "observer-reload-response " +
          JSON.stringify({
            initialPublication,
            selected: selected?.id ?? null,
            dropped: reloadRequestsDropped,
            requests: [...reloadRequests.values()],
            pageErrors,
            pageErrorsDropped,
            bodyState,
            injectedPublication,
          }),
      );
      void publicationPage
        .evaluate(() => ({
          path: location.pathname.slice(0, 120),
          readyState: document.readyState,
          version: document.querySelector("#version")?.textContent?.slice(0, 64) ?? null,
        }))
        .then((value) => {
          markMilestone("observer-reload-dom-after-rejection " + JSON.stringify(value));
        })
        .catch(() => {});
    } catch {}
    throw error;
  }

  markMilestone("observer-second");

  for (const entry of /** @type {Required<BrowserEntry>[]} */ (opened)) {
    entry.documentReload = entry.page.waitForRequest(
      (request) =>
        request.isNavigationRequest() &&
        request.resourceType() === "document" &&
        new URL(request.url()).pathname === "/nested",
      { timeout: 30000 },
    );
    void entry.documentReload.catch(() => {});
  }

  markMilestone("waits-armed");

  for (const releaseEventStream of releaseEventStreams) releaseEventStream();
  eventStreamsReleased = true;

  markMilestone("gate-release");

  for (const entry of /** @type {Required<BrowserEntry>[]} */ (opened)) {
    const documentRequest = await entry.documentReload;

    await entry.page.waitForFunction(
      () => document.querySelector("#version")?.textContent === "second",
      null,
      { timeout: 30000 },
    );

    assert.equal(documentRequest.isNavigationRequest(), true, "Reload issued a navigation request");

    assert.equal(documentRequest.resourceType(), "document", "Reload requested a document");

    assert.equal(
      new URL(documentRequest.url()).pathname,
      "/nested",
      "Document request retained the deep URL",
    );

    assert.notEqual(
      await entry.page.evaluate(() => performance.timeOrigin),
      entry.initialTimeOrigin,
      "Reload created a new document performance context",
    );

    assert.equal(
      await entry.page.locator("#count").textContent(),
      "0",
      "Reload created fresh component state",
    );

    assert.equal(
      await entry.page.evaluate(() => globalThis.beforeReloadMarker),
      undefined,
      "Reload created a new document environment",
    );

    assert.equal(new URL(entry.page.url()).pathname, "/nested", "Reload retained the deep URL");

    assert.equal(
      await entry.page.evaluate(() => sessionStorage.getItem("hesperia-dev-reload-ack")),
      String(entry.hasNativeRouteInterception),
      "The dev runtime acknowledged hard reload only when its native route bridge was available",
    );

    if (entry.name === "chromium")
      assert.equal(entry.hasNativeRouteInterception, true, "Chromium exercises the runtime bridge");

    assert.deepEqual(entry.errors, []);

    console.log(entry.name + " development warning and reload verified");
  }
} finally {
  if (!eventStreamsReleased) {
    for (const releaseEventStream of releaseEventStreams) releaseEventStream();

    markMilestone("cleanup-gate-release");
  }

  await Promise.all(opened.map((entry) => entry.browser.close()));
}
