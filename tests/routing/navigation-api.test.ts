import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { bootstrapApplication } from "../../packages/hesperia/src/runtime/application.ts";
import { defineComponent } from "../../packages/hesperia/src/runtime/components.ts";
import { element, text, type Rendered } from "../../packages/hesperia/src/runtime/dom.ts";
import { Router } from "../../packages/hesperia/src/routing/navigation.ts";
import {
  navigationReservationFor,
  reserveNavigation,
} from "../../packages/hesperia/src/routing/navigation-api.ts";
import { installHistoryTracking } from "../../packages/hesperia/src/routing/history.ts";
import type {
  RouteTable,
  RouteTableModule,
  RouteTableNode,
} from "../../packages/hesperia/src/routing/route-table.ts";
import { installHistoryCloneAdapter } from "./history-platform.ts";

const windows: Window[] = [];

afterEach(() => {
  for (const window of windows.splice(0)) window.close();
});

function createWindow(url = "https://example.test/"): globalThis.Window {
  const window = new Window({ url });

  windows.push(window);

  installHistoryCloneAdapter(window as unknown as globalThis.Window);

  return window as unknown as globalThis.Window;
}

function waitForSelector(window: globalThis.Window, selector: string): Promise<Element> {
  const existing = window.document.querySelector(selector);

  if (existing) return Promise.resolve(existing);

  return new Promise((resolve, reject) => {
    const MutationObserverConstructor = (
      window as unknown as { MutationObserver: typeof MutationObserver }
    ).MutationObserver;
    const observer = new MutationObserverConstructor(() => {
      const match = window.document.querySelector(selector);

      if (!match) return;

      clearTimeout(timeout);

      observer.disconnect();

      resolve(match);
    });
    const timeout = setTimeout(() => {
      observer.disconnect();

      reject(new Error(`Timed out waiting for ${selector}`));
    }, 2000);

    observer.observe(window.document, { childList: true, subtree: true });
  });
}

function devHardReloadEvent(window: globalThis.Window): CustomEvent {
  const Constructor = (window as unknown as { CustomEvent?: typeof CustomEvent }).CustomEvent;

  if (!Constructor) throw new Error("The test window has no CustomEvent constructor");

  return new Constructor("hesperia:dev-hard-reload", {
    cancelable: true,
  }) as unknown as CustomEvent;
}

function installNativeNavigation(
  window: globalThis.Window,
  reload: (options?: NavigationReloadOptions) => NavigationResult,
): EventTarget & Navigation {
  const navigation = new EventTarget() as EventTarget & Navigation;
  const entry = {
    key: "native-current",
    id: "native-current",
    index: 0,
    url: window.location.href,
    sameDocument: true,
    getState: () => undefined,
  } as NavigationHistoryEntry;

  Object.defineProperties(navigation, {
    currentEntry: { configurable: true, value: entry },
    entries: { configurable: true, value: () => [entry] },
    reload: { configurable: true, value: reload },
  });

  Object.defineProperty(window, "navigation", { configurable: true, value: navigation });

  Object.defineProperty(window, "NavigateEvent", {
    configurable: true,
    value: { prototype: { intercept() {} } },
  });

  Object.defineProperty(window, "NavigationPrecommitController", {
    configurable: true,
    value: function NavigationPrecommitController() {},
  });

  return navigation;
}

function nativeReloadEvent(
  info: unknown,
  intercept: (options: NavigationInterceptOptions) => void,
) {
  const event = new Event("navigate", { cancelable: true }) as NavigateEvent;

  Object.defineProperties(event, {
    navigationType: { value: "reload" },
    info: { value: info },
    canIntercept: { value: true },
    destination: { value: { url: "https://example.test/" } },
    intercept: { value: intercept },
  });

  return event;
}

function nativeHistoryState(window: globalThis.Window): unknown {
  let prototype = Object.getPrototypeOf(window.history) as object | null;

  while (prototype) {
    const getter = Object.getOwnPropertyDescriptor(prototype, "state")?.get;

    if (getter) return Reflect.apply(getter, window.history, []);

    prototype = Object.getPrototypeOf(prototype) as object | null;
  }

  throw new Error("History has no native state getter");
}

function createHistoryDriver(window: globalThis.Window) {
  type Row = { readonly url: string; readonly state: unknown };

  const history = window.history;
  const nativePush = history.pushState.bind(history);
  const nativeReplace = history.replaceState.bind(history);
  let prototype = Object.getPrototypeOf(history) as object | null;
  let getNativeState: (() => unknown) | undefined;

  while (prototype && !getNativeState) {
    getNativeState = Object.getOwnPropertyDescriptor(prototype, "state")?.get as
      | (() => unknown)
      | undefined;
    prototype = Object.getPrototypeOf(prototype) as object | null;
  }

  if (!getNativeState) throw new Error("History has no native state getter");

  const physicalState = () => Reflect.apply(getNativeState!, history, []);

  const rows: Row[] = [{ url: window.location.href, state: physicalState() }];
  let index = 0;
  let hold = false;
  let heldMove: (() => void) | undefined;

  const capture = (mode: "push" | "replace") => {
    const row = { url: window.location.href, state: structuredClone(physicalState()) };

    if (mode === "replace") {
      rows[index] = row;
      return;
    }

    rows.splice(index + 1);

    rows.push(row);

    index = rows.length - 1;
  };

  history.pushState = function (...args: unknown[]) {
    Reflect.apply(nativePush, history, args);

    capture("push");
  } as History["pushState"];
  history.replaceState = function (...args: unknown[]) {
    Reflect.apply(nativeReplace, history, args);

    capture("replace");
  } as History["replaceState"];

  const move = (delta: number) => {
    const next = index + delta;

    if (next < 0 || next >= rows.length) return;

    index = next;
    const row = rows[index]!;

    Reflect.apply(nativeReplace, history, [row.state, "", row.url]);

    const PopStateEventConstructor = (
      window as unknown as {
        PopStateEvent?: typeof PopStateEvent;
      }
    ).PopStateEvent;

    if (!PopStateEventConstructor) throw new Error("The History test window has no PopStateEvent");

    window.dispatchEvent(new PopStateEventConstructor("popstate", { state: row.state }));
  };

  history.go = (delta = 0) => {
    if (hold) heldMove = () => move(delta);
    else move(delta);
  };

  return {
    holdMoves(value: boolean) {
      hold = value;
    },

    releaseMove() {
      const release = heldMove;
      heldMove = undefined;

      release?.();
    },
  };
}

