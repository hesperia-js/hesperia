import assert from "node:assert/strict";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

if (process.versions.node !== "22.23.2")
  throw new Error(`Expected Node 22.23.2; received ${process.versions.node}`);

const [
  graphqlUrl,
  controlUrl,
  graphqlWsUrl,
  checkoutRoot,
  expectedInstanceId,
  expectedVersionsJson,
] = process.argv.slice(2);

if (
  !graphqlUrl ||
  !controlUrl ||
  !graphqlWsUrl ||
  !checkoutRoot ||
  !expectedInstanceId ||
  !expectedVersionsJson
)
  throw new Error(
    "Expected GraphQL URL, control URL, GraphQL WebSocket URL, checkout root, fixture id, and direct package pins",
  );

if (!isAbsolute(checkoutRoot)) throw new Error("Expected an absolute source checkout root");

/** @typedef {{ entry: string, root: string, version: string }} InstalledPackage */
/** @typedef {{ instanceId: string, revision: number, writes: string[], resolverCalls: { state: number } }} FixtureState */
/** @typedef {{ partial: { ok: string, broken: string | null } }} PartialData */
/** @typedef {{ state: { revision: number, writes: string[] } }} StateData */
/** @typedef {{ writeThenFail: { value: string, failure: string | null } | null }} FailedWriteData */
/** @typedef {{ value: string }} FailedWriteVariables */
/** @typedef {{ events: { sequence: number, value: string, broken: string | null, fatal: string } | null }} NativeEventData */
/** @typedef {{ id: string }} NativeEventVariables */
/** @typedef {{ id: string, started: number, finally: number, emitted: number, protocolComplete: number, clientComplete: number, socketClose: number, active: boolean }} SubscriptionSnapshot */
/** @typedef {import("@hesperia/graphql").GraphQLResult<NativeEventData>} NativeEventEnvelope */
/** @typedef {import("hesperia/aeolia").Feed<NativeEventEnvelope>} NativeEventFeed */
/** @typedef {(envelope: NativeEventEnvelope | undefined) => boolean} NativeEventEnvelopePredicate */
/** @typedef {import("@apollo/client").TypedDocumentNode<PartialData, Record<string, never>>} PartialDocument */
/** @typedef {import("@apollo/client").TypedDocumentNode<StateData, Record<string, never>>} StateDocument */
/** @typedef {import("@apollo/client").TypedDocumentNode<FailedWriteData, FailedWriteVariables>} FailedWriteDocument */
/** @typedef {import("@apollo/client").TypedDocumentNode<NativeEventData, NativeEventVariables>} NativeEventDocument */
/** @typedef {import("@hesperia/graphql").GraphQLResultError<FailedWriteData>} FailedWriteError */

/** @type {Record<string, string>} */
const expectedVersions = JSON.parse(expectedVersionsJson);
const appRoot = await realpath(process.cwd());
const checkoutPath = await realpath(checkoutRoot);
const nodeModulesRoot = await realpath(join(appRoot, "node_modules"));

/** @param {string} parent @param {string} child */
function isInside(parent, child) {
  const path = relative(parent, child);

  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

if (!isInside(appRoot, nodeModulesRoot))
  throw new Error(`Installed node_modules escaped the consumer app: ${nodeModulesRoot}`);

let ancestor = dirname(appRoot);

while (true) {
  const ancestorNodeModules = join(ancestor, "node_modules");
  let exists = false;

  try {
    await stat(ancestorNodeModules);
    exists = true;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }

  if (exists)
    throw new Error(
      `Found an ancestor node_modules outside the isolated consumer app: ${ancestorNodeModules}`,
    );

  const parent = dirname(ancestor);

  if (parent === ancestor) break;

  ancestor = parent;
}

/**
 * @param {string} packageName
 * @param {string} [specifier]
 * @returns {Promise<InstalledPackage>}
 */
async function resolveInstalledPackage(packageName, specifier = packageName) {
  const entry = await realpath(fileURLToPath(import.meta.resolve(specifier)));

  if (!isInside(nodeModulesRoot, entry))
    throw new Error(
      `${specifier} did not resolve inside the consumer's installed node_modules: ${entry}`,
    );

  if (isInside(checkoutPath, entry))
    throw new Error(`${specifier} resolved back into the source checkout: ${entry}`);

  let directory = dirname(entry);

  while (directory !== nodeModulesRoot && isInside(nodeModulesRoot, directory)) {
    try {
      /** @type {{ name?: string, version?: string }} */
      const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));

      if (manifest.name === packageName && typeof manifest.version === "string")
        return { entry, root: directory, version: manifest.version };
    } catch {
      // This directory is not a package root; continue toward node_modules.
    }

    directory = dirname(directory);
  }

  throw new Error(`Could not find installed package metadata for ${packageName} from ${entry}`);
}

