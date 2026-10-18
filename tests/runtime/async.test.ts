import { afterEach, expect, test } from "bun:test";
import { createGraph, createQuery, defineContract } from "aeolia";
import { Window } from "happy-dom";
import { createContractApi } from "../../packages/hesperia/src/data/contract.ts";
import { registerFrameworkAwaitable } from "../../packages/hesperia/src/data/protocol.ts";
import { createClient, type State } from "../../packages/hesperia/src/client.ts";
import { errorBoundary } from "../../packages/hesperia/src/runtime/error-boundary.ts";
import {
  asyncBoundary,
  awaitComponent,
  component,
  componentItem,
  defineComponent,
  element,
  mount,
  region,
  runAsyncBody,
  text,
  type Owner,
} from "../../packages/hesperia/src/runtime/index.ts";

const windows: Window[] = [];

afterEach(() => {
  for (const window of windows.splice(0)) window.close();
});

function container(): Element {
  const window = new Window();

  windows.push(window);

  return window.document.body as unknown as Element;
}

test("an installed boundary can wait again while preserving its synchronous native sibling", async () => {
  const target = container();
  const query = deferred<string>();
  const activated = deferred<void>();
  let pending!: State<boolean>;
  const errors: unknown[] = [];
  const Ready = defineComponent(() => "ready");
  const Later = defineComponent(
    (owner) =>
      runAsyncBody(owner, function* () {
        yield registerFrameworkAwaitable(query.promise, owner, "query");

        createClient(owner).effect(() => activated.resolve());

        return "later";
      }),
    { async: true },
  );
  const App = defineComponent((owner) => {
    pending = createClient(owner).state(false);
    return asyncBoundary(
      owner,
      "wait",
      () => "loading",
      (content) => [
        element(content, "input", { bind: createClient(content).bind<HTMLInputElement>() }),
        region(content, "child", () => componentItem(pending() ? Later : Ready, {}, "child")),
      ],
    );
  });
  const app = mount(target, App, {}, { onError: (error) => errors.push(error) });

  await app.settled();

  const input = target.querySelector("input")!;
  input.value = "local native state";

  pending.set(true);

  expect(target.textContent).toBe("loading");

  await app.settled();

  query.resolve("done");

  await activated.promise;

  expect(target.querySelector("input")).toBe(input);

  expect(input.value).toBe("local native state");

  expect(target.textContent).toBe("later");

  expect(errors).toStrictEqual([]);

  app.dispose();
});

