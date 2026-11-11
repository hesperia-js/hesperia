import { afterEach, expect, spyOn, test } from "bun:test";
import { create, type MessageInitShape, type MessageShape } from "@bufbuild/protobuf";
import {
  createContextValues,
  type StreamResponse,
  type Transport,
  type UnaryResponse,
} from "@connectrpc/connect";
import {
  affects,
  computed,
  createGraph,
  defineContract,
  storeKey,
  subscribe,
  type CallContext,
  type MutationDefinition,
  type Readable,
  type QueryDefinition,
  type StreamDefinition,
} from "aeolia";
import {
  grpcMutation,
  grpcQuery,
  grpcStream,
  type GrpcNativeCallOptions,
} from "../../packages/grpc/src/index.ts";
import { bindImported } from "../../packages/hesperia/src/data/api.ts";
import { withAeolia } from "../../packages/hesperia/src/aeolia/index.ts";
import { Owner, type RuntimeContext } from "../../packages/hesperia/src/runtime/owner.ts";
import { ServiceAll } from "./fixtures/grpc/service-all_pb.ts";

type UnaryCall = {
  readonly method: unknown;
  readonly signal: AbortSignal | undefined;
  readonly timeoutMs: number | undefined;
  readonly headers: HeadersInit | undefined;
  readonly input: unknown;
  readonly contextValues: unknown;
};

type StreamCall = Omit<UnaryCall, "input"> & {
  readonly input: AsyncIterable<unknown>;
};

type TransportHandlers = {
  readonly unary?: (call: UnaryCall) => Promise<unknown>;
  readonly stream?: (call: StreamCall) => Promise<unknown>;
};

const owners: Owner[] = [];

afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});

function makeTransport(handlers: TransportHandlers): Transport {
  const transport = {
    unary(...args: unknown[]) {
      if (handlers.unary === undefined) throw new Error("unexpected unary call");

      return handlers.unary(recordCall(args));
    },

    stream(...args: unknown[]) {
      if (handlers.stream === undefined) throw new Error("unexpected stream call");

      const call = recordCall(args);

      return handlers.stream({ ...call, input: call.input as AsyncIterable<unknown> });
    },
  };

  return transport as unknown as Transport;
}

function recordCall(args: unknown[]): UnaryCall {
  const [method, signal, timeoutMs, headers, input, contextValues] = args;

  return {
    method,
    signal: signal as AbortSignal | undefined,
    timeoutMs: timeoutMs as number | undefined,
    headers: headers as HeadersInit | undefined,
    input,
    contextValues,
  };
}

function unaryResponse(method: unknown, message: unknown): UnaryResponse {
  return {
    stream: false,
    service: ServiceAll,
    method,
    message,
    header: new Headers({ "x-response-phase": "header" }),
    trailer: new Headers({ "x-response-phase": "trailer" }),
  } as UnaryResponse;
}

function streamResponse(method: unknown, message: AsyncIterable<unknown>): StreamResponse {
  return {
    stream: true,
    service: ServiceAll,
    method,
    message,
    header: new Headers({ "x-response-phase": "header" }),
    trailer: new Headers({ "x-response-phase": "trailer" }),
  } as StreamResponse;
}

async function* yieldValues<T>(values: readonly T[]): AsyncGenerator<T> {
  for (const value of values) yield value;
}

async function* yieldThenFail<T>(value: T, reason: unknown): AsyncGenerator<T> {
  yield value;

  throw reason;
}

