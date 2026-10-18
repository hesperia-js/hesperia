import { Router } from "hesperia/routing";
import type { Component } from "hesperia";
import { createRuntimeRoot } from "../../../packages/hesperia/dist/runtime/dom.js";
import {
  createRouteHost,
  type RouteHostModule,
} from "../../../packages/hesperia/dist/routing/route-host.js";
import { CachedEventPage, OtherEventPage, eventCacheCalls } from "../EventCache.tsx";

const target = document.getElementById("app")!;
const errors: string[] = [];
const runtime = createRuntimeRoot(target, {
  onError: (error) => errors.push(error instanceof Error ? error.message : String(error)),
});
const host = createRouteHost(runtime, target);

runtime.owner.commit();

const first: RouteHostModule = { node: {}, definition: CachedEventPage as Component<unknown> };
const second: RouteHostModule = { node: {}, definition: OtherEventPage as Component<unknown> };
let cachedOnceA: HTMLButtonElement | undefined;
let cachedRegular: HTMLButtonElement | undefined;

const router = new Router({
  window,
  pageCacheSize: 2,
  onError: (error) => errors.push(error instanceof Error ? error.message : String(error)),

  resolve(url) {
    const page = url.pathname === "/events/two" ? second : first;
    return {
      params: {},
      departingOwners: host.departingOwners([]),

      prepare(inputs) {
        return host.prepare({
          layouts: [],
          page: {
            node: page.node,
            definition: page.definition,
            props: () => ({}),
          },
          inputs,
        });
      },
    };
  },
});

const initial = await router.navigate("/events/one", { history: "replace" });

if (initial.status !== "committed") throw new Error("The cached event page did not mount");

await runtime.context.scheduler.settled();

cachedOnceA = document.getElementById("event-cache-once-a") as HTMLButtonElement;
cachedRegular = document.getElementById("event-cache-regular") as HTMLButtonElement;

router.installHistoryNavigation();

function waitForRoute(path: string): Promise<void> {
  const expected = new URL(path, window.location.href).href;
  return new Promise((resolve, reject) => {
    let active = true;
    const timeout = window.setTimeout(() => {
      active = false;

      reject(new Error(`Timed out waiting for ${expected}`));
    }, 5000);

    const check = () => {
      if (!active) return;

      if (router.url !== expected) {
        window.requestAnimationFrame(check);

        return;
      }

      active = false;

      window.clearTimeout(timeout);

      void runtime.context.scheduler.settled().then(resolve, reject);
    };

    check();
  });
}

Object.assign(window, {
  eventOptionsCacheFixture: {
    calls: eventCacheCalls,
    errors: () => errors.slice(),

    async goTwo() {
      const result = await router.navigate("/events/two", { history: "push" });

      await runtime.context.scheduler.settled();

      return result.status;
    },

    async goBack() {
      window.history.back();

      await waitForRoute("/events/one");
    },

    dispatchParked() {
      if (!cachedRegular) throw new Error("The cached event node was not retained");

      cachedRegular.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    },

    sameRestoredNode() {
      return cachedOnceA === document.getElementById("event-cache-once-a");
    },
  },
});

document.documentElement.dataset.ready = "true";