function createHarness(window = createWindow(), mountPath = "/") {
  const driver = createHistoryDriver(window);
  const history = installHistoryTracking(window);
  const reservation = reserveNavigation(window, mountPath);

  reservation.setHistoryTracker(history);

  let holdSettlement = false;
  let releaseSettlement: (() => void) | undefined;
  let markSettlementStarted!: () => void;
  let settlementStarted = Promise.resolve();
  const scheduler = {
    settled() {
      if (!holdSettlement) return Promise.resolve();

      settlementStarted = new Promise<void>((resolve) => {
        markSettlementStarted = resolve;
      });
      return new Promise<void>((resolve) => {
        releaseSettlement = resolve;

        markSettlementStarted();
      });
    },
  };
  let denyOne = false;
  let oneGuardCalls = 0;
  let onePreparationFailure: unknown;
  let routeCalls = 0;
  const router = new Router({
    window,
    pageCacheSize: 0,

    resolve(url) {
      routeCalls++;
      return {
        params: {},
        guards:
          url.pathname === "/one"
            ? [
                () => {
                  oneGuardCalls++;
                  return !denyOne;
                },
              ]
            : [],

        prepare() {
          if (url.pathname === "/one" && onePreparationFailure !== undefined)
            throw onePreparationFailure;

          const main = window.document.createElement("main");
          main.textContent = url.pathname;
          return {
            owners: [],

            install() {
              window.document.body.replaceChildren(main);
            },

            dispose() {
              main.remove();
            },
          };
        },
      };
    },
  });

  reservation.attachRouter(router, scheduler);

  return {
    window,
    history,
    reservation,
    router,
    driver,

    setDenyOne(value: boolean) {
      denyOne = value;
    },

    getOneGuardCalls() {
      return oneGuardCalls;
    },

    getRouteCalls() {
      return routeCalls;
    },

    failOnePreparation(error: unknown) {
      onePreparationFailure = error;
    },

    holdSettlements(value: boolean) {
      holdSettlement = value;
    },

    waitForSettlement() {
      return settlementStarted;
    },

    releaseSettlement() {
      const release = releaseSettlement;
      releaseSettlement = undefined;

      release?.();
    },

    async start() {
      const initialPath = mountPath === "/" ? "/one" : `${mountPath}/one`;

      await reservation.beginInitialNavigation(
        router.navigate(initialPath, { history: "replace", state: { page: "one" } }),
      );

      router.installHistoryNavigation();

      reservation.historyAdapterInstalled();
    },

    async startPreservingCurrentEntry() {
      await reservation.beginInitialNavigation(
        router.navigate(window.location.pathname, { history: "none", state: null }),
      );

      router.installHistoryNavigation();

      reservation.historyAdapterInstalled();
    },

    dispose() {
      reservation.release();

      router.dispose();

      history.release();
    },
  };
}

test("fallback document navigations delegate to the browser and keep their promises pending", async () => {
  const cases = [
    {
      target: "https://outside.test/destination",
      expected: "https://outside.test/destination",
      method: "assign",
      options: undefined,
    },
    {
      target: "https://example.test/outside",
      expected: "https://example.test/outside",
      method: "replace",
      options: { history: "replace" as const },
    },
  ] as const;

  for (const item of cases) {
    const window = createWindow("https://example.test/app/one");
    const destinations: string[] = [];

    Object.defineProperty(window.location, item.method, {
      configurable: true,
      value: (url: string | URL) => destinations.push(String(url)),
    });

    const harness = createHarness(window, "/app");

    try {
      await harness.start();

      const callsBeforeNavigation = harness.getRouteCalls();
      const navigation = harness.reservation.facade.navigate(item.target, item.options);
      let committedSettled = false;
      let finishedSettled = false;

      void navigation.committed.then(
        () => {
          committedSettled = true;
        },
        () => {
          committedSettled = true;
        },
      );

      void navigation.finished.then(
        () => {
          finishedSettled = true;
        },
        () => {
          finishedSettled = true;
        },
      );

      await Promise.resolve();

      expect(destinations).toStrictEqual([item.expected]);

      expect(harness.getRouteCalls()).toBe(callsBeforeNavigation);

      expect(committedSettled).toBe(false);

      expect(finishedSettled).toBe(false);
    } finally {
      harness.dispose();
    }
  }
});

