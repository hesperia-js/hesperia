import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type Locator } from "@playwright/test";

interface NativeState {
  readonly graphqlWsUrl: string;
}
interface NativeSubscriptionSnapshot {
  readonly id: string;
  readonly incarnation: number;
  readonly started: number;
  readonly finally: number;
  readonly emitted: number;
  readonly protocolComplete: number;
  readonly clientComplete: number;
  readonly socketClose: number;
  readonly active: boolean;
}

type NativeSubscriptionPhase =
  | "started"
  | "finally"
  | "emitted"
  | "protocolComplete"
  | "clientComplete"
  | "socketClose";

type NativeSubscriptionEvent = {
  readonly sequence: number;
  readonly value: string;
  readonly broken?: boolean;
  readonly fatal?: boolean;
};

interface GraphQLBrowserFixture {
  dispose(): Promise<void>;
  subscription: {
    resetGraph(): Promise<void>;
    disposeGraph(): void;
    disposeSocket(): Promise<void>;
  };
}
interface GraphQLBrowserControls {
  readonly graphqlFixture?: GraphQLBrowserFixture;
}

async function control<T>(
  request: APIRequestContext,
  session: string,
  path: string,
  method: "GET" | "POST" = "GET",
  parameters: Record<string, string> = {},
  body?: NativeSubscriptionEvent,
): Promise<T> {
  const search = new URLSearchParams({ session, ...parameters });
  const response = await request.fetch(`/__graphql-native/__fixture/${path}?${search}`, {
    method,
    timeout: 35_000,
    ...(body === undefined ? {} : { data: body }),
  });

  expect(response.ok(), `Native GraphQL control ${path}: ${await response.text()}`).toBe(true);

  return response.json() as Promise<T>;
}

async function readNativeSubscription(
  request: APIRequestContext,
  session: string,
  id: string,
  incarnation?: number,
): Promise<NativeSubscriptionSnapshot> {
  return control(request, session, "subscription", "GET", {
    id,
    ...(incarnation === undefined ? {} : { incarnation: String(incarnation) }),
  });
}

async function waitForNativeSubscription(
  request: APIRequestContext,
  session: string,
  id: string,
  phase: NativeSubscriptionPhase,
  count = 1,
  incarnation?: number,
): Promise<NativeSubscriptionSnapshot> {
  return control(request, session, "wait-subscription", "GET", {
    id,
    phase,
    count: String(count),
    ...(incarnation === undefined ? {} : { incarnation: String(incarnation) }),
  });
}

async function sendNativeSubscriptionControl(
  request: APIRequestContext,
  session: string,
  route:
    | "subscription-event"
    | "subscription-finish"
    | "subscription-throw"
    | "subscription-cancel",
  id: string,
  body?: NativeSubscriptionEvent,
  incarnation?: number,
): Promise<void> {
  await control(
    request,
    session,
    route,
    "POST",
    { id, ...(incarnation === undefined ? {} : { incarnation: String(incarnation) }) },
    body,
  );
}

async function subscriptionUrl(
  request: APIRequestContext,
  session: string,
  mode: "events" | "reset" | "dispose",
  id?: string,
): Promise<string> {
  const state = await control<NativeState>(request, session, "state");
  const search = new URLSearchParams({
    session,
    "subscription-ws": state.graphqlWsUrl,
    "subscription-mode": mode,
  });

  if (id) search.set("subscription-id", id);

  return `/graphql?${search}`;
}

async function retireCancelledNativeSubscriptions(
  request: APIRequestContext,
  session: string,
  ids: readonly string[],
): Promise<void> {
  for (const id of ids) {
    const current = await readNativeSubscription(request, session, id);

    for (let incarnation = 1; incarnation <= current.started; incarnation++) {
      const generation = await readNativeSubscription(request, session, id, incarnation);

      if (generation.started === 0 || generation.finally >= generation.started) continue;

      const clientComplete = await waitForNativeSubscription(
        request,
        session,
        id,
        "clientComplete",
        1,
        incarnation,
      );

      if (clientComplete.active)
        await sendNativeSubscriptionControl(
          request,
          session,
          "subscription-cancel",
          id,
          undefined,
          incarnation,
        );

      await waitForNativeSubscription(request, session, id, "finally", 1, incarnation);
    }
  }
}

async function renderedJson(locator: Locator): Promise<unknown> {
  return JSON.parse(await locator.innerText()) as unknown;
}

async function disposeGraphQLFixtureInBrowser(): Promise<void> {
  const fixture = (globalThis as unknown as GraphQLBrowserControls).graphqlFixture;
  if (!fixture) throw new Error("The GraphQL browser fixture is unavailable");
  await fixture.dispose();
}