function waitFor<T>(source: Readable<T>, predicate: (value: T) => boolean): Promise<T> {
  return new Promise((resolve) => {
    let stop: (() => void) | undefined;

    const observer = (value: T): void => {
      if (!predicate(value)) return;

      if (stop === undefined) queueMicrotask(() => stop?.());
      else stop();

      resolve(value);
    };

    stop = subscribe(source, observer);
  });
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

function makeOwner(): Owner {
  const context = {
    document: {} as Document,
    container: {} as Element,
    onError: () => undefined,
    warn: () => undefined,
    nextGeneration: 0,
    scheduler: undefined,
  } as unknown as RuntimeContext;
  const owner = new Owner(context, null, "grpc-integration-test");

  owners.push(owner);

  return owner;
}

test("unary descriptors preserve message values, native options, explicit effects, and types", async () => {
  type UnaryInput = MessageInitShape<typeof ServiceAll.method.unary.input>;
  type UnaryOutput = MessageShape<typeof ServiceAll.method.unary.output>;

  const input = create(ServiceAll.method.unary.input, { value: "lookup" });
  const found = create(ServiceAll.method.unary.output, { value: 7 });
  const saved = create(ServiceAll.method.unary.output, { value: 8 });
  const refreshed = create(ServiceAll.method.unary.output, { value: 9 });
  const headers = new Headers({ authorization: "configured-by-caller" });
  const contextValues = createContextValues();
  const nativeResults = [found, saved, refreshed];
  const calls: UnaryCall[] = [];
  const transport = makeTransport({
    unary: async (call) => {
      calls.push(call);

      return unaryResponse(call.method, nativeResults.shift());
    },
  });
  const queryContexts: Array<{ readonly graph: unknown; readonly key: string }> = [];
  const mutationContexts: CallContext[] = [];
  const query: QueryDefinition<UnaryInput, UnaryOutput, string> = grpcQuery({
    transport,
    method: ServiceAll.method.unary,
    name: "grpc.fixture.lookup",
    key: ({ value }) => `lookup:${value ?? ""}`,
    nativeOptions: (_input, context) => {
      queryContexts.push({ graph: context.graph, key: context.key });

      return { timeoutMs: 4_000, headers, contextValues };
    },
  });
  const mutation: MutationDefinition<UnaryInput, UnaryOutput> = grpcMutation({
    transport,
    method: ServiceAll.method.unary,
    name: "grpc.fixture.save",
    affects: [
      affects(query, { select: (mutationInput: UnaryInput) => mutationInput, on: "revalidate" }),
    ],
    nativeOptions: (_input, context) => {
      mutationContexts.push(context);

      return { timeoutMs: 2_000 };
    },
  });
  const contract = defineContract({
    namespace: "grpc-fixture-explicit-kinds",
    operations: { lookup: query, save: mutation },
  });
  const graph = createGraph({ contract });

  try {
    expect(query.kind).toBe("query");

    expect(mutation.kind).toBe("mutation");

    const store = graph.api.lookup(input);

    await store.ready;

    expect(store.value.get()).toBe(found);

    expect(calls).toHaveLength(1);

    expect(calls[0]?.method).toBe(ServiceAll.method.unary);

    expect(calls[0]?.input).toBe(input);

    expect(calls[0]?.headers).toBe(headers);

    expect(calls[0]?.contextValues).toBe(contextValues);

    expect(calls[0]?.timeoutMs).toBe(4_000);

    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);

    expect(queryContexts[0]?.graph).toBe(graph.id);

    expect(queryContexts[0]?.key).toBe(store.key);

    const refreshedValue = waitFor(store.value, (value) => value === refreshed);

    await expect(graph.api.save(input)).resolves.toBe(saved);

    await refreshedValue;

    expect(calls).toHaveLength(3);

    expect(store.value.get()).toBe(refreshed);

    expect(mutationContexts[0]?.graph).toBe(graph.id);

    expect(calls[1]?.timeoutMs).toBe(2_000);

    expect(queryContexts).toHaveLength(2);

    expect(nativeResults).toHaveLength(0);
  } finally {
    graph.dispose();
  }
});

test("graph cancellation owns the unary signal even if JavaScript supplies a signal override", async () => {
  const input = create(ServiceAll.method.unary.input, { value: "pending" });
  const override = new AbortController();
  let callSignal: AbortSignal | undefined;
  let startCall!: () => void;
  let resolveResponse: ((response: UnaryResponse) => void) | undefined;
  const external = new AbortController();
  const callStarted = new Promise<void>((resolve) => {
    startCall = resolve;
  });
  const transport = makeTransport({
    unary: (call) => {
      callSignal = call.signal;
      startCall();

      return new Promise((resolve) => {
        resolveResponse = resolve;
      });
    },
  });
  const query = grpcQuery({
    transport,
    method: ServiceAll.method.unary,
    name: "grpc.fixture.signal-owner",
    key: ({ value }) => `signal:${value ?? ""}`,
    nativeOptions: () => ({ signal: override.signal }) as unknown as GrpcNativeCallOptions,
  });
  const contract = defineContract({
    namespace: "grpc-fixture-signal-owner",
    operations: { query },
  });
  const graph = createGraph({ contract, abortSignal: external.signal });
  const store = graph.api.query(input);
  const ready = store.ready.catch(() => undefined);

  try {
    await callStarted;

    expect(callSignal).toBeDefined();

    expect(callSignal).not.toBe(override.signal);

    external.abort(new Error("dispose graph"));

    expect(callSignal?.aborted).toBe(true);

    expect(override.signal.aborted).toBe(false);

    resolveResponse?.(
      unaryResponse(ServiceAll.method.unary, create(ServiceAll.method.unary.output, { value: 10 })),
    );

    await ready;
  } finally {
    if (!external.signal.aborted) graph.dispose();

    resolveResponse?.(
      unaryResponse(ServiceAll.method.unary, create(ServiceAll.method.unary.output, { value: 10 })),
    );

    await ready;
  }
});