test("native cross-origin navigation keeps the native Navigation result", async () => {
  const window = createWindow("https://example.test/app/one");
  const assigned: string[] = [];

  Object.defineProperty(window.location, "assign", {
    configurable: true,
    value: (url: string | URL) => assigned.push(String(url)),
  });

  const native = installNativeNavigation(window, () => {
    throw new Error("reload was not expected");
  });
  const entry = native.currentEntry!;
  const expected = {
    committed: Promise.resolve(entry),
    finished: Promise.resolve(entry),
  };
  const calls: Array<{ readonly url: string; readonly options?: NavigationNavigateOptions }> = [];

  Object.defineProperty(native, "navigate", {
    configurable: true,
    value: (url: string, options?: NavigationNavigateOptions) => {
      calls.push({ url, options });

      return expected;
    },
  });

  const harness = createHarness(window, "/app");

  try {
    await harness.start();

    const options: NavigationNavigateOptions = { history: "replace", info: "external" };
    const callsBeforeNavigation = harness.getRouteCalls();

    const result = harness.reservation.facade.navigate("https://outside.test/destination", options);

    expect(result).toBe(expected);

    expect(calls).toStrictEqual([{ url: "https://outside.test/destination", options }]);

    expect(assigned).toStrictEqual([]);

    expect(harness.getRouteCalls()).toBe(callsBeforeNavigation);
  } finally {
    harness.dispose();
  }
});

test("History fallback exposes stable entries, follows traversals, and waits for route completion", async () => {
  const harness = createHarness();

  await harness.start();

  const one = harness.reservation.facade.currentEntry!;
  let replacedOneDisposals = 0;
  let replacedOnePropertyDisposals = 0;

  const oneOnDispose = () => {
    replacedOnePropertyDisposals++;
  };

  one.ondispose = oneOnDispose;

  expect(one.ondispose).toBe(oneOnDispose);

  one.addEventListener("dispose", () => replacedOneDisposals++);

  const replacement = harness.reservation.facade.navigate("/one?tab=second", {
    history: "replace",
    state: { page: "one-replaced" },
  });
  await replacement.finished;
  const oneReplaced = harness.reservation.facade.currentEntry!;

  expect(oneReplaced).not.toBe(one);

  expect(oneReplaced.key).toBe(one.key);

  expect(oneReplaced.id).not.toBe(one.id);

  expect(one.index).toBe(-1);

  expect(one.ondispose).toBe(oneOnDispose);

  expect(replacedOneDisposals).toBe(1);

  expect(replacedOnePropertyDisposals).toBe(1);

  expect(oneReplaced.url).toBe("https://example.test/one?tab=second");

  expect(oneReplaced.getState()).toStrictEqual({ page: "one-replaced" });

  const twoNavigation = harness.reservation.facade.navigate("/two", {
    state: { page: "two" },
  });
  await twoNavigation.finished;
  const two = harness.reservation.facade.currentEntry!;
  let prunedTwoPropertyDisposals = 0;

  const twoOnDispose = () => {
    prunedTwoPropertyDisposals++;
  };

  two.ondispose = twoOnDispose;

  expect(two.ondispose).toBe(twoOnDispose);

  expect(harness.reservation.facade.entries()).toStrictEqual([oneReplaced, two]);

  expect(harness.reservation.facade.canGoBack).toBe(true);

  expect(harness.reservation.facade.canGoForward).toBe(false);

  harness.holdSettlements(true);

  harness.driver.holdMoves(true);

  const back = harness.reservation.facade.back();
  let committed = false;
  let finished = false;

  void back.committed.then(() => (committed = true));

  void back.finished.then(() => (finished = true));

  await Promise.resolve();

  expect(committed).toBe(false);

  expect(harness.window.location.pathname).toBe("/two");

  harness.driver.holdMoves(false);

  harness.driver.releaseMove();

  expect(await back.committed).toBe(oneReplaced);

  expect(harness.reservation.facade.canGoForward).toBe(true);

  await harness.waitForSettlement();

  expect(finished).toBe(false);

  harness.holdSettlements(false);

  harness.releaseSettlement();

  expect(await back.finished).toBe(oneReplaced);

  const forward = harness.reservation.facade.forward();

  expect(await forward.finished).toBe(two);

  const traverse = harness.reservation.facade.traverseTo(oneReplaced.key);

  expect(await traverse.finished).toBe(oneReplaced);

  expect(harness.reservation.facade.currentEntry).toBe(oneReplaced);

  await expect(harness.reservation.facade.back().committed).rejects.toMatchObject({
    name: "InvalidStateError",
  });

  await expect(
    harness.reservation.facade.traverseTo("not-an-entry").finished,
  ).rejects.toMatchObject({
    name: "InvalidStateError",
  });

  const replacementAfterBack = harness.reservation.facade.navigate("/three", {
    state: { page: "three" },
  });
  await replacementAfterBack.finished;

  expect(two.index).toBe(-1);

  expect(two.ondispose).toBe(twoOnDispose);

  expect(prunedTwoPropertyDisposals).toBe(1);

  expect(harness.reservation.facade.entries().map((entry) => entry.url)).toStrictEqual([
    "https://example.test/one?tab=second",
    "https://example.test/three",
  ]);

  expect(harness.reservation.facade.canGoForward).toBe(false);

  harness.dispose();
});