/** @type {Record<string, InstalledPackage>} */
const entrypoints = {};

for (const packageName of Object.keys(expectedVersions))
  entrypoints[packageName] = await resolveInstalledPackage(packageName);

Object.assign(entrypoints, {
  "@hesperia/graphql/client": await resolveInstalledPackage(
    "@hesperia/graphql",
    "@hesperia/graphql/client",
  ),
  "@apollo/client/link/http": await resolveInstalledPackage(
    "@apollo/client",
    "@apollo/client/link/http",
  ),
  "@apollo/client/link/subscriptions": await resolveInstalledPackage(
    "@apollo/client",
    "@apollo/client/link/subscriptions",
  ),
  "@apollo/client/errors": await resolveInstalledPackage("@apollo/client", "@apollo/client/errors"),
  "hesperia/runtime": await resolveInstalledPackage("hesperia", "hesperia/runtime"),
  "hesperia/aeolia": await resolveInstalledPackage("hesperia", "hesperia/aeolia"),
  aeolia: await resolveInstalledPackage("aeolia"),
  graphql: await resolveInstalledPackage("graphql"),
  rxjs: await resolveInstalledPackage("rxjs"),
});

assert.equal(entrypoints["@hesperia/graphql"].root, entrypoints["@hesperia/graphql/client"].root);
assert.equal(
  entrypoints["@apollo/client/link/http"].root,
  entrypoints["@apollo/client/errors"].root,
);
assert.equal(
  entrypoints["@apollo/client/link/http"].root,
  entrypoints["@apollo/client/link/subscriptions"].root,
);
assert.equal(entrypoints["@hesperia/graphql"].version, expectedVersions["@hesperia/graphql"]);
assert.equal(entrypoints["hesperia/runtime"].root, entrypoints.hesperia.root);
assert.equal(entrypoints["hesperia/aeolia"].root, entrypoints.hesperia.root);

const [
  graphqlRoot,
  graphqlClient,
  http,
  subscriptions,
  apolloErrors,
  graphqlLanguage,
  aeolia,
  hesperiaRuntime,
  hesperiaAeolia,
  happyDom,
  graphqlWs,
  ws,
] = await Promise.all([
  import("@hesperia/graphql"),
  import("@hesperia/graphql/client"),
  import("@apollo/client/link/http"),
  import("@apollo/client/link/subscriptions"),
  import("@apollo/client/errors"),
  import("graphql"),
  import("aeolia"),
  import("hesperia/runtime"),
  import("hesperia/aeolia"),
  import("happy-dom"),
  import("graphql-ws"),
  import("ws"),
]);

assert.equal(graphqlRoot.createGraphQLClient, graphqlClient.createGraphQLClient);

const installedVersions = Object.fromEntries(
  Object.keys(expectedVersions).map((packageName) => [
    packageName,
    entrypoints[packageName].version,
  ]),
);

assert.deepEqual(installedVersions, expectedVersions);

const { createGraphQLClient } = graphqlClient;
const { HttpLink } = http;
const { GraphQLWsLink } = subscriptions;
const { CombinedGraphQLErrors } = apolloErrors;
const { parse } = graphqlLanguage;
const { affects, createGraph, defineContract, subscribe } = aeolia;
const { mount, defineComponent, bindImported, text } = hesperiaRuntime;
const { withAeolia } = hesperiaAeolia;
const { Window } = happyDom;
const { createClient } = graphqlWs;
const WebSocket = ws.default;

/** @param {unknown} error @returns {error is FailedWriteError} */
function isFailedWriteError(error) {
  return error instanceof Error && Object.hasOwn(error, "result");
}