test("unary callbacks run after response and callback failures keep their phase and identity", async () => {
  const input = create(ServiceAll.method.unary.input, { value: "callbacks" });
  const output = create(ServiceAll.method.unary.output, { value: 11 });
  const events: string[] = [];
  const callFailure = new Error("header observer failed");
  let response: UnaryResponse | undefined;
  const transport = makeTransport({
    unary: async (call) => {
      response = unaryResponse(call.method, output);

      return response;
    },
  });
  const successfulQuery = grpcQuery({
    transport,
    method: ServiceAll.method.unary,
    name: "grpc.fixture.callback-success",
    key: ({ value }) => `callback-success:${value ?? ""}`,
    nativeOptions: () => ({
      onHeader: (headers) => {
        events.push("success-header");

        if (!response) throw new Error("Header callback ran before its transport response");

        expect(headers).toBe(response.header);
      },
      onTrailer: (trailers) => {
        events.push("success-trailer");

        if (!response) throw new Error("Trailer callback ran before its transport response");

        expect(trailers).toBe(response.trailer);
      },
    }),
  });
  const failingQuery = grpcQuery({
    transport,
    method: ServiceAll.method.unary,
    name: "grpc.fixture.callback-failure",
    key: ({ value }) => `callback:${value ?? ""}`,
    nativeOptions: () => ({
      onHeader: (headers) => {
        events.push("header");

        if (!response) throw new Error("Header callback ran before its transport response");

        expect(headers).toBe(response.header);

        throw callFailure;
      },
      onTrailer: () => events.push("trailer"),
    }),
  });
  const graph = createGraph({
    contract: defineContract({
      namespace: "grpc-fixture-callback-failure",
      operations: { successfulQuery, failingQuery },
    }),
  });

  try {
    const successfulStore = graph.api.successfulQuery(input);

    await successfulStore.ready;

    expect(successfulStore.value.get()).toBe(output);

    expect(events).toStrictEqual(["success-header", "success-trailer"]);

    const store = graph.api.failingQuery(input);

    await expect(store.ready).rejects.toBe(callFailure);

    expect(events).toStrictEqual(["success-header", "success-trailer", "header"]);

    expect(store.error.get()).toBe(callFailure);

    expect(store.status.get()).toBe("failed");
  } finally {
    graph.dispose();
  }
});

test("withAeolia projects native server-stream messages into a non-awaitable Feed", async () => {
  type StreamOutput = MessageShape<typeof ServiceAll.method.serverStream.output>;

  const input = create(ServiceAll.method.serverStream.input, { value: "events" });
  const first = create(ServiceAll.method.serverStream.output, { value: 12 });
  const last = create(ServiceAll.method.serverStream.output, { value: 13 });
  const streamCalls: StreamCall[] = [];
  const transport = makeTransport({
    stream: async (call) => {
      streamCalls.push(call);

      return streamResponse(call.method, yieldValues([first, last]));
    },
  });
  const events: StreamDefinition<
    MessageInitShape<typeof ServiceAll.method.serverStream.input>,
    StreamOutput,
    string
  > = grpcStream({
    transport,
    method: ServiceAll.method.serverStream,
    name: "grpc.fixture.events",
    key: ({ value }) => `events:${value ?? ""}`,
  });
  const contract = defineContract({ namespace: "grpc-fixture-feed", operations: { events } });
  const graph = createGraph({ contract });
  const owner = makeOwner();

  try {
    const imported = withAeolia(graph, contract);
    const api = bindImported(owner, imported) as typeof imported;
    const feed = api.events(input);
    const status = computed(() => feed.status(), { label: "grpc-test:feed-status" });
    const closed = waitFor(status, (value) => value === "closed");

    owner.commit();

    await closed;

    expect(feed.value()).toBe(last);

    expect(feed.pending()).toBe(false);

    expect(feed.error()).toBeUndefined();

    expect("then" in feed).toBe(false);

    expect(streamCalls).toHaveLength(1);

    expect(streamCalls[0]?.method).toBe(ServiceAll.method.serverStream);

    expect(streamCalls[0]?.signal).toBeInstanceOf(AbortSignal);

    const requests: unknown[] = [];

    for await (const request of streamCalls[0]!.input) requests.push(request);

    expect(requests).toHaveLength(1);

    expect(requests[0]).toStrictEqual(input);
  } finally {
    owner.dispose();

    graph.dispose();
  }
});

