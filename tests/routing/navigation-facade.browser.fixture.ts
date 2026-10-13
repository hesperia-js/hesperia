import { Router } from "../../packages/hesperia/src/routing/navigation.ts";
import { navigation as exportedNavigation } from "../../packages/hesperia/src/navigation.ts";
import { reserveNavigation } from "../../packages/hesperia/src/routing/navigation-api.ts";
import { installHistoryTracking } from "../../packages/hesperia/src/routing/history.ts";
import {
  bootstrapApplication,
  defineComponent,
  element,
  type MountedApplication,
  type Rendered,
} from "../../packages/hesperia/src/runtime/index.ts";
import type {
  RouteTable,
  RouteTableModule,
  RouteTableNode,
} from "../../packages/hesperia/src/routing/index.ts";

const homePage = defineComponent((owner) =>
  element(owner, "main", { "data-page": "home" }, [
    element(owner, "a", { href: "detail" }, ["detail"]),
  ]),
);
const detailPage = defineComponent((owner) =>
  element(owner, "main", { "data-page": "detail" }, ["detail"]),
);

const routeModule = (filename: string, component: typeof homePage): RouteTableModule => ({
  filename,
  load: async () => component,
});

const detailRoute: RouteTableNode = {
  id: "detail",
  pattern: "/detail",
  segments: [{ kind: "static", value: "detail" }],
  files: { page: routeModule("/routes/detail/+page.tsx", detailPage) },
  children: [],
};
const homeRoute: RouteTableNode = {
  id: "root",
  pattern: "/",
  segments: [],
  files: { page: routeModule("/routes/+page.tsx", homePage) },
  children: [detailRoute],
};
const routes: RouteTable = { version: 1, root: homeRoute, routes: [homeRoute, detailRoute] };
const shell = defineComponent<{ children: Rendered }>((owner, props) =>
  element(owner, "html", {}, [
    element(owner, "head", {}, []),
    element(owner, "body", {}, [props.children()]),
  ]),
);
const applicationModules = {
  configuration: () => ({}),
  shell: () => shell,
  routes: () => routes,
};
const iframeApplications: MountedApplication[] = [];

async function startIframeApplications(first: Window, second: Window): Promise<void> {
  iframeApplications.push(
    await bootstrapApplication(first, applicationModules, { mountPath: "/window/first" }),
  );

  iframeApplications.push(
    await bootstrapApplication(second, applicationModules, { mountPath: "/window/second" }),
  );
}

function disposeIframeApplications(): void {
  const [first, second] = iframeApplications.splice(0);

  try {
    first?.dispose();
  } finally {
    second?.dispose();
  }
}

if (location.pathname === "/window-driver") {
  Object.assign(window, {
    navigationFacadeFixture: {
      ready: true,
      startIframeApplications,
      disposeIframeApplications,
    },
  });
} else {
  const reservation = reserveNavigation(window);
  const tracker = installHistoryTracking(window);

  reservation.setHistoryTracker(tracker);

  const events: string[] = [];
  const navigationEvents: Array<{
    type: string;
    sameDocument: boolean;
    hashChange: boolean;
    url: string | null;
  }> = [];
  let guardCalls = 0;
  let lastReloadInfo: unknown;
  const router = new Router({
    window,
    pageCacheSize: 0,

    resolve(url) {
      return {
        params: {},
        guards: [
          () => {
            guardCalls++;
            return true;
          },
        ],

        prepare() {
          const main = document.createElement("main");
          main.textContent = url.pathname;
          let localState = 0;
          main.dataset.localState = String(localState);

          main.addEventListener("click", () => {
            localState++;
            main.dataset.localState = String(localState);
          });

          return {
            owners: [],

            install() {
              document.body.replaceChildren(main);

              events.push(`install:${url.pathname}`);
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
    router.navigate("/one", { history: "replace", state: { initial: true } }),
  );

  router.installHistoryNavigation();

  reservation.historyAdapterInstalled();

  const navigation = reservation.facade;

  navigation.addEventListener("navigate", (event) => {
    const current = event as NavigateEvent;

    if (current.navigationType === "reload") lastReloadInfo = current.info;

    navigationEvents.push({
      type: current.navigationType,
      sameDocument: current.destination.sameDocument,
      hashChange: current.hashChange,
      url: current.destination.url,
    });

    events.push(
      `navigate:${current.navigationType}:${current.destination.sameDocument}:${current.canIntercept}`,
    );
  });

  Object.assign(window, {
    navigationFacadeFixture: {
      ready: true,
      navigation,
      exportedNavigation,
      router,
      native: reservation.native,
      events,
      navigationEvents,
      startIframeApplications,
      disposeIframeApplications,

      get guardCalls() {
        return guardCalls;
      },

      get lastReloadInfo() {
        return lastReloadInfo;
      },
    },
  });
}
