import { afterEach, expect, test } from "bun:test";
import { affects, createGraph, defineContract, subscribe } from "aeolia";
import type { Contract, Graph } from "aeolia";
import { HttpLink } from "@apollo/client/link/http";
import type { TypedDocumentNode } from "@apollo/client";
import { parse } from "graphql";
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

type FixtureReady = {
  readonly type: "ready";
  readonly host: string;
  readonly port: number;
  readonly instanceId: string;
  readonly graphqlUrl: string;
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
  readonly revision: number;
  readonly writes: readonly string[];
  readonly resolverCalls: {
    readonly echo: number;
    readonly contextEcho: number;
    readonly state: number;
  };
  readonly gates: readonly GateSnapshot[];
};

type NativeChild = ReturnType<typeof Bun.spawn>;

type ChildResource = { readonly child: NativeChild; controlUrl?: string };

const owners = new Set<Owner>();
const graphs = new Set<{ dispose(): void }>();
const clients: Array<{ stop(): void }> = [];
const children: ChildResource[] = [];
const subscriptions: Array<() => void> = [];

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
          () =>
            reject(
              new Error(
                "Timed out waiting for the Node 22.23.2 GraphQL Yoga fixture readiness line",
              ),
            ),
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

  const nodePath = nodeOverride ?? Bun.which("node");

  if (!nodePath) {
    throw new Error(
      "Node 22.23.2 was not found on PATH; install it or set HESPERIA_GRAPHQL_NODE to its absolute executable path",
    );
  }

  const fixturePath = resolve(import.meta.dir, "fixtures/graphql-server.fixture.mjs");
  const child = Bun.spawn([nodePath, fixturePath], {
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
): Promise<T> {
  const response = await fetch(`${fixture.controlUrl}/${path}`, {
    method,
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

async function captureFailure<T>(promise: Promise<T>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
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
