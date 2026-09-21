import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createClient } from "../../src/client.ts";
import { asyncBoundary, runAsyncBody } from "../../src/runtime/async.ts";
import { errorBoundary } from "../../src/runtime/error-boundary.ts";
import {
  component,
  createRuntimeRoot,
  defineComponent,
  element,
  mount,
  prepareTree,
  text,
} from "../../src/runtime/dom.ts";
import { Owner } from "../../src/runtime/owner.ts";
import { registerFrameworkAwaitable } from "../../src/data/protocol.ts";

const windows: Window[] = [];
afterEach(() => {
  for (const window of windows.splice(0)) window.close();
});

function container(): Element {
  const window = new Window();
  windows.push(window);
  return window.document.body as unknown as Element;
}

test("body and cleanup failures create at most one local error view and forward the cleanup failure", async () => {
  const target = container();
  const bodyFailure = new Error("body failed");
  const cleanupFailure = new Error("cleanup failed");
  const unhandled: unknown[] = [];
  const events: string[] = [];
  const App = defineComponent((owner) =>
    errorBoundary(
      owner,
      "error",
      (viewOwner, error) => {
        events.push("error body");
        const node = element(viewOwner, "span", {}, [String(error())]);
        createClient(viewOwner).effect(() => {
          events.push(`error effect:${node.isConnected}`);
        });
        return node;
      },
      (contentOwner) => {
        createClient(contentOwner).cleanup(() => {
          throw cleanupFailure;
        });
        throw bodyFailure;
      },
    ),
  );
  const app = mount(target, App, {}, { onError: (error) => unhandled.push(error) });
  await app.settled();
  expect(events).toStrictEqual(["error body", "error effect:true"]);
  expect(target.textContent).toBe(String(bodyFailure));
  expect(unhandled).toHaveLength(1);
  expect(unhandled[0]).toBeInstanceOf(AggregateError);
  expect((unhandled[0] as AggregateError).errors).toStrictEqual([cleanupFailure]);
  app.dispose();
});

test("a cleanup fault during an effect failure can replace an enclosing boundary without reviving the inner view", async () => {
  const target = container();
  const cleanupFailure = new Error("cleanup failed");
  const unhandled: unknown[] = [];
  const caught: unknown[] = [];
  let fail!: () => void;
  let innerViews = 0;
  const App = defineComponent((owner) =>
    errorBoundary(
      owner,
      "outer",
      (_viewOwner, error) => {
        caught.push(error());
        return "outer error";
      },
      (outerContent) =>
        errorBoundary(
          outerContent,
          "inner",
          () => {
            innerViews++;
            return "inner error";
          },
          (innerContent) => {
            const state = createClient(innerContent).state(false);
            fail = () => state.set(true);
            createClient(innerContent).effect(() => {
              if (state()) throw new Error("effect failed");
            });
            createClient(innerContent).cleanup(() => {
              throw cleanupFailure;
            });
            return "content";
          },
        ),
    ),
  );
  const app = mount(target, App, {}, { onError: (error) => unhandled.push(error) });
  await app.settled();
  fail();
  await app.settled();
  expect(target.textContent).toBe("outer error");
  expect(innerViews).toBe(0);
  expect(caught).toHaveLength(1);
  expect((caught[0] as AggregateError).errors).toStrictEqual([cleanupFailure]);
  expect(unhandled).toStrictEqual([]);
  app.dispose();
});

test("a body fault cleans its partial content before constructing the error view", async () => {
  const target = container();
  const failure = new Error("body failed");
  const events: string[] = [];
  let readError!: () => unknown;
  const App = defineComponent((owner) =>
    errorBoundary(
      owner,
      "error",
      (viewOwner, error) => {
        readError = error;
        events.push("error body");
        createClient(viewOwner).effect(() => {
          events.push(`error effect:${target.textContent}`);
        });
        return element(viewOwner, "p", {}, [text(viewOwner, () => (error() as Error).message)]);
      },
      (contentOwner) => {
        createClient(contentOwner).cleanup(() => events.push("content cleanup"));
        createClient(contentOwner).effect(() => {
          events.push("forbidden content effect");
        });
        element(contentOwner, "input");
        throw failure;
      },
    ),
  );
  const app = mount(target, App, {});
  await app.settled();
  expect(events).toStrictEqual(["content cleanup", "error body", "error effect:body failed"]);
  expect(target.querySelector("input")).toBeNull();
  expect(readError()).toBe(failure);
  app.dispose();
  expect(target.childNodes).toHaveLength(0);
  expect(readError).toThrow(/destroyed/);
});

