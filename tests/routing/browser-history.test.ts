import { expect, test } from "bun:test";
import {
  installBrowserHistory,
  type BrowserHistoryEntry,
  type BrowserHistoryTraversalResult,
} from "../../src/routing/browser-history.ts";

function entry(key: string, index: number, url: string, position?: number): BrowserHistoryEntry {
  return { key, index, url: `https://example.test${url}`, state: { key }, position };
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
  const window = {
    navigation,
  } as unknown as Window;
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
        afterCommit: () => callbacks.push(`presentation:${navigation.currentEntry.key}`),
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
  const window = { navigation } as unknown as Window;
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
  const window = { navigation } as unknown as Window;
  const callbacks: string[] = [];
  const controller = new AbortController();
  let intercepted!: NavigationInterceptOptions;
  const adapter = installBrowserHistory({
    window,
    onTraverse: () => ({
      status: "committed" as const,
      afterCommit: () => callbacks.push("presentation"),
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
  const adapter = installBrowserHistory({
    window,
    readEntry: (url) => entries.get(url),
    onTraverse: () => ({
      status: "committed" as const,
      afterCommit: () => callbacks.push("presentation"),
    }),
    onCommit: () => callbacks.push("commit"),
  });
  href = "https://example.test/b";
  target.dispatchEvent(new Event("popstate"));
  await Promise.resolve();
  await Promise.resolve();
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
      afterCommit: () => callbacks.push("presentation"),
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
    afterCommit: () => callbacks.push("presentation"),
  });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(callbacks).toStrictEqual(["presentation", "commit"]);
  expect(adapter.current?.key).toBe("b");
  adapter.dispose();
});