const graphql = createGraphQLClient({ link: new HttpLink({ uri: graphqlUrl }) });
const partialDocument = /** @type {PartialDocument} */ (
  parse(`query InstalledPartial { partial { ok broken } }`)
);
const partial = graphql.query({
  name: "installed-runtime.partial",
  document: partialDocument,
  key: () => "partial",
});
const stateDocument = /** @type {StateDocument} */ (
  parse(`query InstalledState { state { revision writes } }`)
);
const state = graphql.query({
  name: "installed-runtime.state",
  document: stateDocument,
  key: () => "state",
});
const failedWriteDocument = /** @type {FailedWriteDocument} */ (
  parse(`
    mutation InstalledFailedWrite($value: String!) {
      writeThenFail(value: $value) {
        value
        failure
      }
    }
  `)
);
const nativeEventDocument = /** @type {NativeEventDocument} */ (
  parse(`
    subscription NativeEvents($id: ID!) {
      events(id: $id) {
        sequence
        value
        broken
        fatal
      }
    }
  `)
);
const failedWrite = graphql.mutation({
  name: "installed-runtime.failed-write",
  document: failedWriteDocument,
  affects: [
    affects(state, {
      select: () => ({}),
      on: "revalidate",
      optimistic: () => ({
        data: { state: { revision: 1, writes: ["predicted-installed-write"] } },
      }),
    }),
  ],
});
const contract = defineContract({
  namespace: "installed-runtime",
  operations: { partial, state, failedWrite },
});
const graph = createGraph({ contract });
const partialStore = graph.api.partial({}, {});
const stateStore = graph.api.state({}, {});
/** @type {(() => void) | undefined} */
let stopStateObservation;

/** @returns {Promise<FixtureState>} */
async function readFixtureState() {
  const response = await fetch(`${controlUrl}/state`, {
    signal: AbortSignal.timeout(5_000),
  });

  assert.equal(response.status, 200);

  return /** @type {FixtureState} */ (await response.json());
}

/** @param {string} route @param {string} session @param {string} id @param {{ method?: string, query?: Record<string, string>, body?: unknown }} [options] */
async function requestSubscriptionControl(route, session, id, options = {}) {
  const url = new URL(`${controlUrl}/${route}`);
  url.searchParams.set("session", session);
  url.searchParams.set("id", id);

  for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value);

  const response = await fetch(url, {
    method: options.method ?? "GET",
    ...(options.body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(options.body) }),
    signal: AbortSignal.timeout(8_000),
  });
  const text = await response.text();

  if (response.status !== 200)
    throw new Error(`Subscription control ${route} failed (${response.status}): ${text}`);

  return /** @type {Record<string, unknown>} */ (text ? JSON.parse(text) : {});
}

/** @param {string} session @param {string} id @param {string} phase @param {number} [count] @returns {Promise<SubscriptionSnapshot>} */
async function waitForSubscription(session, id, phase, count = 1) {
  return /** @type {Promise<SubscriptionSnapshot>} */ (
    requestSubscriptionControl("wait-subscription", session, id, {
      query: { phase, count: String(count) },
    })
  );
}

/** @param {Record<string, unknown> | undefined} extensions */
function readFixtureInstanceId(extensions) {
  const fixture = extensions?.fixture;

  if (typeof fixture !== "object" || fixture === null || !("instanceId" in fixture))
    return undefined;

  return typeof fixture.instanceId === "string" ? fixture.instanceId : undefined;
}

/** @type {Record<string, unknown> | undefined} */
let report;