test("an effect fault replaces only its boundary and cleans connected content parent first", async () => {
  const target = container();
  const events: string[] = [];
  let fail!: () => void;
  const Child = defineComponent((owner) => {
    const node = element(owner, "input");
    createClient(owner).cleanup(() => events.push(`child cleanup:${node.isConnected}`));
    return node;
  });
  const App = defineComponent((owner) => [
    element(owner, "aside", {}, ["sibling"]),
    errorBoundary(
      owner,
      "error",
      (viewOwner, error) => {
        events.push("error body");
        return element(viewOwner, "p", {}, [String(error())]);
      },
      (contentOwner) => {
        const state = createClient(contentOwner).state(false);
        fail = () => state.set(true);
        createClient(contentOwner).cleanup(() =>
          events.push(`parent cleanup:${target.querySelector("input")?.isConnected}`),
        );
        createClient(contentOwner).effect(() => {
          if (state()) throw "effect failed";
        });
        return component(contentOwner, Child, {}, "child");
      },
    ),
  ]);
  const app = mount(target, App, {});
  await app.settled();
  const sibling = target.querySelector("aside");
  fail();
  await app.settled();
  expect(events).toStrictEqual(["parent cleanup:true", "child cleanup:true", "error body"]);
  expect(target.textContent).toBe("siblingeffect failed");
  expect(target.querySelector("aside")).toBe(sibling);
  app.dispose();
});

test("an error view's own failure reaches the enclosing boundary", async () => {
  const target = container();
  const seen: unknown[] = [];
  const failure = new Error("error view failed");
  const App = defineComponent((owner) =>
    errorBoundary(
      owner,
      "outer",
      (_viewOwner, error) => {
        seen.push(error());
        return "outer error";
      },
      (outerContent) =>
        errorBoundary(
          outerContent,
          "inner",
          () => {
            throw failure;
          },
          () => {
            throw new Error("content failed");
          },
        ),
    ),
  );
  const app = mount(target, App, {});
  await app.settled();
  expect(seen).toStrictEqual([failure]);
  expect(target.textContent).toBe("outer error");
  app.dispose();
});

test("a rejected async child replaces its loading view and never activates failed content", async () => {
  const target = container();
  let reject!: (error: unknown) => void;
  const query = new Promise<string>((_resolve, no) => {
    reject = no;
  });
  let installed!: () => void;
  const errorInstalled = new Promise<void>((resolve) => {
    installed = resolve;
  });
  const events: string[] = [];
  const Child = defineComponent(
    (owner) =>
      runAsyncBody(owner, function* () {
        createClient(owner).effect(() => {
          events.push("forbidden child effect");
        });
        yield registerFrameworkAwaitable(query, owner, "query");
        return "ready";
      }),
    { async: true },
  );
  const App = defineComponent((owner) =>
    errorBoundary(
      owner,
      "error",
      (viewOwner, error) => {
        createClient(viewOwner).effect(() => installed());
        return String(error());
      },
      (contentOwner) =>
        asyncBoundary(
          contentOwner,
          "waiting",
          (loadingOwner) => {
            createClient(loadingOwner).cleanup(() =>
              events.push(`loading cleanup:${target.textContent}`),
            );
            return "loading";
          },
          (waitingOwner) => component(waitingOwner, Child, {}, "child"),
        ),
    ),
  );
  const app = mount(target, App, {});
  await app.settled();
  expect(target.textContent).toBe("loading");
  reject("query failed");
  await errorInstalled;
  expect(target.textContent).toBe("query failed");
  expect(events).toStrictEqual(["loading cleanup:loading"]);
  app.dispose();
});

