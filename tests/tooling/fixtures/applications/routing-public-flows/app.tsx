import type { Component, Rendered } from "hesperia";
import { client } from "hesperia";
import { Router } from "hesperia/routing";
import { beforeLeave, navigation } from "hesperia/navigation";
import { api } from "./api";

type RoutingPublicFixture = {
  beforeLeaveChecks: number;
  homeBodies: number;
  cachedBodies: number;
  blockedBodies: number;
  redirectBodies: number;
  sharedUpdateDone: boolean;
  navigationResults: unknown[];
  navigation: typeof navigation;
  renderFailure?: Error;
  router?: Router;
  reloadEnabled: boolean;
  reloadAllowed: boolean;
  reloadHoldLayout: boolean;
  reloadTrace: string[];
  reloadTimeline: string[];
  reloadNative: boolean;
  reloadObserverReady: boolean;
  reloadOutcome: string | undefined;
  reloadCommittedOutcome: string | undefined;
  reloadFinishedOutcome: string | undefined;
  releaseReload: (() => void) | undefined;
  startReload: (() => void) | undefined;
  reloadReferences:
    | {
        document: Document;
        html: Element;
        layout: Element | null;
        page: Element | null;
      }
    | undefined;
  appInstance?: string;
  layoutInstance?: string;
  homeInstance?: string;
};

Object.assign(globalThis, {
  routingPublicFixture: {
    beforeLeaveChecks: 0,
    homeBodies: 0,
    cachedBodies: 0,
    blockedBodies: 0,
    redirectBodies: 0,
    sharedUpdateDone: false,
    navigationResults: [],
    navigation,
    reloadEnabled: false,
    reloadAllowed: false,
    reloadHoldLayout: true,
    reloadTrace: [],
    reloadTimeline: [],
    reloadNative: false,
    reloadObserverReady: false,
    reloadOutcome: undefined,
    reloadCommittedOutcome: undefined,
    reloadFinishedOutcome: undefined,
    releaseReload: undefined,
    startReload: undefined,
    reloadReferences: undefined,
  } satisfies RoutingPublicFixture,
});

function routingFixture() {
  return (globalThis as unknown as { routingPublicFixture: RoutingPublicFixture })
    .routingPublicFixture;
}

Object.assign(globalThis, {
  routingPublicReloadCheck(name: string) {
    const fixture = routingFixture();

    if (!fixture.reloadEnabled) return true;

    fixture.reloadTrace.push(name + ":started");

    fixture.reloadTimeline.push(name + ":started");

    const settle = () => {
      fixture.reloadTrace.push(name + ":settled");

      fixture.reloadTimeline.push(name + ":settled");

      return fixture.reloadAllowed;
    };

    if (name === "layout" && fixture.reloadHoldLayout)
      return new Promise<boolean>((resolve) => {
        fixture.releaseReload = () => resolve(settle());
      });

    return settle();
  },
});

const originalNavigate = Router.prototype.navigate;

Router.prototype.navigate = function (this: Router, target, options) {
  routingFixture().router = this;

  const result = originalNavigate.call(this, target, options);

  void result.then((outcome) => {
    (
      globalThis as unknown as { routingPublicFixture: { navigationResults: unknown[] } }
    ).routingPublicFixture.navigationResults.push(outcome);
  });

  return result;
};

export default function App(props: Component.Props<{ children: Rendered }>) {
  const fixture = routingFixture();

  fixture.appInstance = crypto.randomUUID();

  fixture.startReload = () => {
    fixture.reloadCommittedOutcome = undefined;

    fixture.reloadFinishedOutcome = undefined;

    const result = navigation.reload({ info: "public-routing-authored-reload" });

    void Promise.allSettled([result.committed, result.finished] as const).then((outcomes) => {
      const outcomeName = (outcome: PromiseSettledResult<unknown>) => {
        if (outcome.status === "fulfilled") return "fulfilled";

        const reason = outcome.reason as { name?: unknown } | null;

        return String(reason?.name ?? "rejected");
      };

      fixture.reloadCommittedOutcome = outcomeName(outcomes[0]);

      fixture.reloadFinishedOutcome = outcomeName(outcomes[1]);

      fixture.reloadOutcome = outcomes.every((outcome) => outcome.status === "fulfilled")
        ? "resolved"
        : "rejected";
    });
  };

  fixture.reloadNative = (() => {
    const nativeWindow = window as Window & {
      readonly NavigationPrecommitController?: unknown;
      readonly NavigateEvent?: { readonly prototype?: { readonly intercept?: unknown } };
    };

    return (
      nativeWindow.navigation !== undefined &&
      typeof nativeWindow.NavigateEvent?.prototype?.intercept === "function" &&
      typeof nativeWindow.NavigationPrecommitController === "function"
    );
  })();

  const checkReload = (
    globalThis as unknown as {
      routingPublicReloadCheck: (name: string) => boolean | Promise<boolean>;
    }
  ).routingPublicReloadCheck;

  beforeLeave(() => checkReload("app"));

  const shellState = client.state(0);

  const shared = api.message("shared");

  const update = api.update();

  // prettier-ignore
  return <html data-app-instance={fixture.appInstance}><head><title>Public routing flows</title></head><body>
    <nav>
      <a id="nav-home" href="/">Home</a>
      <a id="nav-target" href="/target">Target</a>
      <a id="nav-blocked" href="/blocked">Blocked</a>
      <a id="nav-redirect" href="/redirect">Redirect</a>
      <a id="nav-cached" href="/cached">Cached</a>
      <a id="nav-user" href="/users/one?tab=first">User</a>
      <a id="nav-missing" href="/missing">Missing</a>
      <button id="update-shared" on:click={() => { fixture.sharedUpdateDone = false;

          void update.run({ id: "shared" }).then(() => { fixture.sharedUpdateDone = true; }); }}>Update shared</button>
      <button id="bump-shell-state" on:click={() => shellState.set(shellState() + 1)}>Shell state</button>
      <output id="shell-state">{String(shellState())}</output>
      <output id="shared-shell">{shared.value()?.message ?? ""}</output>
    </nav>
    {props.children()}
  </body></html>;
}
