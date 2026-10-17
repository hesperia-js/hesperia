import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { installHistoryCloneAdapter } from "./history-platform.ts";
import {
  Router,
  redirect,
  registerDeparture,
  type PreparedRoute,
  type RouteCandidate,
  type RouteInputs,
} from "../../packages/hesperia/src/routing/index.ts";
import { Owner, type RuntimeContext } from "../../packages/hesperia/src/runtime/owner.ts";
import { Scheduler } from "../../packages/hesperia/src/runtime/scheduler.ts";
import { text } from "../../packages/hesperia/src/runtime/dom.ts";

const windows: Window[] = [];

afterEach(() => {
  for (const window of windows.splice(0)) window.close();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function browser() {
  const window = new Window({ url: "https://example.test/" });

  windows.push(window);

  installHistoryCloneAdapter(window as unknown as globalThis.Window);

  const events: string[] = [];
  const nativeScrollTo = window.scrollTo.bind(window);
  window.scrollTo = ((x: number, y: number) => {
    nativeScrollTo(x, y);

    events.push("scroll");
  }) as typeof window.scrollTo;
  return { window: window as unknown as globalThis.Window, events };
}

function mouse(window: globalThis.Window, init: MouseEventInit): MouseEvent {
  const Constructor = (window as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent;
  return new Constructor("click", init);
}

function page(
  window: globalThis.Window,
  inputs: RouteInputs,
  label: string,
  events: string[],
  cacheable = false,
): PreparedRoute {
  const context = {
    document: window.document,
    container: window.document.body,
    nextGeneration: 0,
    warn: () => undefined,
    onError: (error: unknown) => {
      throw error;
    },
  } as unknown as RuntimeContext;
  const owner = new Owner(context, null, label);
  context.scheduler = new Scheduler(owner);
  const node = window.document.createElement("main");

  owner.nodes.add(node);

  node.id = "focus";
  node.tabIndex = -1;
  node.focus = () => {
    events.push(`focus:${label}`);
  };

  node.append(text(owner, () => `${label}:${inputs.queryParams().get("tab") ?? "none"}`));

  owner.executingBody = false;
  const prepared: PreparedRoute = {
    owners: [owner],
    title: label,
    language: "en",
    focusTarget: "#focus",
    announcement: label,

    install() {
      events.push(`install:${label}`);

      window.document.body.append(node);

      owner.commit();

      context.scheduler.requestEffects();
    },

    dispose() {
      events.push(`dispose:${label}`);

      owner.dispose();
    },
  };

  if (cacheable) {
    Object.assign(prepared, {
      park: () => {
        node.parentNode?.removeChild(node);

        owner.suspend();
      },
      restore: () => {
        window.document.body.append(node);

        owner.resume();
      },
    });
  }

  return prepared;
}

function presentationPage(
  window: globalThis.Window,
  inputs: RouteInputs,
  label: string,
): PreparedRoute {
  const context = {
    document: window.document,
    container: window.document.body,
    nextGeneration: 0,
    warn: () => undefined,
    onError: (error: unknown) => {
      throw error;
    },
  } as unknown as RuntimeContext;
  const owner = new Owner(context, null, label);
  context.scheduler = new Scheduler(owner);
  const main = window.document.createElement("main");
  main.tabIndex = -1;
  const control = window.document.createElement("button");
  control.id = "remembered-focus";

  main.append(
    text(owner, () => `${label}:${inputs.queryParams().get("tab") ?? "none"}`),
    control,
  );

  owner.nodes.add(main);

  owner.executingBody = false;
  return {
    owners: [owner],
    title: label,
    announcement: label,

    install() {
      window.document.body.append(main);

      owner.commit();
    },

    dispose() {
      owner.dispose();
    },
  };
}

test("incoming guards precede every outgoing departure interest and veto prevents preparation and terminal effects", async () => {
  const { window, events } = browser();
  let current!: PreparedRoute;
  let denyGuard = false;
  let veto = false;
  const router = new Router({
    window,
    announce: (message) => events.push(`announce:${message}`),
    resolve: (url) => ({
      params: {},
      guards: [
        () => {
          events.push("guard");

          return !denyGuard;
        },
      ],

      prepare(inputs) {
        events.push("prepare");

        current = page(window, inputs, url.pathname, events);
        return current;
      },
    }),
  });

  await router.navigate("/first", { history: "replace" });

  registerDeparture(current.owners[0]!, () => {
    events.push("parent-check");

    return !veto;
  });

  const child = new Owner(current.owners[0]!.context, current.owners[0]!, "child");

  child.commit();

  registerDeparture(child, () => {
    events.push("child-check");

    return true;
  });

  events.length = 0;
  denyGuard = true;

  expect((await router.navigate("/second", { history: "push" })).status).toBe("denied");

  expect(events).toStrictEqual(["guard"]);

  denyGuard = false;
  veto = true;
  events.length = 0;

  expect((await router.navigate("/second", { history: "push" })).status).toBe("denied");

  expect(events).toStrictEqual(["guard", "parent-check", "child-check"]);

  expect(window.location.pathname).toBe("/first");

  expect(window.document.title).toBe("/first");

  expect(window.document.body.textContent).toBe("/first:none");

  router.dispose();
});

test("superseded pending guards cancel immediately and cannot later install", async () => {
  const { window, events } = browser();
  const gate = deferred<boolean>();
  const entered = deferred<void>();
  let oldSignal!: AbortSignal;
  const router = new Router({
    window,
    resolve: (url, signal) => ({
      params: {},
      guards: [
        () => {
          if (url.pathname !== "/slow") return true;

          oldSignal = signal;

          entered.resolve();

          return gate.promise;
        },
      ],
      prepare: (inputs) => page(window, inputs, url.pathname, events),
    }),
  });
  const slow = router.navigate("/slow", { history: "push" });
  await entered.promise;
  const fast = router.navigate("/fast", { history: "replace" });

  expect((await slow).status).toBe("cancelled");

  expect(oldSignal.aborted).toBe(true);

  await fast;

  gate.resolve(true);

  await gate.promise;

  expect(events.filter((event) => event.startsWith("install"))).toStrictEqual(["install:/fast"]);

  expect(router.url).toBe("https://example.test/fast");

  router.dispose();
});

test("late prepared candidates are disposed and never replace a newer committed page", async () => {
  const { window, events } = browser();
  const entered = deferred<void>();
  const ready = deferred<PreparedRoute>();
  let late!: PreparedRoute;
  const router = new Router({
    window,
    resolve: (url) => ({
      params: {},

      prepare(inputs) {
        const result = page(window, inputs, url.pathname, events);

        if (url.pathname === "/slow") {
          late = result;

          entered.resolve();

          return ready.promise;
        }

        return result;
      },
    }),
  });
  const slow = router.navigate("/slow", { history: "push" });
  await entered.promise;

  await router.navigate("/fast", { history: "replace" });

  expect((await slow).status).toBe("cancelled");

  ready.resolve(late);

  await ready.promise;

  expect(events.filter((event) => event.startsWith("install"))).toStrictEqual(["install:/fast"]);

  expect(events).toContain("dispose:/slow");

  expect(late.owners[0]!.state).toBe("destroyed");

  router.dispose();
});

test("query-only navigation retains the page while changed parameters remount", async () => {
  const { window, events } = browser();
  const inputs: RouteInputs[] = [];
  let checks = 0;
  let bodies = 0;
  const router = new Router({
    window,
    announce: () => events.push("announce"),
    resolve: (url) => ({
      params: { id: url.pathname.slice(1) },
      guards: [
        ({ queryParams }) => {
          checks++;

          if (queryParams.get("tab") === "denied") return false;

          if (queryParams.get("tab") === "redirect") return redirect("/1?tab=redirected");

          return true;
        },
      ],

      prepare(input) {
        inputs.push(input);

        bodies++;
        return page(window, input, url.pathname, events);
      },
    }),
  });

  await router.navigate("/1?tab=first&keep=yes", { history: "replace" });

  const node = window.document.querySelector("main");
  const length = window.history.length;
  events.length = 0;

  router.updateQuery("tab", "second", { history: "push", state: { tab: 2 } });

  expect(window.history.length).toBe(length + 1);

  expect(router.state).toStrictEqual({ tab: 2 });

  expect(window.location.search).toBe("?keep=yes&tab=second");

  expect(window.document.body.textContent).toBe("/1:second");

  expect(window.document.querySelector("main")).toBe(node);

  expect(events).toStrictEqual([]);

  expect(checks).toBe(1);

  const view = inputs[0]!.queryParams();

  expect(() => (view as unknown as URLSearchParams).set("tab", "forbidden")).toThrow("read-only");

  router.updateQuery("tab", ["alpha", "beta"], { history: "replace" });

  const arrayView = inputs[0]!.queryParams();

  expect(window.location.search).toBe("?keep=yes&tab=alpha&tab=beta");

  expect(router.url).toBe(window.location.href);

  expect(arrayView.getAll("tab")).toStrictEqual(["alpha", "beta"]);

  expect(arrayView.get("keep")).toBe("yes");

  expect(view.getAll("tab")).toStrictEqual(["second"]);

  expect(window.history.length).toBe(length + 1);

  expect(window.document.body.textContent).toBe("/1:alpha");

  expect(window.document.querySelector("main")).toBe(node);

  router.updateQuery("tab", null, { history: "replace" });

  expect(window.location.search).toBe("?keep=yes");

  expect(router.url).toBe(window.location.href);

  expect(inputs[0]!.queryParams().has("tab")).toBe(false);

  expect(inputs[0]!.queryParams().getAll("tab")).toStrictEqual([]);

  expect(inputs[0]!.queryParams().get("keep")).toBe("yes");

  expect(arrayView.getAll("tab")).toStrictEqual(["alpha", "beta"]);

  expect(view.getAll("tab")).toStrictEqual(["second"]);

  expect(window.history.length).toBe(length + 1);

  expect(window.document.body.textContent).toBe("/1:none");

  expect(window.document.querySelector("main")).toBe(node);

  expect(bodies).toBe(1);

  expect(checks).toBe(1);

  expect(events).toStrictEqual([]);

  router.updateQuery("tab", "second", { history: "replace" });

  const historyLength = window.history.length;
  const denied = await router.navigate("/1?tab=denied", { history: "push" });

  expect(denied.status).toBe("denied");

  expect(window.location.search).toBe("?keep=yes&tab=second");

  expect(window.history.length).toBe(historyLength);

  expect(window.document.querySelector("main")).toBe(node);

  expect(bodies).toBe(1);

  const redirected = await router.navigate("/1?tab=redirect", {
    history: "push",
    state: { redirected: true },
  });

  expect(redirected.status).toBe("committed");

  expect(router.url).toBe("https://example.test/1?tab=redirected");

  expect(window.location.href).toBe(router.url);

  expect(router.state).toStrictEqual({ redirected: true });

  expect(window.history.length).toBe(historyLength + 1);

  expect(window.document.querySelector("main")).toBe(node);

  await router.navigate("/1?tab=third", { history: "replace" });

  expect(bodies).toBe(1);

  expect(window.document.querySelector("main")).toBe(node);

  expect(inputs[0]!.queryParams().get("tab")).toBe("third");

  await router.navigate("/2?tab=third", { history: "replace" });

  expect(inputs[1]!.params).toStrictEqual({ id: "2" });

  expect(bodies).toBe(2);

  expect(window.document.querySelector("main")).not.toBe(node);

  expect(() => inputs[0]!.queryParams()).toThrow("disposed route");

  router.dispose();
});

test("fragment-only navigation retains the route lifetime and applies native fragment presentation", async () => {
  const { window, events } = browser();
  let bodies = 0;
  let guardCalls = 0;
  let departureCalls = 0;
  const router = new Router({
    window,
    announce: (message) => events.push(`announce:${message}`),
    resolve: (url) => ({
      params: {},
      guards: [
        () => {
          guardCalls++;
          return true;
        },
      ],

      prepare(inputs) {
        bodies++;
        const prepared = page(window, inputs, url.pathname, events);
        const fragment = window.document.createElement("a");
        fragment.id = "details";
        fragment.tabIndex = -1;
        const focus = fragment.focus.bind(fragment);
        fragment.focus = (options?: FocusOptions) => {
          events.push("fragment-focus");

          focus(options);
        };
        fragment.scrollIntoView = () => {
          events.push("fragment-scroll");
        };

        prepared.owners[0]!.nodes.add(fragment);

        registerDeparture(prepared.owners[0]!, () => {
          departureCalls++;
          return true;
        });

        return {
          ...prepared,

          install(options) {
            prepared.install(options);

            window.document.body.append(fragment);
          },
        };
      },
    }),
  });

  await router.navigate("/one", { history: "replace" });

  const node = window.document.querySelector("main");
  const length = window.history.length;
  events.length = 0;

  const result = await router.navigate("/one#details", {
    history: "push",
    state: { fragment: true },
  });

  expect(result.status).toBe("committed");

  expect(router.url).toBe("https://example.test/one#details");

  expect(window.location.href).toBe("https://example.test/one#details");

  expect(window.history.length).toBe(length + 1);

  expect(router.state).toStrictEqual({ fragment: true });

  expect(window.document.querySelector("main")).toBe(node);

  expect(bodies).toBe(1);

  expect(guardCalls).toBe(2);

  expect(departureCalls).toBe(0);

  expect(events).toStrictEqual(["fragment-focus", "fragment-scroll", "announce:/one"]);

  events.length = 0;
  const cleared = await router.navigate("/one", { history: "push" });

  expect(cleared.status).toBe("committed");

  expect(router.url).toBe("https://example.test/one");

  expect(window.document.querySelector("main")).toBe(node);

  expect(bodies).toBe(1);

  expect(events).toStrictEqual(["focus:/one", "scroll", "announce:/one"]);

  router.dispose();
});

test("a superseded query-only guard leaves the current page until the newer query commits", async () => {
  const { window } = browser();
  const gate = deferred<boolean>();
  const entered = deferred<void>();
  let slowSignal!: AbortSignal;
  let bodies = 0;
  const router = new Router({
    window,
    resolve: (url) => ({
      params: { id: url.pathname.slice(1) },
      guards: [
        ({ queryParams, signal: guardSignal }) => {
          if (queryParams.get("tab") !== "slow") return true;

          slowSignal = guardSignal;

          entered.resolve();

          return gate.promise;
        },
      ],

      prepare(inputs) {
        bodies++;
        return page(window, inputs, url.pathname, []);
      },
    }),
  });

  await router.navigate("/1?tab=first", { history: "replace" });

  const node = window.document.querySelector("main");
  const length = window.history.length;
  const slow = router.navigate("/1?tab=slow", { history: "push" });
  await entered.promise;
  const fast = router.navigate("/1?tab=fast", { history: "push" });

  expect((await slow).status).toBe("cancelled");

  expect(slowSignal.aborted).toBe(true);

  expect((await fast).status).toBe("committed");

  expect(window.location.search).toBe("?tab=fast");

  expect(window.history.length).toBe(length + 1);

  expect(window.document.querySelector("main")).toBe(node);

  expect(bodies).toBe(1);

  gate.resolve(true);

  await gate.promise;

  router.dispose();
});

test("managed history state preserves null, undefined, and colliding author objects", async () => {
  const { window, events } = browser();
  const router = new Router({
    window,
    resolve: (url) => ({
      params: {},
      prepare: (inputs) => page(window, inputs, url.pathname, events),
    }),
  });
  const authorState = { __hesperiaHistory: {}, state: "author" };

  window.history.replaceState(authorState, "", "/before-startup");

  expect(router.state).toStrictEqual(authorState);

  await router.navigate("/object", { history: "replace", state: authorState });

  expect(router.state).toStrictEqual(authorState);

  await router.navigate("/undefined", { history: "replace", state: undefined });

  expect(router.state).toBeUndefined();

  await router.navigate("/null", { history: "replace", state: null });

  expect(router.state).toBeNull();

  router.dispose();
});

test("fragment guard redirects retain the requested history disposition", async () => {
  const { window, events } = browser();
  let bodies = 0;
  const router = new Router({
    window,
    resolve: (url) => ({
      params: {},
      guards: [({ url: target }) => (target.hash === "#bad" ? redirect("#details") : true)],

      prepare(inputs) {
        bodies++;
        return page(window, inputs, url.pathname, events);
      },
    }),
  });

  await router.navigate("/one", { history: "replace" });

  const node = window.document.querySelector("main");
  const length = window.history.length;
  const result = await router.navigate("/one#bad", {
    history: "push",
    state: { requested: true },
  });

  expect(result.status).toBe("committed");

  expect(router.url).toBe("https://example.test/one#details");

  expect(window.location.href).toBe("https://example.test/one#details");

  expect(window.history.length).toBe(length + 1);

  expect(router.state).toStrictEqual({ requested: true });

  expect(window.document.querySelector("main")).toBe(node);

  expect(bodies).toBe(1);

  router.dispose();
});

test("guard redirects use fresh immutable input snapshots and terminals follow installation", async () => {
  const { window, events } = browser();
  const router = new Router({
    window,
    announce: (message) => events.push(`announce:${message}`),
    resolve: (url): RouteCandidate => ({
      params: { id: url.pathname },
      guards: [
        ({ url: copy, params }) => {
          copy.pathname = "/tampered";

          expect(Object.isFrozen(params)).toBe(true);

          return url.pathname === "/start" ? redirect("/finish") : true;
        },
      ],
      prepare: (inputs) => page(window, inputs, url.pathname, events),
    }),
  });

  await router.navigate("/start", { history: "replace" });

  expect(events).toStrictEqual(["install:/finish", "focus:/finish", "scroll", "announce:/finish"]);

  expect(window.location.pathname).toBe("/finish");

  expect(window.document.title).toBe("/finish");

  expect(window.document.documentElement.lang).toBe("en");

  router.dispose();
});

test("retained layout owners survive page commits while departing page owners clean up once", async () => {
  const { window, events } = browser();
  let layout: Owner | undefined;
  let currentPage: Owner | undefined;
  const cleaned: string[] = [];
  const checked: string[] = [];
  const router = new Router({
    window,
    resolve: (url) => ({
      params: {},
      departingOwners: currentPage ? [currentPage] : [],

      prepare(inputs) {
        const fresh = page(window, inputs, url.pathname, events);

        if (!layout) {
          layout = new Owner(fresh.owners[0]!.context, null, "layout");
          layout.executingBody = false;

          layout.onCleanup(() => {
            cleaned.push("layout");
          });

          registerDeparture(layout, () => {
            checked.push("layout");

            return true;
          });

          layout.commit();
        }

        const child = fresh.owners[0]!;

        child.onCleanup(() => {
          cleaned.push(url.pathname);

          expect(inputs.queryParams().get("tab")).toBe("value");
        });

        registerDeparture(child, () => {
          checked.push(url.pathname);

          return true;
        });

        const shared = layout;
        return {
          ...fresh,
          owners: [shared, child],

          install() {
            fresh.install();

            currentPage = child;
          },

          dispose(reason, preserving) {
            if (!preserving?.has(shared)) shared.dispose(reason);

            if (!preserving?.has(child)) fresh.dispose(reason);
          },
        };
      },
    }),
  });

  await router.navigate("/first?tab=value", { history: "replace" });

  const retained = layout;

  await router.navigate("/second?tab=value", { history: "replace" });

  expect(layout).toBe(retained);

  expect(layout!.state).toBe("mounted");

  expect(cleaned).toStrictEqual(["/first"]);

  expect(checked).toStrictEqual(["/first"]);

  router.dispose();

  expect(cleaned).toStrictEqual(["/first", "layout", "/second"]);
});

test("explicit cancellation and failed preparation preserve the committed owner and history", async () => {
  const { window, events } = browser();
  const waiting = deferred<void>();
  const never = new Promise<boolean>(() => undefined);
  const failure = new Error("prepare failed");
  const router = new Router({
    window,
    resolve: (url) => ({
      params: {},
      guards: [
        () => {
          if (url.pathname === "/cancel") {
            waiting.resolve();

            return never;
          }

          return true;
        },
      ],
      prepare: (inputs) => {
        if (url.pathname === "/failure") throw failure;

        return page(window, inputs, url.pathname, events);
      },
    }),
  });

  await router.navigate("/current", { history: "replace" });

  events.length = 0;
  const candidate = router.navigate("/cancel", { history: "push" });
  await waiting.promise;

  router.cancel();

  expect((await candidate).status).toBe("cancelled");

  await expect(router.navigate("/failure", { history: "push" })).rejects.toBe(failure);

  expect(events).toStrictEqual([]);

  expect(window.location.pathname).toBe("/current");

  expect(window.document.querySelectorAll("main")).toHaveLength(1);

  expect(window.document.querySelector("main")!.textContent).toBe("/current:none");

  expect(window.document.querySelector('[role="status"]')!.textContent).toBe("/current");

  router.dispose();
});

test("link interception preserves native escape paths and releases its listener", async () => {
  const { window, events } = browser();
  let installed!: () => void;
  const committed = new Promise<void>((resolve) => {
    installed = resolve;
  });
  const router = new Router({
    window,
    resolve: (url) => ({
      params: {},

      prepare(inputs) {
        const prepared = page(window, inputs, url.pathname, events);
        return {
          ...prepared,

          install() {
            prepared.install();

            installed();
          },
        };
      },
    }),
  });
  const remove = router.listenToLinks();
  const sameOrigin = window.document.createElement("a");
  sameOrigin.href = "/next";
  sameOrigin.textContent = "next";

  window.document.body.append(sameOrigin);

  const primary = mouse(window, { bubbles: true, cancelable: true, button: 0 });

  sameOrigin.dispatchEvent(primary);

  expect(primary.defaultPrevented).toBe(true);

  await committed;

  expect(router.url).toBe("https://example.test/next");

  const external = window.document.createElement("a");
  external.href = "https://other.test/away";

  window.document.body.append(external);

  const externalClick = mouse(window, {
    bubbles: true,
    cancelable: true,
    button: 0,
  });

  external.dispatchEvent(externalClick);

  expect(externalClick.defaultPrevented).toBe(false);

  const modified = mouse(window, {
    bubbles: true,
    cancelable: true,
    button: 0,
    ctrlKey: true,
  });

  sameOrigin.dispatchEvent(modified);

  expect(modified.defaultPrevented).toBe(false);

  remove();

  const afterRemoval = mouse(window, {
    bubbles: true,
    cancelable: true,
    button: 0,
  });

  sameOrigin.dispatchEvent(afterRemoval);

  expect(afterRemoval.defaultPrevented).toBe(false);

  router.dispose();
});

test("redirect cycles and cross-origin targets fail before preparation, and disposal revokes navigation", async () => {
  const { window, events } = browser();
  const router = new Router({
    window,
    resolve: (url) => ({
      params: {},
      guards: [() => redirect(url.pathname === "/one" ? "/two" : "/one")],
      prepare: (inputs) => page(window, inputs, url.pathname, events),
    }),
  });

  await expect(router.navigate("/one", { history: "push" })).rejects.toMatchObject({
    kind: "navigation-redirect-cycle",
  });

  expect(events).toStrictEqual([]);

  expect(window.location.pathname).toBe("/");

  await expect(
    router.navigate("https://other.test/away", { history: "push" }),
  ).rejects.toMatchObject({ kind: "navigation-origin" });

  expect(events).toStrictEqual([]);

  router.dispose();

  await expect(router.navigate("/after-dispose", { history: "push" })).rejects.toMatchObject({
    kind: "disposed",
  });
});

test("cached and active alias guard redirects share one cycle transaction", async () => {
  const { window } = browser();
  let redirectCycle = false;
  const router = new Router({
    window,
    pageCacheSize: 2,
    resolve: (url) => ({
      params: {},
      guards: [() => (redirectCycle ? redirect(url.pathname === "/one" ? "/two" : "/one") : true)],

      prepare(inputs) {
        return page(window, inputs, url.pathname, [], true);
      },
    }),
  });

  await router.navigate("/one", { history: "replace" });

  await router.navigate("/two", { history: "push" });

  redirectCycle = true;

  await expect(router.navigate("/one", { history: "none" })).rejects.toMatchObject({
    kind: "navigation-redirect-cycle",
  });

  router.dispose();
});

test("history-entry cache restores a parked route instance and evicts at the configured limit", async () => {
  const { window, events } = browser();
  let bodies = 0;
  let firstNode: HTMLElement | null = null;
  const router = new Router({
    window,
    pageCacheSize: 1,
    resolve: (url, signal) => ({
      params: {},

      prepare(inputs) {
        bodies++;
        const result = page(window, inputs, url.pathname, events, true);

        if (url.pathname === "/one") firstNode = window.document.querySelector<HTMLElement>("main");

        signal.addEventListener("abort", () => result.dispose(signal.reason), { once: true });

        return result;
      },
    }),
  });

  await router.navigate("/one", { history: "replace" });

  firstNode = window.document.querySelector<HTMLElement>("main");

  await router.navigate("/two", { history: "push" });

  expect(window.document.querySelector("main")).not.toBe(firstNode);

  window.history.back();

  await router.navigate(window.location.href, { history: "none" });

  expect(window.document.querySelector("main")).toBe(firstNode);

  expect(bodies).toBe(2);

  router.dispose();
});

test("failed cached restore restores the outgoing route and keeps the cached entry retryable", async () => {
  const { window, events } = browser();
  const prepared = new Map<string, PreparedRoute>();
  const router = new Router({
    window,
    pageCacheSize: 2,
    resolve: (url) => ({
      params: {},

      prepare(inputs) {
        const result = page(window, inputs, url.pathname, events, true);

        prepared.set(url.pathname, result);

        return result;
      },
    }),
  });

  await router.navigate("/one", { history: "replace" });

  const first = prepared.get("/one")!;

  await router.navigate("/two", { history: "push" });

  const outgoing = prepared.get("/two")!;
  const outgoingOwner = outgoing.owners[0]!;
  const outgoingNode = window.document.querySelector("main");
  const restore = first.restore!;
  const failure = new Error("restore boom");

  Object.assign(first, {
    restore: () => {
      throw failure;
    },
  });

  window.history.back();

  await expect(router.navigate("/one", { history: "none" })).rejects.toBe(failure);

  expect(router.url).toBe("https://example.test/two");

  expect(window.location.href).toBe("https://example.test/one");

  expect(window.document.querySelector("main")).toBe(outgoingNode);

  expect(outgoingOwner.state).toBe("mounted");

  Object.assign(first, { restore });

  expect(await router.navigate("/one", { history: "none" })).toMatchObject({ status: "committed" });

  expect(window.document.querySelector("main")?.textContent).toContain("/one");

  router.dispose();
});

test("failed cached history traversal restores the physical and managed outgoing route once", async () => {
  const { window, events } = browser();
  const prepared = new Map<string, PreparedRoute>();
  const reported = deferred<unknown>();
  const returned = deferred<void>();
  const router = new Router({
    window,
    pageCacheSize: 2,
    onError: (error) => reported.resolve(error),
    resolve: (url) => ({
      params: {},

      prepare(inputs) {
        const result = page(window, inputs, url.pathname, events, true);

        prepared.set(url.pathname, result);

        return result;
      },
    }),
  });

  await router.navigate("/one", { history: "replace" });

  const first = prepared.get("/one")!;

  await router.navigate("/two", { history: "push" });

  const outgoing = prepared.get("/two")!;
  const outgoingOwner = outgoing.owners[0]!;
  const outgoingNode = window.document.querySelector("main");
  const failure = new Error("restore boom");

  Object.assign(first, {
    restore: () => {
      throw failure;
    },
  });

  const remove = router.installHistoryNavigation();

  const onPopState = () => {
    if (window.location.pathname === "/two") returned.resolve();
  };

  window.addEventListener("popstate", onPopState);

  window.history.back();

  expect(await reported.promise).toBe(failure);

  await returned.promise;

  expect(window.location.href).toBe("https://example.test/two");

  expect(router.url).toBe("https://example.test/two");

  expect(window.document.querySelector("main")).toBe(outgoingNode);

  expect(outgoingOwner.state).toBe("mounted");

  window.removeEventListener("popstate", onPopState);

  remove();

  router.dispose();
});

test("history traversal restores a cached same-path lifetime instead of updating the active query", async () => {
  const { window, events } = browser();
  let bodies = 0;
  const router = new Router({
    window,
    pageCacheSize: 2,
    resolve: (url, signal) => ({
      params: { id: "same" },

      prepare(inputs) {
        bodies++;
        const prepared = page(window, inputs, url.pathname, events, true);

        signal.addEventListener("abort", () => prepared.dispose(signal.reason), { once: true });

        return prepared;
      },
    }),
  });

  await router.navigate("/same?tab=first", { history: "replace" });

  const firstNode = window.document.querySelector("main");

  await router.navigate("/other?tab=other", { history: "push" });

  await router.navigate("/same?tab=second", { history: "push" });

  const secondNode = window.document.querySelector("main");

  expect(secondNode).not.toBe(firstNode);

  expect(bodies).toBe(3);

  window.history.back();

  await router.navigate(window.location.href, { history: "none" });

  window.history.back();

  await router.navigate(window.location.href, { history: "none" });

  expect(window.location.href).toBe("https://example.test/same?tab=first");

  expect(window.document.querySelector("main")).toBe(firstNode);

  expect(window.document.querySelector("main")).not.toBe(secondNode);

  expect(bodies).toBe(3);

  router.dispose();
});

test("the default cache retains five inactive pages alongside the current page", async () => {
  const { window } = browser();
  let bodies = 0;
  const router = new Router({
    window,
    resolve: (url, signal) => ({
      params: {},

      prepare(inputs) {
        bodies++;
        const prepared = page(window, inputs, url.pathname, [], true);

        signal.addEventListener("abort", () => prepared.dispose(signal.reason), { once: true });

        return prepared;
      },
    }),
  });

  await router.navigate("/0", { history: "replace" });

  for (let index = 1; index <= 6; index++) await router.navigate(`/${index}`, { history: "push" });

  expect(bodies).toBe(7);

  for (let index = 0; index < 5; index++) {
    window.history.back();

    await router.navigate(window.location.href, { history: "none" });
  }

  expect(window.location.pathname).toBe("/1");

  expect(bodies).toBe(7);

  window.history.back();

  await router.navigate(window.location.href, { history: "none" });

  expect(window.location.pathname).toBe("/0");

  expect(bodies).toBe(8);

  router.dispose();
});

test("uncached history traversal restores the recreated page's focus and scroll snapshot", async () => {
  const { window } = browser();
  const router = new Router({
    window,
    pageCacheSize: 0,
    resolve: (url, inputsSignal) => ({
      params: {},
      prepare: (inputs) => {
        const prepared = presentationPage(window, inputs, url.pathname);

        inputsSignal.addEventListener("abort", () => prepared.dispose(inputsSignal.reason), {
          once: true,
        });

        return prepared;
      },
    }),
  });

  await router.navigate("/one", { history: "replace" });

  const firstMain = window.document.querySelector("main");

  window.document.querySelector<HTMLButtonElement>("#remembered-focus")!.focus();

  window.scrollTo(11, 22);

  await router.navigate("/two", { history: "push" });

  window.history.back();

  await router.navigate(window.location.href, { history: "none" });

  expect(window.document.querySelector("main")).not.toBe(firstMain);

  expect(window.document.activeElement?.id).toBe("remembered-focus");

  expect([window.scrollX, window.scrollY]).toStrictEqual([11, 22]);

  router.dispose();
});

test("native precommit history traversal restores before the physical URL changes", async () => {
  const { window } = browser();
  const router = new Router({
    window,
    pageCacheSize: 0,
    resolve: (url) => ({
      params: {},
      prepare: (inputs) => presentationPage(window, inputs, url.pathname),
    }),
  });

  await router.navigate("/one", { history: "replace" });

  const navigation = new EventTarget() as EventTarget & {
    currentEntry: NavigationHistoryEntry;
  };
  const firstEntry = {
    key: "one",
    index: 0,
    url: "https://example.test/one",
    getState: () => null,
  } as NavigationHistoryEntry;
  const secondEntry = {
    key: "two",
    index: 1,
    url: "https://example.test/two",
    getState: () => null,
  } as NavigationHistoryEntry;
  navigation.currentEntry = firstEntry;

  function TestNavigateEvent() {}

  Object.defineProperty(TestNavigateEvent, "prototype", {
    value: { intercept() {} },
  });

  Object.defineProperty(window, "NavigateEvent", { configurable: true, value: TestNavigateEvent });

  Object.defineProperty(window, "NavigationPrecommitController", {
    configurable: true,
    value: function NavigationPrecommitController() {},
  });

  Object.defineProperty(window, "navigation", { configurable: true, value: navigation });

  const remove = router.installHistoryNavigation();

  window.document.querySelector<HTMLButtonElement>("#remembered-focus")!.focus();

  window.scrollTo(17, 27);

  navigation.currentEntry = secondEntry;

  await router.navigate("/two", { history: "push" });

  let intercepted!: NavigationInterceptOptions;
  let commit!: () => void;
  const event = new Event("navigate") as NavigateEvent;

  Object.defineProperties(event, {
    navigationType: { value: "traverse" },
    canIntercept: { value: true },
    destination: {
      value: {
        key: "one",
        index: 0,
        url: "https://example.test/one",
        sameDocument: true,
        getState: () => null,
      },
    },
    signal: { value: new AbortController().signal },
  });

  Object.defineProperty(event, "intercept", {
    value: (options: NavigationInterceptOptions) => {
      intercepted = options;
    },
  });

  navigation.dispatchEvent(event);

  await intercepted.precommitHandler!({
    addHandler(handler) {
      commit = handler;
    },

    redirect() {
      throw new Error("unexpected redirect");
    },
  } as NavigationPrecommitController);

  expect(window.location.pathname).toBe("/two");

  expect(window.document.activeElement?.id).not.toBe("remembered-focus");

  expect([window.scrollX, window.scrollY]).toStrictEqual([0, 0]);

  navigation.currentEntry = firstEntry;

  commit();

  expect(window.document.activeElement?.id).toBe("remembered-focus");

  expect([window.scrollX, window.scrollY]).toStrictEqual([17, 27]);

  remove();

  router.dispose();
});

test("ordinary replacement keeps the new navigation's default focus and scroll", async () => {
  const { window } = browser();
  const router = new Router({
    window,
    resolve: (url) => ({
      params: {},
      prepare: (inputs) => presentationPage(window, inputs, url.pathname),
    }),
  });

  await router.navigate("/one", { history: "replace" });

  window.document.querySelector<HTMLButtonElement>("#remembered-focus")!.focus();

  window.scrollTo(15, 25);

  await router.navigate("/two", { history: "replace" });

  expect(window.document.activeElement?.tagName).toBe("MAIN");

  expect([window.scrollX, window.scrollY]).toStrictEqual([0, 0]);

  router.dispose();
});

test("query-only history entries restore the earlier entry's focus and scroll snapshot", async () => {
  const { window } = browser();
  const router = new Router({
    window,
    resolve: (url) => ({
      params: {},
      prepare: (inputs) => presentationPage(window, inputs, url.pathname),
    }),
  });

  await router.navigate("/one?tab=first", { history: "replace" });

  const firstMain = window.document.querySelector("main");

  window.document.querySelector<HTMLButtonElement>("#remembered-focus")!.focus();

  window.scrollTo(13, 24);

  router.updateQuery("tab", "second", { history: "push" });

  expect(window.document.querySelector("main")).toBe(firstMain);

  window.scrollTo(31, 42);

  window.history.back();

  await router.navigate(window.location.href, { history: "none" });

  expect(window.document.querySelector("main")).toBe(firstMain);

  expect(window.location.search).toBe("?tab=first");

  expect(window.document.body.textContent).toContain("/one:first");

  expect(window.document.activeElement?.id).toBe("remembered-focus");

  expect([window.scrollX, window.scrollY]).toStrictEqual([13, 24]);

  router.dispose();
});

test("restoring a cached route checks the current outgoing owner", async () => {
  const { window, events } = browser();
  let veto = false;
  let allowDestination = true;
  let waitForDeparture = false;
  let bodies = 0;
  let completed = false;
  const departureEntered = deferred<void>();
  const departureGate = deferred<boolean>();
  let cached!: PreparedRoute;
  let current!: PreparedRoute;
  const router = new Router({
    window,
    pageCacheSize: 2,
    resolve: (url, signal) => ({
      params: {},
      guards: [
        () => {
          events.push(`guard:${url.pathname}`);

          return url.pathname !== "/two" || allowDestination;
        },
      ],

      prepare(inputs) {
        bodies++;
        const prepared = page(window, inputs, url.pathname, events, true);
        current = prepared;

        if (url.pathname === "/two") {
          cached = prepared;
          const restore = prepared.restore!;

          Object.assign(prepared, {
            restore: () => {
              events.push("restore:/two");

              restore();
            },
          });
        }

        if (url.pathname === "/three") {
          registerDeparture(current.owners[0]!, () => {
            events.push("first-check");

            return !veto;
          });

          registerDeparture(current.owners[0]!, () => {
            events.push("second-check");

            if (!waitForDeparture) return true;

            departureEntered.resolve();

            return departureGate.promise;
          });
        }

        signal.addEventListener("abort", () => prepared.dispose(signal.reason), { once: true });

        return prepared;
      },
    }),
  });

  await router.navigate("/one", { history: "replace" });

  await router.navigate("/two", { history: "push" });

  const cachedNode = window.document.querySelector("main");

  await router.navigate("/three", { history: "push" });

  const outgoingNode = window.document.querySelector("main");
  const outgoingOwner = current.owners[0]!;
  const installsBefore = events.filter((event) => event === "install:two").length;
  veto = true;

  window.history.back();

  const result = await router.navigate(window.location.href, { history: "none" });

  expect(result.status).toBe("denied");

  expect(window.document.querySelector<HTMLElement>("main")?.textContent).toContain("three");

  expect(events.filter((event) => event === "install:two")).toHaveLength(installsBefore);

  veto = false;
  allowDestination = false;
  events.length = 0;

  expect((await router.navigate(window.location.href, { history: "none" })).status).toBe("denied");

  expect(events).toStrictEqual(["guard:/two"]);

  expect(router.url).toBe("https://example.test/three");

  expect(window.document.querySelector("main")).toBe(outgoingNode);

  expect(outgoingOwner.state).toBe("mounted");

  expect(cached.owners[0]!.state).toBe("suspended");

  expect(bodies).toBe(3);

  allowDestination = true;
  waitForDeparture = true;
  events.length = 0;
  const restoration = router.navigate(window.location.href, { history: "none" }).then((result) => {
    completed = true;
    return result;
  });
  await departureEntered.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));

  expect(completed).toBe(false);

  expect(events).toStrictEqual(["guard:/two", "first-check", "second-check"]);

  expect(router.url).toBe("https://example.test/three");

  expect(window.document.querySelector("main")).toBe(outgoingNode);

  expect(outgoingOwner.state).toBe("mounted");

  expect(cached.owners[0]!.state).toBe("suspended");

  expect(bodies).toBe(3);

  departureGate.resolve(true);

  expect((await restoration).status).toBe("committed");

  expect(completed).toBe(true);

  expect(window.location.href).toBe("https://example.test/two");

  expect(router.url).toBe(window.location.href);

  expect(window.document.querySelector("main")).toBe(cachedNode);

  expect(cached.owners[0]!.state).toBe("mounted");

  expect(outgoingOwner.state).toBe("suspended");

  expect(events.filter((event) => event === "restore:/two")).toHaveLength(1);

  expect(bodies).toBe(3);

  router.dispose();
});

test("cancelled loading composition restores the outgoing owner without aborting its lifetime", async () => {
  const { window, events } = browser();
  const entered = deferred<void>();
  const gate = deferred<PreparedRoute>();
  let firstNode: HTMLElement | null = null;
  const router = new Router({
    window,
    resolve: (url) => ({
      params: {},
      prepareLoading:
        url.pathname === "/slow"
          ? (inputs) => page(window, inputs, "loading", events, true)
          : undefined,

      prepare(inputs) {
        if (url.pathname === "/first") {
          const result = page(window, inputs, "first", events, true);
          firstNode = window.document.querySelector<HTMLElement>("main");
          return result;
        }

        entered.resolve();

        return gate.promise;
      },
    }),
  });

  await router.navigate("/first", { history: "replace" });

  firstNode = window.document.querySelector<HTMLElement>("main");
  const pending = router.navigate("/slow", { history: "push" });
  await entered.promise;

  expect(events).toContain("install:loading");

  router.cancel();

  expect((await pending).status).toBe("cancelled");

  expect(window.document.querySelector("main")).toBe(firstNode);

  expect(events).not.toContain("dispose:first");

  router.dispose();
});

test("query updates restore a parked active page and publish the new query", async () => {
  const { window, events } = browser();
  const entered = deferred<void>();
  const gate = deferred<PreparedRoute>();
  const router = new Router({
    window,
    resolve: (url) => ({
      params: {},
      prepareLoading:
        url.pathname === "/slow"
          ? (inputs) => page(window, inputs, "loading", events, true)
          : undefined,

      prepare(inputs) {
        if (url.pathname === "/first") return page(window, inputs, "first", events, true);

        entered.resolve();

        return gate.promise;
      },
    }),
  });

  await router.navigate("/first", { history: "replace" });

  const firstNode = window.document.querySelector("main");
  const pending = router.navigate("/slow", { history: "push" });
  await entered.promise;

  expect(events).toContain("install:loading");

  router.updateQuery("tab", "second", { history: "push" });

  expect((await pending).status).toBe("cancelled");

  expect(window.document.querySelector("main")).toBe(firstNode);

  expect(window.location.search).toBe("?tab=second");

  expect(firstNode?.textContent).toBe("first:second");

  expect(window.document.querySelector("main")?.textContent).not.toContain("loading");

  router.dispose();
});

test("disposing after explicit cancellation does not restore a parked owner", async () => {
  const { window, events } = browser();
  const entered = deferred<void>();
  const gate = deferred<PreparedRoute>();
  const router = new Router({
    window,
    resolve: (url) => ({
      params: {},
      prepareLoading:
        url.pathname === "/slow"
          ? (inputs) => page(window, inputs, "loading", events, true)
          : undefined,

      prepare(inputs) {
        if (url.pathname === "/first") return page(window, inputs, "first", events, true);

        entered.resolve();

        return gate.promise;
      },
    }),
  });

  await router.navigate("/first", { history: "replace" });

  const pending = router.navigate("/slow", { history: "push" });
  await entered.promise;

  expect(events).toContain("install:loading");

  router.cancel();

  router.dispose();

  expect((await pending).status).toBe("cancelled");

  expect(window.document.querySelector("main")).toBeNull();
});

test("superseding a loading composition keeps the outgoing page cacheable", async () => {
  const { window, events } = browser();
  const entered = deferred<void>();
  const gate = deferred<PreparedRoute>();
  const router = new Router({
    window,
    resolve: (url) => ({
      params: {},
      prepareLoading:
        url.pathname === "/slow"
          ? (inputs) => page(window, inputs, "loading", events, true)
          : undefined,

      prepare(inputs) {
        if (url.pathname === "/slow") {
          entered.resolve();

          return gate.promise;
        }

        return page(window, inputs, "fast", events, true);
      },
    }),
  });

  await router.navigate("/first", { history: "replace" });

  const slow = router.navigate("/slow", { history: "push" });
  await entered.promise;
  const fast = router.navigate("/fast", { history: "push" });

  expect((await slow).status).toBe("cancelled");

  expect((await fast).status).toBe("committed");

  expect(events).not.toContain("dispose:first");

  expect(events).toContain("dispose:loading");

  expect(events).toContain("install:fast");

  router.dispose();
});

test("router disposal releases cached and active owners after either cleanup throws", async () => {
  const { window } = browser();
  const disposed: string[] = [];
  const originalPush = window.history.pushState;
  const router = new Router({
    window,
    pageCacheSize: 1,
    resolve: (url) => ({
      params: {},

      prepare() {
        const label = url.pathname;
        return {
          owners: [],

          install() {},

          park() {},

          restore() {},

          dispose() {
            disposed.push(label);

            throw new Error(`dispose:${label}`);
          },
        };
      },
    }),
  });

  await router.navigate("/one", { history: "replace" });

  await router.navigate("/two", { history: "push" });

  expect(() => router.dispose()).toThrow();

  expect(disposed.sort()).toStrictEqual(["/one", "/two"]);

  expect(window.history.pushState).toBe(originalPush);
});
