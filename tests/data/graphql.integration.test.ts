import { afterEach, expect, test } from "bun:test";
import { affects, createGraph, defineContract, storeKey, subscribe } from "aeolia";
import type { Contract, Graph, OpenOptions } from "aeolia";
import { ApolloLink } from "@apollo/client/link";
import { HttpLink } from "@apollo/client/link/http";
import { GraphQLWsLink } from "@apollo/client/link/subscriptions";
import type { TypedDocumentNode } from "@apollo/client";
import { GraphQLError, parse } from "graphql";
import { createClient as createNativeWebSocketClient } from "graphql-ws";
import { Observable } from "rxjs";
import { randomUUID } from "node:crypto";
import { createGraphQLClient } from "../../packages/graphql/src/index.ts";
import type { GraphQLResult, GraphQLResultError } from "../../packages/graphql/src/index.ts";
import { withAeolia } from "../../packages/hesperia/src/aeolia/index.ts";
import type { ImportedApi } from "../../packages/hesperia/src/aeolia/index.ts";
import { bindImported } from "../../packages/hesperia/src/data/api.ts";
import { Owner, type RuntimeContext } from "../../packages/hesperia/src/runtime/owner.ts";
import { isAbsolute, resolve } from "node:path";

type EmptyVariables = Record<string, never>;

type ValueVariables = { readonly value: string };

type EchoData = { readonly echo: string };

type ContextEchoData = {
  readonly contextEcho: { readonly value: string; readonly identity: string | null };
};

type FullData = EchoData & ContextEchoData;

type PartialData = {
  readonly partial: { readonly ok: string; readonly broken: string | null };
};

type RootFailureData = { readonly rootFailure: string };

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

afterEach(async () => {
  for (const stop of subscriptions.splice(0)) stop();

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