test("History fallback rejects a denied Back after the adapter restores the current entry", async () => {
  const harness = createHarness();

  await harness.start();

  await harness.reservation.facade.navigate("/two").finished;

  harness.setDenyOne(true);

  const result = harness.reservation.facade.back();
  const committed = result.committed.catch((error) => error);
  const finished = result.finished.catch((error) => error);

  harness.driver.releaseMove();

  const [committedError, finishedError] = await Promise.all([committed, finished]);

  expect(committedError).toMatchObject({ name: "AbortError" });

  expect(finishedError).toBe(committedError);

  await Promise.resolve();

  expect(harness.window.location.pathname).toBe("/two");

  expect(harness.router.url).toBe("https://example.test/two");

  expect(harness.window.document.querySelector("main")?.textContent).toBe("/two");

  harness.dispose();
});

test("fallback tracks direct History writes made after reservation", async () => {
  const harness = createHarness();

  await harness.start();

  const first = harness.reservation.facade.currentEntry!;

  harness.window.history.pushState({ direct: "push" }, "", "/direct");

  const pushed = harness.reservation.facade.currentEntry!;
  let pushedDisposals = 0;

  pushed.addEventListener("dispose", () => pushedDisposals++);

  expect(pushed.url).toBe("https://example.test/direct");

  expect(pushed.getState()).toBeUndefined();

  expect(harness.window.history.state).toStrictEqual({ direct: "push" });

  expect(harness.reservation.facade.entries()).toStrictEqual([first, pushed]);

  expect(harness.router.url).toBe("https://example.test/one");

  expect(harness.window.document.querySelector("main")?.textContent).toBe("/one");

  harness.reservation.facade.updateCurrentEntry({ state: { api: "temporary" } });

  expect(pushed.getState()).toStrictEqual({ api: "temporary" });

  expect(harness.window.history.state).toStrictEqual({ direct: "push" });

  await harness.router.navigate("/direct", { history: "none" });

  expect(harness.reservation.facade.currentEntry).toBe(pushed);

  expect(harness.router.url).toBe("https://example.test/direct");

  expect(harness.window.document.querySelector("main")?.textContent).toBe("/direct");

  harness.window.history.replaceState({ direct: "replace" }, "", "/direct-replaced");

  const directlyReplaced = harness.reservation.facade.currentEntry!;

  expect(directlyReplaced).not.toBe(pushed);

  expect(directlyReplaced.key).toBe(pushed.key);

  expect(directlyReplaced.id).not.toBe(pushed.id);

  expect(pushedDisposals).toBe(1);

  expect(directlyReplaced.url).toBe("https://example.test/direct-replaced");

  expect(directlyReplaced.getState()).toBeUndefined();

  expect(harness.window.history.state).toStrictEqual({ direct: "replace" });

  expect(harness.router.url).toBe("https://example.test/direct");

  await harness.router.navigate("/direct-replaced", { history: "none" });

  expect(harness.router.url).toBe("https://example.test/direct-replaced");

  expect(harness.window.document.querySelector("main")?.textContent).toBe("/direct-replaced");

  harness.dispose();
});

test("fallback exact unchanged-fragment navigation keeps the page and skips route guards", async () => {
  const harness = createHarness();

  await harness.start();

  await harness.reservation.facade.navigate("#intro", { history: "replace" }).finished;

  harness.window.history.replaceState({ classic: "preserved" }, "", "/one#intro");

  const page = harness.window.document.querySelector("main");
  const guardsBefore = harness.getOneGuardCalls();
  let observed: { readonly sameDocument: boolean; readonly hashChange: boolean } | undefined;

  harness.reservation.facade.addEventListener("navigate", (event) => {
    const navigate = event as NavigateEvent;
    observed = {
      sameDocument: navigate.destination.sameDocument,
      hashChange: navigate.hashChange,
    };
  });

  const navigation = harness.reservation.facade.navigate("#intro", {
    state: { navigation: "new-entry" },
  });

  await navigation.finished;

  expect(harness.window.location.href).toBe("https://example.test/one#intro");

  expect(harness.router.url).toBe("https://example.test/one#intro");

  expect(harness.window.document.querySelector("main")).toBe(page);

  expect(harness.getOneGuardCalls()).toBe(guardsBefore);

  expect(observed).toStrictEqual({ sameDocument: true, hashChange: false });

  expect(harness.window.history.state).toBeNull();

  expect(harness.reservation.facade.currentEntry?.getState()).toStrictEqual({
    navigation: "new-entry",
  });

  harness.dispose();
});

test("fallback same-URL navigation without a fragment still performs route work", async () => {
  const harness = createHarness();

  await harness.start();

  const page = harness.window.document.querySelector("main");
  const guardsBefore = harness.getOneGuardCalls();

  await harness.reservation.facade.navigate("/one", { history: "replace" }).finished;

  expect(harness.window.location.href).toBe("https://example.test/one");

  expect(harness.router.url).toBe("https://example.test/one");

  expect(harness.window.document.querySelector("main")).not.toBe(page);

  expect(harness.getOneGuardCalls()).toBe(guardsBefore + 1);

  harness.dispose();
});

