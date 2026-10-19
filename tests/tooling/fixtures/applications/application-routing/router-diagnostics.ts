import { Router } from "hesperia/routing";

type DiagnosticsWindow = Window & {
  __hesperiaRoutingDiagnostics?: {
    record(kind: string, detail: unknown): void;
  };
};

const instances = new WeakMap<Router, number>();
let nextInstance = 0;
let nextIntent = 0;
let remaining = 200;

function record(router: Router, kind: string, detail: Record<string, unknown>): void {
  try {
    if (remaining === 0) return;

    remaining--;
    const state = router.state;

    (window as DiagnosticsWindow).__hesperiaRoutingDiagnostics?.record(kind, {
      ...detail,
      instance: instances.get(router),
      routerUrl: router.url,
      routerState:
        state === null || typeof state !== "object"
          ? state
          : { type: typeof state, keys: Object.keys(state).slice(0, 12) },
      remaining,
    });

    if (remaining === 0)
      (window as DiagnosticsWindow).__hesperiaRoutingDiagnostics?.record("router-capture-limit", {
        limit: 200,
      });
  } catch {}
}

function attach(router: Router): void {
  if (instances.has(router)) return;

  instances.set(router, ++nextInstance);

  try {
    router.observeHistory({
      entryCommitted: (entry, disposition) =>
        record(router, "router-entry-committed", {
          target: entry.url,
          key: entry.key,
          disposition,
        }),
      traversalAccepted: (entry) =>
        record(router, "router-traversal-accepted", { target: entry.url, key: entry.key }),
      traversalCommitted: (entry) =>
        record(router, "router-traversal-committed", { target: entry.url, key: entry.key }),
      traversalRejected: (entry, error) =>
        record(router, "router-traversal-rejected", {
          target: entry?.url,
          error: String(error),
        }),
    });
  } catch (error) {
    record(router, "router-observer-error", { error: String(error) });
  }
}

function observe<T extends { status: string; url: string }>(
  router: Router,
  method: string,
  intent: number,
  result: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const aborted = () => {
    record(router, "router-abort", { method, intent, reason: String(signal?.reason) });
  };

  try {
    signal?.addEventListener("abort", aborted, { once: true });

    void result
      .then(
        (outcome) => {
          signal?.removeEventListener("abort", aborted);

          record(router, "router-result", {
            method,
            intent,
            status: outcome.status,
            target: outcome.url,
            aborted: signal?.aborted,
          });
        },
        (error: unknown) => {
          signal?.removeEventListener("abort", aborted);

          record(router, "router-reject", {
            method,
            intent,
            error: String(error),
            aborted: signal?.aborted,
          });
        },
      )
      .catch(() => {});
  } catch (error) {
    record(router, "router-observer-error", { method, intent, error: String(error) });
  }

  return result;
}

const navigate = Router.prototype.navigate;

Router.prototype.navigate = function (this: Router, ...args: Parameters<Router["navigate"]>) {
  attach(this);

  const intent = ++nextIntent;

  record(this, "router-entry", {
    method: "navigate",
    intent,
    target: String(args[0]),
    history: args[1].history,
  });

  try {
    const result: ReturnType<Router["navigate"]> = Reflect.apply(navigate, this, args);

    return observe(this, "navigate", intent, result);
  } catch (error) {
    record(this, "router-throw", { method: "navigate", intent, error: String(error) });

    throw error;
  }
};

const handleNavigationEvent = Router.prototype.handleNavigationEvent;

Router.prototype.handleNavigationEvent = function (
  this: Router,
  ...args: Parameters<Router["handleNavigationEvent"]>
) {
  attach(this);

  const intent = ++nextIntent;
  const event = args[0];

  record(this, "router-entry", {
    method: "handleNavigationEvent",
    intent,
    target: event.destination.url,
    navigationType: event.navigationType,
    aborted: event.signal.aborted,
  });

  try {
    const result: ReturnType<Router["handleNavigationEvent"]> = Reflect.apply(
      handleNavigationEvent,
      this,
      args,
    );

    return observe(this, "handleNavigationEvent", intent, result, event.signal);
  } catch (error) {
    record(this, "router-throw", {
      method: "handleNavigationEvent",
      intent,
      error: String(error),
    });

    throw error;
  }
};
