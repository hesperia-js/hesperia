import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { installHistoryCloneAdapter } from "./history-platform.ts";
import {
  Router,
  type PreparedRoute,
  type RouteCandidate,
  type RouteInputs,
} from "../../src/routing/index.ts";
import { createClient } from "../../src/client.ts";
import {
  componentItem,
  createRuntimeRoot,
  element,
  prepareTree,
  region,
  type RuntimeRoot,
} from "../../src/runtime/dom.ts";
import { asyncBoundary } from "../../src/runtime/async.ts";
import { defineComponent } from "../../src/runtime/components.ts";
import { Owner } from "../../src/runtime/owner.ts";

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

function browser(): { window: globalThis.Window; runtime: RuntimeRoot; events: string[] } {
  const window = new Window({ url: "https://example.test/" });
  windows.push(window);
  installHistoryCloneAdapter(window as unknown as globalThis.Window);
  window.scrollTo = (() => undefined) as typeof window.scrollTo;
  const target = window.document.body as unknown as Element;
  const runtime = createRuntimeRoot(target, { development: false });
  runtime.owner.commit();
  return { window: window as unknown as globalThis.Window, runtime, events: [] };
}

function preparedPage(
  runtime: RuntimeRoot,
  window: globalThis.Window,
  inputs: RouteInputs,
  label: string,
  events: string[],
): PreparedRoute & { readonly owner: Owner } {
  const owner = new Owner(runtime.context, runtime.owner, `page:${label}`);
  const tree = prepareTree(owner, () => {
    const client = createClient(owner);
    client.effect(() => {
      events.push(`effect:${label}`);
    });
    const node = element(owner, "main", {}, [
      `${label}:${inputs.queryParams().get("tab") ?? "none"}`,
    ]);
    node.dataset.route = label;
    return node;
  });
  return {
    owner,
    owners: [owner],
    install() {
      events.push(`install:${label}`);
      tree.install(window.document.body);
    },
    dispose(reason) {
      events.push(`dispose:${label}`);
      tree.dispose(reason);
    },
  };
}

function preparedAsyncPage(
  runtime: RuntimeRoot,
  window: globalThis.Window,
  inputs: RouteInputs,
  events: string[],
) {
  const owner = new Owner(runtime.context, runtime.owner, "page:async");
  let button!: HTMLButtonElement;
  const childGate = deferred<void>();
  const childBodyDone = deferred<void>();
  const Child = defineComponent(
    async (childOwner) => {
      await childGate.promise;
      const client = createClient(childOwner);
      const binding = client.bind<HTMLButtonElement>();
      client.effect(() => {
        events.push("effect:async-child");
      });
      childOwner.onCommit(() => {
        events.push("commit:async-child");
      });
      button = element(
        childOwner,
        "button",
        {
          bind: binding,
          "on:click": () => {
            events.push("click:async-child");
          },
        },
        [inputs.queryParams().get("tab") ?? "async"],
      );
      childBodyDone.resolve();
      return button;
    },
    { async: true },
  );
  const tree = prepareTree(owner, () => {
    owner.onCommit(() => {
      events.push("commit:async-page");
    });
    return asyncBoundary(
      owner,
      "boundary",
      (loadingOwner) => element(loadingOwner, "i", {}, ["loading"]),
      (boundaryOwner) =>
        region(boundaryOwner, "children", () => componentItem(Child, {}, "child", "child")),
    );
  });
  const contentReady = new Promise<void>((resolve) => {
    const Observer = window.document.defaultView!.MutationObserver;
    const observer = new Observer(() => {
      observer.disconnect();
      resolve();
    });
    observer.observe(tree.fragment, { childList: true, subtree: true });
  });
  return {
    owner,
    tree,
    button: () => button,
    childGate,
    childBodyDone,
    contentReady,
  };
}

