import { mount } from "hesperia/runtime";
import { Router } from "hesperia/routing";
import type { Component } from "hesperia";
import { createRuntimeRoot } from "../../../packages/hesperia/dist/runtime/dom.js";
import {
  createRouteHost,
  type RouteHostModule,
} from "../../../packages/hesperia/dist/routing/route-host.js";
import {
  asyncEvents,
  awaitedChildBodies,
  createAsyncBoundary,
  createCachedRecoveryPage,
  createIndependentParent,
  createRecoveryAwayPage,
  createRecoveryOutside,
  recoveryChildBodies,
  recoveryLifecycle,
  recoveryOutsideBodies,
  recoveryParentBodies,
  recoveryProbeReady,
  refusedChildBodies,
} from "../Async.tsx";
import {
  beginReset,
  probeDisposedViewSource,
  probeStaleAccessor,
  resetIdentity,
  resetState,
  savedQueryValue,
  savedSourceState,
} from "./async-recovery-api.ts";

const errors: string[] = [];
const independentErrors: string[] = [];
const recoveryErrors: string[] = [];
const recoveryMode = new URL(window.location.href).searchParams.has("reset");
const recoveryContainer = recoveryMode ? document.getElementById("independent-app")! : undefined;
const recoveryPageTarget = recoveryContainer ? document.createElement("div") : undefined;
const recoveryOutsideTarget = recoveryContainer ? document.createElement("div") : undefined;

if (recoveryPageTarget && recoveryOutsideTarget)
  recoveryContainer!.append(recoveryPageTarget, recoveryOutsideTarget);

const primary = mount(
  document.getElementById("async-app")!,
  createAsyncBoundary,
  {},
  {
    onError: (error) => errors.push(error instanceof Error ? error.message : String(error)),
  },
);
const independent = recoveryMode
  ? undefined
  : mount(
      document.getElementById("independent-app")!,
      createIndependentParent,
      {},
      {
        onError: (error) =>
          independentErrors.push(error instanceof Error ? error.message : String(error)),
      },
    );
const recoveryRuntime = recoveryPageTarget
  ? createRuntimeRoot(recoveryPageTarget, {
      onError: (error) =>
        recoveryErrors.push(error instanceof Error ? error.message : String(error)),
    })
  : undefined;
const recoveryHost =
  recoveryRuntime && recoveryPageTarget
    ? createRouteHost(recoveryRuntime, recoveryPageTarget)
    : undefined;

recoveryRuntime?.owner.commit();

const recoveryOutside = recoveryOutsideTarget
  ? mount(
      recoveryOutsideTarget,
      createRecoveryOutside,
      {},
      {
        onError: (error) =>
          recoveryErrors.push(error instanceof Error ? error.message : String(error)),
      },
    )
  : undefined;
const recoveryPage: RouteHostModule = {
  node: {},
  definition: createCachedRecoveryPage as Component<unknown>,
};
const recoveryAwayPage: RouteHostModule = {
  node: {},
  definition: createRecoveryAwayPage as Component<unknown>,
};
let recoveryRouter: Router | undefined;

if (recoveryRuntime && recoveryHost) {
  const host = recoveryHost;
  recoveryRouter = new Router({
    window,
    pageCacheSize: 1,
    onError: (error) => recoveryErrors.push(error instanceof Error ? error.message : String(error)),

    resolve(url) {
      const page = url.pathname === "/async-recovery-away" ? recoveryAwayPage : recoveryPage;
      return {
        params: {},
        departingOwners: host.departingOwners([]),

        prepare(inputs) {
          return host.prepare({
            layouts: [],
            page: { node: page.node, definition: page.definition, props: () => ({}) },
            inputs,
          });
        },
      };
    },
  });
}

Object.assign(globalThis, {
  asyncFixture: {
    errors,
    independentErrors,

    get events() {
      return [...asyncEvents];
    },

    get awaitedChildBodies() {
      return awaitedChildBodies;
    },

    get refusedChildBodies() {
      return refusedChildBodies;
    },

    get recovery() {
      return {
        parentBodies: recoveryParentBodies,
        childBodies: recoveryChildBodies,
        outsideBodies: recoveryOutsideBodies,
        probeReady: recoveryProbeReady,
        errors: [...recoveryErrors],
        lifecycle: { ...recoveryLifecycle },
      };
    },

    dispose() {
      primary.dispose();

      independent?.dispose();

      recoveryRouter?.dispose();

      recoveryHost?.dispose();

      recoveryRuntime?.owner.dispose();

      recoveryOutside?.dispose();
    },
  },
  asyncRecoveryControl: {
    beginReset,
    resetState,
    resetIdentity,
    savedQueryValue,
    savedSourceState,
    probeDisposedViewSource,
    probeStaleAccessor,
  },
  asyncCacheControl: recoveryRouter
    ? {
        async navigateAway() {
          const result = await recoveryRouter!.navigate("/async-recovery-away", {
            history: "push",
          });

          await recoveryRuntime!.context.scheduler.settled();

          return result.status;
        },
      }
    : undefined,
});

await primary.settled();

await independent?.settled();

if (recoveryRouter) {
  const result = await recoveryRouter.navigate("/async-recovery-one", { history: "replace" });

  if (result.status !== "committed") throw new Error("The async recovery route did not mount");

  recoveryRouter.installHistoryNavigation();

  await recoveryRuntime?.context.scheduler.settled();
}

await recoveryOutside?.settled();

document.documentElement.dataset.ready = "true";
