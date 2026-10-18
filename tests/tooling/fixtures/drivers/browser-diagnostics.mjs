import { createWriteStream, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

/** @typedef {import("playwright").Page} Page */
/** @typedef {import("playwright").Request} Request */
/** @typedef {{name?: string, message: string, stack?: string, cause?: ErrorDetails}} ErrorDetails */

const eventLimit = 800;
const pendingLimit = 400;
const captureTimeout = 4000;

/** @param {unknown} value @returns {ErrorDetails} */
function errorDetails(value, depth = 0) {
  if (!(value instanceof Error)) return { message: String(value) };

  return {
    name: value.name,
    message: value.message,
    stack: value.stack,
    cause:
      depth < 4 && value.cause !== undefined ? errorDetails(value.cause, depth + 1) : undefined,
  };
}

/**
 * @template T
 * @param {() => Promise<T>} operation
 * @param {number} timeout
 * @returns {Promise<{status: "completed", value: T} | {status: "failed" | "timed-out", error: ReturnType<typeof errorDetails>}>}
 */
async function bounded(operation, timeout) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  let timedOut = false;

  try {
    const value = await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;

          reject(new Error(`Diagnostics exceeded ${timeout}ms`));
        }, timeout);
      }),
    ]);

    return { status: "completed", value: /** @type {T} */ (value) };
  } catch (error) {
    return { status: timedOut ? "timed-out" : "failed", error: errorDetails(error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Records browser evidence without changing action or assertion timeouts.
 * Call before navigation. Capture failures are recorded and never replace the test error.
 *
 * @param {Page} page
 * @param {{directory: string, label: string}} options Durable run directory and browser label.
 */
export async function startBrowserDiagnostics(page, { directory, label }) {
  const started = Date.now();
  const startedMonotonic = performance.now();
  const context = page.context();
  const safeLabel = label.replace(/[^a-zA-Z0-9_.-]/g, "_").replace(/^\.+$/, "browser");
  const artifactDirectory = resolve(directory, safeLabel || "browser");
  /** @type {{at: string, monotonicMs: number, elapsedMs: number, pid: number, kind: string, detail: unknown}[]} */
  const timeline = [];
  /** @type {Record<string, number>} */
  const truncated = {};
  /** @type {Map<Request, {id: number, url: string, method: string, resourceType: string, navigation: boolean, elapsedMs: number}>} */
  const pending = new Map();
  /** @type {WeakMap<Request, number>} */
  const requestIds = new WeakMap();
  let nextRequestId = 0;
  let traceStopped = false;
  let disposed = false;
  /** @type {Promise<void> | undefined} */
  let captured;
  /** @type {import("node:fs").WriteStream | undefined} */
  let journal;
  /** @type {ErrorDetails | undefined} */
  let journalError;
  let ownsDirectory = false;
  let journalBytes = 0;
  let journalEntries = 0;

  try {
    mkdirSync(directory, { recursive: true });

    mkdirSync(artifactDirectory);
    ownsDirectory = true;
    journal = createWriteStream(join(artifactDirectory, "progress.jsonl"), { flags: "wx" });

    journal.on("error", (error) => {
      journalError = errorDetails(error);
      journal = undefined;
    });
  } catch (error) {
    journalError = errorDetails(error);
  }

  /** @param {string} kind @param {unknown} [detail] */
  function record(kind, detail) {
    if (timeline.length === eventLimit) {
      const removed = timeline.shift();

      if (removed) truncated[removed.kind] = (truncated[removed.kind] ?? 0) + 1;
    }

    const monotonicMs = performance.now();
    const event = {
      at: new Date().toISOString(),
      monotonicMs,
      elapsedMs: monotonicMs - startedMonotonic,
      pid: process.pid,
      kind,
      detail,
    };

    timeline.push(event);

    if (journal && !truncated.journal) {
      try {
        let line = JSON.stringify(event) + "\n";

        if (++journalEntries > 2000 || journalBytes + Buffer.byteLength(line) > 2_000_000) {
          truncated.journal = 1;
          line =
            JSON.stringify({
              at: event.at,
              monotonicMs: event.monotonicMs,
              elapsedMs: event.elapsedMs,
              pid: process.pid,
              kind: "journal-truncated",
              entryLimit: 2000,
              byteLimit: 2_000_000,
            }) + "\n";
        }

        journalBytes += Buffer.byteLength(line);

        journal.write(line);
      } catch (error) {
        journalError = errorDetails(error);
        journal = undefined;
      }
    }
  }

  /** @param {Request} request */
  function requestInfo(request) {
    let id = requestIds.get(request);

    if (id === undefined) {
      id = ++nextRequestId;

      requestIds.set(request, id);
    }

    return {
      id,
      url: request.url().slice(0, 8000),
      method: request.method(),
      resourceType: request.resourceType(),
      navigation: request.isNavigationRequest(),
      elapsedMs: performance.now() - startedMonotonic,
    };
  }

  /** @param {Request} request */
  function onRequest(request) {
    const detail = requestInfo(request);

    if (pending.size === pendingLimit) {
      const oldest = pending.keys().next().value;

      if (oldest) pending.delete(oldest);

      truncated.pendingRequests = (truncated.pendingRequests ?? 0) + 1;
    }

    pending.set(request, detail);

    record("request", detail);
  }

  /** @param {import("playwright").Response} response */
  function onResponse(response) {
    record("response", {
      ...requestInfo(response.request()),
      status: response.status(),
      statusText: response.statusText(),
      fromServiceWorker: response.fromServiceWorker(),
    });
  }

  /** @param {Request} request */
  function onRequestFailed(request) {
    record("requestfailed", { ...requestInfo(request), failure: request.failure() });

    pending.delete(request);
  }

  /** @param {Request} request */
  function onRequestFinished(request) {
    record("requestfinished", { ...requestInfo(request), timing: request.timing() });

    pending.delete(request);
  }

  /** @param {Error} error */
  function onPageError(error) {
    record("pageerror", errorDetails(error));
  }

  /** @param {import("playwright").ConsoleMessage} message */
  function onConsole(message) {
    if (message.type() !== "error" && message.type() !== "warning") return;

    record("console", {
      type: message.type(),
      text: message.text().slice(0, 16000),
      location: message.location(),
    });
  }

  /** @param {import("playwright").Frame} frame */
  function onFrameNavigated(frame) {
    record("framenavigated", { url: frame.url(), mainFrame: frame === page.mainFrame() });
  }

  const onDomContentLoaded = () => record("domcontentloaded");
  const onLoad = () => record("load");
  const onCrash = () => record("crash");
  const onClose = () => record("close");

  record("diagnostics-start", {
    label,
    startedAt: new Date(started).toISOString(),
    timeOriginMs: performance.timeOrigin,
    url: page.url(),
    browserVersion: context.browser()?.version(),
  });

  page.on("request", onRequest);

  page.on("response", onResponse);

  page.on("requestfailed", onRequestFailed);

  page.on("requestfinished", onRequestFinished);

  page.on("pageerror", onPageError);

  page.on("console", onConsole);

  page.on("framenavigated", onFrameNavigated);

  page.on("domcontentloaded", onDomContentLoaded);

  page.on("load", onLoad);

  page.on("crash", onCrash);

  page.on("close", onClose);

  const traceStartup = await bounded(
    () => context.tracing.start({ screenshots: true, snapshots: true, sources: true }),
    1500,
  );

  record("trace-start", traceStartup);

  /** @param {string} step @param {unknown} [detail] */
  function mark(step, detail) {
    /** @type {unknown} */
    let savedDetail;

    try {
      savedDetail = detail === undefined ? undefined : JSON.parse(JSON.stringify(detail));
    } catch {
      savedDetail = String(detail);
    }

    record("mark", { label: step, detail: savedDetail });
  }

  /** @param {unknown} error */
  async function captureFailure(error) {
    const deadline = Date.now() + captureTimeout;
    /** @type {Record<string, unknown>} */
    const captures = {
      trace: { status: "pending" },
      dom: { status: "pending" },
      screenshot: { status: "pending" },
    };
    const originalError = errorDetails(error);

    record("failure", originalError);

    function saveSummary() {
      writeFileSync(
        join(artifactDirectory, "summary.json"),
        JSON.stringify(
          {
            label,
            startedAt: new Date(started).toISOString(),
            capturedAt: new Date().toISOString(),
            originalError,
            url: page.url(),
            browserVersion: context.browser()?.version(),
            pageClosed: page.isClosed(),
            timeline,
            pendingRequests: [...pending.values()],
            truncated,
            journalError,
            traceStartup,
            captures,
          },
          null,
          2,
        ),
      );
    }

    try {
      mkdirSync(artifactDirectory, { recursive: true });

      // Preserve Node-side evidence before a stalled renderer can delay capture.
      saveSummary();

      /** @param {number} limit */
      const remaining = (limit) => Math.max(1, Math.min(limit, deadline - Date.now()));
      traceStopped = true;
      const trace = bounded(
        () => context.tracing.stop({ path: join(artifactDirectory, "trace.zip") }),
        remaining(3500),
      );
      const dom = bounded(
        () =>
          page.evaluate(() => {
            const globals = /** @type {Record<string, unknown>} */ (
              /** @type {unknown} */ (globalThis)
            );
            const navigation = window.navigation;

            return {
              url: location.href,
              title: document.title,
              readyState: document.readyState,
              outerHTML: document.documentElement?.outerHTML.slice(0, 1_000_000),
              scripts: [...document.scripts].slice(0, 100).map((script) => ({
                src: script.src,
                type: script.type,
                text: script.textContent?.slice(0, 2000),
              })),
              targets: ["#draft", "#root-error", "#loading", "#ready", "button"].map((selector) => {
                const elements = [...document.querySelectorAll(selector)];

                return {
                  selector,
                  count: elements.length,
                  elements: elements.slice(0, 100).map((element) => {
                    const style = getComputedStyle(element);

                    return {
                      id: element.id,
                      text: element.textContent?.slice(0, 8000),
                      disabled: element instanceof HTMLButtonElement ? element.disabled : undefined,
                      rects: [...element.getClientRects()].map((rect) => rect.toJSON()),
                      display: style.display,
                      visibility: style.visibility,
                    };
                  }),
                };
              }),
              routePageLoaded: globals.routePageLoaded,
              history: { length: history.length, state: history.state },
              navigationPrecommitController: typeof globals.NavigationPrecommitController,
              navigation: navigation
                ? {
                    canGoBack: navigation.canGoBack,
                    canGoForward: navigation.canGoForward,
                    transition: navigation.transition
                      ? {
                          navigationType: navigation.transition.navigationType,
                          from: {
                            url: navigation.transition.from.url,
                            key: navigation.transition.from.key,
                            index: navigation.transition.from.index,
                          },
                        }
                      : null,
                    currentEntry: navigation.currentEntry
                      ? {
                          url: navigation.currentEntry.url,
                          key: navigation.currentEntry.key,
                          index: navigation.currentEntry.index,
                          state: navigation.currentEntry.getState(),
                        }
                      : null,
                  }
                : null,
            };
          }),
        remaining(2000),
      );
      const screenshot = bounded(
        () =>
          page.screenshot({
            path: join(artifactDirectory, "screenshot.png"),
            timeout: remaining(2000),
          }),
        remaining(2200),
      );
      const [traceResult, domResult, screenshotResult] = await Promise.all([
        trace,
        dom,
        screenshot,
      ]);
      captures.trace = traceResult;
      captures.screenshot =
        screenshotResult.status === "completed" ? { status: "completed" } : screenshotResult;
      captures.dom = domResult.status === "completed" ? { status: "completed" } : domResult;

      if (domResult.status === "completed") {
        try {
          writeFileSync(
            join(artifactDirectory, "dom.json"),
            JSON.stringify(domResult.value, null, 2),
          );
        } catch (domError) {
          captures.dom = { status: "failed", error: errorDetails(domError) };
        }
      }

      saveSummary();

      console.error(`[browser diagnostics] ${label}: ${artifactDirectory}`);
    } catch (captureError) {
      console.error(`[browser diagnostics] ${label}: ${String(captureError)}`);
    }
  }

  /** @param {unknown} error */
  async function capture(error) {
    captured ??= captureFailure(error);

    await captured;
  }

  async function dispose() {
    if (disposed) return;

    disposed = true;

    page.off("request", onRequest);

    page.off("response", onResponse);

    page.off("requestfailed", onRequestFailed);

    page.off("requestfinished", onRequestFinished);

    page.off("pageerror", onPageError);

    page.off("console", onConsole);

    page.off("framenavigated", onFrameNavigated);

    page.off("domcontentloaded", onDomContentLoaded);

    page.off("load", onLoad);

    page.off("crash", onCrash);

    page.off("close", onClose);

    if (!traceStopped) {
      traceStopped = true;

      await bounded(() => context.tracing.stop(), 1500);
    }

    const stream = journal;

    if (stream && !stream.closed) {
      await bounded(
        () =>
          new Promise((resolve) => {
            stream.once("close", () => resolve(undefined));

            stream.end();
          }),
        1000,
      );

      stream.destroy();
    }

    if (!captured && ownsDirectory && dirname(artifactDirectory) === resolve(directory)) {
      try {
        rmSync(artifactDirectory, { recursive: true, force: true });
      } catch (error) {
        console.error(`[browser diagnostics] ${label} cleanup: ${String(error)}`);
      }
    }
  }

  return { mark, capture, dispose };
}
