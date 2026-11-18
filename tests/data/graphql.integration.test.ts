import { afterEach, expect, test } from "bun:test";
import { affects, computed, createGraph, defineContract, storeKey, subscribe } from "aeolia";
import type { Contract, Graph, OpenOptions } from "aeolia";
import { ApolloLink } from "@apollo/client/link";
import { HttpLink } from "@apollo/client/link/http";
import { GraphQLWsLink } from "@apollo/client/link/subscriptions";
import type { TypedDocumentNode } from "@apollo/client";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { GraphQLError, parse } from "graphql";
import { Window } from "happy-dom";
import { createClient as createNativeWebSocketClient } from "graphql-ws";
import { Observable, tap } from "rxjs";
import { randomUUID } from "node:crypto";
import { createGraphQLClient } from "../../packages/graphql/src/index.ts";
import type { GraphQLResult, GraphQLResultError } from "../../packages/graphql/src/index.ts";
import { withAeolia } from "../../packages/hesperia/src/aeolia/index.ts";
import type { ImportedApi } from "../../packages/hesperia/src/aeolia/index.ts";
import { bindImported } from "../../packages/hesperia/src/data/api.ts";
import { Owner, type RuntimeContext } from "../../packages/hesperia/src/runtime/owner.ts";
import {
  defineComponent,
  mount,
  text,
  type MountedApplication,
} from "../../packages/hesperia/src/runtime/index.ts";
import { createDataApplication } from "../../packages/hesperia/src/data/environment.ts";
import { registerNativeQueryProfile } from "../../packages/hesperia/src/data/native-observation.ts";
import { isAbsolute, resolve } from "node:path";

type EmptyVariables = Record<string, never>;

type ValueVariables = { readonly value: string };

type EchoData = { readonly echo: string };

type ContextEchoData = {
  readonly contextEcho: { readonly value: string; readonly identity: string | null };
};

type FullData = EchoData & ContextEchoData;

type PartialData = {
  readonly partial: {
    readonly __typename?: "PartialResult";
    readonly ok: string;
    readonly broken: string | null;
  };
};

type RootFailureData = { readonly rootFailure: string };
type DeferredRootFailureData = { readonly __typename: "Query"; readonly rootFailure: string };
type IncrementalFailureData = {
  readonly incrementalFailureItems: readonly (string | null)[] | null;
};

type ServerStateData = {
  readonly state: { readonly revision: number; readonly writes: readonly string[] };
};

type WriteData = {
  readonly writeThenFail: { readonly value: string; readonly failure: string | null } | null;
};

type CleanWriteData = { readonly writeThenFail: { readonly value: string } | null };

type GateData = { readonly waitAtGate: string };

type NativeEventsData = {
  readonly events: {
    readonly __typename?: "NativeEvent";
    readonly sequence: number;
    readonly value: string;
    readonly broken: string | null;
    readonly fatal: string;
  };
};

type NativeEventsVariables = { readonly id: string };

type FixtureReady = {
  readonly type: "ready";
  readonly host: string;
  readonly port: number;
  readonly instanceId: string;
  readonly graphqlUrl: string;
  readonly graphqlWsUrl: string;
  readonly controlUrl: string;
};

type GateSnapshot = {
  readonly id: string;
  readonly started: number;
  readonly aborted: number;
  readonly completed: number;
  readonly lateCompletions: number;
  readonly pending: boolean;
};

type FixtureSnapshot = {
  readonly instanceId: string;
  readonly graphqlWsUrl: string;
  readonly revision: number;
  readonly writes: readonly string[];
  readonly resolverCalls: {
    readonly echo: number;
    readonly contextEcho: number;
    readonly state: number;
  };
  readonly gates: readonly GateSnapshot[];
};

type NativeSubscriptionSnapshot = {
  readonly id: string;
  readonly incarnation: number;
  readonly started: number;
  readonly finally: number;
  readonly emitted: number;
  readonly protocolComplete: number;
  readonly clientComplete: number;
  readonly socketClose: number;
  readonly active: boolean;
};

type NativeChild = ReturnType<typeof Bun.spawn>;

type ChildResource = { readonly child: NativeChild; controlUrl?: string };

const owners = new Set<Owner>();
const graphs = new Set<{ dispose(): void }>();
const clients: Array<{ stop(): void }> = [];
const children: ChildResource[] = [];
const subscriptions: Array<() => void> = [];
const webSocketClients: Array<{ dispose(): void | Promise<void> }> = [];
const mounts: MountedApplication[] = [];
const windows: Window[] = [];

const fullDocument = parse(`
  query Full($value: String!) {
    echo(value: $value)
    contextEcho(value: $value) {
      value
      identity
    }
  }
`) as TypedDocumentNode<FullData, ValueVariables>;

const partialDocument = parse(`
  query Partial {
    partial {
      ok
      broken
    }
  }
`) as TypedDocumentNode<PartialData, EmptyVariables>;

const rootFailureDocument = parse(`query RootFailure { rootFailure }`) as TypedDocumentNode<
  RootFailureData,
  EmptyVariables
>;

const deferredRootFailureDocument = parse(`
  query IncrementalDeferredRootFailure {
    __typename
    ... @defer(label: "deferred-root-failure") { rootFailure }
  }
`) as TypedDocumentNode<DeferredRootFailureData, EmptyVariables>;

const incrementalPartialErrorDocument = parse(`
  query IncrementalPartialError {
    ... @defer(label: "partial-error") { partial { ok broken } }
  }
`) as TypedDocumentNode<PartialData, EmptyVariables>;

const incrementalStreamErrorDocument = parse(`
  query IncrementalStreamError {
    incrementalFailureItems @stream(initialCount: 1, label: "failure-items")
  }
`) as TypedDocumentNode<IncrementalFailureData, EmptyVariables>;

const incrementalBoardDocument = parse(`
  query IncrementalBoard {
    incrementalBoard {
      items @stream(initialCount: 1, label: "board-items") {
        id
        title
        ... @defer(label: "item-details") { details }
      }
    }
  }
`) as TypedDocumentNode<
  {
    readonly incrementalBoard: {
      readonly items: readonly {
        readonly id: string;
        readonly title: string;
        readonly details: string;
      }[];
    };
  },
  EmptyVariables
>;

const serverStateDocument = parse(
  `query ServerState { state { revision writes } }`,
) as TypedDocumentNode<ServerStateData, EmptyVariables>;

const writeDocument = parse(`
  mutation WriteThenFail($value: String!) {
    writeThenFail(value: $value) {
      value
      failure
    }
  }
`) as TypedDocumentNode<WriteData, ValueVariables>;

const cleanWriteDocument = parse(`
  mutation Write($value: String!) {
    writeThenFail(value: $value) {
      value
    }
  }
`) as TypedDocumentNode<CleanWriteData, ValueVariables>;

const gateDocument = parse(`
  mutation WaitAtGate($id: ID!) {
    waitAtGate(id: $id)
  }
`) as TypedDocumentNode<GateData, { readonly id: string }>;

const nativeEventsDocument = parse(`
  subscription NativeEvents($id: ID!) {
    events(id: $id) {
      sequence
      value
      broken
      fatal
    }
  }
`) as TypedDocumentNode<NativeEventsData, NativeEventsVariables>;

function ownGraph<C extends Contract>(contract: C): Graph<C> {
  const graph = createGraph({ contract });

  graphs.add(graph);

  return graph;
}

function makeOwner(): Owner {
  const context = {
    document: {} as Document,
    container: {} as Element,
    onError: (error: unknown) => {
      throw error;
    },
    warn: () => undefined,
    nextGeneration: 0,
    scheduler: undefined,
  } as unknown as RuntimeContext;
  const owner = new Owner(context, null, "graphql-native-test");

  owner.commit();

  owners.add(owner);

  return owner;
}

function bindOwner<C extends Contract>(owner: Owner, graph: Graph<C>, contract: C): ImportedApi<C> {
  return bindImported(owner, withAeolia(graph, contract)) as ImportedApi<C>;
}

function mountQueryOwner(): Owner {
  const window = new Window({ url: "https://graphql.test/" });
  windows.push(window);
  let captured: Owner | undefined;
  const Consumer = defineComponent((owner) => {
    captured = owner;
    return text(owner, () => "");
  });
  const application = mount(
    window.document.body as unknown as Element,
    Consumer,
    {},
    {
      dataBinding: { application: createDataApplication(), security: () => ({ kind: "none" }) },
    },
  );
  mounts.push(application);
  if (!captured) throw new Error("The public mount did not prepare its query owner");
  return captured;
}

function makeClient(uri: string, context?: { readonly headers: Record<string, string> }) {
  const client = createGraphQLClient({
    link: new HttpLink({ uri }),
    ...(context === undefined ? {} : { context }),
  });

  clients.push(client);

  return client;
}

function makeNativeWebSocketClient(uri: string, session: string) {
  const client = createNativeWebSocketClient({
    url: uri,
    connectionParams: { session },
    lazy: false,
  });

  webSocketClients.push(client);

  return client;
}

function makeGraphQLClientWithLink(link: ApolloLink) {
  const client = createGraphQLClient({ link });

  clients.push(client);

  return client;
}

async function disposeNativeWebSocketClient(client: {
  dispose(): void | Promise<void>;
}): Promise<void> {
  await client.dispose();

  const index = webSocketClients.indexOf(client);

  if (index >= 0) webSocketClients.splice(index, 1);
}

async function readReadyLine(child: NativeChild): Promise<string> {
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let output = "";
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const stderr = new Response(child.stderr as ReadableStream<Uint8Array>).text();

  try {
    const line = await Promise.race([
      (async () => {
        while (true) {
          const chunk = await reader.read();

          if (chunk.done) {
            const [status, errors] = await Promise.all([child.exited, stderr]);

            throw new Error(
              `GraphQL Yoga fixture exited before readiness (${status})\n${output}\n${errors}`,
            );
          }

          output += decoder.decode(chunk.value, { stream: true });
          const newline = output.indexOf("\n");

          if (newline >= 0) return output.slice(0, newline);
        }
      })(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Timed out waiting for the GraphQL Yoga fixture readiness line")),
          15_000,
        );
      }),
    ]);

    return line;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);

    await reader.cancel().catch(() => undefined);

    reader.releaseLock();
  }
}