async function resetGraphQLGraphInBrowser(): Promise<void> {
  const fixture = (globalThis as unknown as GraphQLBrowserControls).graphqlFixture;

  if (!fixture) throw new Error("The GraphQL browser fixture is unavailable");

  await fixture.subscription.resetGraph();
}

function disposeGraphQLGraphInBrowser(): void {
  const fixture = (globalThis as unknown as GraphQLBrowserControls).graphqlFixture;

  if (!fixture) throw new Error("The GraphQL browser fixture is unavailable");

  fixture.subscription.disposeGraph();
}

async function disposeGraphQLSocketInBrowser(): Promise<void> {
  const fixture = (globalThis as unknown as GraphQLBrowserControls).graphqlFixture;

  if (!fixture) throw new Error("The GraphQL browser fixture is unavailable");

  await fixture.subscription.disposeSocket();
}

test("compiled GraphQL subscriptions preserve event policies, shared ownership, and terminal provenance", async ({
  page,
  request,
  browserName,
}) => {
  test.setTimeout(90_000);

  const session = `${browserName}-${randomUUID()}`;
  const errors: string[] = [];
  const sharedId = "browser-shared";
  const allId = "browser-all";
  const ignoreId = "browser-ignore";

  page.on("pageerror", (error) => errors.push(error.message));

  await control(request, session, "reset", "POST");

  try {
    await page.goto(await subscriptionUrl(request, session, "events"));

    await expect(page.locator("html")).toHaveAttribute("data-ready", "true");

    await waitForNativeSubscription(request, session, sharedId, "started");
    await waitForNativeSubscription(request, session, allId, "started");
    await waitForNativeSubscription(request, session, ignoreId, "started");

    expect((await readNativeSubscription(request, session, sharedId)).started).toBe(1);
    expect((await readNativeSubscription(request, session, allId)).started).toBe(1);
    expect((await readNativeSubscription(request, session, ignoreId)).started).toBe(1);

    const first = page.getByTestId("subscription-first");
    const second = page.getByTestId("subscription-second");
    const all = page.getByTestId("subscription-result-all");
    const ignore = page.getByTestId("subscription-result-ignore");
    const retainedSecond = await second.elementHandle();

    expect(retainedSecond).not.toBeNull();

    await sendNativeSubscriptionControl(request, session, "subscription-event", sharedId, {
      sequence: 1,
      value: "none-partial",
      broken: true,
    });
    await waitForNativeSubscription(request, session, sharedId, "emitted");

    const nonePartialLocator = page.getByTestId("subscription-result-first");

    await expect
      .poll(() => renderedJson(nonePartialLocator))
      .toMatchObject({
        errors: [{ message: "fixture subscription field failure" }],
      });

    const nonePartial = await renderedJson(nonePartialLocator);

    expect(nonePartial).not.toHaveProperty("data");
    await expect(page.getByTestId("subscription-status-first")).toHaveText("live");
    await expect(page.getByTestId("subscription-error-first")).toHaveText("none");

    await sendNativeSubscriptionControl(request, session, "subscription-event", allId, {
      sequence: 1,
      value: "all-partial",
      broken: true,
    });
    await waitForNativeSubscription(request, session, allId, "emitted");
    await expect
      .poll(() => renderedJson(all))
      .toMatchObject({
        data: { events: { sequence: 1, value: "all-partial", broken: null } },
        errors: [{ message: "fixture subscription field failure" }],
      });

    await sendNativeSubscriptionControl(request, session, "subscription-event", ignoreId, {
      sequence: 1,
      value: "ignore-partial",
      broken: true,
    });
    await waitForNativeSubscription(request, session, ignoreId, "emitted");
    await expect
      .poll(() => renderedJson(ignore))
      .toMatchObject({
        data: { events: { sequence: 1, value: "ignore-partial", broken: null } },
      });
    const ignoredPartial = await renderedJson(ignore);

    expect(ignoredPartial).toMatchObject({
      data: { events: { sequence: 1, value: "ignore-partial", broken: null } },
    });
    expect(ignoredPartial).not.toHaveProperty("errors");

    await sendNativeSubscriptionControl(request, session, "subscription-event", sharedId, {
      sequence: 2,
      value: "none-live",
    });
    await waitForNativeSubscription(request, session, sharedId, "emitted", 2);
    await expect
      .poll(() => renderedJson(page.getByTestId("subscription-result-second")))
      .toMatchObject({ data: { events: { sequence: 2, value: "none-live" } } });

    await sendNativeSubscriptionControl(request, session, "subscription-event", allId, {
      sequence: 2,
      value: "all-live",
    });
    await waitForNativeSubscription(request, session, allId, "emitted", 2);
    await expect
      .poll(() => renderedJson(all))
      .toMatchObject({
        data: { events: { sequence: 2, value: "all-live" } },
      });

    await sendNativeSubscriptionControl(request, session, "subscription-event", ignoreId, {
      sequence: 2,
      value: "ignore-live",
    });
    await waitForNativeSubscription(request, session, ignoreId, "emitted", 2);
    await expect
      .poll(() => renderedJson(ignore))
      .toMatchObject({
        data: { events: { sequence: 2, value: "ignore-live" } },
      });

    await page.getByTestId("remove-subscription-owner").click();

    await expect(first).toHaveCount(0);

    expect(await readNativeSubscription(request, session, sharedId)).toMatchObject({
      started: 1,
      finally: 0,
      active: true,
      clientComplete: 0,
    });

    await sendNativeSubscriptionControl(request, session, "subscription-event", sharedId, {
      sequence: 3,
      value: "second-owner-remains",
    });
    await waitForNativeSubscription(request, session, sharedId, "emitted", 3);
    await expect
      .poll(() => renderedJson(page.getByTestId("subscription-result-second")))
      .toMatchObject({ data: { events: { sequence: 3, value: "second-owner-remains" } } });

    expect(
      await retainedSecond!.evaluate(
        (node) => node === document.querySelector('[data-testid="subscription-second"]'),
      ),
    ).toBe(true);

    await sendNativeSubscriptionControl(request, session, "subscription-event", allId, {
      sequence: 3,
      value: "all-null-data",
      fatal: true,
    });
    await waitForNativeSubscription(request, session, allId, "emitted", 3);
    await expect
      .poll(() => renderedJson(all))
      .toMatchObject({
        data: null,
        errors: [{ message: "fixture subscription root failure" }],
      });
    await expect(page.getByTestId("subscription-status-all")).toHaveText("live");

    await sendNativeSubscriptionControl(request, session, "subscription-finish", sharedId);
    await waitForNativeSubscription(request, session, sharedId, "protocolComplete");
    const sharedComplete = await waitForNativeSubscription(request, session, sharedId, "finally");

    expect(sharedComplete.active).toBe(false);
    await expect(page.getByTestId("subscription-status-second")).toHaveText("closed");

    await sendNativeSubscriptionControl(request, session, "subscription-finish", allId);
    await waitForNativeSubscription(request, session, allId, "protocolComplete");
    await waitForNativeSubscription(request, session, allId, "finally");
    await expect(page.getByTestId("subscription-status-all")).toHaveText("closed");

    await sendNativeSubscriptionControl(request, session, "subscription-throw", ignoreId);
    const ignoredFailure = await waitForNativeSubscription(request, session, ignoreId, "finally");

    expect(ignoredFailure.active).toBe(false);
    await expect(page.getByTestId("subscription-status-ignore")).toHaveText("failed");
    await expect(page.getByTestId("subscription-error-ignore")).toContainText(
      "fixture subscription failure: browser-ignore",
    );

    expect((await readNativeSubscription(request, session, sharedId)).socketClose).toBe(0);
    expect((await readNativeSubscription(request, session, allId)).socketClose).toBe(0);
    expect((await readNativeSubscription(request, session, ignoreId)).socketClose).toBe(0);
    await expect(page.locator("html")).not.toHaveAttribute("data-fault");
    expect(errors).toEqual([]);
  } finally {
    if (!page.isClosed()) {
      await page.evaluate(disposeGraphQLGraphInBrowser);
      await retireCancelledNativeSubscriptions(request, session, [sharedId, allId, ignoreId]);
      await page.evaluate(disposeGraphQLFixtureInBrowser);
    }
  }
});