test("an async failure in detached work prepares its error view without activating it", async () => {
  const target = container();
  target.textContent = "current route";
  const runtime = createRuntimeRoot(target);
  runtime.owner.commit();
  const candidate = new Owner(runtime.context, runtime.owner, "candidate");
  candidate.commitDeferred = true;
  let reject!: (reason: unknown) => void;
  const query = new Promise<string>((_resolve, no) => {
    reject = no;
  });
  let prepared!: () => void;
  const errorPrepared = new Promise<void>((resolve) => {
    prepared = resolve;
  });
  const events: string[] = [];
  const Child = defineComponent(
    (owner) =>
      runAsyncBody(owner, function* () {
        yield registerFrameworkAwaitable(query, owner, "query");
        return "ready";
      }),
    { async: true },
  );
  const tree = prepareTree(candidate, () =>
    errorBoundary(
      candidate,
      "error",
      (viewOwner) => {
        const node = element(viewOwner, "p", {}, ["error view"]);
        createClient(viewOwner).effect(() => {
          events.push(`error effect:${node.isConnected}`);
        });
        prepared();
        return node;
      },
      (contentOwner) =>
        asyncBoundary(
          contentOwner,
          "loading",
          () => "loading",
          (waitingOwner) => component(waitingOwner, Child, {}, "child"),
        ),
    ),
  );
  reject("failed while detached");
  await errorPrepared;
  runtime.owner.commit();
  await runtime.context.scheduler.settled();
  expect(target.textContent).toBe("current route");
  expect(tree.fragment.textContent).toBe("error view");
  expect(events).toStrictEqual([]);
  candidate.commitDeferred = false;
  tree.install(target);
  await runtime.context.scheduler.settled();
  expect(events).toStrictEqual(["error effect:true"]);
  runtime.owner.dispose();
});

test("a split error-boundary range forwards the original fault to its enclosing boundary", async () => {
  const target = container();
  const failure = new Error("content effect failed");
  let enclosingError!: unknown;
  const unhandled: unknown[] = [];
  let fail!: () => void;
  const App = defineComponent((owner) =>
    errorBoundary(
      owner,
      "outer",
      (viewOwner, error) => {
        enclosingError = error();
        return element(viewOwner, "p", { id: "outer-error" }, [
          String((enclosingError as Error).message),
        ]);
      },
      (outerContent) =>
        errorBoundary(
          outerContent,
          "inner",
          () => "inner error",
          (innerContent) => {
            const state = createClient(innerContent).state(false);
            fail = () => state.set(true);
            createClient(innerContent).effect(() => {
              if (state()) throw failure;
            });
            return "content";
          },
        ),
    ),
  );
  const app = mount(target, App, {}, { onError: (error) => unhandled.push(error) });
  await app.settled();
  const innerEnd = [...target.childNodes].find(
    (node) => node.nodeType === 8 && (node as Comment).data === "/error",
  );
  expect(innerEnd).toBeDefined();
  innerEnd!.remove();
  fail();
  await app.settled();
  expect(enclosingError).toBe(failure);
  expect(target.querySelector("#outer-error")?.textContent).toBe("content effect failed");
  expect(unhandled).toStrictEqual([]);
  app.dispose();
});

test("a missing error-boundary range reaches the root once and disposes its owner", async () => {
  const target = container();
  const failure = new Error("root content effect failed");
  const errors: unknown[] = [];
  let fail!: () => void;
  const App = defineComponent((owner) =>
    errorBoundary(
      owner,
      "error",
      () => "error",
      (contentOwner) => {
        const state = createClient(contentOwner).state(false);
        fail = () => state.set(true);
        createClient(contentOwner).effect(() => {
          if (state()) throw failure;
        });
        return "content";
      },
    ),
  );
  const app = mount(target, App, {}, { onError: (error) => errors.push(error) });
  await app.settled();
  const end = [...target.childNodes].find(
    (node) => node.nodeType === 8 && (node as Comment).data === "/error",
  );
  expect(end).toBeDefined();
  end!.remove();
  fail();
  await app.settled();
  expect(errors).toHaveLength(1);
  expect(errors[0]).toBe(failure);
  expect(target.childNodes).toHaveLength(0);
  app.dispose();
});
