import assert from "node:assert/strict";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { Code, ConnectError } from "@connectrpc/connect";
import { Http2SessionManager } from "@connectrpc/connect-node";
import { create, type MessageShape } from "@bufbuild/protobuf";
import {
  affects,
  createGraph,
  defineContract,
  storeKey,
  subscribe,
  type Readable,
} from "aeolia";
import {
  grpcMutation,
  grpcQuery,
  grpcStream,
} from "@hesperia/grpc";
import {
  createGrpcTransport,
  type GrpcTransportOptions,
} from "@hesperia/grpc/native";
import { ServiceAll } from "../../data/fixtures/grpc/service-all_pb.js";

type FixtureEvent =
  | "deadline-observed"
  | "unary-held"
  | "unary-cancelled"
  | "stream-cancelled";

type RecordedCall = {
  readonly path: string;
  readonly requestFrames: readonly string[];
  readonly responseFrames: readonly string[];
  readonly requestHeaders: Readonly<Record<string, string>>;
  readonly requestError?: string;
  readonly responseHeaders: Readonly<Record<string, string>>;
  readonly responseTrailers: Readonly<Record<string, string>>;
  readonly closeCode: number | undefined;
  readonly streamErrors?: readonly string[];
};

type FixtureEventRecord = {
  readonly name: string;
  readonly callId: number;
  readonly path: string;
  readonly requestLabel: string | undefined;
  readonly closeCode: number | undefined;
};

type GrpcServerFixture = {
  readonly baseUrl: string;
  readonly observations: {
    readonly calls: RecordedCall[];
    readonly events: FixtureEventRecord[];
    readonly serverErrors: string[];
  };
  readonly waitForEvent: (name: FixtureEvent, timeoutMs?: number) => Promise<FixtureEventRecord>;
  readonly close: () => Promise<void>;
};

type GrpcServerFixtureModule = {
  readonly startGrpcServerFixture: () => Promise<GrpcServerFixture>;
};

type StreamOutput = MessageShape<typeof ServiceAll.method.serverStream.output>;
type StreamIterator = AsyncIterator<StreamOutput, void, unknown>;

const unaryPath = "/spec.ServiceAll/Unary";
const streamPath = "/spec.ServiceAll/ServerStream";
const frame = {
  q: "00000000030a0151",
  m: "00000000030a014d",
  f: "00000000030a0146",
  d: "00000000030a0144",
  u: "00000000030a0155",
  s: "00000000030a0153",
  e: "00000000030a0145",
  c: "00000000030a0143",
  int32Seven: "00000000020807",
  int32Eight: "00000000020808",
  int32Nine: "00000000020809",
  int32Fourteen: "0000000002080e",
  int32Fifteen: "0000000002080f",
  int32Zero: "0000000000",
} as const;

const nativeDeadlineMs = 500;

function waitFor<T>(
  source: Readable<T>,
  predicate: (value: T) => boolean,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let stop: (() => void) | undefined;
    let settled = false;
    let stopWhenAvailable = false;

    const cleanup = (): void => {
      if (stop === undefined) stopWhenAvailable = true;
      else stop();

      signal.removeEventListener("abort", abort);
    };

    const finish = (complete: () => void): void => {
      if (settled) return;

      settled = true;
      cleanup();
      complete();
    };

    const abort = (): void => {
      finish(() => reject(signal.reason));
    };

    const observer = (value: T): void => {
      if (!predicate(value)) return;

      finish(() => resolve(value));
    };

    if (signal.aborted) {
      abort();

      return;
    }

    signal.addEventListener("abort", abort, { once: true });
    stop = subscribe(source, observer);

    if (stopWhenAvailable) stop();

    if (signal.aborted) abort();
  });
}

async function captureFailure<T>(promise: Promise<T>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("Expected the native RPC to reject");
    },
    (error: unknown) => error,
  );
}