async function startFixture(): Promise<FixtureReady> {
  const nodeOverride = process.env.HESPERIA_GRAPHQL_NODE;

  if (nodeOverride !== undefined && !isAbsolute(nodeOverride)) {
    throw new Error(
      "HESPERIA_GRAPHQL_NODE must be an absolute Node 22.23.2 executable path when supplied",
    );
  }

  if (!isAbsolute(process.execPath) || Bun.version !== "1.4.4") {
    throw new Error("The GraphQL fixture launcher requires the pinned Bun 1.4.4 executable");
  }

  const fixturePath = resolve(import.meta.dir, "fixtures/graphql-server.fixture.mjs");
  const command =
    nodeOverride === undefined
      ? [process.execPath, "--no-env-file", "--no-install", fixturePath, "bun"]
      : [nodeOverride, fixturePath, "node"];
  const child = Bun.spawn(command, {
    cwd: resolve(import.meta.dir, "../.."),
    stdout: "pipe",
    stderr: "pipe",
  });
  const resource: ChildResource = { child };

  children.push(resource);

  const ready = JSON.parse(await readReadyLine(child)) as FixtureReady;

  if (
    ready.type !== "ready" ||
    ready.host !== "127.0.0.1" ||
    ready.port < 1 ||
    !ready.instanceId ||
    !ready.graphqlUrl ||
    !ready.graphqlWsUrl ||
    !ready.controlUrl
  ) {
    throw new Error(
      `GraphQL Yoga fixture returned invalid readiness data: ${JSON.stringify(ready)}`,
    );
  }

  resource.controlUrl = ready.controlUrl;

  return ready;
}

async function controlRequest<T>(
  fixture: FixtureReady,
  path: string,
  method: "GET" | "POST",
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${fixture.controlUrl}/${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
    signal: AbortSignal.timeout(35_000),
  });
  const value = (await response.json()) as T & { error?: string };

  if (!response.ok)
    throw new Error(`GraphQL fixture control ${path} failed (${response.status}): ${value.error}`);

  return value;
}

async function waitForGate(
  fixture: FixtureReady,
  id: string,
  phase: "started" | "aborted" | "completed" | "lateCompletion",
): Promise<GateSnapshot> {
  const search = new URLSearchParams({ gate: id, phase });

  return controlRequest<GateSnapshot>(fixture, `wait?${search}`, "GET");
}

async function readFixtureState(fixture: FixtureReady): Promise<FixtureSnapshot> {
  return controlRequest<FixtureSnapshot>(fixture, "state", "GET");
}

function subscriptionQuery(session: string, id: string, extra?: Record<string, string>): string {
  return new URLSearchParams({ session, id, ...extra }).toString();
}

async function readSubscriptionSnapshot(
  fixture: FixtureReady,
  session: string,
  id: string,
  incarnation?: number,
): Promise<NativeSubscriptionSnapshot> {
  const extra = incarnation === undefined ? undefined : { incarnation: String(incarnation) };

  return controlRequest<NativeSubscriptionSnapshot>(
    fixture,
    `subscription?${subscriptionQuery(session, id, extra)}`,
    "GET",
  );
}

async function waitForSubscription(
  fixture: FixtureReady,
  session: string,
  id: string,
  phase: "started" | "finally" | "emitted" | "protocolComplete" | "clientComplete" | "socketClose",
  count = 1,
  incarnation?: number,
): Promise<NativeSubscriptionSnapshot> {
  const extra = {
    phase,
    count: String(count),
    ...(incarnation === undefined ? {} : { incarnation: String(incarnation) }),
  };

  return controlRequest<NativeSubscriptionSnapshot>(
    fixture,
    `wait-subscription?${subscriptionQuery(session, id, extra)}`,
    "GET",
  );
}

async function postSubscriptionControl(
  fixture: FixtureReady,
  route:
    | "subscription-event"
    | "subscription-finish"
    | "subscription-throw"
    | "subscription-cancel",
  session: string,
  id: string,
  body?: unknown,
  incarnation?: number,
): Promise<{
  readonly accepted: true;
  readonly id: string;
  readonly incarnation: number;
  readonly command?: string;
}> {
  const extra = incarnation === undefined ? undefined : { incarnation: String(incarnation) };

  return controlRequest(fixture, `${route}?${subscriptionQuery(session, id, extra)}`, "POST", body);
}

