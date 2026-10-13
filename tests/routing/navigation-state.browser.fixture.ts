import { installHistoryTracking } from "../../packages/hesperia/src/routing/history.ts";
import { reserveNavigation } from "../../packages/hesperia/src/routing/navigation-api.ts";
import { Router } from "../../packages/hesperia/src/routing/navigation.ts";

const nativeHistoryMethods = {
  pushState: window.history.pushState,
  replaceState: window.history.replaceState,
};
const reservation = reserveNavigation(window);
const tracker = installHistoryTracking(window);

reservation.setHistoryTracker(tracker);

const restoredAtStartup = {
  classic: window.history.state,
  navigation: reservation.facade.currentEntry?.getState(),
};
const popstateStates: unknown[] = [];

window.addEventListener("popstate", (event) => {
  popstateStates.push((event as PopStateEvent).state);
});

const router = new Router({
  window,
  pageCacheSize: 0,

  resolve(url) {
    return {
      params: {},

      prepare() {
        const main = document.createElement("main");
        main.textContent = url.pathname;
        return {
          owners: [],

          install() {
            document.body.replaceChildren(main);
          },

          dispose() {
            main.remove();
          },
        };
      },
    };
  },
});

reservation.attachRouter(router, { settled: () => Promise.resolve() });

await reservation.beginInitialNavigation(
  router.navigate(window.location.pathname, { history: "none", state: null }),
);

router.installHistoryNavigation();

Object.assign(window, {
  navigationStateFixture: {
    ready: true,
    navigation: reservation.facade,
    router,
    restoredAtStartup,
    popstateStates,

    dispose() {
      reservation.release();

      router.dispose();

      tracker.release();
    },

    get historyMethodsRestored() {
      return (
        window.history.pushState === nativeHistoryMethods.pushState &&
        window.history.replaceState === nativeHistoryMethods.replaceState
      );
    },
  },
});
