import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createInternalStyleRuntime } from "../../packages/hesperia/src/runtime/style.ts";

const emptyPlan = { assets: [], owners: [], entries: [], compositions: [] };
const windows: Window[] = [];

afterEach(() => {
  for (const window of windows.splice(0)) window.close();
});

function revisionWithTrackedAbortListeners() {
  const window = new Window();

  windows.push(window);

  const controller = new AbortController();
  const active = new Set<unknown>();
  const add = controller.signal.addEventListener.bind(controller.signal);
  const remove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ) => {
    if (!listener) return;

    if (type === "abort") active.add(listener);

    return add(type, listener, options);
  }) as typeof add;
  controller.signal.removeEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ) => {
    if (!listener) return;

    if (type === "abort") active.delete(listener);

    return remove(type, listener, options);
  }) as typeof remove;

  const runtime = createInternalStyleRuntime(emptyPlan);
  return {
    active,
    controller,
    prepare: () =>
      runtime.prepareRevision(
        emptyPlan,
        window.document.head as unknown as HTMLHeadElement,
        controller.signal,
      ),
  };
}

test("releasing a prepared revision removes its registered abort listener", async () => {
  const tracked = revisionWithTrackedAbortListeners();
  const revision = await tracked.prepare();

  expect(tracked.active.size).toBe(1);

  revision.release();

  expect(tracked.active.size).toBe(0);
});

test("publishing a prepared revision removes its registered abort listener", async () => {
  const tracked = revisionWithTrackedAbortListeners();
  const revision = await tracked.prepare();

  expect(tracked.active.size).toBe(1);

  revision.publish();

  expect(tracked.active.size).toBe(0);
});

test("aborting a prepared revision removes its registered listener and invalidates its handle", async () => {
  const tracked = revisionWithTrackedAbortListeners();
  const revision = await tracked.prepare();

  expect(tracked.active.size).toBe(1);

  tracked.controller.abort();

  expect(tracked.active.size).toBe(0);

  let failure: unknown;

  try {
    revision.publish();
  } catch (error) {
    failure = error;
  }

  expect(failure).toMatchObject({ kind: "style-revision-stale" });
});