async function checkNativeSubscriptionContract() {
  const session = "installed-graphql-subscription";
  const noneId = "installed-error-policy-none";
  const allId = "installed-error-policy-all";
  const cancelId = "installed-operation-cancel";
  const nativeWsClient = createClient({
    url: graphqlWsUrl,
    webSocketImpl: WebSocket,
    connectionParams: () => ({ session }),
    lazy: false,
  });
  /** @type {import("@hesperia/graphql/client").GraphQLClient | undefined} */
  let subscriptionClient = createGraphQLClient({
    link: new GraphQLWsLink(nativeWsClient),
  });
  const events = subscriptionClient.subscription({
    name: "installed-runtime.native-events",
    document: nativeEventDocument,
    key: ({ id }) => `native-events/${id}`,
  });
  const allEvents = subscriptionClient.subscription({
    name: "installed-runtime.native-events-all",
    document: nativeEventDocument,
    key: ({ id }) => `native-events-all/${id}`,
    errorPolicy: "all",
  });
  const contract = defineContract({
    namespace: "installed-runtime-subscriptions",
    operations: { events, allEvents },
  });
  /** @type {import("aeolia").Graph<typeof contract> | undefined} */
  let graph = createGraph({ contract });
  const imported = withAeolia(graph, contract);
  const window = new Window({ url: "https://installed-subscriptions.test/" });
  /** @type {{ none?: import("hesperia/aeolia").Feed<import("@hesperia/graphql").GraphQLResult<NativeEventData>>, all?: import("hesperia/aeolia").Feed<import("@hesperia/graphql").GraphQLResult<NativeEventData>>, cancel?: import("hesperia/aeolia").Feed<import("@hesperia/graphql").GraphQLResult<NativeEventData>> }} */
  const bindings = {};
  /** @type {import("hesperia/runtime").MountedApplication | undefined} */
  let application;
  let socketDisposed = false;

  try {
    const Consumer = defineComponent((owner) => {
      const api = /** @type {typeof imported} */ (bindImported(owner, imported));
      const none = api.events({ id: noneId });
      const all = api.allEvents({ id: allId });
      const cancel = api.events({ id: cancelId });

      Object.assign(bindings, { none, all, cancel });

      return text(owner, () => {
        none.status();
        cancel.status();

        return all.value()?.data?.events?.value ?? "pending";
      });
    });

    application = mount(
      /** @type {Element} */ (/** @type {unknown} */ (window.document.body)),
      Consumer,
      {},
    );

    const noneFeed = bindings.none;
    const allFeed = bindings.all;

    if (!noneFeed || !allFeed || !bindings.cancel)
      throw new Error("The installed Hesperia component did not bind its subscription feeds");

    /**
     * @param {NativeEventFeed} feed
     * @param {NativeEventEnvelopePredicate} matches
     * @param {string} description
     * @returns {Promise<NativeEventEnvelope>}
     */
    const waitForEnvelope = (feed, matches, description) => {
      const source = feed.source;

      if (!source) throw new Error("The installed Hesperia subscription has no acquired source");

      return new Promise((resolve, reject) => {
        /** @type {() => void} */
        let stop = () => undefined;
        let settled = false;
        const timeout = setTimeout(() => {
          if (settled) return;

          settled = true;
          stop();
          reject(new Error(`Subscription ${description} was not observed`));
        }, 6_000);

        try {
          stop = subscribe(source.value, (envelope) => {
            if (settled || !envelope || !matches(envelope)) return;

            settled = true;
            clearTimeout(timeout);
            stop();
            resolve(envelope);
          });

          if (settled) stop();
        } catch (error) {
          settled = true;
          clearTimeout(timeout);
          stop();
          reject(error);
        }
      });
    };

    const [noneStarted, allStarted, cancelStarted] = await Promise.all([
      waitForSubscription(session, noneId, "started"),
      waitForSubscription(session, allId, "started"),
      waitForSubscription(session, cancelId, "started"),
    ]);

    assert.equal(noneStarted.active, true);
    assert.equal(allStarted.active, true);
    assert.equal(cancelStarted.active, true);

    const noneEvent = waitForEnvelope(
      noneFeed,
      (envelope) => envelope?.errors?.[0]?.message === "fixture subscription field failure",
      "error-policy-none event envelope",
    );
    const allEvent = waitForEnvelope(
      allFeed,
      (envelope) => envelope?.data?.events?.sequence === 2,
      "error-policy-all event envelope",
    );

    await requestSubscriptionControl("subscription-event", session, noneId, {
      method: "POST",
      body: { sequence: 1, value: "installed-none-event", broken: true },
    });
    await requestSubscriptionControl("subscription-event", session, allId, {
      method: "POST",
      body: { sequence: 2, value: "installed-all-event", broken: true },
    });

    const [noneEnvelope, allEnvelope] = await Promise.all([noneEvent, allEvent]);
    const noneError = noneEnvelope.errors?.[0];
    const allError = allEnvelope.errors?.[0];
    const noneExtensionInstanceId = readFixtureInstanceId(noneEnvelope.extensions);
    const allExtensionInstanceId = readFixtureInstanceId(allEnvelope.extensions);

    assert.equal(Object.hasOwn(noneEnvelope, "data"), false);
    assert.equal(noneError?.message, "fixture subscription field failure");
    assert.equal(noneExtensionInstanceId, expectedInstanceId);
    assert.equal(allEnvelope.data?.events?.sequence, 2);
    assert.equal(allEnvelope.data?.events?.value, "installed-all-event");
    assert.equal(allEnvelope.data?.events?.broken, null);
    assert.equal(allEnvelope.data?.events?.fatal, "ok");
    assert.equal(allError?.message, "fixture subscription field failure");
    assert.deepEqual(allError?.path, ["events", "broken"]);
    assert.equal(allExtensionInstanceId, expectedInstanceId);

    await application.settled();

    assert.equal(window.document.body.textContent, "installed-all-event");

    await requestSubscriptionControl("subscription-finish", session, noneId, { method: "POST" });
    await requestSubscriptionControl("subscription-finish", session, allId, { method: "POST" });
    const [noneComplete, allComplete] = await Promise.all([
      waitForSubscription(session, noneId, "protocolComplete"),
      waitForSubscription(session, allId, "protocolComplete"),
    ]);
    const [noneFinished, allFinished] = await Promise.all([
      waitForSubscription(session, noneId, "finally"),
      waitForSubscription(session, allId, "finally"),
    ]);

    assert.equal(noneComplete.protocolComplete, 1);
    assert.equal(allComplete.protocolComplete, 1);
    assert.equal(noneFinished.emitted, 1);
    assert.equal(allFinished.emitted, 1);
    assert.equal(noneFinished.active, false);
    assert.equal(allFinished.active, false);

    application.dispose();
    application = undefined;
    graph.dispose();
    graph = undefined;
    subscriptionClient.stop();
    subscriptionClient = undefined;

    const clientComplete = await waitForSubscription(session, cancelId, "clientComplete");

    assert.equal(clientComplete.clientComplete, 1);
    assert.equal(clientComplete.socketClose, 0);

    await requestSubscriptionControl("subscription-cancel", session, cancelId, {
      method: "POST",
    });
    const cancelled = await waitForSubscription(session, cancelId, "finally");

    assert.equal(cancelled.clientComplete, 1);
    assert.equal(cancelled.emitted, 0);
    assert.equal(cancelled.protocolComplete, 0);
    assert.equal(cancelled.socketClose, 0);
    assert.equal(cancelled.active, false);

    await nativeWsClient.dispose();
    socketDisposed = true;
    const socketClosed = await waitForSubscription(session, cancelId, "socketClose");

    assert.equal(socketClosed.socketClose, 1);

    return {
      none: {
        dataOmitted: !Object.hasOwn(noneEnvelope, "data"),
        errorMessage: noneError?.message,
        extensionInstanceId: noneExtensionInstanceId,
        emitted: noneFinished.emitted,
        protocolComplete: noneFinished.protocolComplete,
        generatorFinally: noneFinished.finally,
      },
      all: {
        sequence: allEnvelope.data?.events?.sequence,
        value: allEnvelope.data?.events?.value,
        broken: allEnvelope.data?.events?.broken,
        errorMessage: allError?.message,
        errorPath: allError?.path,
        extensionInstanceId: allExtensionInstanceId,
        emitted: allFinished.emitted,
        protocolComplete: allFinished.protocolComplete,
        generatorFinally: allFinished.finally,
      },
      cancellation: {
        clientComplete: cancelled.clientComplete,
        emitted: cancelled.emitted,
        generatorFinally: cancelled.finally,
        socketCloseBeforeCallerDisposal: cancelled.socketClose,
        socketCloseAfterCallerDisposal: socketClosed.socketClose,
      },
    };
  } finally {
    application?.dispose();
    graph?.dispose();
    subscriptionClient?.stop();
    if (!socketDisposed) await nativeWsClient.dispose();
    window.close();
  }
}

