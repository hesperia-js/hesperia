import { Router } from "../../packages/hesperia/src/routing/index.ts";

const events: string[] = [];
const fixture: {
  events: string[];
  ready: boolean;
  denyBack: boolean;
  redirectBack: boolean;
  guardPending: boolean;
  guardStarted: boolean;
  guardRuns: number;
  guardVetoes: number;
  releaseGuard?: (decision: boolean) => void;
  lastNode?: HTMLElement;
  beforeBackNode?: HTMLElement;
  router?: Router;
} = {
  events,
  ready: false,
  denyBack: false,
  redirectBack: false,
  guardPending: false,
  guardStarted: false,
  guardRuns: 0,
  guardVetoes: 0,
  router: undefined as Router | undefined,
};

Object.assign(window, { routingFixture: fixture });

const target = document.getElementById("route")!;
const router = new Router({
  window,
  pageCacheSize: 0,
  onError: (error) => {
    events.push(`error:${String(error)}`);
  },
  resolve: (url) => ({
    params: {},
    guards: [
      () => {
        if (url.pathname !== "/") return true;

        fixture.guardRuns++;

        if (fixture.redirectBack) return { redirect: "/redirected" };

        if (fixture.guardPending)
          return new Promise<boolean>((resolve) => {
            fixture.guardStarted = true;
            fixture.releaseGuard = resolve;
          });

        if (fixture.denyBack) {
          fixture.guardVetoes++;
          return false;
        }

        return true;
      },
    ],

    prepare() {
      const node = document.createElement("main");
      const control = document.createElement("button");
      fixture.lastNode = node;
      node.textContent = url.pathname;
      control.id = "route-focus";
      control.textContent = "Remember focus";
      return {
        owners: [],
        title: url.pathname,

        install() {
          target.append(node);

          target.append(control);

          events.push(`install:${url.pathname}`);
        },

        dispose() {
          node.remove();

          control.remove();
        },
      };
    },
  }),
});
fixture.router = router;

await router.navigate(location.href, { history: "replace", state: { entry: "root" } });

router.installHistoryNavigation();

router.listenToLinks();

fixture.ready = true;