async function captureFailure<T>(promise: Promise<T>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

function requireGraphQLResult<T>(
  result: GraphQLResult<T> | undefined,
  description: string,
): GraphQLResult<T> {
  if (result === undefined) throw new Error(`Expected ${description} GraphQL result envelope`);

  return result;
}

function graphQLErrorMessages(error: unknown): string[] {
  const values = Array.isArray(error) ? error : [error];

  return values.flatMap((value) => {
    if (value instanceof Error) return [value.message];

    if (
      typeof value === "object" &&
      value !== null &&
      "message" in value &&
      typeof value.message === "string"
    )
      return [value.message];

    return [];
  });
}

async function stopChild(resource: ChildResource): Promise<void> {
  if (resource.controlUrl !== undefined) {
    try {
      const response = await fetch(`${resource.controlUrl}/shutdown`, {
        method: "POST",
        signal: AbortSignal.timeout(2_000),
      });

      await response.arrayBuffer();
    } catch {
      resource.child.kill();
    }
  } else {
    resource.child.kill();
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const exited = await Promise.race([
    resource.child.exited.then(() => true),
    new Promise<false>((resolveTimeout) => {
      timeout = setTimeout(() => resolveTimeout(false), 5_000);
    }),
  ]);

  if (timeout !== undefined) clearTimeout(timeout);

  if (!exited) {
    resource.child.kill();

    await resource.child.exited;
  }
}

function observed<T>(read: () => T, accept: (value: T) => boolean): Promise<T> {
  const result = Promise.withResolvers<T>();
  const value = computed(read);
  let done = false;
  let stop: (() => void) | undefined;

  const check = (next: T): void => {
    if (done || !accept(next)) return;

    done = true;
    stop?.();
    result.resolve(next);
  };

  stop = subscribe(value, check);

  if (done) stop();
  else check(value.get());

  subscriptions.push(stop);

  return result.promise;
}

afterEach(async () => {
  for (const stop of subscriptions.splice(0)) stop();
  for (const application of mounts.splice(0)) application.dispose();

  for (const owner of owners) {
    owners.delete(owner);

    owner.dispose();
  }

  for (const graph of graphs) {
    graphs.delete(graph);

    graph.dispose();
  }

  for (const client of clients.splice(0)) client.stop();

  for (const client of webSocketClients.splice(0)) await client.dispose();

  for (const child of children.splice(0)) await stopChild(child);
  for (const window of windows.splice(0)) window.close();
});

test("incremental progress reports terminal null only for a completed response", async () => {
  const fixture = await startFixture();
  let nullResponseFrames = 0;
  let rootFailureLinkCompletions = 0;
  let missingDataResponsesWithoutData = 0;
  let missingDataLinkCompletions = 0;
  const rootFailureObserver = new ApolloLink((operation, forward) => {
    if (!forward) throw new Error("The root-failure observer has no forwarded link");

    return forward(operation).pipe(
      tap({
        next(result) {
          const response = result as {
            readonly data?: unknown;
            readonly errors?: readonly unknown[];
          };

          if (
            operation.operationName === "RootFailure" &&
            Object.prototype.hasOwnProperty.call(result, "data") &&
            response.data === null
          )
            nullResponseFrames += 1;

          if (
            operation.operationName === "IncrementalMissingData" &&
            !Object.prototype.hasOwnProperty.call(result, "data") &&
            Array.isArray(response.errors) &&
            response.errors.length > 0
          )
            missingDataResponsesWithoutData += 1;
        },
        complete() {
          if (operation.operationName === "RootFailure") rootFailureLinkCompletions += 1;

          if (operation.operationName === "IncrementalMissingData") missingDataLinkCompletions += 1;
        },
      }),
    );
  });
  const client = createGraphQLClient({
    link: ApolloLink.from([
      rootFailureObserver,
      new HttpLink({
        uri: fixture.graphqlUrl.replace(/\/graphql$/, "/graphql-incremental"),
      }),
    ]),
    experimentalIncremental: { profile: "graphql17-v0.2" },
  });

  clients.push(client);

  const missingDataDocument = parse(
    "query IncrementalMissingData($value: String!) { echo(value: $value) }",
  ) as TypedDocumentNode<EmptyVariables, EmptyVariables>;
  const rejectedNullOutput: StandardSchemaV1<GraphQLResult<RootFailureData>, RootFailureData> = {
    "~standard": {
      version: 1,
      vendor: "graphql-terminal-null-test",
      validate() {
        return { issues: [{ message: "terminal null output validation rejected" }] };
      },
    },
  };
  const terminalNullAll = client.query({
    name: "graphql-incremental.terminal-null-all",
    document: rootFailureDocument,
    key: () => "terminal-null/all",
    errorPolicy: "all",
  });
  const terminalNullIgnore = client.query({
    name: "graphql-incremental.terminal-null-ignore",
    document: rootFailureDocument,
    key: () => "terminal-null/ignore",
    errorPolicy: "ignore",
  });
  const terminalNullNone = client.query({
    name: "graphql-incremental.terminal-null-none",
    document: rootFailureDocument,
    key: () => "terminal-null/none",
    errorPolicy: "none",
  });
  const terminalNullOutputRejected = registerNativeQueryProfile(
    client.query({
      name: "graphql-incremental.terminal-null-output-rejected",
      document: rootFailureDocument,
      key: () => "terminal-null/output-rejected",
    }),
    { output: rejectedNullOutput },
  );
  const missingData = client.query({
    name: "graphql-incremental.missing-data",
    document: missingDataDocument,
    key: () => "missing-data",
  });
  const contract = defineContract({
    namespace: "graphql-incremental-terminal-null",
    operations: {
      terminalNullAll,
      terminalNullIgnore,
      terminalNullNone,
      terminalNullOutputRejected,
      missingData,
    },
  });
  const graph = ownGraph(contract);
  const owner = mountQueryOwner();

  const api = bindOwner(owner, graph, contract);
  const terminalNullCases = [
    { run: () => api.terminalNullAll({}), hasErrors: true },
    { run: () => api.terminalNullIgnore({}), hasErrors: false },
  ] as const;

  for (const { run, hasErrors } of terminalNullCases) {
    const view = run();
    const progress = view.project();
    const previousFrames = nullResponseFrames;
    const previousCompletions = rootFailureLinkCompletions;
    const result = await view.ready;
    const value = progress.value();

    if (value === undefined) throw new Error("Expected terminal-null progress");

    expect(nullResponseFrames).toBe(previousFrames + 1);
    expect(rootFailureLinkCompletions).toBe(previousCompletions + 1);
    expect(result.data).toBeNull();
    expect(result.extensions).toMatchObject({ fixture: { instanceId: fixture.instanceId } });
    expect(value.dataState).toBe("empty");
    expect(value.data).toBeNull();
    expect(value.errors).toStrictEqual(result.errors);
    expect(value.extensions).toStrictEqual(result.extensions);
    expect(progress.status()).toBe("complete");
    expect(progress.pending()).toBe(false);

    if (hasErrors) {
      expect(value.errors?.map(({ message, path }) => ({ message, path }))).toStrictEqual([
        { message: "fixture root failure", path: ["rootFailure"] },
      ]);
    } else {
      expect("errors" in value).toBe(false);
    }
  }

  const noneView = api.terminalNullNone({});
  const noneProgress = noneView.project();
  const previousNoneFrames = nullResponseFrames;
  const noneFailure = await captureFailure(noneView.ready);
  const noneResult = (noneFailure as GraphQLResultError<RootFailureData> | undefined)?.result;

  expect(nullResponseFrames).toBe(previousNoneFrames + 1);
  expect(noneFailure).toBeInstanceOf(Error);
  expect(noneResult?.data).toBeNull();
  expect(noneResult?.errors?.map(({ message }) => message)).toStrictEqual(["fixture root failure"]);
  expect(noneProgress.value()).toBeUndefined();
  expect(noneProgress.status()).toBe("failed");
  expect(noneProgress.pending()).toBe(false);

  const outputRejectedView = api.terminalNullOutputRejected({});
  const outputRejectedProgress = outputRejectedView.project();
  const previousOutputFrames = nullResponseFrames;
  const previousOutputCompletions = rootFailureLinkCompletions;
  const outputFailure = await captureFailure(outputRejectedView.ready);

  expect(nullResponseFrames).toBe(previousOutputFrames + 1);
  expect(rootFailureLinkCompletions).toBe(previousOutputCompletions + 1);
  expect(outputFailure).toBeDefined();
  expect(outputRejectedProgress.value()?.dataState).toBe("empty");
  expect(outputRejectedProgress.value()?.data).toBeNull();
  expect(outputRejectedProgress.status()).toBe("failed");
  expect(outputRejectedProgress.pending()).toBe(false);

  const missingDataView = api.missingData({});
  const missingDataProgress = missingDataView.project();
  const missingDataFailure = await captureFailure(missingDataView.ready);
  const missingDataResult = (missingDataFailure as GraphQLResultError<EmptyVariables> | undefined)
    ?.result;

  expect(missingDataFailure).toBeInstanceOf(Error);
  expect(missingDataResponsesWithoutData).toBe(1);
  expect(missingDataLinkCompletions).toBe(1);
  expect(missingDataResult?.data).toBeUndefined();
  expect(missingDataResult?.errors?.[0]?.message).toContain("$value");
  expect(missingDataProgress.value()).toBeUndefined();
  expect(missingDataProgress.status()).toBe("failed");
  expect(missingDataProgress.pending()).toBe(false);
});

test("incremental error policies retain actual patch and completion errors", async () => {
  const fixture = await startFixture();
  const client = createGraphQLClient({
    link: new HttpLink({
      uri: fixture.graphqlUrl.replace(/\/graphql$/, "/graphql-incremental"),
    }),
    experimentalIncremental: { profile: "graphql17-v0.2" },
  });

  clients.push(client);

  const all = client.query({
    name: "graphql-incremental.errors.all",
    document: incrementalPartialErrorDocument,
    key: () => "partial/all",
    errorPolicy: "all",
  });
  const ignore = client.query({
    name: "graphql-incremental.errors.ignore",
    document: incrementalPartialErrorDocument,
    key: () => "partial/ignore",
    errorPolicy: "ignore",
  });
  const none = client.query({
    name: "graphql-incremental.errors.none",
    document: incrementalPartialErrorDocument,
    key: () => "partial/none",
    errorPolicy: "none",
  });
  const completed = client.query({
    name: "graphql-incremental.errors.completed",
    document: incrementalStreamErrorDocument,
    key: () => "stream/completed-error",
    errorPolicy: "all",
  });
  const contract = defineContract({
    namespace: "graphql-incremental-errors",
    operations: { all, ignore, none, completed },
  });
  const graph = ownGraph(contract);
  const owner = makeOwner();
  const api = bindOwner(owner, graph, contract);

  const allView = api.all({});
  const allProgress = allView.project();
  const allResult = await allView.ready;

  expect(allResult.data?.partial).toStrictEqual({
    __typename: "PartialResult",
    ok: "partial-ok",
    broken: null,
  });
  expect(allResult.errors?.map(({ message }) => message)).toStrictEqual([
    "fixture partial field failure",
  ]);
  expect(allResult.extensions?.fixture).toStrictEqual({
    instanceId: fixture.instanceId,
    phase: "subsequent",
  });
  expect(allProgress.value()?.dataState).toBe("complete");
  expect(allProgress.value()?.errors?.map(({ message }) => message)).toStrictEqual([
    "fixture partial field failure",
  ]);
  expect(allProgress.status()).toBe("complete");

  const ignoreView = api.ignore({});
  const ignoreProgress = ignoreView.project();
  const ignoreResult = await ignoreView.ready;

  expect(ignoreResult.data?.partial).toStrictEqual({
    __typename: "PartialResult",
    ok: "partial-ok",
    broken: null,
  });
  expect(ignoreResult.errors).toBeUndefined();
  expect(ignoreResult.extensions?.fixture).toStrictEqual({
    instanceId: fixture.instanceId,
    phase: "subsequent",
  });
  expect(ignoreProgress.value()?.dataState).toBe("complete");
  expect(ignoreProgress.value()?.errors).toBeUndefined();
  expect(ignoreProgress.status()).toBe("complete");

  const noneView = api.none({});
  const noneProgress = noneView.project();
  const noneError = await captureFailure(noneView.ready);
  const noneResult = (noneError as GraphQLResultError<unknown> | undefined)?.result;

  expect(noneError).toBeInstanceOf(Error);
  expect(noneResult?.data).toMatchObject({
    partial: { ok: "partial-ok", broken: null },
  });
  expect(noneResult?.errors?.map(({ message }) => message)).toStrictEqual([
    "fixture partial field failure",
  ]);
  expect(noneResult?.extensions?.fixture).toStrictEqual({
    instanceId: fixture.instanceId,
    phase: "subsequent",
  });
  expect(noneProgress.status()).toBe("failed");
  expect(noneProgress.pending()).toBe(false);

  const completedView = api.completed({});
  const completedProgress = completedView.project();
  const completedResult = await completedView.ready;

  expect(completedResult.data?.incrementalFailureItems).toStrictEqual(["initial failure item"]);
  expect(completedResult.errors?.map(({ message }) => message)).toStrictEqual([
    "fixture incremental stream failure",
  ]);
  expect(completedResult.extensions?.fixture).toStrictEqual({
    instanceId: fixture.instanceId,
    phase: "subsequent",
  });
  expect(completedProgress.value()?.dataState).toBe("complete");
  expect(completedProgress.value()?.data).toStrictEqual({
    incrementalFailureItems: ["initial failure item"],
  });
  expect(completedProgress.value()?.errors?.map(({ message }) => message)).toStrictEqual([
    "fixture incremental stream failure",
  ]);
  expect(completedProgress.status()).toBe("complete");
  expect(completedProgress.pending()).toBe(false);
});

test("a completed deferred error preserves Apollo streaming progress", async () => {
  const fixture = await startFixture();
  const deferredFrames: Array<{
    readonly hasNext: unknown;
    readonly hasExtensions: boolean;
    readonly extensions?: Record<string, unknown>;
    readonly pendingLabels: readonly string[];
    readonly completionErrorMessages: readonly string[];
  }> = [];
  let deferredLinkCompletions = 0;
  const deferredLinkObserver = new ApolloLink((operation, forward) => {
    if (!forward) throw new Error("The deferred Link observer has no forwarded link");

    return forward(operation).pipe(
      tap({
        next(result) {
          if (operation.operationName !== "IncrementalDeferredRootFailure") return;

          const frame = result as {
            readonly hasNext?: unknown;
            readonly extensions?: Record<string, unknown>;
            readonly pending?: readonly { readonly label?: unknown }[];
            readonly completed?: readonly {
              readonly errors?: readonly { readonly message?: unknown }[];
            }[];
          };
          deferredFrames.push({
            hasNext: frame.hasNext,
            hasExtensions: Object.prototype.hasOwnProperty.call(result, "extensions"),
            extensions: frame.extensions,
            pendingLabels: (frame.pending ?? []).flatMap(({ label }) =>
              typeof label === "string" ? [label] : [],
            ),
            completionErrorMessages: (frame.completed ?? []).flatMap(({ errors }) =>
              (errors ?? []).flatMap(({ message }) =>
                typeof message === "string" ? [message] : [],
              ),
            ),
          });
        },
        complete() {
          if (operation.operationName === "IncrementalDeferredRootFailure")
            deferredLinkCompletions += 1;
        },
      }),
    );
  });
  const client = createGraphQLClient({
    link: ApolloLink.from([
      deferredLinkObserver,
      new HttpLink({
        uri: fixture.graphqlUrl.replace("/graphql", "/graphql-incremental"),
      }),
    ]),
    experimentalIncremental: { profile: "graphql17-v0.2" },
  });

  clients.push(client);

  let deferredOutputValidationCount = 0;
  let deferredOutputValidationInput: unknown;
  const rejectedDeferredOutput: StandardSchemaV1<
    GraphQLResult<DeferredRootFailureData>,
    DeferredRootFailureData
  > = {
    "~standard": {
      version: 1,
      vendor: "graphql-deferred-root-failure-test",
      validate(value) {
        deferredOutputValidationCount += 1;
        deferredOutputValidationInput = value;

        return { issues: [{ message: "deferred output validation rejected" }] };
      },
    },
  };
  const latestExtensions = (frames: typeof deferredFrames): Record<string, unknown> | undefined => {
    let latest: Record<string, unknown> | undefined;

    for (const frame of frames) {
      if (frame.hasExtensions) latest = frame.extensions;
    }

    return latest;
  };
  const cases = [
    { policy: "all", hasErrors: true },
    { policy: "ignore", hasErrors: false },
  ] as const;

  for (const { policy, hasErrors } of cases) {
    const query = client.query({
      name: "graphql-incremental.deferred-root-failure." + policy,
      document: deferredRootFailureDocument,
      key: () => "deferred-root-failure/" + policy,
      errorPolicy: policy,
    });
    const contract = defineContract({
      namespace: "graphql-incremental-deferred-failure-" + policy,
      operations: { query },
    });
    const graph = ownGraph(contract);
    const owner = makeOwner();
    const previousFrameCount = deferredFrames.length;
    const previousCompletionCount = deferredLinkCompletions;
    const view = bindOwner(owner, graph, contract).query({});
    const progress = view.project();
    const result = await view.ready;
    const requestFrames = deferredFrames.slice(previousFrameCount);
    const finalFrame = requestFrames.at(-1);
    const extensions = latestExtensions(requestFrames);
    const value = progress.value();

    if (!finalFrame) throw new Error("Expected raw deferred response frames");
    if (!extensions) throw new Error("Expected top-level fixture extensions");
    if (!value) throw new Error("Expected deferred progress");

    expect(deferredLinkCompletions).toBe(previousCompletionCount + 1);
    expect(
      requestFrames.some(({ pendingLabels }) => pendingLabels.includes("deferred-root-failure")),
    ).toBe(true);
    expect(
      requestFrames.some(
        ({ completionErrorMessages, hasNext }) =>
          completionErrorMessages.includes("fixture root failure") && hasNext === false,
      ),
    ).toBe(true);
    expect(finalFrame.hasNext).toBe(false);
    expect(extensions).toMatchObject({
      fixture: { instanceId: fixture.instanceId, phase: "subsequent" },
    });
    expect(result.extensions).toStrictEqual(extensions);
    expect(value.extensions).toStrictEqual(extensions);
    expect(value.dataState).toBe("streaming");
    expect(progress.status()).toBe("complete");
    expect(progress.pending()).toBe(false);

    if (hasErrors) {
      expect(result.errors?.map(({ message }) => message)).toContain("fixture root failure");
      expect(value.errors?.map(({ message }) => message)).toContain("fixture root failure");
    } else {
      expect("errors" in result).toBe(false);
      expect("errors" in value).toBe(false);
    }
  }

  const outputRejectedQuery = registerNativeQueryProfile(
    client.query({
      name: "graphql-incremental.deferred-root-failure.output-rejected",
      document: deferredRootFailureDocument,
      key: () => "deferred-root-failure/output-rejected",
      errorPolicy: "all",
    }),
    { output: rejectedDeferredOutput },
  );
  const outputRejectedContract = defineContract({
    namespace: "graphql-incremental-deferred-failure-output",
    operations: { query: outputRejectedQuery },
  });
  const outputRejectedGraph = ownGraph(outputRejectedContract);
  const outputRejectedOwner = mountQueryOwner();

  const previousOutputFrameCount = deferredFrames.length;
  const previousOutputCompletionCount = deferredLinkCompletions;
  const outputRejectedView = bindOwner(
    outputRejectedOwner,
    outputRejectedGraph,
    outputRejectedContract,
  ).query({});
  const outputRejectedProgress = outputRejectedView.project();
  const outputFailure = await captureFailure(outputRejectedView.ready);
  const outputFrames = deferredFrames.slice(previousOutputFrameCount);
  const outputFinalFrame = outputFrames.at(-1);
  const outputExtensions = latestExtensions(outputFrames);

  if (!outputFinalFrame) throw new Error("Expected raw output-rejected deferred frames");
  if (!outputExtensions) throw new Error("Expected output-rejected fixture extensions");

  expect(outputFailure).toBeInstanceOf(Error);
  expect(deferredOutputValidationCount).toBe(1);
  expect(deferredOutputValidationInput).toMatchObject({
    errors: expect.arrayContaining([expect.objectContaining({ message: "fixture root failure" })]),
  });
  expect(deferredLinkCompletions).toBe(previousOutputCompletionCount + 1);
  expect(outputFinalFrame.hasNext).toBe(false);
  expect(
    outputFrames.some(
      ({ completionErrorMessages, hasNext }) =>
        completionErrorMessages.includes("fixture root failure") && hasNext === false,
    ),
  ).toBe(true);
  expect(outputRejectedProgress.value()?.dataState).toBe("streaming");
  expect(outputExtensions).toMatchObject({
    fixture: { instanceId: fixture.instanceId, phase: "subsequent" },
  });
  expect(outputRejectedProgress.value()?.extensions).toStrictEqual(outputExtensions);
  expect(outputRejectedProgress.status()).toBe("failed");
  expect(outputRejectedProgress.pending()).toBe(false);

  const noneQuery = client.query({
    name: "graphql-incremental.deferred-root-failure.none",
    document: deferredRootFailureDocument,
    key: () => "deferred-root-failure/none",
    errorPolicy: "none",
  });
  const noneContract = defineContract({
    namespace: "graphql-incremental-deferred-failure-none",
    operations: { query: noneQuery },
  });
  const noneGraph = ownGraph(noneContract);
  const noneOwner = makeOwner();
  const previousNoneFrameCount = deferredFrames.length;
  const noneView = bindOwner(noneOwner, noneGraph, noneContract).query({});
  const noneProgress = noneView.project();
  const noneFailure = await captureFailure(noneView.ready);
  const noneFrames = deferredFrames.slice(previousNoneFrameCount);

  expect(noneFailure).toBeInstanceOf(Error);
  expect(
    noneFrames.some(
      ({ completionErrorMessages, hasNext }) =>
        completionErrorMessages.includes("fixture root failure") && hasNext === false,
    ),
  ).toBe(true);
  const noneResult = (noneFailure as GraphQLResultError<DeferredRootFailureData>).result;
  expect(noneResult?.errors?.map(({ message }) => message)).toContain("fixture root failure");
  expect(noneProgress.status()).toBe("failed");
  expect(noneProgress.pending()).toBe(false);
});

test("incremental queries preserve transport and Link failures", async () => {
  const fixture = await startFixture();
  let incrementalTransportLinkError: unknown;
  const incrementalTransportObserver = new ApolloLink((operation, forward) => {
    if (!forward) throw new Error("The incremental transport observer has no forwarded link");

    return forward(operation).pipe(
      tap({
        error(error) {
          incrementalTransportLinkError = error;
        },
      }),
    );
  });
  const incrementalIgnoredTransportClient = createGraphQLClient({
    link: ApolloLink.from([
      incrementalTransportObserver,
      new HttpLink({ uri: fixture.controlUrl + "/transport-error" }),
    ]),
    queryErrorPolicy: "ignore",
    experimentalIncremental: { profile: "graphql17-v0.2" },
  });

  const incrementalPostFrameLinkError = new Error("incremental Link failed after a response frame");
  let incrementalUndefinedLinkErrorObserved = false;
  const incrementalPostFrameLink = new ApolloLink(
    (operation) =>
      new Observable<ApolloLink.Result>((observer) => {
        const value = operation.variables.value as string;
        if (value === "undefined-null-frame") {
          observer.next({ data: null } as unknown as ApolloLink.Result);
          incrementalUndefinedLinkErrorObserved = true;
          observer.error(undefined);

          return;
        }

        observer.next({
          data: { echo: value, contextEcho: { value, identity: null } },
          hasNext: false,
        } as unknown as ApolloLink.Result);
        observer.error(incrementalPostFrameLinkError);
      }),
  );
  const incrementalPostFrameClient = createGraphQLClient({
    link: incrementalPostFrameLink,
    queryErrorPolicy: "ignore",
    experimentalIncremental: { profile: "graphql17-v0.2" },
  });
  clients.push(incrementalIgnoredTransportClient, incrementalPostFrameClient);

  const ignoredTransportQuery = incrementalIgnoredTransportClient.query({
    name: "graphql-incremental-policy.ignored-transport",
    document: rootFailureDocument,
    key: () => "ignored-transport",
    revalidateAfterMs: 60_000,
  });
  const incrementalPostFrameQuery = incrementalPostFrameClient.query({
    name: "graphql-incremental-policy.post-frame-error",
    document: fullDocument,
    key: ({ value }) => "post-frame-error/" + value,
    revalidateAfterMs: 60_000,
  });
  const incrementalUndefinedLinkQuery = incrementalPostFrameClient.query({
    name: "graphql-incremental-policy.undefined-null-frame-error",
    document: fullDocument,
    key: ({ value }) => "undefined-null-frame-error/" + value,
    revalidateAfterMs: 60_000,
  });
  const contract = defineContract({
    namespace: "graphql-incremental-policy",
    operations: { ignoredTransportQuery, incrementalPostFrameQuery, incrementalUndefinedLinkQuery },
  });
  const graph = ownGraph(contract);
  const owner = mountQueryOwner();

  const api = bindOwner(owner, graph, contract);

  const ignoredTransportView = api.ignoredTransportQuery({});
  const ignoredTransportProgress = ignoredTransportView.project();
  const ignoredTransportFailure = await captureFailure(ignoredTransportView.ready);
  expect(ignoredTransportFailure).toBeInstanceOf(Error);
  expect((ignoredTransportFailure as Error).message).toBe(
    "The incremental GraphQL operation did not produce a complete result",
  );
  expect((ignoredTransportFailure as GraphQLResultError).cause).toBe(incrementalTransportLinkError);
  expect(incrementalTransportLinkError).toBeInstanceOf(Error);
  expect(ignoredTransportProgress.status()).toBe("failed");
  expect(ignoredTransportProgress.pending()).toBe(false);
  expect(ignoredTransportProgress.value()).toBeUndefined();

  const incrementalPostFrameView = api.incrementalPostFrameQuery({ value: "frame-error" });
  const incrementalPostFrameProgress = incrementalPostFrameView.project();
  const incrementalPostFrameFailure = await captureFailure(incrementalPostFrameView.ready);
  expect(incrementalPostFrameFailure).toBeInstanceOf(Error);
  expect(
    incrementalPostFrameFailure === incrementalPostFrameLinkError ||
      (incrementalPostFrameFailure as GraphQLResultError).cause === incrementalPostFrameLinkError,
  ).toBe(true);
  expect(incrementalPostFrameProgress.status()).toBe("failed");
  expect(incrementalPostFrameProgress.pending()).toBe(false);
  expect(incrementalPostFrameProgress.value()?.dataState).not.toBe("complete");

  const undefinedFrameView = api.incrementalUndefinedLinkQuery({
    value: "undefined-null-frame",
  });
  const undefinedFrameProgress = undefinedFrameView.project();
  const undefinedFrameOutcome = await undefinedFrameView.ready.then(
    () => "resolved",
    () => "rejected",
  );

  expect(incrementalUndefinedLinkErrorObserved).toBe(true);
  expect(undefinedFrameOutcome).toBe("rejected");
  expect(undefinedFrameProgress.value()).toBeUndefined();
  expect(undefinedFrameProgress.status()).toBe("failed");
  expect(undefinedFrameProgress.pending()).toBe(false);
});

test("aborting an incremental HTTP execution interrupts its observed progress", async () => {
  const fixture = await startFixture();
  let nativeSignal: AbortSignal | undefined;
  const signalObserver = new ApolloLink((operation, forward) => {
    if (!forward) throw new Error("The incremental signal observer has no forwarded link");
    nativeSignal = operation.getContext().fetchOptions?.signal;
    return forward(operation);
  });
  const client = createGraphQLClient({
    link: ApolloLink.from([
      signalObserver,
      new HttpLink({ uri: fixture.graphqlUrl.replace(/\/graphql$/, "/graphql-incremental") }),
    ]),
    experimentalIncremental: { profile: "graphql17-v0.2" },
  });
  clients.push(client);
  const query = client.query({
    name: "graphql-incremental.interrupted",
    document: incrementalBoardDocument,
    key: () => "interrupted",
  });
  const contract = defineContract({
    namespace: "graphql-incremental-interrupted",
    operations: { query },
  });
  const graph = ownGraph(contract);
  const caller = new AbortController();
  const view = bindOwner(mountQueryOwner(), graph, contract).query(
    {},
    { abortSignal: caller.signal },
  );
  const progress = view.project();
  const failure = captureFailure(view.ready);
  const partial = await observed(progress.value, (value) => value?.dataState === "streaming");
  const started = await waitForGate(fixture, "incremental-streamed-details", "started");
  expect(partial?.dataState).toBe("streaming");
  expect(started).toMatchObject({ started: 1, completed: 0, pending: true });
  if (!nativeSignal) throw new Error("The native HTTP request did not receive its abort signal");
  expect(nativeSignal.aborted).toBe(false);

  const reason = new DOMException("caller interrupted incremental query", "AbortError");
  caller.abort(reason);
  expect(caller.signal.reason).toBe(reason);
  expect(nativeSignal.aborted).toBe(true);
  expect(await failure).toBe(nativeSignal.reason);
  const aborted = await waitForGate(fixture, "incremental-streamed-details", "aborted");
  expect(aborted.aborted).toBe(1);
  expect(progress.status()).toBe("interrupted");
  expect(progress.value()?.dataState).toBe("streaming");
  expect(progress.pending()).toBe(false);
});

test("native GraphQL execution preserves full, partial, null, error, and extension results", async () => {
  const fixture = await startFixture();
  const native = makeClient(fixture.graphqlUrl, { headers: { "x-fixture-identity": "author-17" } });
  const operations = {
    full: native.query({
      name: "graphql-envelope.full",
      document: fullDocument,
      key: ({ value }) => value,
    }),
    partial: native.query({
      name: "graphql-envelope.partial",
      document: partialDocument,
      key: () => "partial",
    }),
    rootFailure: native.query({
      name: "graphql-envelope.root-failure",
      document: rootFailureDocument,
      key: () => "root-failure",
    }),
  };
  const contract = defineContract({ namespace: "graphql-envelope", operations });
  const graph = ownGraph(contract);
  const owner = makeOwner();
  const api = bindOwner(owner, graph, contract);
  const full = await api.full({ value: "Ada" }).ready;

  expect(full.data).toMatchObject({
    echo: "Ada",
    contextEcho: { value: "Ada", identity: "author-17" },
  });

  expect(full.errors).toBeUndefined();

  expect(full.extensions).toStrictEqual({ fixture: { instanceId: fixture.instanceId } });

  const partial = await api.partial({}).ready;

  expect(partial.data).toMatchObject({ partial: { ok: "partial-ok", broken: null } });

  expect(partial.errors?.map(({ message, path }) => ({ message, path }))).toStrictEqual([
    { message: "fixture partial field failure", path: ["partial", "broken"] },
  ]);

  expect(partial.extensions).toStrictEqual({ fixture: { instanceId: fixture.instanceId } });

  const rootFailure = await api.rootFailure({}).ready;

  expect(rootFailure.data).toBeNull();

  expect(rootFailure.errors?.map(({ message, path }) => ({ message, path }))).toStrictEqual([
    { message: "fixture root failure", path: ["rootFailure"] },
  ]);

  expect(rootFailure.extensions).toStrictEqual({ fixture: { instanceId: fixture.instanceId } });
});

test("explicit native error policies preserve only the result fields each policy permits", async () => {
  const fixture = await startFixture();
  const native = makeClient(fixture.graphqlUrl);
  const contract = defineContract({
    namespace: "graphql-error-policy",
    operations: {
      all: native.query({
        name: "graphql-policy.all",
        document: partialDocument,
        key: () => "all",
        errorPolicy: "all",
      }),
      none: native.query({
        name: "graphql-policy.none",
        document: partialDocument,
        key: () => "none",
        errorPolicy: "none",
      }),
      ignore: native.query({
        name: "graphql-policy.ignore",
        document: partialDocument,
        key: () => "ignore",
        errorPolicy: "ignore",
      }),
      mutationAll: native.mutation({
        name: "graphql-policy.mutation-all",
        document: writeDocument,
        affects: [],
        errorPolicy: "all",
      }),
      mutationIgnore: native.mutation({
        name: "graphql-policy.mutation-ignore",
        document: writeDocument,
        affects: [],
        errorPolicy: "ignore",
      }),
    },
  });
  const graph = ownGraph(contract);
  const owner = makeOwner();
  const api = bindOwner(owner, graph, contract);

  const all = await api.all({}).ready;

  expect(all.data).toMatchObject({ partial: { ok: "partial-ok", broken: null } });

  expect(all.errors?.[0]?.message).toBe("fixture partial field failure");

  const noneFailure = await captureFailure(api.none({}).ready);

  expect(noneFailure).toBeInstanceOf(Error);

  const noneResult = (noneFailure as GraphQLResultError<PartialData>).result;

  expect(noneResult?.data).toMatchObject({ partial: { ok: "partial-ok", broken: null } });

  expect(noneResult?.errors?.[0]?.message).toBe("fixture partial field failure");

  const ignored = await api.ignore({}).ready;

  expect(ignored.data).toMatchObject({ partial: { ok: "partial-ok", broken: null } });

  expect("errors" in ignored).toBe(false);

  expect(ignored.extensions).toStrictEqual({ fixture: { instanceId: fixture.instanceId } });

  const mutationAll = await api.mutationAll().run({ value: "mutation-all" });

  expect(mutationAll.data).toMatchObject({
    writeThenFail: { value: "mutation-all", failure: null },
  });

  expect(mutationAll.errors?.[0]?.message).toBe("fixture mutation field failure");

  const mutationIgnore = await api.mutationIgnore().run({ value: "mutation-ignore" });

  expect(mutationIgnore.data).toMatchObject({
    writeThenFail: { value: "mutation-ignore", failure: null },
  });

  expect("errors" in mutationIgnore).toBe(false);
});

test("native GraphQL WebSocket subscriptions preserve ordered execution envelopes and completion", async () => {
  const fixture = await startFixture();
  const session = `graphql-ws-envelope-${randomUUID()}`;
  const socket = makeNativeWebSocketClient(fixture.graphqlWsUrl, session);
  const native = makeGraphQLClientWithLink(new GraphQLWsLink(socket));
  const contract = defineContract({
    namespace: "graphql-native-ws-envelope",
    operations: {
      none: native.subscription({
        name: "graphql-ws-envelope.none",
        document: nativeEventsDocument,
        key: ({ id }) => id,
        errorPolicy: "none",
      }),
      all: native.subscription({
        name: "graphql-ws-envelope.all",
        document: nativeEventsDocument,
        key: ({ id }) => id,
        errorPolicy: "all",
      }),
      ignore: native.subscription({
        name: "graphql-ws-envelope.ignore",
        document: nativeEventsDocument,
        key: ({ id }) => id,
        errorPolicy: "ignore",
      }),
    },
  });
  const graph = ownGraph(contract);
  const owner = makeOwner();
  const api = bindOwner(owner, graph, contract);
  const none = api.none({ id: "policy-none" });
  const all = api.all({ id: "policy-all" });
  const ignore = api.ignore({ id: "policy-ignore" });
  const secondAll = bindOwner(makeOwner(), graph, contract).all({ id: "policy-all" });
  const ids = ["policy-none", "policy-all", "policy-ignore"];
  const instanceId = (await readFixtureState(fixture)).instanceId;
  const secondAllPartial = observed(
    () => secondAll.value(),
    (result) => result?.errors?.length === 1,
  );
  const partialResults = [
    observed(
      () => none.value(),
      (result) => result?.errors?.length === 1,
    ),
    observed(
      () => all.value(),
      (result) => result?.errors?.length === 1,
    ),
    observed(
      () => ignore.value(),
      (result) => result?.data?.events.sequence === 1,
    ),
  ];

  await Promise.all(ids.map((id) => waitForSubscription(fixture, session, id, "started")));

  expect((await readSubscriptionSnapshot(fixture, session, "policy-all")).started).toBe(1);

  await Promise.all(
    ids.map((id) =>
      postSubscriptionControl(fixture, "subscription-event", session, id, {
        sequence: 1,
        value: "partial",
        broken: true,
      }),
    ),
  );

  const [nonePartialResult, allPartialResult, ignoredPartialResult] =
    await Promise.all(partialResults);
  const nonePartial = requireGraphQLResult(nonePartialResult, "none policy partial");
  const allPartial = requireGraphQLResult(allPartialResult, "all policy partial");
  const ignoredPartial = requireGraphQLResult(ignoredPartialResult, "ignore policy partial");
  const secondAllPartialResult = requireGraphQLResult(
    await secondAllPartial,
    "shared all policy partial",
  );

  expect("data" in nonePartial).toBe(false);

  expect(nonePartial.errors?.[0]?.message).toBe("fixture subscription field failure");

  expect(nonePartial.extensions).toStrictEqual({ fixture: { instanceId } });

  expect(allPartial.data?.events).toStrictEqual({
    __typename: "NativeEvent",
    sequence: 1,
    value: "partial",
    broken: null,
    fatal: "ok",
  });

  expect(allPartial.errors?.[0]?.message).toBe("fixture subscription field failure");

  expect(allPartial.extensions).toStrictEqual({ fixture: { instanceId } });

  expect(secondAllPartialResult).toStrictEqual(allPartial);

  expect(ignoredPartial.data?.events).toStrictEqual({
    __typename: "NativeEvent",
    sequence: 1,
    value: "partial",
    broken: null,
    fatal: "ok",
  });

  expect("errors" in ignoredPartial).toBe(false);

  expect(ignoredPartial.extensions).toStrictEqual({ fixture: { instanceId } });

  const successResults = [
    observed(
      () => none.value(),
      (result) => result?.data?.events.sequence === 2,
    ),
    observed(
      () => all.value(),
      (result) => result?.data?.events.sequence === 2,
    ),
    observed(
      () => ignore.value(),
      (result) => result?.data?.events.sequence === 2,
    ),
  ];

  await Promise.all(
    ids.map((id) =>
      postSubscriptionControl(fixture, "subscription-event", session, id, {
        sequence: 2,
        value: "after-error",
      }),
    ),
  );

  const [noneSuccessResult, allSuccessResult, ignoredSuccessResult] =
    await Promise.all(successResults);
  const successEnvelopes = [
    requireGraphQLResult(noneSuccessResult, "none policy next"),
    requireGraphQLResult(allSuccessResult, "all policy next"),
    requireGraphQLResult(ignoredSuccessResult, "ignore policy next"),
  ];

  for (const result of successEnvelopes) {
    expect(result.data?.events).toStrictEqual({
      __typename: "NativeEvent",
      sequence: 2,
      value: "after-error",
      broken: null,
      fatal: "ok",
    });

    expect(result.errors).toBeUndefined();

    expect(result.extensions).toStrictEqual({ fixture: { instanceId } });
  }

  const nullResultPromise = observed(
    () => all.value(),
    (result) => result?.data === null,
  );

  await postSubscriptionControl(fixture, "subscription-event", session, "policy-all", {
    sequence: 3,
    value: "null-data",
    fatal: true,
  });

  const nullResult = requireGraphQLResult(await nullResultPromise, "null-data execution");

  expect(nullResult.data).toBeNull();

  expect(nullResult.errors?.[0]?.message).toBe("fixture subscription root failure");

  expect(nullResult.extensions).toStrictEqual({ fixture: { instanceId } });

  await Promise.all(
    ids.map((id) => postSubscriptionControl(fixture, "subscription-finish", session, id)),
  );

  const completionSnapshots = await Promise.all(
    ids.map((id) => waitForSubscription(fixture, session, id, "protocolComplete")),
  );
  const finalSnapshots = await Promise.all(
    ids.map((id) => waitForSubscription(fixture, session, id, "finally")),
  );
  const closedStatuses = await Promise.all([
    observed(
      () => none.status(),
      (status) => status === "closed",
    ),
    observed(
      () => all.status(),
      (status) => status === "closed",
    ),
    observed(
      () => ignore.status(),
      (status) => status === "closed",
    ),
  ]);

  expect(completionSnapshots.map(({ protocolComplete }) => protocolComplete)).toStrictEqual([
    1, 1, 1,
  ]);

  expect(completionSnapshots.map(({ started }) => started)).toStrictEqual([1, 1, 1]);

  expect(finalSnapshots.map(({ finally: finallyCount }) => finallyCount)).toStrictEqual([1, 1, 1]);

  expect(
    finalSnapshots.map(({ clientComplete, socketClose }) => [clientComplete, socketClose]),
  ).toStrictEqual([
    [0, 0],
    [0, 0],
    [0, 0],
  ]);

  expect(closedStatuses).toStrictEqual(["closed", "closed", "closed"]);
});

test("native request validation and generator errors terminate without protocol completion", async () => {
  const fixture = await startFixture();
  const session = `graphql-ws-errors-${randomUUID()}`;
  const socket = makeNativeWebSocketClient(fixture.graphqlWsUrl, session);
  const native = makeGraphQLClientWithLink(new GraphQLWsLink(socket));
  const invalidDocument = parse(`
    subscription InvalidNativeEvents($id: ID!) {
      events(id: $id) {
        absentField
      }
    }
  `) as TypedDocumentNode<NativeEventsData, NativeEventsVariables>;
  const contract = defineContract({
    namespace: "graphql-native-ws-errors",
    operations: {
      invalid: native.subscription({
        name: "graphql-ws-errors.invalid",
        document: invalidDocument,
        key: ({ id }) => id,
        errorPolicy: "all",
      }),
      thrown: native.subscription({
        name: "graphql-ws-errors.thrown",
        document: nativeEventsDocument,
        key: ({ id }) => id,
        errorPolicy: "ignore",
      }),
    },
  });
  const graph = ownGraph(contract);
  const owner = makeOwner();
  const api = bindOwner(owner, graph, contract);
  const invalid = api.invalid({ id: "invalid-request" });
  const invalidStatus = observed(
    () => invalid.status(),
    (status) => status === "failed",
  );

  expect(await invalidStatus).toBe("failed");

  const invalidMessages = graphQLErrorMessages(invalid.error());

  expect(
    invalidMessages.some((message) => message.includes('Cannot query field "absentField"')),
  ).toBe(true);

  expect(await readSubscriptionSnapshot(fixture, session, "invalid-request")).toMatchObject({
    started: 0,
    finally: 0,
    protocolComplete: 0,
    socketClose: 0,
  });

  const thrown = api.thrown({ id: "generator-throw" });
  const thrownStatus = observed(
    () => thrown.status(),
    (status) => status === "failed",
  );

  await waitForSubscription(fixture, session, "generator-throw", "started");

  await postSubscriptionControl(fixture, "subscription-throw", session, "generator-throw");

  expect(await thrownStatus).toBe("failed");

  expect(graphQLErrorMessages(thrown.error())).toContain(
    "fixture subscription failure: generator-throw",
  );

  const thrownFinal = await waitForSubscription(fixture, session, "generator-throw", "finally");

  expect(thrownFinal).toMatchObject({ protocolComplete: 0, active: false, socketClose: 0 });
});

test("subscription return, abort, client stop, and external socket disposal retain their owners", async () => {
  const fixture = await startFixture();
  const session = `graphql-ws-lifecycle-${randomUUID()}`;
  const socket = makeNativeWebSocketClient(fixture.graphqlWsUrl, session);
  const link = new GraphQLWsLink(socket);
  const firstClient = makeGraphQLClientWithLink(link);
  const manualReturn = firstClient.subscription({
    name: "graphql-ws-lifecycle.manual-return",
    document: nativeEventsDocument,
    key: ({ id }) => id,
  });
  const manualOptions: OpenOptions = {
    abortSignal: new AbortController().signal,
    graph: "graphql-ws-manual-return" as OpenOptions["graph"],
    key: storeKey("graphql-ws-manual-return"),
    reportGap: () => undefined,
  };
  const manualIterator = manualReturn
    .open({ id: "iterator-return" }, manualOptions)
    [Symbol.asyncIterator]();

  await waitForSubscription(fixture, session, "iterator-return", "started");

  expect(await manualIterator.return?.()).toStrictEqual({ done: true, value: undefined });

  const manualComplete = await waitForSubscription(
    fixture,
    session,
    "iterator-return",
    "clientComplete",
  );

  expect(manualComplete).toMatchObject({ clientComplete: 1, protocolComplete: 0, socketClose: 0 });

  await postSubscriptionControl(fixture, "subscription-cancel", session, "iterator-return");

  const manualFinally = await waitForSubscription(fixture, session, "iterator-return", "finally");

  expect(manualFinally).toMatchObject({
    finally: 1,
    emitted: 0,
    clientComplete: 1,
    protocolComplete: 0,
    socketClose: 0,
    active: false,
  });

  const abortedDefinition = firstClient.subscription({
    name: "graphql-ws-lifecycle.abort",
    document: nativeEventsDocument,
    key: ({ id }) => id,
  });
  const abortController = new AbortController();
  const abortOptions: OpenOptions = {
    abortSignal: abortController.signal,
    graph: "graphql-ws-abort" as OpenOptions["graph"],
    key: storeKey("graphql-ws-abort"),
    reportGap: () => undefined,
  };
  const abortedIterator = abortedDefinition
    .open({ id: "signal-abort" }, abortOptions)
    [Symbol.asyncIterator]();
  const abortRead = abortedIterator.next();

  await waitForSubscription(fixture, session, "signal-abort", "started");

  const abortReason = new Error("fixture subscription was aborted by its caller");

  abortController.abort(abortReason);

  expect(await captureFailure(abortRead)).toBe(abortReason);

  const abortedComplete = await waitForSubscription(
    fixture,
    session,
    "signal-abort",
    "clientComplete",
  );

  expect(abortedComplete.clientComplete).toBe(1);

  await postSubscriptionControl(fixture, "subscription-cancel", session, "signal-abort");

  expect(await waitForSubscription(fixture, session, "signal-abort", "finally")).toMatchObject({
    finally: 1,
    emitted: 0,
    clientComplete: 1,
    protocolComplete: 0,
    socketClose: 0,
    active: false,
  });

  const stopClient = makeGraphQLClientWithLink(link);
  const stopDefinition = stopClient.subscription({
    name: "graphql-ws-lifecycle.client-stop",
    document: nativeEventsDocument,
    key: ({ id }) => id,
  });
  const stopContract = defineContract({
    namespace: "graphql-native-ws-client-stop",
    operations: { events: stopDefinition },
  });
  const stopGraph = ownGraph(stopContract);
  const stopOwner = makeOwner();
  const stoppingFeed = bindOwner(stopOwner, stopGraph, stopContract).events({
    id: "client-stop",
  });

  await waitForSubscription(fixture, session, "client-stop", "started");

  const failedAfterStop = observed(
    () => stoppingFeed.status(),
    (status) => status === "failed",
  );

  stopClient.stop();

  expect(await failedAfterStop).toBe("failed");

  await waitForSubscription(fixture, session, "client-stop", "clientComplete");

  await postSubscriptionControl(fixture, "subscription-cancel", session, "client-stop");

  const stoppedFinally = await waitForSubscription(fixture, session, "client-stop", "finally");

  expect(stoppedFinally).toMatchObject({
    finally: 1,
    emitted: 0,
    clientComplete: 1,
    protocolComplete: 0,
    socketClose: 0,
    active: false,
  });

  const laterClient = makeGraphQLClientWithLink(link);
  const laterDefinition = laterClient.subscription({
    name: "graphql-ws-lifecycle.later-operation",
    document: nativeEventsDocument,
    key: ({ id }) => id,
  });
  const laterContract = defineContract({
    namespace: "graphql-native-ws-later-operation",
    operations: { events: laterDefinition },
  });
  const laterGraph = ownGraph(laterContract);
  const laterOwner = makeOwner();
  const laterFeed = bindOwner(laterOwner, laterGraph, laterContract).events({
    id: "later-operation",
  });
  const laterValue = observed(
    () => laterFeed.value(),
    (result) => result?.data?.events.sequence === 1,
  );

  await waitForSubscription(fixture, session, "later-operation", "started");

  await postSubscriptionControl(fixture, "subscription-event", session, "later-operation", {
    sequence: 1,
    value: "same-socket",
  });

  const laterEnvelope = requireGraphQLResult(await laterValue, "later same-socket subscription");

  expect(laterEnvelope.data?.events.value).toBe("same-socket");

  const socketClose = disposeNativeWebSocketClient(socket);
  const closedSnapshot = await waitForSubscription(
    fixture,
    session,
    "later-operation",
    "socketClose",
  );

  expect(closedSnapshot.socketClose).toBe(1);

  const closedAfterSocketClose = observed(
    () => laterFeed.status(),
    (status) => status === "closed",
  );

  await postSubscriptionControl(fixture, "subscription-cancel", session, "later-operation");

  await socketClose;

  expect(await waitForSubscription(fixture, session, "later-operation", "finally")).toMatchObject({
    finally: 1,
    emitted: 1,
    clientComplete: 0,
    protocolComplete: 0,
    socketClose: 1,
    active: false,
  });

  expect(await closedAfterSocketClose).toBe("closed");
});

test("synchronous configured Apollo links preserve policy envelopes and release on completion", async () => {
  for (const policy of ["none", "all", "ignore"] as const) {
    const callbackOrder: string[] = [];
    const executionError = new GraphQLError(`fixture errors-only ${policy}`);
    let teardownCount = 0;
    const link = new ApolloLink(
      () =>
        new Observable<ApolloLink.Result>((observer) => {
          callbackOrder.push("subscribe");
          observer.next({
            errors: [executionError],
            extensions: { fixture: "errors-only" },
          } as unknown as ApolloLink.Result);
          callbackOrder.push("next:errors-only");
          observer.next({
            data: {
              events: { sequence: 1, value: "after-errors", broken: null, fatal: "ok" },
            },
            extensions: { fixture: "valid" },
          });
          callbackOrder.push("next:valid");
          callbackOrder.push("complete");
          observer.complete();

          return () => {
            teardownCount += 1;
            callbackOrder.push("teardown");
          };
        }),
    );
    const client = makeGraphQLClientWithLink(link);
    const definition = client.subscription({
      name: `graphql-sync-link.errors-only.${policy}`,
      document: nativeEventsDocument,
      key: ({ id }) => id,
      errorPolicy: policy,
    });
    const iterator = definition
      .open(
        { id: `errors-only-${policy}` },
        {
          abortSignal: new AbortController().signal,
          graph: `graphql-sync-link-${policy}` as OpenOptions["graph"],
          key: storeKey(`graphql-sync-link-${policy}`),
          reportGap: () => undefined,
        },
      )
      [Symbol.asyncIterator]();
    const values: Array<GraphQLResult<NativeEventsData>> = [];

    while (true) {
      const item = await iterator.next();

      if (item.done) break;

      values.push(item.value);
    }

    if (policy === "ignore") {
      expect(values).toStrictEqual([
        {
          data: {
            events: { sequence: 1, value: "after-errors", broken: null, fatal: "ok" },
          },
          extensions: { fixture: "valid" },
        },
      ]);
    } else {
      expect(values).toHaveLength(2);
      expect("data" in (values[0] ?? {})).toBe(false);
      expect(values[0]?.errors?.map(({ message }) => message)).toStrictEqual([
        `fixture errors-only ${policy}`,
      ]);
      expect(values[0]?.extensions).toStrictEqual({ fixture: "errors-only" });
      expect(values[1]?.data?.events).toStrictEqual({
        sequence: 1,
        value: "after-errors",
        broken: null,
        fatal: "ok",
      });
      expect(values[1]?.errors).toBeUndefined();
    }

    expect(teardownCount).toBe(1);
    expect(callbackOrder).toStrictEqual([
      "subscribe",
      "next:errors-only",
      "next:valid",
      "complete",
      "teardown",
    ]);
  }

  const bufferedError = new Error("fixture synchronous error after buffered events");
  let bufferedErrorTeardownCount = 0;
  const bufferedErrorLink = new ApolloLink(
    () =>
      new Observable<ApolloLink.Result>((observer) => {
        observer.next({
          data: {
            events: { sequence: 11, value: "buffered-first", broken: null, fatal: "ok" },
          },
          extensions: { fixture: "buffered-first" },
        });
        observer.next({
          data: {
            events: { sequence: 12, value: "buffered-second", broken: null, fatal: "ok" },
          },
          extensions: { fixture: "buffered-second" },
        });
        observer.error(bufferedError);

        return () => {
          bufferedErrorTeardownCount += 1;
        };
      }),
  );
  const bufferedErrorClient = makeGraphQLClientWithLink(bufferedErrorLink);
  const bufferedErrorDefinition = bufferedErrorClient.subscription({
    name: "graphql-sync-link.buffered-error",
    document: nativeEventsDocument,
    key: ({ id }) => id,
    errorPolicy: "ignore",
  });
  const bufferedErrorIterator = bufferedErrorDefinition
    .open(
      { id: "buffered-error-ignore" },
      {
        abortSignal: new AbortController().signal,
        graph: "graphql-sync-link-buffered-error" as OpenOptions["graph"],
        key: storeKey("graphql-sync-link-buffered-error"),
        reportGap: () => undefined,
      },
    )
    [Symbol.asyncIterator]();

  expect(bufferedErrorTeardownCount).toBe(1);

  expect(await bufferedErrorIterator.next()).toStrictEqual({
    done: false,
    value: {
      data: {
        events: { sequence: 11, value: "buffered-first", broken: null, fatal: "ok" },
      },
      extensions: { fixture: "buffered-first" },
    },
  });

  expect(await bufferedErrorIterator.next()).toStrictEqual({
    done: false,
    value: {
      data: {
        events: { sequence: 12, value: "buffered-second", broken: null, fatal: "ok" },
      },
      extensions: { fixture: "buffered-second" },
    },
  });

  expect(await captureFailure(bufferedErrorIterator.next())).toBe(bufferedError);

  expect(bufferedErrorTeardownCount).toBe(1);

  const controller = new AbortController();
  const callbackOrder: string[] = [];
  let teardownCount = 0;
  let forwardedSignal: AbortSignal | undefined;
  const link = new ApolloLink(
    (operation) =>
      new Observable<ApolloLink.Result>((observer) => {
        callbackOrder.push("subscribe");
        forwardedSignal = operation.getContext().fetchOptions?.signal as AbortSignal | undefined;

        callbackOrder.push("next:null");
        observer.next({
          data: null,
          errors: [new GraphQLError("fixture raw null result")],
          extensions: {},
        } as unknown as ApolloLink.Result);
        callbackOrder.push("next:event");
        observer.next({
          data: {
            events: { sequence: 2, value: "following", broken: null, fatal: "ok" },
          },
          extensions: {},
        } as unknown as ApolloLink.Result);
        callbackOrder.push("complete");
        observer.complete();

        return () => {
          teardownCount += 1;
          callbackOrder.push("teardown");
        };
      }),
  );
  const native = makeGraphQLClientWithLink(link);
  const definition = native.subscription({
    name: "graphql-sync-link.events",
    document: nativeEventsDocument,
    key: ({ id }) => id,
    errorPolicy: "ignore",
  });
  const actualOpenOptions: OpenOptions = {
    abortSignal: controller.signal,
    graph: "graphql-sync-link" as OpenOptions["graph"],
    key: storeKey("graphql-sync-link"),
    reportGap: () => undefined,
  };
  const iterator = definition
    .open({ id: "synchronous-link" }, actualOpenOptions)
    [Symbol.asyncIterator]();
  const first = await iterator.next();
  const second = await iterator.next();
  const complete = await iterator.next();

  expect(forwardedSignal).toBe(controller.signal);

  expect(first).toMatchObject({ done: false, value: { data: null, extensions: {} } });

  if (first.done) throw new Error("Expected the first synchronous native result");

  expect("data" in first.value).toBe(true);

  expect("extensions" in first.value).toBe(true);

  expect(first.value.extensions).toStrictEqual({});

  expect("errors" in first.value).toBe(false);

  expect(second).toStrictEqual({
    done: false,
    value: {
      data: { events: { sequence: 2, value: "following", broken: null, fatal: "ok" } },
      extensions: {},
    },
  });

  expect(complete).toStrictEqual({ done: true, value: undefined });

  expect(teardownCount).toBe(1);

  expect(callbackOrder).toStrictEqual([
    "subscribe",
    "next:null",
    "next:event",
    "complete",
    "teardown",
  ]);

  const abortController = new AbortController();
  const abortReason = new Error("fixture synchronous subscription abort");
  const abortOrder: string[] = [];
  let abortSignal: AbortSignal | undefined;
  let lateNextAttempted = false;
  let abortTeardownCount = 0;
  const abortLink = new ApolloLink(
    (operation) =>
      new Observable<ApolloLink.Result>((observer) => {
        abortOrder.push("subscribe");
        abortSignal = operation.getContext().fetchOptions?.signal as AbortSignal | undefined;
        observer.next({
          data: {
            events: { sequence: 3, value: "buffered", broken: null, fatal: "ok" },
          },
          extensions: {},
        });
        abortOrder.push("abort");
        abortController.abort(abortReason);
        lateNextAttempted = true;
        abortOrder.push("late-next");
        observer.next({
          data: {
            events: { sequence: 4, value: "late", broken: null, fatal: "ok" },
          },
          extensions: {},
        });

        return () => {
          abortTeardownCount += 1;
          abortOrder.push("teardown");
        };
      }),
  );
  const abortClient = makeGraphQLClientWithLink(abortLink);
  const abortDefinition = abortClient.subscription({
    name: "graphql-sync-link.abort",
    document: nativeEventsDocument,
    key: ({ id }) => id,
  });
  const abortOptions: OpenOptions = {
    abortSignal: abortController.signal,
    graph: "graphql-sync-link-abort" as OpenOptions["graph"],
    key: storeKey("graphql-sync-link-abort"),
    reportGap: () => undefined,
  };
  const abortIterator = abortDefinition
    .open({ id: "synchronous-abort" }, abortOptions)
    [Symbol.asyncIterator]();

  expect(abortSignal).toBe(abortController.signal);

  expect(await captureFailure(abortIterator.next())).toBe(abortReason);

  expect(await captureFailure(abortIterator.next())).toBe(abortReason);

  expect(lateNextAttempted).toBe(true);

  expect(abortTeardownCount).toBe(1);

  expect(abortOrder).toStrictEqual(["subscribe", "abort", "late-next", "teardown"]);

  expect(() => abortClient.stop()).not.toThrow();
});

test("request, malformed-response, and transport failures stay rejected without execution data", async () => {
  const fixture = await startFixture();
  const requestClient = makeClient(fixture.graphqlUrl, {
    headers: { accept: "application/graphql-response+json" },
  });
  const decodeClient = makeClient(`${fixture.controlUrl}/decode-error`);
  const transportClient = makeClient(`${fixture.controlUrl}/transport-error`);
  const requestDocument = parse(`query InvalidField { absentField }`) as TypedDocumentNode<
    EmptyVariables,
    EmptyVariables
  >;
  const contract = defineContract({
    namespace: "graphql-request-failure",
    operations: {
      request: requestClient.query({
        name: "graphql-request.invalid-field",
        document: requestDocument,
        key: () => "invalid-field",
      }),
      decode: decodeClient.query({
        name: "graphql-request.decode",
        document: fullDocument,
        key: ({ value }) => value,
      }),
      transport: transportClient.query({
        name: "graphql-request.transport",
        document: fullDocument,
        key: ({ value }) => value,
      }),
    },
  });
  const graph = ownGraph(contract);
  const owner = makeOwner();
  const api = bindOwner(owner, graph, contract);
  const requestFailure = await captureFailure(api.request({}).ready);

  expect(requestFailure).toBeInstanceOf(Error);

  const requestResult = (requestFailure as GraphQLResultError<EmptyVariables>).result;

  expect(requestResult?.data).toBeUndefined();

  expect(requestResult?.errors?.[0]?.message).toContain('Cannot query field "absentField"');

  const decodeFailure = await captureFailure(api.decode({ value: "decode" }).ready);

  expect(decodeFailure).toBeInstanceOf(Error);

  expect(decodeFailure).not.toHaveProperty("result");

  const transportFailure = await captureFailure(api.transport({ value: "transport" }).ready);

  expect(transportFailure).toBeInstanceOf(Error);

  expect(transportFailure).not.toHaveProperty("result");
});

test("native request sharing stays graph-scoped while fixed auth contexts stay isolated", async () => {
  const fixture = await startFixture();
  const reset = await fetch(`${fixture.controlUrl}/reset`, { method: "POST" });

  expect(reset.status).toBe(200);

  const link = new HttpLink({ uri: fixture.graphqlUrl });
  const authorClient = createGraphQLClient({
    link,
    context: { headers: { "x-fixture-identity": "author" } },
  });
  const reviewerClient = createGraphQLClient({
    link,
    context: { headers: { "x-fixture-identity": "reviewer" } },
  });
  clients.push(authorClient, reviewerClient);

  const authorDefinition = authorClient.query({
    name: "graphql-context.author",
    document: fullDocument,
    key: ({ value }) => value,
  });
  const reviewerDefinition = reviewerClient.query({
    name: "graphql-context.reviewer",
    document: fullDocument,
    key: ({ value }) => value,
  });
  const authorContract = defineContract({
    namespace: "graphql-author",
    operations: { identity: authorDefinition },
  });
  const reviewerContract = defineContract({
    namespace: "graphql-reviewer",
    operations: { identity: reviewerDefinition },
  });
  const authorGraph = ownGraph(authorContract);
  const reviewerGraph = ownGraph(reviewerContract);
  const authorOwner = makeOwner();
  const reviewerOwner = makeOwner();
  const author = bindOwner(authorOwner, authorGraph, authorContract);
  const reviewer = bindOwner(reviewerOwner, reviewerGraph, reviewerContract);
  const variables = { value: "same query variables" };
  const [authorResult, reviewerResult] = await Promise.all([
    author.identity(variables).ready,
    reviewer.identity(variables).ready,
  ]);

  expect(authorResult.data).toMatchObject({
    contextEcho: { value: variables.value, identity: "author" },
  });

  expect(reviewerResult.data).toMatchObject({
    contextEcho: { value: variables.value, identity: "reviewer" },
  });

  expect((await readFixtureState(fixture)).resolverCalls.contextEcho).toBe(2);

  const sharedClient = makeClient(fixture.graphqlUrl, {
    headers: { "x-fixture-identity": "shared" },
  });
  const sharedDefinition = sharedClient.query({
    name: "graphql-context.shared",
    document: fullDocument,
    key: ({ value }) => value,
  });
  const sharedContract = defineContract({
    namespace: "graphql-shared",
    operations: { identity: sharedDefinition },
  });
  const sharedGraph = ownGraph(sharedContract);
  const separateGraph = ownGraph(sharedContract);
  const firstOwner = makeOwner();
  const secondOwner = makeOwner();
  const separateGraphOwner = makeOwner();
  const first = bindOwner(firstOwner, sharedGraph, sharedContract).identity(variables);
  const second = bindOwner(secondOwner, sharedGraph, sharedContract).identity(variables);
  const third = bindOwner(separateGraphOwner, separateGraph, sharedContract).identity(variables);
  const [firstResult, secondResult, thirdResult] = await Promise.all([
    first.ready,
    second.ready,
    third.ready,
  ]);

  for (const result of [firstResult, secondResult, thirdResult]) {
    expect(result.data).toMatchObject({
      contextEcho: { value: variables.value, identity: "shared" },
    });

    expect(result.errors).toBeUndefined();

    expect(result.extensions).toStrictEqual({ fixture: { instanceId: fixture.instanceId } });
  }

  expect((await readFixtureState(fixture)).resolverCalls.contextEcho).toBe(4);
});

test("mutation failure retires its prediction without pretending the server write rolled back", async () => {
  const fixture = await startFixture();
  const native = makeClient(fixture.graphqlUrl);
  const state = native.query({
    name: "graphql-mutation.state",
    document: serverStateDocument,
    key: () => "state",
  });
  const write = native.mutation({
    name: "graphql-mutation.write-then-fail",
    document: writeDocument,
    affects: [
      affects(state, {
        select: () => ({}),
        on: "revalidate",
        optimistic: () => ({ data: { state: { revision: 1, writes: ["predicted"] } } }),
      }),
    ],
  });
  const contract = defineContract({ namespace: "graphql-mutation", operations: { state, write } });
  const graph = ownGraph(contract);
  const owner = makeOwner();
  const api = bindOwner(owner, graph, contract);
  const stateView = api.state({});
  const initial = await stateView.ready;

  expect(initial.data).toMatchObject({ state: { revision: 0, writes: [] } });

  let stopPrediction: (() => void) | undefined;
  let predictionStopped = false;
  const disposePrediction = () => {
    if (predictionStopped) return;

    predictionStopped = true;
    stopPrediction?.();
  };
  const predictionObserved = new Promise<GraphQLResult<ServerStateData>>((resolvePrediction) => {
    stopPrediction = subscribe(stateView.source.value, (value) => {
      if (!value?.data?.state.writes.includes("predicted")) return;

      resolvePrediction(value);
    });
  });
  subscriptions.push(disposePrediction);

  const task = api.write();
  const run = task.run({ value: "persisted-on-server" });

  expect(task.pending()).toBe(true);

  await predictionObserved;

  expect(stateView.value()).toMatchObject({
    data: { state: { revision: 1, writes: ["predicted"] } },
  });

  const mutationFailure = await captureFailure(Promise.resolve(run));

  expect(mutationFailure).toBeInstanceOf(Error);

  const failure = mutationFailure as GraphQLResultError<WriteData>;

  expect(failure.result).toMatchObject({
    data: { writeThenFail: { value: "persisted-on-server", failure: null } },
    errors: [{ message: "fixture mutation field failure", path: ["writeThenFail", "failure"] }],
    extensions: { fixture: { instanceId: fixture.instanceId } },
  });

  expect(failure.cause).toBeDefined();

  expect(task.status()).toBe("failure");

  expect(task.error()).toBe(failure);

  expect(stateView.value()).toStrictEqual(initial);

  expect(stateView.pending()).toBe(false);

  expect(stateView.status()).toBe("ready");

  const serverState = await readFixtureState(fixture);

  expect(serverState.writes).toStrictEqual(["persisted-on-server"]);

  expect(serverState.revision).toBe(1);

  expect(serverState.resolverCalls.state).toBe(1);
});

test("successful native mutation publishes its typed result and runs its declared query effect", async () => {
  const fixture = await startFixture();
  const native = makeClient(fixture.graphqlUrl);
  const state = native.query({
    name: "graphql-mutation-success.state",
    document: serverStateDocument,
    key: () => "state",
  });
  const write = native.mutation({
    name: "graphql-mutation-success.write",
    document: cleanWriteDocument,
    affects: [affects(state, { select: () => ({}), on: "revalidate" })],
  });
  const contract = defineContract({
    namespace: "graphql-mutation-success",
    operations: { state, write },
  });
  const graph = ownGraph(contract);
  const owner = makeOwner();
  const api = bindOwner(owner, graph, contract);
  const stateView = api.state({});

  await stateView.ready;

  let stopRefresh: (() => void) | undefined;
  let refreshStopped = false;
  const disposeRefresh = () => {
    if (refreshStopped) return;

    refreshStopped = true;
    stopRefresh?.();
  };
  const refreshed = new Promise<GraphQLResult<ServerStateData>>((resolveRefresh) => {
    stopRefresh = subscribe(stateView.source.value, (value) => {
      if (!value?.data?.state.writes.includes("native-success")) return;

      disposeRefresh();
      resolveRefresh(value);
    });
  });
  subscriptions.push(disposeRefresh);

  const task = api.write();
  const result = await task.run({ value: "native-success" });

  expect(result.data).toMatchObject({ writeThenFail: { value: "native-success" } });

  expect(result.errors).toBeUndefined();

  expect(result.extensions).toStrictEqual({ fixture: { instanceId: fixture.instanceId } });

  const refreshedState = await refreshed;

  expect(refreshedState.data).toMatchObject({
    state: { revision: 1, writes: ["native-success"] },
  });

  expect((await readFixtureState(fixture)).resolverCalls.state).toBe(2);

  expect(task.status()).toBe("success");

  expect(task.value()).toStrictEqual(result);
});

test("caller abort cancels a held native mutation and a late resolver cannot publish success", async () => {
  const fixture = await startFixture();
  const native = makeClient(fixture.graphqlUrl);
  const waitAtGate = native.mutation({
    name: "graphql-cancellation.wait-at-gate",
    document: gateDocument,
    affects: [],
  });
  const contract = defineContract({
    namespace: "graphql-cancellation",
    operations: { waitAtGate },
  });
  const graph = ownGraph(contract);
  const owner = makeOwner();
  const api = bindOwner(owner, graph, contract);
  const task = api.waitAtGate();
  const caller = new AbortController();
  const run = task.run({ id: "caller-abort" }, { abortSignal: caller.signal });
  const outcome = Promise.resolve(run).then(
    () => ({ status: "resolved" as const }),
    (error: unknown) => ({ status: "rejected" as const, error }),
  );

  expect((await waitForGate(fixture, "caller-abort", "started")).started).toBe(1);

  caller.abort(new DOMException("caller stopped", "AbortError"));

  expect((await waitForGate(fixture, "caller-abort", "aborted")).aborted).toBe(1);

  const release = await fetch(`${fixture.controlUrl}/release?gate=caller-abort`, {
    method: "POST",
  });

  expect(release.status).toBe(200);

  expect((await waitForGate(fixture, "caller-abort", "lateCompletion")).lateCompletions).toBe(1);

  const settled = await outcome;

  expect(settled.status).toBe("rejected");

  if (settled.status !== "rejected")
    throw new Error("Expected the caller-aborted GraphQL mutation to reject");

  expect(settled.error).toHaveProperty("name", "AbortError");

  expect(task.status()).toBe("cancelled");

  expect(task.pending()).toBe(false);

  expect(task.error()).toBeUndefined();

  expect(task.value()).toBeUndefined();
});
