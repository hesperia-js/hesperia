import { installHistoryTracking } from "../../packages/hesperia/src/routing/history.ts";

const tracker = installHistoryTracking(window);
const popstateStates: unknown[] = [];

window.addEventListener("popstate", (event) => {
  popstateStates.push((event as PopStateEvent).state);
});

Object.assign(window, {
  historyStateFixture: {
    ready: true,
    popstateStates,

    dispose() {
      tracker.release();
    },
  },
});