async function settleWithin(
  promises: readonly Promise<unknown>[],
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    await Promise.race([
      Promise.allSettled(promises),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Native client cleanup exceeded its bound")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function readHeader(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  const target = name.toLowerCase();

  return Object.entries(headers).find(([key]) => key.toLowerCase() === target)?.[1];
}

function hex(frames: readonly string[]): string[] {
  return frames.map((value) => value.replaceAll(/[\s:]/g, "").toLowerCase());
}

function callFor(
  calls: readonly RecordedCall[],
  path: string,
  requestFrame: string,
): RecordedCall {
  const call = calls.find(
    (item) => item.path === path && hex(item.requestFrames).join("") === requestFrame,
  );

  assert.ok(call, `Missing ${path} call for request frame ${requestFrame}`);

  return call;
}

function expectConnectError(
  value: unknown,
  code: Code,
  rawMessage?: string,
): ConnectError {
  assert.ok(value instanceof ConnectError, `Expected ConnectError, received ${String(value)}`);
  assert.equal(value.code, code);

  if (rawMessage !== undefined) assert.equal(value.rawMessage, rawMessage);

  return value;
}

async function main(): Promise<void> {
  assert.equal(process.versions.node, "22.23.2");

  const fixtureModulePath = process.argv[2];

  if (fixtureModulePath === undefined || !isAbsolute(fixtureModulePath)) {
    throw new Error("Pass the absolute path to grpc-server.fixture.mjs as the first argument");
  }

  const fixtureModule = (await import(
    pathToFileURL(fixtureModulePath).href
  )) as GrpcServerFixtureModule;
  const fixture = await fixtureModule.startGrpcServerFixture();
  let sessionManager: Http2SessionManager | undefined;
  const graphs: Array<{ dispose: () => void }> = [];
  const parents: AbortController[] = [];
  const refreshWaitController = new AbortController();
  const iterators: StreamIterator[] = [];
  const pendingCalls: Promise<unknown>[] = [];
  const checks: string[] = [];
  let moduleResolutions: Record<string, string> = {};
  let scenarioError: unknown;
  let scenarioFailed = false;
  const cleanupErrors: unknown[] = [];

  try {
    sessionManager = new Http2SessionManager(fixture.baseUrl);

    const transportOptions: GrpcTransportOptions = {
      baseUrl: fixture.baseUrl,
      sessionManager,
    };
    const transport = createGrpcTransport(transportOptions);
    const streamEvents = new Map<string, string[]>();
    const query = grpcQuery({
      transport,
      method: ServiceAll.method.unary,
      name: "grpc.native.state-query",
      key: ({ value }) => `native:${value ?? ""}`,
      nativeOptions: (input) => {
        if (input.value === "D") return { timeoutMs: nativeDeadlineMs };

        if (input.value === "Q") return { headers: { "x-fixture-client": "Q" } };

        if (input.value === "F") return { headers: { "x-fixture-client": "F" } };

        return undefined;
      },
    });
    const mutation = grpcMutation({
      transport,
      method: ServiceAll.method.unary,
      name: "grpc.native.state-mutation",
      affects: [affects(query, { select: () => ({ value: "Q" }), on: "revalidate" })],
      nativeOptions: () => ({ headers: { "x-fixture-client": "M" } }),
    });
    const stream = grpcStream({
      transport,
      method: ServiceAll.method.serverStream,
      name: "grpc.native.receive-stream",
      key: ({ value }) => `native-stream:${value ?? ""}`,
      nativeOptions: (input) => {
        const mode = input.value ?? "";
        const events = streamEvents.get(mode) ?? [];

        streamEvents.set(mode, events);

        return {
          onHeader: (headers) =>
            events.push(`header:${headers.get("x-fixture-header") ?? ""}`),
          onTrailer: (trailers) => {
            const status = trailers.get("grpc-status") ?? "";
            const fixtureTrailer = trailers.get("x-fixture-trailer") ?? "";

            events.push(`trailer:${status}:${fixtureTrailer}`);
          },
        };
      },
    });
    const contract = defineContract({
      namespace: "grpc.native.fixture",
      operations: { query, mutation, stream },
    });
    const graph = createGraph({ contract });

    graphs.push(graph);

    moduleResolutions = {
      hesperiaGrpc: import.meta.resolve("@hesperia/grpc"),
      hesperiaGrpcNative: import.meta.resolve("@hesperia/grpc/native"),
      connectNode: import.meta.resolve("@connectrpc/connect-node"),
      protobuf: import.meta.resolve("@bufbuild/protobuf"),
      aeolia: import.meta.resolve("aeolia"),
    };

    process.stdout.write(
      `${JSON.stringify({
        event: "server-ready",
        nodeVersion: process.versions.node,
        nodeExecutable: process.execPath,
        baseUrl: fixture.baseUrl,
      })}\n`,
    );

    const initialQueryInput = create(ServiceAll.method.unary.input, { value: "Q" });
    const state = graph.api.query(initialQueryInput);

    await state.ready;

    const initialValue = state.value.get();

    assert.ok(initialValue);

    assert.equal(initialValue.value, 7);

    const refreshedState = waitFor(
      state.value,
      (value) => value?.value === 9,
      refreshWaitController.signal,
    );

    pendingCalls.push(refreshedState);

    void refreshedState.catch(() => undefined);

    const mutationResult = await graph.api.mutation(
      create(ServiceAll.method.unary.input, { value: "M" }),
    );

    assert.equal(mutationResult.value, 8);

    const refreshed = await refreshedState;

    assert.ok(refreshed);

    assert.equal(refreshed.value, 9);

    const unaryCalls = fixture.observations.calls.filter((call) => call.path === unaryPath);
    const initialQueryCall = callFor(unaryCalls, unaryPath, frame.q);
    const mutationCall = callFor(unaryCalls, unaryPath, frame.m);
    const refreshCalls = unaryCalls.filter(
      (call) => hex(call.requestFrames).join("") === frame.q,
    );

    assert.equal(refreshCalls.length, 2);

    assert.deepEqual(hex(initialQueryCall.requestFrames), [frame.q]);

    assert.deepEqual(hex(initialQueryCall.responseFrames), [frame.int32Seven]);

    assert.deepEqual(hex(mutationCall.requestFrames), [frame.m]);

    assert.deepEqual(hex(mutationCall.responseFrames), [frame.int32Eight]);

    assert.deepEqual(hex(refreshCalls[1]!.responseFrames), [frame.int32Nine]);

    assert.equal(readHeader(initialQueryCall.requestHeaders, "x-fixture-client"), "Q");

    assert.equal(readHeader(mutationCall.requestHeaders, "x-fixture-client"), "M");

    for (const call of [initialQueryCall, mutationCall, refreshCalls[1]!]) {
      assert.equal(readHeader(call.requestHeaders, "grpc-timeout"), undefined);

      assert.equal(readHeader(call.responseTrailers, "grpc-status"), "0");
    }

    checks.push("query-mutation-effects");

    const failureStore = graph.api.query(
      create(ServiceAll.method.unary.input, { value: "F" }),
    );
    const failure = await captureFailure(failureStore.ready);
    const connectFailure = expectConnectError(failure, Code.PermissionDenied, "permission denied");
    const details = connectFailure.findDetails(ServiceAll.method.unary.input);

    assert.equal(connectFailure.metadata.get("x-fixture-header"), "F-header");

    assert.equal(connectFailure.metadata.get("x-fixture-error-trailer"), "F-trailer");

    assert.equal(details.length, 1);

    assert.equal(details[0]?.value, "permission-detail");

    const failureCall = callFor(fixture.observations.calls, unaryPath, frame.f);

    assert.deepEqual(hex(failureCall.requestFrames), [frame.f]);

    assert.deepEqual(hex(failureCall.responseFrames), []);

    assert.equal(readHeader(failureCall.requestHeaders, "x-fixture-client"), "F");

    assert.equal(readHeader(failureCall.responseHeaders, "x-fixture-header"), "F-header");

    assert.equal(readHeader(failureCall.responseTrailers, "grpc-status"), "7");

    assert.equal(readHeader(failureCall.responseTrailers, "grpc-message"), "permission%20denied");

    assert.ok(readHeader(failureCall.responseTrailers, "grpc-status-details-bin"));

    checks.push("error-details");

    const deadlineStore = graph.api.query(
      create(ServiceAll.method.unary.input, { value: "D" }),
    );
    const deadlineOutcome = captureFailure(deadlineStore.ready);
    pendingCalls.push(deadlineOutcome);

    void deadlineOutcome.catch(() => undefined);

    const deadlineEventOutcome = fixture.waitForEvent("deadline-observed", 10_000);

    pendingCalls.push(deadlineEventOutcome);

    const [deadlineFailure, deadlineEvent] = await Promise.all([
      deadlineOutcome,
      deadlineEventOutcome,
    ]);
    const deadlineError = expectConnectError(
      deadlineFailure,
      Code.DeadlineExceeded,
    );

    assert.ok(deadlineError instanceof ConnectError);

    const deadlineCall = callFor(fixture.observations.calls, unaryPath, frame.d);

    assert.deepEqual(hex(deadlineCall.requestFrames), [frame.d]);

    assert.deepEqual(hex(deadlineCall.responseFrames), []);

    assert.ok(readHeader(deadlineCall.requestHeaders, "grpc-timeout"));

    assert.equal(deadlineCall.closeCode, 2);

    assert.equal(deadlineEvent.closeCode, 2);

    checks.push("deadline");

    const cancellationController = new AbortController();
    parents.push(cancellationController);

    const cancellationGraph = createGraph({ contract, abortSignal: cancellationController.signal });

    graphs.push(cancellationGraph);

    const cancellationStore = cancellationGraph.api.query(
      create(ServiceAll.method.unary.input, { value: "U" }),
    );
    const cancellationOutcome = cancellationStore.ready.then(
      () => "resolved" as const,
      () => "rejected" as const,
    );

    pendingCalls.push(cancellationOutcome);

    const unaryHeldOutcome = fixture.waitForEvent("unary-held", 10_000);

    pendingCalls.push(unaryHeldOutcome);

    await unaryHeldOutcome;

    cancellationController.abort(new DOMException("native unary canceled", "AbortError"));

    const unaryCancelledOutcome = fixture.waitForEvent("unary-cancelled", 10_000);

    pendingCalls.push(unaryCancelledOutcome);

    const [cancellationSettlement, unaryCancelledEvent] = await Promise.all([
      cancellationOutcome,
      unaryCancelledOutcome,
    ]);

    assert.equal(cancellationSettlement, "rejected");

    const cancellationCall = callFor(fixture.observations.calls, unaryPath, frame.u);

    assert.deepEqual(hex(cancellationCall.requestFrames), [frame.u]);

    assert.deepEqual(hex(cancellationCall.responseFrames), []);

    assert.equal(cancellationCall.closeCode, 8);

    assert.equal(unaryCancelledEvent.closeCode, 8);

    checks.push("unary-cancel");

    const streamParent = new AbortController();

    parents.push(streamParent);

    const open = (value: string): StreamIterator => {
      const iterator = stream.open(
        create(ServiceAll.method.serverStream.input, { value }),
        {
          abortSignal: streamParent.signal,
          graph: graph.id,
          key: storeKey(`native-stream:${value}`),
          reportGap: () => undefined,
        },
      )[Symbol.asyncIterator]();

      iterators.push(iterator);

      return iterator;
    };

    const successIterator = open("S");
    const firstSuccess = await successIterator.next();

    if (firstSuccess.done) throw new Error("Server stream S ended before its first message");

    assert.equal(firstSuccess.value.value, 7);

    const zeroSuccess = await successIterator.next();

    if (zeroSuccess.done) throw new Error("Server stream S ended before its wrapper zero message");

    assert.equal(zeroSuccess.value.value, 0);

    const normalEnd = await successIterator.next();

    assert.equal(normalEnd.done, true);

    assert.deepEqual(streamEvents.get("S"), ["header:S-header", "trailer:0:S-trailer"]);

    const successCall = callFor(fixture.observations.calls, streamPath, frame.s);

    assert.deepEqual(hex(successCall.requestFrames), [frame.s]);

    assert.deepEqual(hex(successCall.responseFrames), [frame.int32Seven, frame.int32Zero]);

    assert.equal(readHeader(successCall.responseTrailers, "grpc-status"), "0");

    assert.equal(readHeader(successCall.responseTrailers, "x-fixture-trailer"), "S-trailer");

    assert.equal(readHeader(successCall.responseHeaders, "x-fixture-header"), "S-header");

    checks.push("stream");

    const lateErrorIterator = open("E");
    const lateErrorItem = await lateErrorIterator.next();

    if (lateErrorItem.done) throw new Error("Server stream E ended before its late error item");

    assert.equal(lateErrorItem.value.value, 14);

    const lateError = expectConnectError(
      await captureFailure(lateErrorIterator.next()),
      Code.PermissionDenied,
      "stream denied",
    );

    assert.equal(lateError.metadata.get("x-fixture-header"), "E-header");

    assert.equal(lateError.metadata.get("x-fixture-error-trailer"), "E-trailer");

    assert.deepEqual(streamEvents.get("E"), ["header:E-header"]);

    const lateErrorCall = callFor(fixture.observations.calls, streamPath, frame.e);

    assert.deepEqual(hex(lateErrorCall.requestFrames), [frame.e]);

    assert.deepEqual(hex(lateErrorCall.responseFrames), [frame.int32Fourteen]);

    assert.equal(readHeader(lateErrorCall.responseTrailers, "grpc-status"), "7");

    assert.equal(
      readHeader(lateErrorCall.responseTrailers, "x-fixture-error-trailer"),
      "E-trailer",
    );

    checks.push("late-error");

    const earlyReturnIterator = open("C");
    const earlyItem = await earlyReturnIterator.next();

    if (earlyItem.done) throw new Error("Server stream C ended before its early-return item");

    assert.equal(earlyItem.value.value, 15);

    const pendingItem = earlyReturnIterator.next();

    pendingCalls.push(pendingItem);

    void pendingItem.catch(() => undefined);

    if (earlyReturnIterator.return === undefined) {
      throw new Error("Server stream C does not expose iterator return");
    }

    const returning = earlyReturnIterator.return();

    pendingCalls.push(returning);

    void returning.catch(() => undefined);

    const streamCancelledOutcome = fixture.waitForEvent("stream-cancelled", 10_000);

    pendingCalls.push(streamCancelledOutcome);

    const [pendingFailure, returned] = await Promise.all([
      captureFailure(pendingItem),
      returning,
      streamCancelledOutcome,
    ]);

    expectConnectError(pendingFailure, Code.Canceled);

    assert.equal(returned.done, true);

    assert.deepEqual(streamEvents.get("C"), ["header:C-header"]);

    const earlyReturnCall = callFor(fixture.observations.calls, streamPath, frame.c);

    assert.deepEqual(hex(earlyReturnCall.requestFrames), [frame.c]);

    assert.deepEqual(hex(earlyReturnCall.responseFrames), [frame.int32Fifteen]);

    assert.deepEqual(earlyReturnCall.responseTrailers, {});

    assert.equal(earlyReturnCall.closeCode, 8);

    checks.push("early-return");

    assert.equal(fixture.observations.calls.length, 9);

    for (const call of fixture.observations.calls) {
      assert.equal(call.requestError, undefined);

      assert.deepEqual(call.streamErrors ?? [], []);
    }

    assert.deepEqual(fixture.observations.serverErrors, []);
  } catch (error) {
    scenarioFailed = true;
    scenarioError = error;
  }

  try {
    refreshWaitController.abort(new Error("scenario cleanup"));
  } catch (error) {
    cleanupErrors.push(error);
  }

  for (const parent of parents) {
    try {
      parent.abort();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  for (const iterator of iterators) {
    try {
      const close = iterator.return?.();

      if (close !== undefined) {
        pendingCalls.push(close);

        void close.catch(() => undefined);
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  for (const currentGraph of graphs) {
    try {
      currentGraph.dispose();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  if (sessionManager !== undefined) {
    try {
      sessionManager.abort();
    } catch (error) {
      cleanupErrors.push(error);
    }

    try {
      const clientSessionState = sessionManager.state();

      assert.equal(clientSessionState, "closed");
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  try {
    await fixture.close();
  } catch (error) {
    cleanupErrors.push(error);
  }

  try {
    await settleWithin(pendingCalls, 5_000);
  } catch (error) {
    cleanupErrors.push(error);
  }

  if (scenarioFailed || cleanupErrors.length > 0) {
    const failures = scenarioFailed ? [scenarioError, ...cleanupErrors] : cleanupErrors;

    throw new AggregateError(failures, "Native gRPC scenario or cleanup failed");
  }

  process.stdout.write(
    `${JSON.stringify({
      event: "completed",
      nodeVersion: process.versions.node,
      nodeExecutable: process.execPath,
      clientSessionState: sessionManager?.state() ?? "not-created",
      serverCleanup: "complete",
      checks,
      moduleResolutions,
      observations: {
        calls: fixture.observations.calls.map((call) => ({
          path: call.path,
          requestFrames: call.requestFrames,
          responseFrames: call.responseFrames,
          requestHeaders: call.requestHeaders,
          responseHeaders: call.responseHeaders,
          responseTrailers: call.responseTrailers,
          closeCode: call.closeCode ?? null,
          requestError: call.requestError ?? null,
          streamErrors: call.streamErrors ?? [],
        })),
        events: fixture.observations.events,
        serverErrors: fixture.observations.serverErrors,
      },
    })}\n`,
  );
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