try {
  stopStateObservation = subscribe(stateStore.value, () => undefined);

  await Promise.all([partialStore.ready, stateStore.ready]);

  const partialEnvelope = partialStore.value.get();
  const partialData = partialEnvelope?.data?.partial;
  const partialError = partialEnvelope?.errors?.[0];
  const partialExtensionInstanceId = readFixtureInstanceId(partialEnvelope?.extensions);

  if (!partialData || !partialError || !partialExtensionInstanceId)
    throw new Error("The native partial query did not retain its data, error, and extension");

  assert.equal(partialData.ok, "partial-ok");
  assert.equal(partialData.broken, null);
  assert.equal(partialError.message, "fixture partial field failure");
  assert.deepEqual(partialError.path, ["partial", "broken"]);
  assert.equal(partialExtensionInstanceId, expectedInstanceId);

  const initialState = stateStore.value.get()?.data?.state;
  const serverBefore = await readFixtureState();

  if (!initialState) throw new Error("The native state query returned no data");

  assert.equal(initialState.revision, 0);
  assert.deepEqual(initialState.writes, []);
  assert.equal(serverBefore.instanceId, expectedInstanceId);
  assert.equal(serverBefore.resolverCalls.state, 1);

  /** @type {unknown} */
  let failure;

  try {
    await graph.api.failedWrite({ value: "installed-failed-write" });
  } catch (error) {
    failure = error;
  }

  if (!isFailedWriteError(failure))
    throw new Error("The default mutation policy did not return its captured result on rejection", {
      cause: failure,
    });

  if (!CombinedGraphQLErrors.is(failure.cause))
    throw new Error("The rejected mutation did not retain Apollo's native GraphQL error as cause");

  const failureEnvelope = failure.result;
  const failureData = failureEnvelope?.data?.writeThenFail;
  const failureError = failureEnvelope?.errors?.[0];
  const failureExtensionInstanceId = readFixtureInstanceId(failureEnvelope?.extensions);

  if (!failureData || !failureError || !failureExtensionInstanceId)
    throw new Error("The rejected mutation did not retain its partial envelope");

  assert.ok(failure.message.includes("fixture mutation field failure"));
  assert.equal(failure.constructor, Error);
  assert.equal(failureData.value, "installed-failed-write");
  assert.equal(failureData.failure, null);
  assert.equal(failureError.message, "fixture mutation field failure");
  assert.deepEqual(failureError.path, ["writeThenFail", "failure"]);
  assert.equal(failureExtensionInstanceId, expectedInstanceId);

  const stateAfterFailure = stateStore.value.get()?.data?.state;
  const serverAfter = await readFixtureState();

  if (!stateAfterFailure)
    throw new Error("The observed state query lost its result after mutation rejection");

  assert.equal(stateAfterFailure.revision, 0);
  assert.deepEqual(stateAfterFailure.writes, []);
  assert.equal(serverAfter.revision, 1);
  assert.deepEqual(serverAfter.writes, ["installed-failed-write"]);
  assert.equal(serverAfter.resolverCalls.state, 1);
  const nativeSubscription = await checkNativeSubscriptionContract();

  report = {
    nodeVersion: process.versions.node,
    fixtureInstanceId: expectedInstanceId,
    entrypoints: Object.fromEntries(
      Object.entries(entrypoints).map(([name, value]) => [name, value.entry]),
    ),
    installedVersions,
    hesperiaRoots: {
      package: entrypoints.hesperia.root,
      runtime: entrypoints["hesperia/runtime"].root,
      aeolia: entrypoints["hesperia/aeolia"].root,
    },
    nativeSubscription,
    partial: {
      ok: partialData.ok,
      broken: partialData.broken,
      errorMessage: partialError.message,
      errorPath: partialError.path,
      extensionInstanceId: partialExtensionInstanceId,
    },
    failure: {
      message: failure.message,
      errorName: failure.name,
      executionMessage: failureError.message,
      causeName: failure.cause.name,
      value: failureData.value,
      failedField: failureData.failure,
      errorPath: failureError.path,
      extensionInstanceId: failureExtensionInstanceId,
    },
    stateBefore: serverBefore,
    stateAfter: serverAfter,
  };
} finally {
  stopStateObservation?.();
  graph.dispose();
  graphql.stop();
}

console.log(JSON.stringify(report));
