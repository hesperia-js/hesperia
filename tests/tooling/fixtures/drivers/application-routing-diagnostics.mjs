/** @typedef {import("playwright").Page} Page */
/** @typedef {{mark(kind: string, detail?: unknown): void}} Diagnostics */

/** Install bounded browser observations without changing navigation or action deadlines.
 * @param {Page} page
 * @param {Diagnostics} diagnostics
 */
export async function installApplicationRoutingDiagnostics(page, diagnostics) {
  try {
    await page.exposeBinding("__hesperiaRoutingDiagnosticsPush", (_source, event) => {
      try {
        diagnostics.mark("routing-diagnostics", event);
      } catch {}
    });

    await page.addInitScript(() => {
      /** @typedef {{record(kind: string, detail?: unknown): void, events: unknown[], dropped: number, captureErrors: number}} Recorder */
      /** @typedef {{url?: string, key?: string, index?: number}} Entry */
      /** @typedef {{navigationType?: string, from?: Entry, finished: Promise<unknown>}} Transition */
      /** @typedef {EventTarget & {currentEntry?: Entry, transition?: Transition | null}} NavigationSource */
      /** @typedef {Event & {destination?: Entry, navigationType?: string, canIntercept?: boolean, hashChange?: boolean, signal?: AbortSignal, error?: unknown, message?: string, from?: Entry}} NavigationEvent */
      const scope =
        /** @type {Window & typeof globalThis & {__hesperiaRoutingDiagnostics?: Recorder, __hesperiaRoutingDiagnosticsPush?: (value: unknown) => Promise<unknown>, navigation?: NavigationSource}} */ (
          window
        );

      try {
        const events = /** @type {unknown[]} */ ([]);
        let sequence = 0;
        let reportedDrop = false;
        let reportedCaptureError = false;
        let delivered = 0;

        /** @param {unknown} value */
        const text = (value) => String(value ?? "").slice(0, 300);

        /** @param {unknown} value @param {number} [depth] @returns {unknown} */
        const bounded = (value, depth = 0) => {
          if (typeof value === "string") return value.slice(0, 300);

          if (value == null || typeof value === "number" || typeof value === "boolean")
            return value;

          if (depth >= 4) return text(value);

          if (Array.isArray(value))
            return value.slice(0, 16).map((item) => bounded(item, depth + 1));

          if (typeof value === "object")
            return Object.fromEntries(
              Object.entries(value)
                .slice(0, 16)
                .map(([key, item]) => [key.slice(0, 80), bounded(item, depth + 1)]),
            );

          return text(value);
        };

        /** @param {unknown} value */
        const push = (value) => {
          try {
            void scope.__hesperiaRoutingDiagnosticsPush?.(value).catch(() => {});
          } catch {}
        };

        const snapshot = () => ({
          url: text(location.href),
          entry: bounded(
            scope.navigation?.currentEntry
              ? {
                  url: scope.navigation.currentEntry.url,
                  key: scope.navigation.currentEntry.key,
                  index: scope.navigation.currentEntry.index,
                }
              : null,
          ),
          transition: scope.navigation?.transition
            ? {
                navigationType: text(scope.navigation.transition.navigationType),
                from: text(scope.navigation.transition.from?.url),
              }
            : null,
        });

        /** @type {Recorder} */
        const recorder = {
          events,
          dropped: 0,
          captureErrors: 0,
          record(kind, detail) {
            try {
              const event = {
                sequence: ++sequence,
                at: new Date().toISOString(),
                monotonicMs: performance.now(),
                kind: text(kind),
                detail: bounded(detail),
                ...snapshot(),
              };

              if (events.length === 500) {
                events.shift();

                recorder.dropped++;
              }

              events.push(event);

              if (delivered < 500) {
                delivered++;

                push(event);
              } else if (!reportedDrop) {
                reportedDrop = true;

                push({ kind: "capture-limit", eventLimit: 500, dropped: recorder.dropped });
              }
            } catch (error) {
              captureError(error);
            }
          },
        };

        /** @param {unknown} error */
        const captureError = (error) => {
          try {
            recorder.captureErrors++;

            if (reportedCaptureError) return;

            reportedCaptureError = true;

            let message = "Unserializable diagnostic error";

            try {
              message = text(error);
            } catch {}

            push({ kind: "capture-error", error: message });
          } catch {}
        };

        /** @template {unknown[]} Args @param {(...args: Args) => void} callback @returns {(...args: Args) => void} */
        const guarded =
          (callback) =>
          (...args) => {
            try {
              callback(...args);
            } catch (error) {
              captureError(error);
            }
          };

        scope.__hesperiaRoutingDiagnostics = recorder;

        /** @param {unknown} node */
        const element = (node) => {
          if (!(node instanceof Element)) return null;

          const rect = node.getBoundingClientRect();
          return {
            tag: node.tagName,
            id: text(node.id),
            href: text(node.getAttribute("href")),
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          };
        };

        /** @param {MouseEvent} event @param {string} phase */
        const pointer = (event, phase) => {
          const anchor = event.composedPath().find((node) => node instanceof HTMLAnchorElement);
          return {
            phase,
            target: element(event.target),
            anchor: element(anchor),
            resolvedHref: anchor instanceof HTMLAnchorElement ? text(anchor.href) : null,
            defaultPrevented: event.defaultPrevented,
            eventPhase: event.eventPhase,
            button: event.button,
            buttons: event.buttons,
            trusted: event.isTrusted,
            x: event.clientX,
            y: event.clientY,
            alt: event.altKey,
            ctrl: event.ctrlKey,
            meta: event.metaKey,
            shift: event.shiftKey,
            hit: element(document.elementFromPoint(event.clientX, event.clientY)),
          };
        };

        /** @param {string} phase */
        const click = (phase) =>
          guarded(
            /** @param {MouseEvent} event */ (event) => {
              const detail = pointer(event, phase);

              recorder.record("click", detail);

              if (phase === "capture")
                setTimeout(
                  guarded(() =>
                    recorder.record("click-post-dispatch", {
                      ...detail,
                      phase: "task",
                      defaultPrevented: event.defaultPrevented,
                      eventPhase: event.eventPhase,
                    }),
                  ),
                  0,
                );
            },
          );

        document.addEventListener("click", click("capture"), { capture: true, passive: true });

        document.addEventListener("click", click("bubble"), { passive: true });

        for (const kind of ["pointerdown", "pointerup", "mousedown", "mouseup"]) {
          document.addEventListener(
            kind,
            guarded((event) =>
              recorder.record(kind, pointer(/** @type {MouseEvent} */ (event), "capture")),
            ),
            { capture: true, passive: true },
          );
        }

        const observed = new WeakSet();

        const observeTransition = () => {
          const transition = scope.navigation?.transition;

          if (!transition || observed.has(transition)) return;

          observed.add(transition);

          void transition.finished.then(
            guarded(() => recorder.record("transition-finished")),
            guarded((error) => recorder.record("transition-rejected", { error: text(error) })),
          );
        };

        for (const kind of ["navigate", "currententrychange", "navigatesuccess", "navigateerror"]) {
          scope.navigation?.addEventListener(
            kind,
            guarded((value) => {
              const event = /** @type {NavigationEvent} */ (value);

              recorder.record(kind, {
                destination: text(event.destination?.url),
                navigationType: event.navigationType,
                canIntercept: event.canIntercept,
                hashChange: event.hashChange,
                defaultPrevented: event.defaultPrevented,
                aborted: event.signal?.aborted,
                error: text(event.error),
                message: text(event.message),
                from: text(event.from?.url),
              });

              event.signal?.addEventListener(
                "abort",
                guarded(() =>
                  recorder.record("navigation-abort", {
                    destination: text(event.destination?.url),
                    reason: text(event.signal?.reason),
                  }),
                ),
                { once: true, passive: true },
              );

              queueMicrotask(
                guarded(() => {
                  recorder.record("navigation-checkpoint", {
                    event: kind,
                    defaultPrevented: event.defaultPrevented,
                    aborted: event.signal?.aborted,
                  });

                  observeTransition();
                }),
              );
            }),
            { passive: true },
          );
        }

        for (const kind of ["hesperia:navigation-error", "hesperia:warning"]) {
          window.addEventListener(
            kind,
            guarded((event) =>
              recorder.record(kind, { detail: bounded(/** @type {CustomEvent} */ (event).detail) }),
            ),
            { passive: true },
          );
        }

        let lastDom = "";

        const dom = () => {
          const nodes = ["root-error", "draft", "loading", "ready"].map((id) => {
            const node = document.getElementById(id);

            if (!node) return { id, present: false };

            const style = getComputedStyle(node);
            return {
              id,
              present: true,
              visible:
                node.getClientRects().length > 0 &&
                style.display !== "none" &&
                style.visibility !== "hidden",
            };
          });
          const signature = JSON.stringify(nodes);

          if (signature !== lastDom) {
            lastDom = signature;

            recorder.record("dom-state", { nodes });
          }
        };

        new MutationObserver(guarded(dom)).observe(document, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ["style", "class", "hidden"],
        });

        document.addEventListener("DOMContentLoaded", guarded(dom), { once: true, passive: true });

        recorder.record("capture-ready", { eventLimit: 500 });
      } catch (error) {
        try {
          void scope
            .__hesperiaRoutingDiagnosticsPush?.({
              kind: "capture-setup-error",
              error: String(error).slice(0, 300),
            })
            .catch(() => {});
        } catch {}
      }
    });
  } catch (error) {
    try {
      diagnostics.mark("routing-diagnostics-setup-error", { error: String(error) });
    } catch {}
  }
}
