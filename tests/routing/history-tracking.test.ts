import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { installHistoryTracking, type HistoryEntry } from "../../src/routing/history.ts";
import { Router } from "../../src/routing/index.ts";
import { installHistoryCloneAdapter } from "./history-platform.ts";

const windows: Window[] = [];

afterEach(() => {
  for (const window of windows.splice(0)) window.close();
});

function browser() {
  const window = new Window({ url: "https://example.test/" });
  windows.push(window);
  installHistoryCloneAdapter(window as unknown as globalThis.Window);
  return window as unknown as globalThis.Window;
}

function write(
  tracker: ReturnType<typeof installHistoryTracking>,
  url: string,
  state: unknown,
  disposition: "push" | "replace",
): HistoryEntry {
  const entry = tracker.create(url, state, disposition);
  if (!entry) throw new Error("Expected a tracked history entry");
  tracker.apply(entry, disposition);
  return entry;
}

test("repeated installation shares one patch and releases it only after the final lease", () => {
  const window = browser();
  const first = installHistoryTracking(window);
  const patchedPush = window.history.pushState;
  const second = installHistoryTracking(window);

  expect(second).not.toBe(first);
  expect(window.history.pushState).toBe(patchedPush);
  window.history.pushState({ value: "tracked" }, "", "/tracked");
  expect(second.read()?.state).toStrictEqual({ value: "tracked" });

  first.release();
  first.release();
  expect(window.history.pushState).toBe(patchedPush);
  window.history.replaceState({ value: "still-tracked" }, "", "/still-tracked");
  expect(second.read()?.state).toStrictEqual({ value: "still-tracked" });

  second.release();
  expect(window.history.pushState).not.toBe(patchedPush);

  const reinstalled = installHistoryTracking(window);
  const beforeReplace = reinstalled.read()!;
  write(reinstalled, "/reinstalled", { value: "replaced" }, "replace");
  const afterReplace = reinstalled.read()!;
  expect(afterReplace.trackerId).toBe(beforeReplace.trackerId);
  expect(afterReplace.id).toBe(beforeReplace.id);
  expect(afterReplace.position).toBe(beforeReplace.position);
  reinstalled.release();
});

test("replace keeps the physical entry identity and position", () => {
  const window = browser();
  const tracker = installHistoryTracking(window);
  write(tracker, "/first", { step: 1 }, "push");
  const before = tracker.read()!;

  write(tracker, "/replacement", { step: 2 }, "replace");
  const after = tracker.read()!;

  expect(after.id).toBe(before.id);
  expect(after.position).toBe(before.position);
  expect(after.url).toBe("https://example.test/replacement");
  expect(after.state).toStrictEqual({ step: 2 });
  tracker.release();
});

test("a native URL failure leaves the physical entry and tracker unchanged", () => {
  const window = browser();
  const tracker = installHistoryTracking(window);
  write(tracker, "/stable", { stable: true }, "replace");
  const before = tracker.read()!;
  const nativeState = window.history.state;

  expect(() =>
    window.history.pushState({ failed: true }, "", "https://other.test/failed"),
  ).toThrow();
  expect(tracker.read()).toStrictEqual(before);
  expect(window.location.href).toBe(before.url);
  expect(window.history.state).toStrictEqual(nativeState);
  tracker.release();
});

test("marker-shaped author state remains author state", () => {
  const window = browser();
  const tracker = installHistoryTracking(window);
  const authorState = {
    __hesperiaHistory: { trackerId: "author-value", id: 7, position: 9 },
    state: "author",
  };

  window.history.pushState(authorState, "", "/author");
  const entry = tracker.read()!;

  expect(entry.state).toStrictEqual(authorState);
  expect(window.history.state).toMatchObject({ state: authorState });
  tracker.release();
});

test("borrowed native wrappers retain native invalid-receiver errors and do not track", () => {
  const window = browser();
  const tracker = installHistoryTracking(window);
  write(tracker, "/stable", { stable: true }, "replace");
  const before = tracker.read()!;
  const borrowedPush = window.history.pushState;
  const borrowedReplace = window.history.replaceState;

  expect(() => borrowedPush.call({} as History, { value: 1 }, "", "/push")).toThrow();
  expect(() => borrowedReplace.call({} as History, { value: 2 }, "", "/replace")).toThrow();
  expect(tracker.read()).toStrictEqual(before);
  tracker.release();
});

test("startup stamps the initial entry and keeps another window's metadata as author data", () => {
  const firstWindow = browser();
  const first = installHistoryTracking(firstWindow);
  const author = firstWindow.history.state;
  const secondWindow = browser();
  secondWindow.history.replaceState(author, "", "/initial");
  const second = installHistoryTracking(secondWindow);

  expect(second.read()?.state).toStrictEqual(author);
  expect(second.read()?.position).toBe(0);
  secondWindow.history.pushState({ next: true }, "", "/next");
  expect(second.read()?.position).toBe(1);
  expect(second.read()?.state).toStrictEqual({ next: true });
  first.release();
  second.release();
});

test("router disposal releases its patch even when outgoing cleanup throws", async () => {
  const window = browser();
  const originalPush = window.history.pushState;
  const fault = new Error("outgoing cleanup failed");
  const router = new Router({
    window,
    resolve: () => ({
      params: {},
      prepare: () => ({
        owners: [],
        install() {},
        dispose() {
          throw fault;
        },
      }),
    }),
  });
  await router.navigate("/active", { history: "replace" });
  expect(window.history.pushState).not.toBe(originalPush);
  expect(() => router.dispose()).toThrow(fault);
  expect(window.history.pushState).toBe(originalPush);
  expect(() => router.dispose()).not.toThrow();
});
