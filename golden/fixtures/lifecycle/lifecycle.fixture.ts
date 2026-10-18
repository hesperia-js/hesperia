import { mount } from "hesperia";
import Lifecycle, { bindingState, lifecycleEvents } from "./Lifecycle.tsx";
import QueryProbe from "./Query.tsx";
import StreamProbe from "./Stream.tsx";
import {
  disposeGraph,
  queryCleanupCount,
  queryRequestCount,
  rejectQuery,
  resolveQuery,
  streamStats,
  waitForQueryCleanups,
  waitForQueryRequests,
  waitForStreamStats,
} from "./api.ts";

const host = document.getElementById("app");

if (!(host instanceof HTMLElement)) throw new Error("Golden application host is missing");

const mode = new URLSearchParams(location.search).get("mode") ?? "lifecycle";
const faults: string[] = [];
const faultWaiters: Array<{ count: number; resolve: (values: readonly string[]) => void }> = [];

const onError = (error: unknown): void => {
  faults.push(error instanceof Error ? error.message : String(error));

  for (let index = faultWaiters.length - 1; index >= 0; index--) {
    const waiter = faultWaiters[index]!;

    if (faults.length < waiter.count) continue;

    faultWaiters.splice(index, 1);

    waiter.resolve([...faults]);
  }
};

const application =
  mode === "stream"
    ? mount(host, StreamProbe, {}, { onError })
    : mode === "query-success" || mode === "query-failure"
      ? mount(host, QueryProbe, { queryKey: mode }, { onError })
      : mount(host, Lifecycle, {}, { onError });

Object.assign(globalThis, {
  hesperiaLifecycle: {
    lifecycleEvents,
    bindingState,
    streamStats,
    queryRequestCount,
    queryCleanupCount,
    waitForStreamStats,
    waitForQueryCleanups,
    waitForQueryRequests,
    resolveQuery,
    rejectQuery,
    errors: () => [...faults],

    waitForErrors(count: number): Promise<readonly string[]> {
      if (faults.length >= count) return Promise.resolve([...faults]);

      return new Promise((resolve) => faultWaiters.push({ count, resolve }));
    },

    settled: () => application.settled(),

    dispose() {
      application.dispose();

      disposeGraph();
    },
  },
});

if (mode === "query-success" || mode === "query-failure") {
  document.documentElement.dataset.ready = "true";
} else {
  await application.settled();

  document.documentElement.dataset.ready = "true";
}
