import { mount } from "hesperia";
import * as client from "hesperia/client";
import { debounce, throttle } from "hesperia/scheduling";
import type { ThrottledFunction } from "hesperia/scheduling";

const callbackEvents: string[] = [];
const lifetimeResults: Record<string, unknown> = {};
const cleanupTimers: Array<() => void> = [];
let releaseActive: (() => void) | undefined;

function output(id: string): HTMLOutputElement {
  const element = document.createElement("output");
  element.id = id;

  document.body.append(element);

  return element;
}

const eventsOutput = output("callback-events");
const lifetimeOutput = output("lifetime-results");
const controlsOutput = output("lifetime-controls");
const throttleOutput = output("throttle-outcomes");
const throttleStateOutput = output("throttle-state");
const abortObservationOutput = output("abort-observation");

function record(event: string): void {
  callbackEvents.push(event);

  eventsOutput.textContent = JSON.stringify(callbackEvents);
}

function describeOutcome(result: PromiseSettledResult<unknown>): unknown {
  if (result.status === "fulfilled") return { status: "fulfilled", value: result.value };

  const error = result.reason as Error & { readonly code?: string; readonly cause?: unknown };

  return {
    status: "rejected",
    name: error.name,
    code: error.code,
    cause: error.cause,
  };
}

function retainLifetimeOutcome(name: string, promise: Promise<unknown>): void {
  void Promise.allSettled([promise]).then(([result]) => {
    if (result === undefined) throw new Error("Missing scheduling outcome");

    lifetimeResults[name] = describeOutcome(result);
    lifetimeOutput.textContent = JSON.stringify(lifetimeResults);
  });
}

function runThrottle(): void {
  const lifetime = new AbortController();

  lifetime.signal.addEventListener("abort", (event) => {
    record("original-signal-aborted");

    event.stopImmediatePropagation();
  });

  const run: ThrottledFunction<(value: number) => number> = throttle(
    (value: number) => {
      record(`throttle-start:${value}`);

      if (value === 2) {
        lifetime.abort("first queued callback aborted");

        abortObservationOutput.textContent = String(run.pendingCount);
      }

      return value * 2;
    },
    2,
    1_000,
    { signal: lifetime.signal },
  );

  cleanupTimers.push(() => run.cancel());

  const calls = [run(0), run(1), run(2), run(3), run(4)];

  throttleStateOutput.textContent = JSON.stringify({
    anySupported: typeof AbortSignal.any === "function",
    activeCount: run.activeCount,
    pendingCount: run.pendingCount,
  });

  void Promise.allSettled(calls).then(async (results) => {
    const future = await Promise.allSettled([run(5)]);

    throttleOutput.textContent = JSON.stringify({
      calls: results.map(describeOutcome),
      future: future.map(describeOutcome),
      activeCount: run.activeCount,
      pendingCount: run.pendingCount,
    });
  });
}

function Scheduling() {
  const lifetime = new AbortController();

  client.cleanup(() => {
    record("component-cleanup");

    lifetime.abort("component removed");
  });

  const owned = debounce(
    () => {
      record("owned-start");

      return "owned-result";
    },
    1_000,
    { signal: lifetime.signal },
  );

  const unbound = debounce(() => {
    record("unbound-start");

    return "unbound-result";
  }, 1_000);

  const active = debounce(
    () => {
      record("active-start");

      return new Promise<string>((resolve) => {
        releaseActive = () => resolve("active-result");
      });
    },
    1_000,
    { leading: true, signal: lifetime.signal },
  );

  cleanupTimers.push(
    () => owned.cancel(),
    () => unbound.cancel(),
    () => active.cancel(),
  );

  const queueLifetimes = () => {
    retainLifetimeOutcome("owned", owned());
    retainLifetimeOutcome("unbound", unbound());
    retainLifetimeOutcome("active", active());

    const pending = unbound.pending;
    const sameWrapper = unbound.unref().ref() === unbound;

    controlsOutput.textContent = JSON.stringify({
      sameWrapper,
      samePending: pending === unbound.pending,
      pendingCount: unbound.pendingCount,
    });
  };

  return (
    <main>
      <button id="queue-lifetimes" type="button" on:click={queueLifetimes}>
        Queue lifetime callbacks
      </button>
      <button id="queue-throttle" type="button" on:click={runThrottle}>
        Queue throttled callbacks
      </button>
    </main>
  );
}

const application = mount(
  document.getElementById("app")!,
  Scheduling,
  {},
  {
    onError(error) {
      document.documentElement.dataset.fault = String(error);
    },
  },
);

const remove = document.createElement("button");
remove.id = "remove-scheduling";
remove.textContent = "Remove scheduling component";

remove.addEventListener("click", () => {
  application.dispose();

  document.documentElement.dataset.disposed = "true";
});

const release = document.createElement("button");
release.id = "release-active";
release.textContent = "Release active callback";

release.addEventListener("click", () => releaseActive?.());

document.body.append(remove, release);

addEventListener(
  "pagehide",
  () => {
    application.dispose();

    for (const cancel of cleanupTimers) cancel();

    releaseActive?.();
  },
  { once: true },
);

await application.settled();

document.documentElement.dataset.fixture = "scheduling";
document.documentElement.dataset.ready = "true";