test("router keeps the committed page visible while a detached candidate waits, then activates and replaces it", async () => {
  const { window, runtime, events } = browser();
  const entered = deferred<void>();
  const ready = deferred<PreparedRoute>();
  let slow!: PreparedRoute & { readonly owner: Owner };
  const router = new Router({
    window,
    resolve: (url): RouteCandidate => ({
      params: {},
      prepare(inputs) {
        const prepared = preparedPage(runtime, window, inputs, url.pathname, events);
        if (url.pathname === "/slow") {
          slow = prepared;
          entered.resolve();
          return ready.promise;
        }
        return prepared;
      },
    }),
  });

  await router.navigate("/current", { history: "replace" });
  await runtime.context.scheduler.settled();
  expect(window.document.body.textContent).toBe("/current:none");
  expect(events).toStrictEqual(["install:/current", "effect:/current"]);
  events.length = 0;

  const pending = router.navigate("/slow", { history: "push" });
  await entered.promise;
  expect(window.document.body.textContent).toBe("/current:none");
  expect(slow.owner.state).toBe("building");
  expect(window.document.body.querySelector('[data-route="/slow"]')).toBeNull();
  expect(events).toStrictEqual([]);

  const fast = await router.navigate("/fast", { history: "replace" });
  expect(fast.status).toBe("committed");
  await runtime.context.scheduler.settled();
  expect(window.document.body.textContent).toBe("/fast:none");
  expect(events).toStrictEqual(["install:/fast", "dispose:/current", "effect:/fast"]);
  expect(slow.owner.state).toBe("building");

  ready.resolve(slow);
  expect((await pending).status).toBe("cancelled");
  expect(slow.owner.state).toBe("destroyed");
  expect(window.document.body.textContent).toBe("/fast:none");
  router.dispose();
});

test("router disposes a failed installed candidate without removing the committed page", async () => {
  const { window, runtime, events } = browser();
  const failure = new Error("candidate install failed");
  let failed!: PreparedRoute & { readonly owner: Owner };
  const router = new Router({
    window,
    resolve: (url): RouteCandidate => ({
      params: {},
      prepare(inputs) {
        const prepared = preparedPage(runtime, window, inputs, url.pathname, events);
        if (url.pathname !== "/failed") return prepared;
        failed = prepared;
        return {
          ...prepared,
          install() {
            prepared.install();
            throw failure;
          },
        };
      },
    }),
  });

  await router.navigate("/current", { history: "replace" });
  await runtime.context.scheduler.settled();
  events.length = 0;
  await expect(router.navigate("/failed", { history: "push" })).rejects.toBe(failure);
  expect(window.document.body.textContent).toBe("/current:none");
  expect(window.document.body.querySelector('[data-route="/failed"]')).toBeNull();
  expect(failed.owner.state).toBe("destroyed");
  expect(events).toStrictEqual(["install:/failed", "dispose:/failed"]);
  router.dispose();
});

test("nested async content settles detached and activates hooks and events only after installation", async () => {
  const { window, runtime, events } = browser();
  const entered = deferred<void>();
  const installGate = deferred<void>();
  let candidate!: ReturnType<typeof preparedAsyncPage>;
  const router = new Router({
    window,
    resolve: (url): RouteCandidate => ({
      params: {},
      prepare(inputs) {
        if (url.pathname === "/current")
          return preparedPage(runtime, window, inputs, "current", events);
        candidate = preparedAsyncPage(runtime, window, inputs, events);
        entered.resolve();
        return candidate.contentReady.then(async () => {
          await installGate.promise;
          return {
            owners: [candidate.owner],
            install() {
              candidate.tree.install(window.document.body);
            },
            dispose(reason) {
              candidate.tree.dispose(reason);
            },
          } satisfies PreparedRoute;
        });
      },
    }),
  });

  await router.navigate("/current", { history: "replace" });
  await runtime.context.scheduler.settled();
  events.length = 0;
  const pending = router.navigate("/async?tab=ready", { history: "push" });
  await entered.promise;
  expect(window.document.body.textContent).toBe("current:none");
  expect(candidate.button()).toBeUndefined();
  expect(events).toStrictEqual([]);

  candidate.childGate.resolve();
  await candidate.childBodyDone.promise;
  await candidate.contentReady;
  expect(candidate.button().isConnected).toBe(false);
  candidate.button().click();
  expect(events).toStrictEqual([]);

  installGate.resolve();
  expect((await pending).status).toBe("committed");
  await runtime.context.scheduler.settled();
  expect(candidate.button().isConnected).toBe(true);
  candidate.button().click();
  expect(events).toStrictEqual([
    "commit:async-child",
    "commit:async-page",
    "dispose:current",
    "effect:async-child",
    "click:async-child",
  ]);
  expect(window.document.body.textContent).toBe("ready");
  router.dispose();
});