test("server-stream callbacks preserve message order and keep terminal callback failures distinct", async () => {
  const input = create(ServiceAll.method.serverStream.input, { value: "terminal" });
  const item = create(ServiceAll.method.serverStream.output, { value: 14 });
  const events: string[] = [];
  const terminalFailure = new Error("trailer observer failed after native completion");
  const parent = new AbortController();
  let nativeSignal: AbortSignal | undefined;
  let response: StreamResponse | undefined;
  const transport = makeTransport({
    stream: async (call) => {
      nativeSignal = call.signal;
      response = streamResponse(call.method, yieldValues([item]));

      return response;
    },
  });
  const stream = grpcStream({
    transport,
    method: ServiceAll.method.serverStream,
    name: "grpc.fixture.terminal-callback",
    key: ({ value }) => `terminal:${value ?? ""}`,
    nativeOptions: () => ({
      onHeader: (headers) => {
        events.push("header");

        if (!response) throw new Error("Header callback ran before its transport response");

        expect(headers).toBe(response.header);
      },
      onTrailer: (trailers) => {
        events.push("trailer");

        if (!response) throw new Error("Trailer callback ran before its transport response");

        expect(trailers).toBe(response.trailer);

        parent.abort(terminalFailure);

        throw terminalFailure;
      },
    }),
  });
  const graph = createGraph({
    contract: defineContract({ namespace: "grpc-terminal-context", operations: { stream } }),
  });
  const definition = stream.open(input, {
    abortSignal: parent.signal,
    graph: graph.id,
    key: storeKey("terminal:terminal"),
    reportGap: () => undefined,
  });
  const iterator = definition[Symbol.asyncIterator]();

  try {
    await expect(iterator.next()).resolves.toStrictEqual({ done: false, value: item });

    events.push("item");

    await expect(iterator.next()).rejects.toBe(terminalFailure);

    expect(events).toStrictEqual(["header", "item", "trailer"]);

    expect(parent.signal.aborted).toBe(true);

    expect(nativeSignal?.aborted).toBe(false);
  } finally {
    const close = iterator.return?.();

    if (close !== undefined) await close;

    parent.abort();

    graph.dispose();
  }
});

test("server-stream native failure after an item is unchanged and skips trailers", async () => {
  const input = create(ServiceAll.method.serverStream.input, { value: "late-failure" });
  const item = create(ServiceAll.method.serverStream.output, { value: 15 });
  const nativeFailure = new Error("native stream failed after an item");
  const events: string[] = [];
  const parent = new AbortController();
  const transport = makeTransport({
    stream: async (call) => streamResponse(call.method, yieldThenFail(item, nativeFailure)),
  });
  const stream = grpcStream({
    transport,
    method: ServiceAll.method.serverStream,
    name: "grpc.fixture.late-native-failure",
    key: ({ value }) => `late:${value ?? ""}`,
    nativeOptions: () => ({
      onHeader: () => events.push("header"),
      onTrailer: () => events.push("trailer"),
    }),
  });
  const graph = createGraph({
    contract: defineContract({ namespace: "grpc-late-native-failure", operations: { stream } }),
  });
  const iterator = stream
    .open(input, {
      abortSignal: parent.signal,
      graph: graph.id,
      key: storeKey("late:late-failure"),
      reportGap: () => undefined,
    })
    [Symbol.asyncIterator]();

  try {
    await expect(iterator.next()).resolves.toStrictEqual({ done: false, value: item });

    await expect(iterator.next()).rejects.toBe(nativeFailure);

    expect(events).toStrictEqual(["header"]);
  } finally {
    const close = iterator.return?.();

    if (close !== undefined) await close;

    parent.abort();

    graph.dispose();
  }
});