test("reset fetch success still reports a fresh content construction failure and cleans up its lifetime", async () => {
  const target = container();
  const fresh = deferred<string>();
  let response = Promise.resolve("initial");
  const query = createQuery({
    name: "async.recovery-construction",
    key: () => "async/recovery-construction",
    fetch: () => response,
  });
  const contract = defineContract({
    namespace: "async-recovery-construction",
    operations: { query },
  });
  const graph = createGraph({ contract });

  await graph.api.query(undefined).revalidate();

  const failure = new Error("fresh content construction failed");
  const caught: unknown[] = [];
  const unhandled: unknown[] = [];
  const events: string[] = [];
  const App = defineComponent((owner) =>
    errorBoundary(
      owner,
      "error",
      (errorOwner, error) => {
        caught.push(error());

        return element(errorOwner, "p", { id: "recovery-error" }, [(error() as Error).message]);
      },
      (parent) =>
        asyncBoundary(
          parent,
          "wait",
          () => "loading",
          (content) => {
            const client = createClient(content);
            const value = createContractApi(content, graph, contract).query(undefined).value();

            events.push(`body:${value}`);

            client.cleanup(() => events.push(`cleanup:${value}`));

            client.effect(() => {
              events.push(`effect:${value}`);
            });

            if (value === "invalid") throw failure;

            return element(content, "output", { id: "recovery-content" }, [String(value)]);
          },
        ),
    ),
  );
  const app = mount(target, App, {}, { onError: (error) => unhandled.push(error) });

  try {
    await app.settled();

    expect(target.querySelector("#recovery-content")?.textContent).toBe("initial");

    expect(events).toStrictEqual(["body:initial", "effect:initial"]);

    response = fresh.promise;
    const reset = graph.reset();

    expect(target.textContent).toBe("loading");

    expect(target.querySelector("#recovery-content")).toBeNull();

    expect(events).toStrictEqual(["body:initial", "effect:initial", "cleanup:initial"]);

    fresh.resolve("invalid");

    await expect(reset).resolves.toBeUndefined();

    await app.settled();

    expect(target.querySelector("#recovery-error")?.textContent).toBe(failure.message);

    expect(target.querySelector("#recovery-content")).toBeNull();

    expect(caught).toHaveLength(1);

    expect(caught[0]).toBe(failure);

    expect(unhandled).toStrictEqual([]);

    expect(events).toStrictEqual([
      "body:initial",
      "effect:initial",
      "cleanup:initial",
      "body:invalid",
      "cleanup:invalid",
    ]);
  } finally {
    app.dispose();

    graph.dispose();
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("independent sibling boundaries complete in query settlement order", async () => {
  const target = container();
  const gates = [deferred<string>(), deferred<string>()];
  const active = [deferred<void>(), deferred<void>()];
  const Child = defineComponent<{ id: number }>(
    (owner, props) =>
      runAsyncBody(owner, function* () {
        const id = props.id();
        const value = yield registerFrameworkAwaitable(gates[id]!.promise, owner, "query");

        createClient(owner).effect(() => active[id]!.resolve());

        return String(value);
      }),
    { async: true, props: { id: { kind: "value", optional: false } } },
  );
  const App = defineComponent((owner) =>
    [0, 1].map((id) =>
      asyncBoundary(
        owner,
        `wait${id}`,
        () => `loading${id}`,
        (content) => component(content, Child, { id }, "child"),
      ),
    ),
  );
  const app = mount(target, App, {});

  await app.settled();

  expect(target.textContent).toBe("loading0loading1");

  gates[1]!.resolve("second");

  await active[1]!.promise;

  expect(target.textContent).toBe("loading0second");

  gates[0]!.resolve("first");

  await active[0]!.promise;

  expect(target.textContent).toBe("firstsecond");

  app.dispose();
});

test("awaited required child binding publishes before parent effects but remains unreadable in the resumed body", async () => {
  const target = container();
  const query = deferred<void>();
  const active = deferred<void>();
  const errors: unknown[] = [];
  const Child = defineComponent<{ bind: { read(): string } }>(
    (owner, props) =>
      runAsyncBody(owner, function* () {
        yield registerFrameworkAwaitable(query.promise, owner, "query");

        createClient(owner).effect(() => props.bind.set({ read: () => "published" }));

        return "child";
      }),
    { async: true, props: { bind: { kind: "binding", optional: false } } },
  );
  let observed = "";
  const Parent = defineComponent(
    (owner) =>
      runAsyncBody(owner, function* () {
        const client = createClient(owner);
        const binding = client.bind<{ read(): string }>();
        const output = yield awaitComponent(owner, Child, { bind: binding }, "child");

        try {
          binding();
        } catch (error) {
          errors.push(error);
        }

        client.effect(() => {
          observed = binding().read();

          active.resolve();
        });

        return output as Node;
      }),
    { async: true },
  );
  const App = defineComponent((owner) =>
    asyncBoundary(
      owner,
      "wait",
      () => "loading",
      (content) => component(content, Parent, {}, "parent"),
    ),
  );
  const app = mount(target, App, {});

  query.resolve();

  await active.promise;

  expect(errors).toHaveLength(1);

  expect(errors[0]).toMatchObject({ kind: "binding-body-read" });

  expect(observed).toBe("published");

  app.dispose();
});

test("async boundary installs the completed tree before descendant-first effects", async () => {
  const target = container();
  const query = deferred<string>();
  const activated = deferred<void>();
  const events: string[] = [];
  let body!: Promise<unknown>;
  const Child = defineComponent(
    (owner) => {
      body = runAsyncBody(owner, function* () {
        createClient(owner).effect(() => {
          events.push(`child:${target.textContent}`);
        });

        const value = yield registerFrameworkAwaitable(query.promise, owner, "query");
        return element(owner, "span", {}, [String(value)]);
      });
      return body as Promise<Node>;
    },
    { async: true },
  );
  const Parent = defineComponent(
    (owner) =>
      runAsyncBody(owner, function* () {
        createClient(owner).effect(() => {
          events.push(`parent:${target.textContent}`);

          activated.resolve();
        });

        return (yield awaitComponent(owner, Child, {}, "child")) as Node;
      }),
    { async: true },
  );
  const App = defineComponent((owner) =>
    asyncBoundary(
      owner,
      "wait",
      (loading) => text(loading, () => "loading"),
      (content) => component(content, Parent, {}, "parent"),
    ),
  );
  const app = mount(target, App, {});

  await app.settled();

  expect(target.textContent).toBe("loading");

  expect(events).toStrictEqual([]);

  query.resolve("ready");

  await body;
  await activated.promise;

  expect(events).toStrictEqual(["child:ready", "parent:ready"]);

  expect(target.textContent).toBe("ready");

  app.dispose();
});

test("async placement and required independent binding fail before the child body", () => {
  let calls = 0;
  const Child = defineComponent<{ bind: { read(): string } }>(
    () => {
      calls++;
      return Promise.resolve("ready");
    },
    { async: true },
  );
  const Outside = defineComponent((owner) =>
    component(owner, Child, { bind: createClient(owner).bind() }, "child"),
  );

  expect(() => mount(container(), Outside, {})).toThrow("enclosing async boundary");

  const Inside = defineComponent((owner) => {
    const bind = createClient(owner).bind<{ read(): string }>();
    return asyncBoundary(
      owner,
      "wait",
      () => "loading",
      (content) => component(content, Child, { bind }, "child"),
    );
  });

  expect(() => mount(container(), Inside, {})).toThrow("independently loading");

  expect(calls).toBe(0);
});

test("cancelled continuation runs finally and cannot publish after its owner dies", async () => {
  const target = container();
  const query = deferred<string>();
  const events: string[] = [];
  let body!: Promise<unknown>;
  const Child = defineComponent(
    (owner) => {
      body = runAsyncBody(owner, function* () {
        try {
          yield registerFrameworkAwaitable(query.promise, owner, "query");

          events.push("continued");

          return "ready";
        } finally {
          events.push("finally");
        }
      });
      return body as Promise<string>;
    },
    { async: true },
  );
  const App = defineComponent((owner) =>
    asyncBoundary(
      owner,
      "wait",
      () => "loading",
      (content) => component(content, Child, {}, "child"),
    ),
  );
  const app = mount(target, App, {});

  app.dispose();

  await expect(body).rejects.toMatchObject({ kind: "cancelled" });

  query.resolve("late");

  await query.promise;

  expect(events).toStrictEqual(["finally"]);

  expect(target.textContent).toBe("");
});

test("query continuation uses the awaiting owner, and failures reach the nearest boundary", async () => {
  const target = container();
  const query = deferred<string>();
  const failed = deferred<unknown>();
  const bodyRejections: unknown[] = [];
  const deliveredErrors: unknown[] = [];
  let sourceOwner!: Owner;
  let waitingOwner!: Owner;
  let actualOwner!: Owner;
  const foreign = {};
  const Child = defineComponent(
    (owner) => {
      waitingOwner = owner;
      owner.errorHandler = (error) => {
        deliveredErrors.push(error);

        failed.resolve(error);
      };
      return runAsyncBody(owner, function* () {
        try {
          yield foreign;
          return "ready";
        } catch (error) {
          bodyRejections.push(error);

          throw error;
        }
      });
    },
    { async: true },
  );
  const App = defineComponent((owner) => {
    sourceOwner = owner;

    registerFrameworkAwaitable(foreign, owner, "query", (awaiting) => {
      actualOwner = awaiting;
      return query.promise;
    });

    return asyncBoundary(
      owner,
      "wait",
      () => "loading",
      (content) => component(content, Child, {}, "child"),
    );
  });
  const app = mount(target, App, {});

  expect(actualOwner).toBe(waitingOwner);

  expect(actualOwner).not.toBe(sourceOwner);

  const error = new Error("query failed");

  sourceOwner.suspend();

  query.reject(error);

  await query.promise.catch(() => undefined);

  expect(bodyRejections).toStrictEqual([]);

  expect(deliveredErrors).toStrictEqual([]);

  expect(target.textContent).toBe("loading");

  sourceOwner.resume();

  expect(await failed.promise).toBe(error);

  expect(bodyRejections).toStrictEqual([error]);

  expect(deliveredErrors).toStrictEqual([error]);

  expect(target.textContent).toBe("loading");

  app.dispose();
});