test("History fallback does not invent entries from before tracking began", async () => {
  const window = createWindow();

  window.history.pushState({ foreign: true }, "", "/before-startup");

  const harness = createHarness(window);

  await harness.start();

  const entries = harness.reservation.facade.entries();

  expect(entries).toHaveLength(1);

  expect(entries[0]?.url).toBe("https://example.test/one");

  expect(harness.reservation.facade.canGoBack).toBe(false);

  await expect(harness.reservation.facade.back().committed).rejects.toMatchObject({
    name: "InvalidStateError",
  });

  await expect(
    harness.reservation.facade.traverseTo("foreign-before-startup").finished,
  ).rejects.toMatchObject({ name: "InvalidStateError" });

  harness.dispose();
});

test("fallback events, state updates, and early traversal errors use Navigation fields", async () => {
  const harness = createHarness();

  await harness.start();

  const navigation = harness.reservation.facade;

  expect(harness.window.dispatchEvent(devHardReloadEvent(harness.window))).toBe(true);

  const initial = navigation.currentEntry!;
  const activation = navigation.activation;

  expect(activation?.entry.url).toBe("https://example.test/");

  const propertyHandled: string[] = [];

  const originalOnNavigate = () => {
    propertyHandled.push("original");
  };

  const replacementOnNavigate = () => {
    propertyHandled.push("replacement");
  };

  navigation.onnavigate = originalOnNavigate;

  expect(navigation.onnavigate).toBe(originalOnNavigate);

  navigation.onnavigate = replacementOnNavigate;

  expect(navigation.onnavigate).toBe(replacementOnNavigate);

  const observed: Array<{
    type: string;
    navigationType: string | null;
    destination?: string;
    from?: NavigationHistoryEntry;
    info?: unknown;
    signal?: AbortSignal;
  }> = [];

  navigation.addEventListener("navigate", (event) => {
    const current = event as NavigateEvent;

    observed.push({
      type: current.type,
      navigationType: current.navigationType,
      destination: current.destination.url,
      info: current.info,
      signal: current.signal,
    });
  });

  navigation.addEventListener("currententrychange", (event) => {
    const current = event as NavigationCurrentEntryChangeEvent;

    observed.push({
      type: current.type,
      navigationType: current.navigationType,
      from: current.from,
    });
  });

  const push = navigation.navigate("/two", { state: { page: 2 }, info: "push-info" });

  expect(navigation.transition?.navigationType).toBe("push");

  expect(navigation.transition?.from).toBe(initial);

  const second = await push.finished;

  expect(observed[0]).toMatchObject({
    type: "navigate",
    navigationType: "push",
    destination: "https://example.test/two",
    info: "push-info",
  });

  expect(observed[0]?.signal).toBeInstanceOf(AbortSignal);

  expect(observed[1]).toMatchObject({
    type: "currententrychange",
    navigationType: "push",
    from: initial,
  });

  expect(propertyHandled).toStrictEqual(["replacement"]);

  const historyState = harness.window.history.state;

  expect(historyState).toBeNull();

  navigation.updateCurrentEntry({ state: { updated: true } });

  expect(navigation.currentEntry).toBe(second);

  expect(second.getState()).toStrictEqual({ updated: true });

  expect(harness.window.history.state).toStrictEqual(historyState);

  expect(observed.at(-1)).toMatchObject({
    type: "currententrychange",
    navigationType: null,
    from: second,
  });

  navigation.onnavigate = null;

  expect(navigation.onnavigate).toBeNull();

  const back = navigation.back({ info: "back-info" });

  expect(await back.finished).toBe(initial);

  expect(observed.at(-2)).toMatchObject({
    type: "navigate",
    navigationType: "traverse",
    info: "back-info",
  });

  expect(propertyHandled).toStrictEqual(["replacement"]);

  const noBack = navigation.back();

  await expect(noBack.committed).rejects.toMatchObject({ name: "InvalidStateError" });

  await expect(noBack.finished).rejects.toMatchObject({ name: "InvalidStateError" });

  harness.dispose();
});

test("development hard reload acknowledges only a synchronous identity-matched native reload", () => {
  const window = createWindow();
  let reloadCalls = 0;
  let reloadInfo: unknown;
  let nativeEvent: NavigateEvent | undefined;
  let intercepted = false;
  let navigation!: EventTarget & Navigation;
  navigation = installNativeNavigation(window, (options) => {
    reloadCalls++;
    reloadInfo = options?.info;
    nativeEvent = nativeReloadEvent(options?.info, () => {
      intercepted = true;
    });

    navigation.dispatchEvent(nativeEvent);

    const entry = navigation.currentEntry!;
    return { committed: Promise.resolve(entry), finished: Promise.resolve(entry) };
  });
  const reservation = reserveNavigation(window);
  const request = devHardReloadEvent(window);

  expect(window.dispatchEvent(request)).toBe(false);

  expect(request.defaultPrevented).toBe(true);

  expect(reloadCalls).toBe(1);

  expect(typeof reloadInfo).toBe("object");

  expect(reloadInfo).not.toBeNull();

  expect(nativeEvent?.info).toBe(reloadInfo);

  expect(nativeEvent?.defaultPrevented).toBe(false);

  expect(intercepted).toBe(false);

  reservation.release();

  const afterRelease = devHardReloadEvent(window);

  expect(window.dispatchEvent(afterRelease)).toBe(true);

  expect(afterRelease.defaultPrevented).toBe(false);

  expect(reloadCalls).toBe(1);
});

