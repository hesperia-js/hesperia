import { performance as nodePerformance } from "node:perf_hooks";

/** @typedef {import("playwright").Page} Page */
/** @typedef {{mark(step: string, detail?: unknown): void}} Diagnostics */

/**
 * Keep browser-native document phases separate from driver receipt times.
 * Setup and delivery failures remain diagnostic data, without changing test deadlines.
 * @param {Page} page
 * @param {Diagnostics} diagnostics
 * @param {string} targetURL Exact document request URL, before any History API changes.
 * @returns {Promise<() => void>} Stop receiving observations for this page.
 */
export async function installDocumentNavigationDiagnostics(page, diagnostics, targetURL) {
  const prefix = "[hesperia-document-navigation]";
  let delivered = 0;
  let captureErrorRecorded = false;
  let payloadLimitRecorded = false;

  /** @param {string} kind @param {unknown} detail */
  const record = (kind, detail) => {
    try {
      diagnostics.mark(kind, detail);
    } catch {}
  };

  /** @param {import("playwright").ConsoleMessage} message */
  const onConsole = (message) => {
    const text = message.text();

    if (!text.startsWith(prefix) || delivered > 12) return;

    if (text.length > 16000) {
      if (!payloadLimitRecorded)
        record("document-navigation-payload-limit", { targetURL, payloadCharacters: text.length });

      payloadLimitRecorded = true;

      return;
    }

    try {
      const event = JSON.parse(text.slice(prefix.length));

      if (
        event.targetURL === targetURL &&
        event.phase === "capture-error" &&
        (event.targetMatched === true || event.documentURL === targetURL)
      ) {
        if (!captureErrorRecorded) record("document-navigation-browser-capture-error", event);

        captureErrorRecorded = true;

        return;
      }

      if (
        event.targetURL !== targetURL ||
        (event.navigation !== null && event.navigation?.name !== targetURL) ||
        (event.navigation === null && event.documentURL !== targetURL)
      )
        return;

      if (delivered++ === 12) {
        record("document-navigation-limit", { targetURL, eventLimit: 12 });

        return;
      }

      record("document-navigation-timing", {
        receivedAtTimeOriginMs: nodePerformance.timeOrigin,
        receivedAtMonotonicMs: nodePerformance.now(),
        browser: event,
      });
    } catch (error) {
      if (!captureErrorRecorded)
        record("document-navigation-capture-error", {
          targetURL,
          error: String(error).slice(0, 300),
        });

      captureErrorRecorded = true;
    }
  };

  page.on("console", onConsole);

  try {
    await page.addInitScript(
      ({ targetURL, prefix }) => {
        if (window !== window.top) return;
        let captureErrorSent = false;

        /** @param {string} phase */
        const emit = (phase) => {
          let targetMatched = false;

          try {
            const navigation = /** @type {PerformanceNavigationTiming | undefined} */ (
              performance.getEntriesByType("navigation")[0]
            );

            if (navigation ? navigation.name !== targetURL : location.href !== targetURL) return;

            targetMatched = true;

            console.debug(
              prefix +
                JSON.stringify({
                  targetURL,
                  phase,
                  documentURL: location.href.slice(0, 8000),
                  timeOriginMs: performance.timeOrigin,
                  monotonicMs: performance.now(),
                  navigation: navigation
                    ? {
                        name: navigation.name.slice(0, 8000),
                        type: navigation.type,
                        startTime: navigation.startTime,
                        responseStart: navigation.responseStart,
                        responseEnd: navigation.responseEnd,
                        encodedBodySize: navigation.encodedBodySize,
                        decodedBodySize: navigation.decodedBodySize,
                        transferSize: navigation.transferSize,
                        domInteractive: navigation.domInteractive,
                        domContentLoadedEventStart: navigation.domContentLoadedEventStart,
                        domContentLoadedEventEnd: navigation.domContentLoadedEventEnd,
                        loadEventStart: navigation.loadEventStart,
                        loadEventEnd: navigation.loadEventEnd,
                      }
                    : null,
                }),
            );
          } catch (error) {
            if (captureErrorSent) return;

            captureErrorSent = true;

            try {
              console.debug(
                prefix +
                  JSON.stringify({
                    targetURL,
                    phase: "capture-error",
                    targetMatched,
                    documentURL: location.href.slice(0, 8000),
                    error: String(error).slice(0, 300),
                  }),
              );
            } catch {}
          }
        };

        addEventListener("DOMContentLoaded", () => emit("domcontentloaded"), { once: true });

        addEventListener("load", () => emit("load"), { once: true });

        emit("init");
      },
      { targetURL, prefix },
    );

    record("document-navigation-installed", { targetURL, eventLimit: 12 });
  } catch (error) {
    record("document-navigation-setup-error", { targetURL, error: String(error).slice(0, 300) });
  }

  return () => page.off("console", onConsole);
}
