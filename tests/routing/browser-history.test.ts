import { expect, test } from "bun:test";
import {
  installBrowserHistory,
  type BrowserHistoryEntry,
  type BrowserHistoryTraversalResult,
} from "../../packages/hesperia/src/routing/browser-history.ts";

function nativeWindow(navigation: EventTarget): Window {
  return {
    navigation,
    NavigateEvent: { prototype: { intercept() {} } },
    NavigationPrecommitController: function NavigationPrecommitController() {},
  } as unknown as Window;
}

function entry(key: string, index: number, url: string, position?: number): BrowserHistoryEntry {
  return { key, index, url: `https://example.test${url}`, state: { key }, position };
}

function nativeEntry(
  key: string,
  index: number,
  url: string,
  state: unknown,
): NavigationHistoryEntry {
  return { key, index, url, getState: () => state } as NavigationHistoryEntry;
}

function programmaticNavigateEvent(
  key: string,
  index: number,
  url: string,
  signal: AbortSignal,
): NavigateEvent {
  const event = new Event("navigate") as NavigateEvent;

  Object.defineProperties(event, {
    navigationType: { value: "push" },
    canIntercept: { value: true },
    destination: {
      value: {
        key,
        index,
        url,
        sameDocument: true,
        getState: () => null,
      },
    },
    signal: { value: signal },
  });

  return event;
}