test("development hard reload does not acknowledge a missing synchronous native event", () => {
  const window = createWindow();
  let reloadCalls = 0;
  let delayedInfo: unknown;
  let intercepted = false;
  let navigation!: EventTarget & Navigation;
  navigation = installNativeNavigation(window, (options) => {
    reloadCalls++;
    delayedInfo = options?.info;
    const entry = navigation.currentEntry!;
    return { committed: Promise.resolve(entry), finished: Promise.resolve(entry) };
  });
  const reservation = reserveNavigation(window);
  const request = devHardReloadEvent(window);

  expect(window.dispatchEvent(request)).toBe(true);

  expect(request.defaultPrevented).toBe(false);

  expect(reloadCalls).toBe(1);

  expect(typeof delayedInfo).toBe("object");

  expect(delayedInfo).not.toBeNull();

  navigation.dispatchEvent(
    nativeReloadEvent(delayedInfo, () => {
      intercepted = true;
    }),
  );

  expect(intercepted).toBe(false);

  reservation.release();
});

test("development hard reload leaves the trigger uncanceled when native reload throws", () => {
  const window = createWindow();
  let reloadCalls = 0;

  installNativeNavigation(window, () => {
    reloadCalls++;
    throw new Error("native reload failed before dispatch");
  });

  const reservation = reserveNavigation(window);
  const request = devHardReloadEvent(window);

  expect(window.dispatchEvent(request)).toBe(true);

  expect(request.defaultPrevented).toBe(false);

  expect(reloadCalls).toBe(1);

  reservation.release();
});

test("fallback Navigation state is separate from classic state and adopts a reloaded entry", async () => {
  const first = createHarness();

  await first.start();

  const firstTrackerId = first.history.read()?.trackerId;
  const navigation = first.reservation.facade;

  first.window.history.replaceState({ classic: "author" }, "", "/one");

  navigation.updateCurrentEntry({ state: { api: "coexisting" } });

  expect(first.window.history.state).toStrictEqual({ classic: "author" });

  expect(navigation.currentEntry?.getState()).toStrictEqual({ api: "coexisting" });

  await navigation.navigate("/two", { state: { api: "pushed" } }).finished;

  expect(first.window.history.state).toBeNull();

  expect(navigation.currentEntry?.getState()).toStrictEqual({ api: "pushed" });

  await navigation.navigate("/replaced", {
    history: "replace",
    state: { api: "replaced" },
  }).finished;

  expect(first.window.history.state).toBeNull();

  expect(navigation.currentEntry?.getState()).toStrictEqual({ api: "replaced" });

  const physical = nativeHistoryState(first.window);
  const physicalPathname = first.window.location.pathname;
  let popState: unknown;

  first.window.addEventListener("popstate", (event) => {
    popState = (event as PopStateEvent).state;
  });

  const back = navigation.back();

  first.driver.releaseMove();

  await back.finished;

  expect(first.window.history.state).toStrictEqual({ classic: "author" });

  expect(popState).toStrictEqual({ classic: "author" });

  expect(navigation.currentEntry?.getState()).toStrictEqual({ api: "coexisting" });

  const reloadedWindow = createWindow();
  const nativeReplace = reloadedWindow.history.replaceState;

  Reflect.apply(nativeReplace, reloadedWindow.history, [physical, "", physicalPathname]);

  const reloaded = createHarness(reloadedWindow);

  await reloaded.startPreservingCurrentEntry();

  expect(reloaded.window.history.state).toBeNull();

  expect(reloaded.history.read()?.trackerId).toBe(firstTrackerId);

  expect(reloaded.reservation.facade.currentEntry?.getState()).toStrictEqual({ api: "replaced" });

  first.dispose();

  reloaded.dispose();
});

test("fallback preserves nested structured-clone boundaries for History and Navigation state", async () => {
  const harness = createHarness();

  await harness.start();

  const classicInput = { nested: { owner: "classic" } };

  harness.window.history.replaceState(classicInput, "", "/one");

  classicInput.nested.owner = "mutated input";

  expect(harness.window.history.state).toStrictEqual({ nested: { owner: "classic" } });

  const navigationInput = { nested: { owner: "navigation" } };
  await harness.reservation.facade.navigate("/two", { state: navigationInput }).finished;
  navigationInput.nested.owner = "mutated input";
  const entry = harness.reservation.facade.currentEntry!;
  const exposed = entry.getState() as { nested: { owner: string } };

  expect(exposed).toStrictEqual({ nested: { owner: "navigation" } });

  exposed.nested.owner = "mutated read";

  expect(entry.getState()).toStrictEqual({ nested: { owner: "navigation" } });

  harness.dispose();
});

test("fallback interception waits before commit and after commit without collapsing result promises", async () => {
  const harness = createHarness();

  await harness.start();

  const navigation = harness.reservation.facade;
  let releasePrecommit!: () => void;
  let releaseHandler!: () => void;
  const precommit = new Promise<void>((resolve) => (releasePrecommit = resolve));
  const handler = new Promise<void>((resolve) => (releaseHandler = resolve));

  navigation.addEventListener("navigate", (event) => {
    const current = event as NavigateEvent;

    if (current.destination.url.endsWith("/two"))
      current.intercept({
        precommitHandler: async () => {
          await precommit;
          return undefined;
        },
        handler: async () => {
          await handler;
          return undefined;
        },
      });
  });

  const result = navigation.navigate("/two");
  let committed = false;
  let finished = false;

  void result.committed.then(() => (committed = true));

  void result.finished.then(() => (finished = true));

  await Promise.resolve();

  expect(committed).toBe(false);

  expect(harness.window.location.pathname).toBe("/one");

  releasePrecommit();

  await result.committed;

  expect(harness.window.location.pathname).toBe("/two");

  expect(finished).toBe(false);

  releaseHandler();

  await result.finished;

  expect(finished).toBe(true);

  harness.dispose();
});