test("compiled GraphQL subscription graph reset retires stale work and publishes a fresh incarnation", async ({
  page,
  request,
  browserName,
}) => {
  test.setTimeout(60_000);

  const session = `${browserName}-${randomUUID()}`;
  const id = "browser-reset";
  const errors: string[] = [];

  page.on("pageerror", (error) => errors.push(error.message));

  await control(request, session, "reset", "POST");

  try {
    await page.goto(await subscriptionUrl(request, session, "reset", id));

    await expect(page.locator("html")).toHaveAttribute("data-ready", "true");
    await waitForNativeSubscription(request, session, id, "started", 1, 1);

    await page.evaluate(resetGraphQLGraphInBrowser);
    await waitForNativeSubscription(request, session, id, "started", 1, 2);
    const oldClientComplete = await waitForNativeSubscription(
      request,
      session,
      id,
      "clientComplete",
      1,
      1,
    );

    expect(oldClientComplete).toMatchObject({
      incarnation: 1,
      started: 1,
      finally: 0,
      active: true,
    });
    expect(await readNativeSubscription(request, session, id, 2)).toMatchObject({
      incarnation: 2,
      started: 1,
      finally: 0,
      active: true,
    });

    await sendNativeSubscriptionControl(
      request,
      session,
      "subscription-event",
      id,
      { sequence: 9001, value: "old-late-event" },
      1,
    );
    await waitForNativeSubscription(request, session, id, "emitted", 1, 1);
    const retired = await waitForNativeSubscription(request, session, id, "finally", 1, 1);

    expect(retired).toMatchObject({
      incarnation: 1,
      started: 1,
      finally: 1,
      clientComplete: 1,
      emitted: 1,
      active: false,
    });
    expect(retired.socketClose).toBe(0);
    expect(await readNativeSubscription(request, session, id)).toMatchObject({
      incarnation: 2,
      started: 2,
      finally: 1,
      active: true,
    });

    const lifecycleResult = page.getByTestId("subscription-result-lifecycle");

    await expect.poll(() => renderedJson(lifecycleResult)).toBeNull();

    await sendNativeSubscriptionControl(
      request,
      session,
      "subscription-event",
      id,
      { sequence: 1, value: "fresh-after-reset" },
      2,
    );
    await waitForNativeSubscription(request, session, id, "emitted", 1, 2);
    await expect
      .poll(() => renderedJson(lifecycleResult))
      .toMatchObject({
        data: { events: { sequence: 1, value: "fresh-after-reset" } },
      });

    await page.evaluate(disposeGraphQLGraphInBrowser);
    const freshClientComplete = await waitForNativeSubscription(
      request,
      session,
      id,
      "clientComplete",
      1,
      2,
    );

    expect(freshClientComplete.active).toBe(true);

    await sendNativeSubscriptionControl(request, session, "subscription-cancel", id, undefined, 2);
    const freshRetired = await waitForNativeSubscription(request, session, id, "finally", 1, 2);

    expect(freshRetired).toMatchObject({
      incarnation: 2,
      started: 1,
      finally: 1,
      clientComplete: 1,
      active: false,
    });
    expect(freshRetired.socketClose).toBe(0);

    await page.evaluate(disposeGraphQLSocketInBrowser);
    const socketClosed = await waitForNativeSubscription(request, session, id, "socketClose");

    expect(socketClosed.socketClose).toBe(1);
    expect(errors).toEqual([]);
  } finally {
    if (!page.isClosed()) {
      await page.evaluate(disposeGraphQLGraphInBrowser);
      await retireCancelledNativeSubscriptions(request, session, [id]);
      await page.evaluate(disposeGraphQLFixtureInBrowser);
    }
  }
});

