import { Router } from "../../src/routing/index.ts";

const events: string[] = [];
const fixture: {
  events: string[];
  ready: boolean;
  denyBack: boolean;
  redirectBack: boolean;
  guardPending: boolean;
  guardStarted: boolean;
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
        if (fixture.redirectBack) return { redirect: "/redirected" };
        if (fixture.guardPending)
          return new Promise<boolean>((resolve) => {
            fixture.guardStarted = true;
            fixture.releaseGuard = resolve;
          });
        return !fixture.denyBack;
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