test("a newer fallback navigation aborts a pending interception before it writes history", async () => {
  const harness = createHarness();

  await harness.start();

  const navigation = harness.reservation.facade;
  let releasePrecommit!: () => void;
  const precommit = new Promise<void>((resolve) => (releasePrecommit = resolve));

  navigation.addEventListener("navigate", (event) => {
    const current = event as NavigateEvent;

    if (current.destination.url.endsWith("/two"))
      current.intercept({
        precommitHandler: async () => {
          await precommit;
          return undefined;
        },
      });
  });

  const first = navigation.navigate("/two");
  const firstFailure = first.finished.catch((error) => error);
  const second = navigation.navigate("/three");

  releasePrecommit();

  expect(await firstFailure).toMatchObject({ name: "AbortError" });

  expect((await second.finished).url).toBe("https://example.test/three");

  expect(harness.window.location.pathname).toBe("/three");

  expect(harness.reservation.facade.entries().some((entry) => entry.url?.endsWith("/two"))).toBe(
    false,
  );

  harness.dispose();
});

test("fallback precommit redirect updates destination, history behavior, state, and info", async () => {
  const harness = createHarness();

  await harness.start();

  const navigation = harness.reservation.facade;
  const before = navigation.currentEntry!;
  let observed!: NavigateEvent;

  navigation.addEventListener(
    "navigate",
    (event) => {
      observed = event as NavigateEvent;

      observed.intercept({
        precommitHandler: async (controller) => {
          controller.redirect("/three", {
            history: "replace",
            state: { redirected: true },
            info: "redirect-info",
          });

          return undefined;
        },
      });
    },
    { once: true },
  );

  const result = navigation.navigate("/two", { state: { original: true }, info: "first-info" });
  const committed = await result.committed;

  expect(committed.url).toBe("https://example.test/three");

  expect(committed.key).toBe(before.key);

  expect(committed.id).not.toBe(before.id);

  expect(committed.getState()).toStrictEqual({ redirected: true });

  expect(observed.destination.url).toBe("https://example.test/three");

  expect(observed.destination.getState()).toStrictEqual({ redirected: true });

  expect(observed.navigationType).toBe("replace");

  expect(observed.info).toBe("redirect-info");

  expect((await result.finished).url).toBe("https://example.test/three");

  expect(harness.reservation.facade.canGoBack).toBe(false);

  harness.dispose();
});

test("fallback scroll is available only after interception commits and only once", async () => {
  const harness = createHarness();

  await harness.start();

  const navigation = harness.reservation.facade;
  let issued!: NavigateEvent;
  let releaseHandler!: () => void;
  const handler = new Promise<void>((resolve) => (releaseHandler = resolve));

  navigation.addEventListener(
    "navigate",
    (event) => {
      issued = event as NavigateEvent;

      issued.intercept({ handler: () => handler });

      expect(() => issued.scroll()).toThrow();
    },
    { once: true },
  );

  const result = navigation.navigate("/two");
  await result.committed;

  expect(() => issued.scroll()).not.toThrow();

  expect(() => issued.scroll()).toThrow();

  releaseHandler();

  await result.finished;

  expect(() => issued.scroll()).toThrow();

  harness.dispose();
});

test("fallback traversal rejects a precommit redirect with InvalidStateError", async () => {
  const harness = createHarness();

  await harness.start();

  const navigation = harness.reservation.facade;
  await navigation.navigate("/two").finished;

  navigation.addEventListener(
    "navigate",
    (event) => {
      const current = event as NavigateEvent;

      if (current.navigationType !== "traverse") return;

      current.intercept({ precommitHandler: (controller) => controller.redirect("/three") });
    },
    { once: true },
  );

  const result = navigation.back();

  await expect(result.committed).rejects.toMatchObject({ name: "InvalidStateError" });

  await expect(result.finished).rejects.toMatchObject({ name: "InvalidStateError" });

  expect(harness.window.location.pathname).toBe("/two");

  harness.dispose();
});

test("fallback omitted state is undefined and clone failures use rejected result promises", async () => {
  const harness = createHarness();

  await harness.start();

  const navigation = harness.reservation.facade;
  const entry = await navigation.navigate("/two").finished;

  expect(entry.getState()).toBeUndefined();

  const failure = navigation.navigate("/three", { state: () => undefined });

  await expect(failure.committed).rejects.toMatchObject({ name: "DataCloneError" });

  await expect(failure.finished).rejects.toMatchObject({ name: "DataCloneError" });

  expect(harness.window.location.pathname).toBe("/two");

  harness.dispose();
});

test("same-URL replace failures reject both promises before a history commit", async () => {
  const harness = createHarness();

  await harness.start();

  const current = harness.reservation.facade.currentEntry!;
  const failure = new Error("same URL preparation failed");

  harness.failOnePreparation(failure);

  const navigation = harness.reservation.facade.navigate("/one", { history: "replace" });
  const committed = navigation.committed.catch((error) => error);
  const finished = navigation.finished.catch((error) => error);

  expect(await committed).toBe(failure);

  expect(await finished).toBe(failure);

  expect(harness.reservation.facade.currentEntry).toBe(current);

  expect(harness.window.location.pathname).toBe("/one");

  expect(harness.router.url).toBe("https://example.test/one");

  harness.dispose();
});