test("compiled GraphQL subscription graph disposal retires the iterator before caller socket disposal", async ({
  page,
  request,
  browserName,
}) => {
  test.setTimeout(60_000);

  const session = `${browserName}-${randomUUID()}`;
  const id = "browser-dispose";
  const errors: string[] = [];

  page.on("pageerror", (error) => errors.push(error.message));

  await control(request, session, "reset", "POST");

  try {
    await page.goto(await subscriptionUrl(request, session, "dispose", id));

    await expect(page.locator("html")).toHaveAttribute("data-ready", "true");
    await waitForNativeSubscription(request, session, id, "started");

    await page.evaluate(disposeGraphQLGraphInBrowser);
    const clientComplete = await waitForNativeSubscription(request, session, id, "clientComplete");

    expect(clientComplete.active).toBe(true);
    expect(clientComplete.finally).toBe(0);

    await sendNativeSubscriptionControl(request, session, "subscription-cancel", id);
    const retired = await waitForNativeSubscription(request, session, id, "finally");

    expect(retired).toMatchObject({ started: 1, finally: 1, clientComplete: 1, active: false });
    expect(retired.socketClose).toBe(0);

    await page.evaluate(disposeGraphQLSocketInBrowser);
    const socketClosed = await waitForNativeSubscription(request, session, id, "socketClose");

    expect(socketClosed.socketClose).toBe(1);
    expect(errors).toEqual([]);
  } finally {
    if (!page.isClosed()) {
      await page.evaluate(disposeGraphQLGraphInBrowser);
      await retireCancelledNativeSubscriptions(request, session, [id]);
      await page.evaluate(disposeGraphQLFixtureInBrowser);
    }
  }
});