test("native traversal runs before commit with router-owned terminal effects", async () => {
  const navigation = new EventTarget() as EventTarget & {
    currentEntry: NavigationHistoryEntry;
  };
  navigation.currentEntry = {
    key: "a",
    index: 0,
    url: "https://example.test/a",
    getState: () => ({ key: "a" }),
  } as NavigationHistoryEntry;

  Object.defineProperty(navigation, "addEventListener", {
    value: EventTarget.prototype.addEventListener.bind(navigation),
  });

  Object.defineProperty(navigation, "removeEventListener", {
    value: EventTarget.prototype.removeEventListener.bind(navigation),
  });

  const window = nativeWindow(navigation);
  const callbacks: string[] = [];
  let intercepted!: NavigationInterceptOptions;
  let commit!: () => void;
  const adapter = installBrowserHistory({
    window,
    onTraverse: async (destination, signal) => {
      expect(destination.key).toBe("b");

      expect(signal.aborted).toBe(false);

      callbacks.push("transaction");

      return {
        status: "committed",
        afterCommit: () => {
          callbacks.push(`presentation:${navigation.currentEntry.key}`);
        },
      };
    },
    onCommit: () => callbacks.push("commit"),
  });

  const event = new Event("navigate") as NavigateEvent;

  Object.defineProperties(event, {
    navigationType: { value: "traverse" },
    canIntercept: { value: true },
    destination: {
      value: {
        key: "b",
        index: 1,
        url: "https://example.test/b",
        sameDocument: true,
        getState: () => ({ key: "b" }),
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

  expect(intercepted.focusReset).toBe("manual");

  expect(intercepted.scroll).toBe("manual");

  commit = () => undefined;

  await intercepted.precommitHandler!({
    addHandler(handler) {
      commit = handler;
    },

    redirect() {
      throw new Error("unexpected redirect");
    },
  } as NavigationPrecommitController);

  expect(callbacks).toStrictEqual(["transaction"]);

  navigation.currentEntry = {
    key: "b",
    index: 1,
    url: "https://example.test/b",
    getState: () => ({ key: "b" }),
  } as NavigationHistoryEntry;

  commit();

  expect(callbacks).toStrictEqual(["transaction", "presentation:b", "commit"]);

  expect(adapter.current?.key).toBe("b");

  adapter.dispose();
});

test("native programmatic commit associates logical state after the physical entry changes", () => {
  const navigation = new EventTarget() as EventTarget & {
    currentEntry: NavigationHistoryEntry;
  };
  navigation.currentEntry = nativeEntry("native-home", 0, "https://example.test/", {
    native: "home",
  });
  const adapter = installBrowserHistory({
    window: nativeWindow(navigation),
    onTraverse: () => ({ status: "committed" }),
  });
  const signal = new AbortController().signal;

  navigation.dispatchEvent(
    programmaticNavigateEvent("native-other", 1, "https://example.test/other", signal),
  );

  const logicalHistory = {
    trackerId: "router",
    id: 2,
    position: 1,
    url: "https://example.test/other",
    state: { draft: "saved" },
    navigationState: null,
  };
  const logicalEntry: BrowserHistoryEntry = {
    key: "hesperia-other",
    index: 1,
    url: logicalHistory.url,
    state: logicalHistory.state,
    position: 1,
    history: logicalHistory,
  };

  adapter.notifyCommitted(logicalEntry);

  expect(adapter.current).toMatchObject({
    key: "native-home",
    state: { native: "home" },
  });

  navigation.currentEntry = nativeEntry("native-other", 1, logicalEntry.url, { native: "other" });

  navigation.dispatchEvent(new Event("currententrychange"));

  expect(adapter.current).toMatchObject({
    key: "native-other",
    index: 1,
    url: logicalEntry.url,
    state: { native: "other" },
    position: 1,
    history: {
      ...logicalHistory,
      state: { draft: "saved" },
    },
  });

  expect(adapter.current?.key).not.toBe(logicalEntry.key);

  adapter.dispose();
});

test("native physical entry changes can precede logical commit notification", () => {
  const navigation = new EventTarget() as EventTarget & {
    currentEntry: NavigationHistoryEntry;
  };
  navigation.currentEntry = nativeEntry("native-home", 0, "https://example.test/", {
    native: "home",
  });
  const adapter = installBrowserHistory({
    window: nativeWindow(navigation),
    onTraverse: () => ({ status: "committed" }),
  });

  navigation.dispatchEvent(
    programmaticNavigateEvent(
      "native-other",
      1,
      "https://example.test/other",
      new AbortController().signal,
    ),
  );

  navigation.currentEntry = nativeEntry("native-other", 1, "https://example.test/other", {
    native: "other",
  });

  navigation.dispatchEvent(new Event("currententrychange"));

  expect(adapter.current).toMatchObject({
    key: "native-other",
    state: { native: "other" },
  });

  adapter.notifyCommitted({
    key: "hesperia-other",
    index: 1,
    url: "https://example.test/other",
    state: { draft: "saved" },
    position: 1,
    history: {
      trackerId: "router",
      id: 2,
      position: 1,
      url: "https://example.test/other",
      state: { draft: "saved" },
      navigationState: null,
    },
  });

  expect(adapter.current).toMatchObject({
    key: "native-other",
    state: { native: "other" },
    position: 1,
    history: {
      state: { draft: "saved" },
    },
  });

  adapter.dispose();
});

test("a redirected logical URL is not assigned to the outgoing native entry", async () => {
  const navigation = new EventTarget() as EventTarget & {
    currentEntry: NavigationHistoryEntry;
  };
  navigation.currentEntry = nativeEntry("native-home", 0, "https://example.test/", {
    native: "home",
  });
  let traversed: BrowserHistoryEntry | undefined;
  let intercepted!: NavigationInterceptOptions;
  const adapter = installBrowserHistory({
    window: nativeWindow(navigation),
    onTraverse: (destination) => {
      traversed = destination;
      return { status: "committed" };
    },
  });

  navigation.dispatchEvent(
    programmaticNavigateEvent(
      "native-requested",
      1,
      "https://example.test/requested",
      new AbortController().signal,
    ),
  );

  adapter.notifyCommitted({
    key: "hesperia-redirected",
    index: 1,
    url: "https://example.test/redirected",
    state: { route: "redirected" },
    position: 1,
  });

  expect(adapter.current?.key).toBe("native-home");

  navigation.currentEntry = nativeEntry("native-requested", 1, "https://example.test/requested", {
    native: "requested",
  });

  navigation.dispatchEvent(new Event("currententrychange"));

  const back = new Event("navigate") as NavigateEvent;

  Object.defineProperties(back, {
    navigationType: { value: "traverse" },
    canIntercept: { value: true },
    destination: {
      value: {
        key: "native-home",
        index: 0,
        url: "https://example.test/",
        sameDocument: true,
        getState: () => ({ native: "home" }),
      },
    },
    signal: { value: new AbortController().signal },
  });

  Object.defineProperty(back, "intercept", {
    value: (options: NavigationInterceptOptions) => {
      intercepted = options;
    },
  });

  navigation.dispatchEvent(back);

  await intercepted.precommitHandler!({
    addHandler() {},

    redirect() {},
  } as NavigationPrecommitController);

  expect(traversed).toMatchObject({
    key: "native-home",
    url: "https://example.test/",
    state: { native: "home" },
  });

  adapter.dispose();
});

test("an aborted native programmatic entry cannot capture a later logical commit", () => {
  const navigation = new EventTarget() as EventTarget & {
    currentEntry: NavigationHistoryEntry;
  };
  navigation.currentEntry = nativeEntry("native-home", 0, "https://example.test/", {
    native: "home",
  });
  const adapter = installBrowserHistory({
    window: nativeWindow(navigation),
    onTraverse: () => ({ status: "committed" }),
  });
  const aborted = new AbortController();

  navigation.dispatchEvent(
    programmaticNavigateEvent("native-aborted", 1, "https://example.test/other", aborted.signal),
  );

  aborted.abort();

  expect(adapter.current?.key).toBe("native-home");

  navigation.dispatchEvent(
    programmaticNavigateEvent(
      "native-committed",
      1,
      "https://example.test/other",
      new AbortController().signal,
    ),
  );

  adapter.notifyCommitted({
    key: "hesperia-other",
    index: 1,
    url: "https://example.test/other",
    state: { draft: "new attempt" },
    position: 1,
    history: {
      trackerId: "router",
      id: 2,
      position: 1,
      url: "https://example.test/other",
      state: { draft: "new attempt" },
      navigationState: null,
    },
  });

  expect(adapter.current?.key).toBe("native-home");

  navigation.currentEntry = nativeEntry("native-committed", 1, "https://example.test/other", {
    native: "committed",
  });

  navigation.dispatchEvent(new Event("currententrychange"));

  expect(adapter.current).toMatchObject({
    key: "native-committed",
    state: { native: "committed" },
    history: {
      state: { draft: "new attempt" },
    },
  });

  adapter.dispose();
});

test("a newer legacy traversal aborts the pending route transaction", async () => {
  const target = new EventTarget();
  let href = "https://example.test/a";
  const signals: AbortSignal[] = [];
  const entries = new Map([
    ["https://example.test/a", entry("a", 0, "/a", 0)],
    ["https://example.test/b", entry("b", 1, "/b", 1)],
    ["https://example.test/c", entry("c", 2, "/c", 2)],
  ]);
  const window = {
    location: {
      get href() {
        return href;
      },
    },
    history: { go() {} },
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
  } as unknown as Window;
  const adapter = installBrowserHistory({
    window,
    readEntry: (url) => entries.get(url),
    onTraverse: (_destination, signal) => {
      signals.push(signal);

      return new Promise<BrowserHistoryTraversalResult>(() => undefined);
    },
  });

  href = "https://example.test/b";

  target.dispatchEvent(new Event("popstate"));

  await Promise.resolve();

  expect(signals).toHaveLength(1);

  expect(signals[0]?.aborted).toBe(false);

  href = "https://example.test/c";

  target.dispatchEvent(new Event("popstate"));

  await Promise.resolve();

  expect(signals).toHaveLength(2);

  expect(signals[0]?.aborted).toBe(true);

  expect(signals[1]?.aborted).toBe(false);

  adapter.dispose();

  expect(signals[1]?.aborted).toBe(true);
});

test("native veto rejects the precommit without changing the adapter entry", async () => {
  const navigation = new EventTarget() as EventTarget & {
    currentEntry: NavigationHistoryEntry;
  };
  navigation.currentEntry = {
    key: "a",
    index: 0,
    url: "https://example.test/a",
    getState: () => null,
  } as NavigationHistoryEntry;
  const window = nativeWindow(navigation);
  let intercepted!: NavigationInterceptOptions;
  const adapter = installBrowserHistory({
    window,
    onTraverse: () => ({ status: "denied", reason: new Error("blocked") }),
  });
  const event = new Event("navigate") as NavigateEvent;

  Object.defineProperties(event, {
    navigationType: { value: "traverse" },
    canIntercept: { value: true },
    destination: {
      value: {
        key: "b",
        index: 1,
        url: "https://example.test/b",
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

  await expect(
    intercepted.precommitHandler!({
      addHandler() {},

      redirect() {},
    } as NavigationPrecommitController),
  ).rejects.toThrow("blocked");

  expect(adapter.current?.key).toBe("a");

  adapter.dispose();
});

test("aborted native traversals drop deferred terminal presentation", async () => {
  const navigation = new EventTarget() as EventTarget & {
    currentEntry: NavigationHistoryEntry;
  };
  navigation.currentEntry = {
    key: "a",
    index: 0,
    url: "https://example.test/a",
    getState: () => null,
  } as NavigationHistoryEntry;
  const window = nativeWindow(navigation);
  const callbacks: string[] = [];
  const controller = new AbortController();
  let intercepted!: NavigationInterceptOptions;
  const adapter = installBrowserHistory({
    window,
    onTraverse: () => ({
      status: "committed" as const,
      afterCommit: () => {
        callbacks.push("presentation");
      },
    }),
  });
  const event = new Event("navigate") as NavigateEvent;

  Object.defineProperties(event, {
    navigationType: { value: "traverse" },
    canIntercept: { value: true },
    destination: {
      value: {
        key: "b",
        index: 1,
        url: "https://example.test/b",
        sameDocument: true,
        getState: () => null,
      },
    },
    signal: { value: controller.signal },
  });

  Object.defineProperty(event, "intercept", {
    value: (options: NavigationInterceptOptions) => {
      intercepted = options;
    },
  });

  navigation.dispatchEvent(event);

  let commit!: () => void;

  await intercepted.precommitHandler!({
    addHandler(handler) {
      commit = handler;
    },

    redirect() {},
  } as NavigationPrecommitController);

  controller.abort();

  navigation.currentEntry = {
    key: "b",
    index: 1,
    url: "https://example.test/b",
    getState: () => null,
  } as NavigationHistoryEntry;

  commit();

  expect(callbacks).toStrictEqual([]);

  expect(adapter.current?.key).toBe("a");

  adapter.dispose();
});

test("legacy traversal restores the exact tracked position after a veto", async () => {
  const target = new EventTarget();
  let href = "https://example.test/a";
  let delta: number | undefined;
  const window = {
    location: {
      get href() {
        return href;
      },
    },
    history: {
      go(value: number) {
        delta = value;
      },
    },
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
  } as unknown as Window;
  const entries = new Map([
    ["https://example.test/a", entry("a", 0, "/a", 0)],
    ["https://example.test/b", entry("b", 1, "/b", 1)],
  ]);
  const adapter = installBrowserHistory({
    window,
    readEntry: (url) => entries.get(url),
    onTraverse: () => ({ status: "denied" }),
  });
  href = "https://example.test/b";

  target.dispatchEvent(new Event("popstate"));

  await Promise.resolve();

  await Promise.resolve();

  expect(delta).toBe(-1);

  expect(adapter.current?.key).toBe("a");

  adapter.dispose();
});

test("legacy traversal reports foreign entries instead of guessing a history delta", async () => {
  const target = new EventTarget();
  let href = "https://example.test/a";
  const errors: unknown[] = [];
  const window = {
    location: {
      get href() {
        return href;
      },
    },
    history: { go() {} },
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
  } as unknown as Window;
  const adapter = installBrowserHistory({
    window,
    readEntry: (url) => (url.endsWith("/a") ? entry("a", 0, "/a", 0) : undefined),
    onTraverse: () => ({ status: "committed" }),
    onError: (error) => errors.push(error),
  });
  href = "https://example.test/foreign";

  target.dispatchEvent(new Event("popstate"));

  await Promise.resolve();

  expect(errors).toHaveLength(1);

  expect(String(errors[0])).toContain("no tracked position");

  adapter.dispose();
});

test("partial native Navigation falls back to tracked History traversal", () => {
  const target = new EventTarget();
  const navigation = new EventTarget() as EventTarget & {
    currentEntry: NavigationHistoryEntry;
  };
  navigation.currentEntry = {
    key: "partial",
    index: 0,
    url: "https://example.test/a",
    getState: () => null,
  } as NavigationHistoryEntry;
  const window = {
    navigation,
    NavigateEvent: { prototype: { intercept() {} } },
    location: { href: "https://example.test/a" },
    history: { go() {} },
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
  } as unknown as Window;
  const adapter = installBrowserHistory({
    window,
    readEntry: (url) => (url.endsWith("/a") ? entry("a", 0, "/a", 0) : undefined),
    onTraverse: () => ({ status: "committed" }),
  });

  expect(adapter.mode).toBe("history");

  adapter.dispose();
});

test("legacy traversal runs terminal presentation after the accepted entry", async () => {
  const target = new EventTarget();
  let href = "https://example.test/a";
  const callbacks: string[] = [];
  const window = {
    location: {
      get href() {
        return href;
      },
    },
    history: { go() {} },
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
  } as unknown as Window;
  const entries = new Map([
    ["https://example.test/a", entry("a", 0, "/a", 0)],
    ["https://example.test/b", entry("b", 1, "/b", 1)],
  ]);
  let resolveCommitted!: () => void;
  const committed = new Promise<void>((resolve) => {
    resolveCommitted = resolve;
  });
  const adapter = installBrowserHistory({
    window,
    readEntry: (url) => entries.get(url),
    onTraverse: () => ({
      status: "committed" as const,
      afterCommit: () => {
        callbacks.push("presentation");
      },
    }),
    onCommit: () => {
      callbacks.push("commit");

      resolveCommitted();
    },
  });
  href = "https://example.test/b";

  target.dispatchEvent(new Event("popstate"));

  await committed;

  expect(callbacks).toStrictEqual(["presentation", "commit"]);

  adapter.dispose();
});

test("legacy fragment traversal waits for hashchange before terminal presentation", async () => {
  const target = new EventTarget();
  let href = "https://example.test/a#one";
  const callbacks: string[] = [];
  const window = {
    location: {
      get href() {
        return href;
      },
    },
    history: { go() {} },
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
  } as unknown as Window;
  const entries = new Map([
    ["https://example.test/a#one", entry("a", 0, "/a#one", 0)],
    ["https://example.test/a#two", entry("b", 1, "/a#two", 1)],
  ]);
  const adapter = installBrowserHistory({
    window,
    readEntry: (url) => entries.get(url),
    onTraverse: () => ({
      status: "committed" as const,
      afterCommit: () => {
        callbacks.push("presentation");
      },
    }),
    onCommit: () => callbacks.push("commit"),
  });
  href = "https://example.test/a#two";

  target.dispatchEvent(new Event("popstate"));

  await Promise.resolve();

  await Promise.resolve();

  expect(callbacks).toStrictEqual([]);

  const unrelatedHashChange = new Event("hashchange");

  Object.defineProperty(unrelatedHashChange, "newURL", {
    value: "https://example.test/a#other",
  });

  target.dispatchEvent(unrelatedHashChange);

  expect(callbacks).toStrictEqual([]);

  const expectedHashChange = new Event("hashchange");

  Object.defineProperty(expectedHashChange, "newURL", {
    value: "https://example.test/a#two",
  });

  target.dispatchEvent(expectedHashChange);

  await Promise.resolve();

  expect(callbacks).toStrictEqual(["presentation", "commit"]);

  expect(adapter.current?.key).toBe("b");

  adapter.dispose();
});

test("legacy fragment traversal keeps the hash barrier while guards are pending", async () => {
  const target = new EventTarget();
  let href = "https://example.test/a#one";
  const callbacks: string[] = [];
  let resolveTraversal!: (result: BrowserHistoryTraversalResult) => void;
  const traversal = new Promise<BrowserHistoryTraversalResult>((resolve) => {
    resolveTraversal = resolve;
  });
  const window = {
    location: {
      get href() {
        return href;
      },
    },
    history: { go() {} },
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
  } as unknown as Window;
  const entries = new Map([
    ["https://example.test/a#one", entry("a", 0, "/a#one", 0)],
    ["https://example.test/a#two", entry("b", 1, "/a#two", 1)],
  ]);
  const adapter = installBrowserHistory({
    window,
    readEntry: (url) => entries.get(url),
    onTraverse: () => traversal,
    onCommit: () => callbacks.push("commit"),
  });
  href = "https://example.test/a#two";

  target.dispatchEvent(new Event("popstate"));

  await Promise.resolve();

  target.dispatchEvent(new Event("hashchange"));

  expect(callbacks).toStrictEqual([]);

  resolveTraversal({
    status: "committed",
    afterCommit: () => {
      callbacks.push("presentation");
    },
  });

  await Promise.resolve();

  await Promise.resolve();

  await Promise.resolve();

  await Promise.resolve();

  expect(callbacks).toStrictEqual(["presentation", "commit"]);

  expect(adapter.current?.key).toBe("b");

  adapter.dispose();
});
