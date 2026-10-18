import { Router, type PreparedRoute } from "hesperia/routing";
import type { Component } from "hesperia";
import { createRuntimeRoot } from "../../../packages/hesperia/dist/runtime/dom.js";
import {
  createRouteHost,
  type RouteHostModule,
} from "../../../packages/hesperia/dist/routing/route-host.js";
import { Frame, NestedFrame, Page, routeEvents, damageNestedLayout } from "../RouteLayouts.tsx";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

const target = document.getElementById("app")!;
const errors: string[] = [];
const runtime = createRuntimeRoot(target, {
  onError: (error) => errors.push(error instanceof Error ? error.message : String(error)),
});
const host = createRouteHost(runtime, target);

runtime.owner.commit();

const frame: RouteHostModule = { node: {}, definition: Frame as Component<unknown> };
const nested: RouteHostModule = { node: {}, definition: NestedFrame as Component<unknown> };
const pageNode = {};
let slow:
  | {
      staged: ReturnType<typeof deferred<void>>;
      gate: ReturnType<typeof deferred<void>>;
      result?: Promise<string>;
      preparation?: Promise<PreparedRoute>;
    }
  | undefined;

const router = new Router({
  window,
  pageCacheSize: 0,

  resolve(url) {
    const layouts = url.pathname.startsWith("/nested/") ? [frame, nested] : [frame];
    return {
      params: { label: url.pathname },
      departingOwners: host.departingOwners(layouts),

      prepare(inputs) {
        const prepared = host.prepare({
          layouts,
          page: {
            node: pageNode,
            definition: Page as Component<unknown>,
            props: (current) => ({
              label: current.params.label,
              query: () => current.queryParams().get("tab"),
            }),
          },
          inputs,
        });

        if (url.pathname === "/nested/slow" && slow) {
          slow.preparation = slow.gate.promise.then(() => prepared);

          slow.staged.resolve();

          return slow.preparation;
        }

        return prepared;
      },
    };
  },
});

async function navigate(path: string): Promise<string> {
  const result = await router.navigate(path, { history: "none" });

  await runtime.context.scheduler.settled();

  return result.status;
}

Object.assign(window, {
  routeHostFixture: {
    navigate,
    damageNestedLayout,

    query(value: string) {
      router.updateQuery("tab", value, { history: "none" });
    },

    async beginSlow() {
      slow = { staged: deferred<void>(), gate: deferred<void>() };
      slow.result = navigate("/nested/slow");
      await slow.staged.promise;
    },

    pendingResult() {
      if (!slow?.result) throw new Error("No pending route");

      return slow.result;
    },

    async releaseSlow() {
      if (!slow) throw new Error("No staged route");

      slow.gate.resolve();

      await slow.preparation;

      await runtime.context.scheduler.settled();
    },

    snapshot: () => ({ events: routeEvents(), errors: errors.slice() }),
  },
});

await navigate("/nested/one");

document.documentElement.dataset.ready = "true";