test("stream iterators skip pre-pull work and cancel pending opens on return, parent abort, and throw", async () => {
  const input = create(ServiceAll.method.serverStream.input, { value: "cancel" });
  const starts = [deferred<void>(), deferred<void>(), deferred<void>()];
  const nativeSignals: AbortSignal[] = [];
  const sharedParent = new AbortController();
  const externalParent = new AbortController();
  const pendingCalls: Promise<unknown>[] = [];
  let resolverCalls = 0;
  let nativeCalls = 0;
  let trailerCalls = 0;
  const transport = makeTransport({
    stream: (call) => {
      const callIndex = nativeCalls;
      const signal = call.signal;

      if (signal === undefined) throw new Error("stream transport did not receive a signal");

      nativeCalls++;
      nativeSignals.push(signal);
      starts[callIndex]?.resolve(undefined);

      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  });
  const stream = grpcStream({
    transport,
    method: ServiceAll.method.serverStream,
    name: "grpc.fixture.iterator-cancel",
    key: ({ value }) => `cancel:${value ?? ""}`,
    nativeOptions: () => {
      resolverCalls++;

      return { timeoutMs: 1_000, onTrailer: () => trailerCalls++ };
    },
  });
  const graph = createGraph({
    contract: defineContract({ namespace: "grpc-iterator-cancel", operations: { stream } }),
  });
  const options = {
    abortSignal: sharedParent.signal,
    graph: graph.id,
    key: storeKey("cancel:cancel"),
    reportGap: () => undefined,
  };
  const untouched = stream.open(input, options)[Symbol.asyncIterator]();

  try {
    if (untouched.return === undefined) throw new Error("stream iterator does not expose return");

    await expect(untouched.return()).resolves.toStrictEqual({ done: true, value: undefined });

    expect(nativeCalls).toBe(0);

    expect(resolverCalls).toBe(0);

    const returnIterator = stream.open(input, options)[Symbol.asyncIterator]();
    const returnWait = returnIterator.next();
    pendingCalls.push(returnWait);

    void returnWait.catch(() => undefined);

    await starts[0]!.promise;

    if (returnIterator.return === undefined)
      throw new Error("stream iterator does not expose return");

    const returning = returnIterator.return();
    pendingCalls.push(returning);

    void returning.catch(() => undefined);

    expect(nativeSignals[0]?.aborted).toBe(true);

    await expect(returnWait).rejects.toBe(nativeSignals[0]?.reason);

    await expect(returning).resolves.toMatchObject({ done: true });

    expect(trailerCalls).toBe(0);

    const parentIterator = stream
      .open(input, { ...options, abortSignal: externalParent.signal })
      [Symbol.asyncIterator]();
    const parentWait = parentIterator.next();
    pendingCalls.push(parentWait);

    void parentWait.catch(() => undefined);

    await starts[1]!.promise;

    const parentReason = new Error("parent stopped stream");

    externalParent.abort(parentReason);

    expect(nativeSignals[1]?.aborted).toBe(true);

    expect(nativeSignals[1]?.reason).toBe(parentReason);

    await expect(parentWait).rejects.toBe(parentReason);

    expect(trailerCalls).toBe(0);

    const thrownIterator = stream.open(input, options)[Symbol.asyncIterator]();
    const thrownWait = thrownIterator.next();
    pendingCalls.push(thrownWait);

    void thrownWait.catch(() => undefined);

    await starts[2]!.promise;

    const thrownReason = new Error("consumer threw into stream");

    if (thrownIterator.throw === undefined)
      throw new Error("stream iterator does not expose throw");

    const throwing = thrownIterator.throw(thrownReason);
    pendingCalls.push(throwing);

    void throwing.catch(() => undefined);

    expect(nativeSignals[2]?.aborted).toBe(true);

    expect(nativeSignals[2]?.reason).toBe(thrownReason);

    await expect(thrownWait).rejects.toBe(thrownReason);

    await expect(throwing).rejects.toBe(thrownReason);

    expect(trailerCalls).toBe(0);
  } finally {
    sharedParent.abort();

    externalParent.abort();

    graph.dispose();

    await Promise.allSettled(pendingCalls);
  }
});

test("stream setup failures preserve reasons and abort unfinished native calls", async () => {
  type NativeMode = "response" | "sync-throw" | "native-reject";

  const resolverFailure = new Error("native option resolver failed");
  const syncFailure = new Error("transport setup threw");
  const nativeFailure = new Error("transport setup rejected");
  const headerFailure = new Error("header observer failed");
  const preAbortReason = new Error("parent was already stopped");
  const parents: AbortController[] = [];
  const nativeSignals: AbortSignal[] = [];
  const pendingCalls: Promise<unknown>[] = [];
  const iterators: AsyncIterator<unknown, void, unknown>[] = [];
  let nativeMode: NativeMode = "response";
  let resolverCalls = 0;
  let nativeCalls = 0;
  const transport = makeTransport({
    stream: (call) => {
      const signal = call.signal;

      if (signal === undefined) throw new Error("stream transport did not receive a signal");

      nativeCalls++;
      nativeSignals.push(signal);

      if (nativeMode === "sync-throw") throw syncFailure;

      if (nativeMode === "native-reject") return Promise.reject(nativeFailure);

      return Promise.resolve(streamResponse(call.method, yieldValues([])));
    },
  });
  const stream = grpcStream({
    transport,
    method: ServiceAll.method.serverStream,
    name: "grpc.fixture.setup-failures",
    key: ({ value }) => `setup:${value ?? ""}`,
    nativeOptions: (input) => {
      resolverCalls++;

      if (input.value === "resolver-failure") throw resolverFailure;

      if (input.value === "header-failure") {
        return {
          onHeader: () => {
            throw headerFailure;
          },
        };
      }

      return undefined;
    },
  });
  const graph = createGraph({
    contract: defineContract({ namespace: "grpc-stream-setup-failures", operations: { stream } }),
  });
  const open = (value: string, parent: AbortController): AsyncIterator<unknown, void, unknown> => {
    const iterator = stream
      .open(create(ServiceAll.method.serverStream.input, { value }), {
        abortSignal: parent.signal,
        graph: graph.id,
        key: storeKey(`setup:${value}`),
        reportGap: () => undefined,
      })
      [Symbol.asyncIterator]();

    iterators.push(iterator);

    return iterator;
  };
  const newParent = (): AbortController => {
    const parent = new AbortController();

    parents.push(parent);

    return parent;
  };
  const expectPullFailure = async (
    iterator: AsyncIterator<unknown, void, unknown>,
    reason: Error,
  ): Promise<void> => {
    const pull = iterator.next();

    pendingCalls.push(pull);

    void pull.catch(() => undefined);

    await expect(pull).rejects.toBe(reason);
  };

  try {
    const preAbortedParent = newParent();

    preAbortedParent.abort(preAbortReason);

    await expectPullFailure(open("pre-aborted", preAbortedParent), preAbortReason);

    expect(resolverCalls).toBe(0);

    expect(nativeCalls).toBe(0);

    await expectPullFailure(open("resolver-failure", newParent()), resolverFailure);

    expect(resolverCalls).toBe(1);

    expect(nativeCalls).toBe(0);

    nativeMode = "sync-throw";

    await expectPullFailure(open("sync-failure", newParent()), syncFailure);

    expect(nativeSignals[0]?.aborted).toBe(true);

    expect(nativeSignals[0]?.reason).toBe(syncFailure);

    nativeMode = "native-reject";

    await expectPullFailure(open("native-failure", newParent()), nativeFailure);

    expect(nativeSignals[1]?.aborted).toBe(true);

    expect(nativeSignals[1]?.reason).toBe(nativeFailure);

    nativeMode = "response";

    await expectPullFailure(open("header-failure", newParent()), headerFailure);

    expect(nativeSignals[2]?.aborted).toBe(true);

    expect(nativeSignals[2]?.reason).toBe(headerFailure);

    expect(nativeCalls).toBe(3);
  } finally {
    for (const parent of parents) parent.abort();

    for (const iterator of iterators) {
      const close = iterator.return?.();

      if (close !== undefined) {
        pendingCalls.push(close);

        void close.catch(() => undefined);
      }
    }

    graph.dispose();

    await Promise.allSettled(pendingCalls);
  }
});

test("consumer cancellation interrupts a server stream waiting for its next native message", async () => {
  const modes = ["parent", "return", "throw"] as const;
  type Mode = (typeof modes)[number];

  const messageRequested: Record<Mode, ReturnType<typeof deferred<void>>> = {
    parent: deferred<void>(),
    return: deferred<void>(),
    throw: deferred<void>(),
  };
  const events: Record<Mode, string[]> = { parent: [], return: [], throw: [] };
  const parents: Partial<Record<Mode, AbortController>> = {};
  const nativeSignals: Partial<Record<Mode, AbortSignal>> = {};
  const pendingCalls: Promise<unknown>[] = [];
  const iterators: AsyncIterator<unknown, void, unknown>[] = [];
  let modeIndex = 0;
  const transport = makeTransport({
    stream: (call) => {
      const mode = modes[modeIndex++];
      const signal = call.signal;

      if (mode === undefined) throw new Error("unexpected stream call");

      if (signal === undefined) throw new Error("stream transport did not receive a signal");

      nativeSignals[mode] = signal;

      const message: AsyncIterable<unknown> = {
        [Symbol.asyncIterator]() {
          return {
            next() {
              messageRequested[mode].resolve(undefined);

              return new Promise((_resolve, reject) => {
                signal.addEventListener("abort", () => reject(signal.reason), { once: true });
              });
            },
          };
        },
      };

      return Promise.resolve(streamResponse(call.method, message));
    },
  });
  const stream = grpcStream({
    transport,
    method: ServiceAll.method.serverStream,
    name: "grpc.fixture.pending-item",
    key: ({ value }) => `pending-item:${value ?? ""}`,
    nativeOptions: (request) => {
      const mode = request.value as Mode;

      return {
        onHeader: () => events[mode].push("header"),
        onTrailer: () => events[mode].push("trailer"),
      };
    },
  });
  const graph = createGraph({
    contract: defineContract({ namespace: "grpc-pending-item", operations: { stream } }),
  });
  const open = (mode: Mode): AsyncIterator<unknown, void, unknown> => {
    const parent = new AbortController();

    parents[mode] = parent;

    const iterator = stream
      .open(create(ServiceAll.method.serverStream.input, { value: mode }), {
        abortSignal: parent.signal,
        graph: graph.id,
        key: storeKey(`pending-item:${mode}`),
        reportGap: () => undefined,
      })
      [Symbol.asyncIterator]();

    iterators.push(iterator);

    return iterator;
  };

  try {
    for (const mode of modes) {
      const iterator = open(mode);
      const pendingItem = iterator.next();

      pendingCalls.push(pendingItem);

      void pendingItem.catch(() => undefined);

      await messageRequested[mode].promise;

      expect(events[mode]).toStrictEqual(["header"]);

      const signal = nativeSignals[mode];

      if (signal === undefined) throw new Error("stream transport signal was not recorded");

      const reason = new Error(`${mode} canceled stream while awaiting message`);

      if (mode === "parent") {
        const parent = parents[mode];

        if (parent === undefined) throw new Error("stream parent was not retained");

        parent.abort(reason);

        expect(signal.reason).toBe(reason);

        await expect(pendingItem).rejects.toBe(reason);
      } else if (mode === "return") {
        if (iterator.return === undefined)
          throw new Error("stream iterator does not expose return");

        const closing = iterator.return();

        pendingCalls.push(closing);

        void closing.catch(() => undefined);

        expect(signal.aborted).toBe(true);

        await expect(pendingItem).rejects.toBe(signal.reason);

        await expect(closing).resolves.toMatchObject({ done: true });
      } else {
        if (iterator.throw === undefined) throw new Error("stream iterator does not expose throw");

        const throwing = iterator.throw(reason);

        pendingCalls.push(throwing);

        void throwing.catch(() => undefined);

        expect(signal.aborted).toBe(true);

        expect(signal.reason).toBe(reason);

        await expect(pendingItem).rejects.toBe(reason);

        await expect(throwing).rejects.toBe(reason);
      }

      expect(signal.aborted).toBe(true);

      expect(events[mode]).toStrictEqual(["header"]);
    }
  } finally {
    for (const parent of Object.values(parents)) parent?.abort();

    for (const iterator of iterators) {
      const close = iterator.return?.();

      if (close !== undefined) {
        pendingCalls.push(close);

        void close.catch(() => undefined);
      }
    }

    graph.dispose();

    await Promise.allSettled(pendingCalls);
  }
});

test("normal stream exhaustion detaches the completed child from its parent", async () => {
  const input = create(ServiceAll.method.serverStream.input, { value: "complete" });
  const item = create(ServiceAll.method.serverStream.output, { value: 16 });
  const parent = new AbortController();
  const events: string[] = [];
  let nativeSignal: AbortSignal | undefined;
  const transport = makeTransport({
    stream: async (call) => {
      nativeSignal = call.signal;

      return streamResponse(call.method, yieldValues([item]));
    },
  });
  const stream = grpcStream({
    transport,
    method: ServiceAll.method.serverStream,
    name: "grpc.fixture.normal-completion",
    key: ({ value }) => `complete:${value ?? ""}`,
    nativeOptions: () => ({
      onHeader: () => events.push("header"),
      onTrailer: () => events.push("trailer"),
    }),
  });
  const graph = createGraph({
    contract: defineContract({ namespace: "grpc-normal-completion", operations: { stream } }),
  });
  const pendingCalls: Promise<unknown>[] = [];
  const addListener = spyOn(parent.signal, "addEventListener");
  const removeListener = spyOn(parent.signal, "removeEventListener");
  const iterator = stream
    .open(input, {
      abortSignal: parent.signal,
      graph: graph.id,
      key: storeKey("complete:complete"),
      reportGap: () => undefined,
    })
    [Symbol.asyncIterator]();

  try {
    const registrations = addListener.mock.calls.filter(([type]) => type === "abort");

    expect(registrations).toHaveLength(1);

    const listener = registrations[0]?.[1];

    expect(listener).toBeDefined();

    expect(removeListener).not.toHaveBeenCalled();

    const firstItem = iterator.next();

    pendingCalls.push(firstItem);

    void firstItem.catch(() => undefined);

    await expect(firstItem).resolves.toStrictEqual({ done: false, value: item });

    const terminal = iterator.next();

    pendingCalls.push(terminal);

    void terminal.catch(() => undefined);

    await expect(terminal).resolves.toStrictEqual({ done: true, value: undefined });

    expect(events).toStrictEqual(["header", "trailer"]);

    expect(nativeSignal?.aborted).toBe(false);

    const removals = removeListener.mock.calls.filter(([type]) => type === "abort");

    expect(removals).toHaveLength(1);

    expect(removals[0]?.[1]).toBe(listener);

    parent.abort(new Error("late parent abort"));

    expect(nativeSignal?.aborted).toBe(false);
  } finally {
    parent.abort();

    const close = iterator.return?.();

    if (close !== undefined) {
      pendingCalls.push(close);

      void close.catch(() => undefined);
    }

    graph.dispose();

    await Promise.allSettled(pendingCalls);

    addListener.mockRestore();

    removeListener.mockRestore();
  }
});

test("builders reject unsupported protobuf cardinalities at construction", () => {
  const transport = makeTransport({});

  expect(() =>
    grpcQuery({
      transport,
      method: ServiceAll.method.serverStream as unknown as typeof ServiceAll.method.unary,
      name: "wrong.query",
      key: () => "wrong",
    }),
  ).toThrow(TypeError);

  expect(() =>
    grpcMutation({
      transport,
      method: ServiceAll.method.serverStream as unknown as typeof ServiceAll.method.unary,
      name: "wrong.mutation",
      affects: [],
    }),
  ).toThrow(TypeError);

  expect(() =>
    grpcStream({
      transport,
      method: ServiceAll.method.unary as unknown as typeof ServiceAll.method.serverStream,
      name: "wrong.stream",
      key: () => "wrong",
    }),
  ).toThrow(TypeError);

  expect(() =>
    grpcStream({
      transport,
      method: ServiceAll.method.clientStream as unknown as typeof ServiceAll.method.serverStream,
      name: "wrong.client-stream",
      key: () => "wrong-client",
    }),
  ).toThrow(TypeError);

  expect(() =>
    grpcStream({
      transport,
      method: ServiceAll.method.bidi as unknown as typeof ServiceAll.method.serverStream,
      name: "wrong.bidi",
      key: () => "wrong-bidi",
    }),
  ).toThrow(TypeError);
});