test("a facade navigation requested during startup supersedes the initial route without hanging", async () => {
  const harness = createHarness();
  const queued = harness.reservation.facade.navigate("/two", { state: { queued: true } });

  await harness.start();

  expect(await queued.finished).toBe(harness.reservation.facade.currentEntry!);

  expect(harness.window.location.pathname).toBe("/two");

  expect(harness.window.document.querySelector("main")?.textContent).toBe("/two");

  harness.dispose();
});

test("bootstrap reserves Navigation and history before authored loaders and rejects a second app", async () => {
  const window = createWindow();
  let releaseConfiguration!: (value: object) => void;
  const config = new Promise<object>((resolve) => {
    releaseConfiguration = resolve;
  });
  const loadFailure = new Error("stop after reservation proof");
  const shell = defineComponent(() => null);
  const first = bootstrapApplication(
    window,
    {
      configuration: () => {
        const reservation = navigationReservationFor(window);

        expect(reservation).toBeDefined();

        expect(reservation?.mountPath).toBe("/app");

        expect(reservation?.facade.currentEntry?.url).toBe(window.location.href);

        return config;
      },
      shell: () => shell,
      routes: () => {
        throw loadFailure;
      },
    },
    { mountPath: "/app" },
  );

  expect(navigationReservationFor(window)).toBeDefined();

  await expect(
    bootstrapApplication(window, {
      configuration: () => ({}),
      shell: () => shell,
      routes: () => ({}) as never,
    }),
  ).rejects.toMatchObject({ kind: "navigation-reserved" });

  releaseConfiguration({});

  await expect(first).rejects.toBe(loadFailure);

  expect(navigationReservationFor(window)).toBeUndefined();
});

test("one compiled filesystem table starts and navigates correctly under two host mounts", async () => {
  const home = defineComponent((owner) =>
    element(owner, "main", { id: "mounted-home" }, [text(owner, () => "home")]),
  );
  const detail = defineComponent((owner) =>
    element(owner, "main", { id: "mounted-detail" }, [text(owner, () => "detail")]),
  );

  const moduleFor = (filename: string, component: typeof home): RouteTableModule => ({
    filename,
    load: async () => component,
  });

  const child: RouteTableNode = {
    id: "detail",
    pattern: "/detail",
    segments: [{ kind: "static", value: "detail" }],
    files: { page: moduleFor("/routes/detail/+page.tsx", detail) },
    children: [],
  };
  const root: RouteTableNode = {
    id: "root",
    pattern: "/",
    segments: [],
    files: { page: moduleFor("/routes/+page.tsx", home) },
    children: [child],
  };
  const routes: RouteTable = { version: 1, root, routes: [root, child] };
  const shell = defineComponent<{ children: Rendered }>((owner, props) =>
    element(owner, "html", {}, [
      element(owner, "head", {}, []),
      element(owner, "body", {}, [props.children()]),
    ]),
  );

  for (const mountPath of ["/first", "/second"]) {
    const window = createWindow(`https://example.test${mountPath}/`);

    window.document.documentElement.remove();

    const app = await bootstrapApplication(
      window,
      {
        configuration: () => ({}),
        shell: () => shell,
        routes: () => routes,
      },
      { mountPath },
    );

    try {
      expect(window.document.querySelector("#mounted-home")?.textContent).toBe("home");

      expect(window.location.pathname).toBe(`${mountPath}/`);

      const facade = navigationReservationFor(window)!.facade;

      expect(facade.href("/detail")).toBe(`${mountPath}/detail`);

      const outside = window.document.createElement("a");

      outside.setAttribute("href", `${mountPath}land/detail`);

      window.document.body.appendChild(outside);

      const MouseEventConstructor = (window as unknown as { MouseEvent: typeof MouseEvent })
        .MouseEvent;
      const outsideClick = new MouseEventConstructor("click", {
        bubbles: true,
        cancelable: true,
        button: 0,
      });

      outside.dispatchEvent(outsideClick);

      expect(outsideClick.defaultPrevented).toBe(false);

      const detailLink = window.document.createElement("a");

      detailLink.setAttribute("href", facade.href("/detail"));

      window.document.body.appendChild(detailLink);

      const detailRendered = waitForSelector(window, "#mounted-detail");
      const detailClick = new MouseEventConstructor("click", {
        bubbles: true,
        cancelable: true,
        button: 0,
      });

      detailLink.dispatchEvent(detailClick);

      expect(detailClick.defaultPrevented).toBe(true);

      await detailRendered;

      expect(window.location.pathname).toBe(`${mountPath}/detail`);

      expect(window.document.querySelector("#mounted-detail")?.textContent).toBe("detail");

      const homeLink = window.document.createElement("a");

      homeLink.setAttribute("href", facade.href("/"));

      window.document.body.appendChild(homeLink);

      const homeRendered = waitForSelector(window, "#mounted-home");
      const homeClick = new MouseEventConstructor("click", {
        bubbles: true,
        cancelable: true,
        button: 0,
      });

      homeLink.dispatchEvent(homeClick);

      expect(homeClick.defaultPrevented).toBe(true);

      await homeRendered;

      expect(window.location.pathname).toBe(`${mountPath}/`);

      expect(window.document.querySelector("#mounted-home")?.textContent).toBe("home");
    } finally {
      app.dispose();
    }
  }
});
