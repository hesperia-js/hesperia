import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { buildSchema } from "graphql";
import { useServer } from "graphql-ws/use/ws";
import { createYoga } from "graphql-yoga";
import { WebSocketServer } from "ws";

const runtime = process.argv[2];

if (runtime === "bun") {
  if (globalThis.Bun?.version !== "1.4.4")
    throw new Error(`Expected Bun 1.4.4; received ${globalThis.Bun?.version}`);
} else if (runtime === "node" || runtime === undefined) {
  if (globalThis.Bun !== undefined || process.versions.node !== "22.23.2")
    throw new Error(`Expected Node 22.23.2; received ${process.versions.node}`);
} else {
  throw new Error("Expected an explicitly selected GraphQL fixture runtime");
}

const host = "127.0.0.1";
const instanceId = randomUUID();
const sessions = new Map();
const controlWaitControllers = new Set();
let shuttingDown = false;
let disposeGraphQLWebSocketServer = async () => undefined;
let graphqlWsUrl = "";

function createSession() {
  return {
    state: { revision: 0, writes: [] },
    resolverCalls: { echo: 0, contextEcho: 0, state: 0 },
    gates: new Map(),
    subscriptions: new Map(),
    socketClose: 0,
    socketOpen: 0,
    subscriptionListeners: new Set(),
  };
}

function getSession(id) {
  let session = sessions.get(id);

  if (!session) {
    session = createSession();
    sessions.set(id, session);
  }

  return session;
}

getSession("");

const schema = buildSchema(`
  type ContextEcho {
    value: String!
    identity: String
  }

  type PartialResult {
    ok: String!
    broken: String
  }

  type MutationState {
    revision: Int!
    writes: [String!]!
  }

  type MutationReceipt {
    value: String!
    failure: String
  }

  type Query {
    echo(value: String!): String!
    contextEcho(value: String!): ContextEcho!
    partial: PartialResult!
    error: String
    rootFailure: String!
    state: MutationState!
    gate(id: ID!): String!
  }

  type Mutation {
    writeThenFail(value: String!): MutationReceipt
    waitAtGate(id: ID!): String!
  }

  type NativeEvent {
    sequence: Int!
    value: String!
    broken: String
    fatal: String!
  }

  type Subscription {
    events(id: ID!): NativeEvent!
  }
`);

function createGate(id) {
  return {
    id,
    started: 0,
    aborted: 0,
    completed: 0,
    lateCompletions: 0,
    release: undefined,
    listeners: new Set(),
  };
}

function gateSnapshot(gate) {
  return {
    id: gate.id,
    started: gate.started,
    aborted: gate.aborted,
    completed: gate.completed,
    lateCompletions: gate.lateCompletions,
    pending: gate.release !== undefined,
  };
}

function notifyGate(gate) {
  for (const listener of gate.listeners) listener();
}

function createSubscriptionIncarnationState(id, incarnation) {
  return {
    id,
    incarnation,
    started: 1,
    finally: 0,
    emitted: 0,
    protocolComplete: 0,
    clientComplete: 0,
    active: true,
    commands: [],
    waiters: [],
    listeners: new Set(),
  };
}

function getSubscription(session, id) {
  let subscription = session.subscriptions.get(id);

  if (!subscription) {
    subscription = {
      id,
      nextIncarnation: 1,
      incarnations: new Map(),
      listeners: new Set(),
    };
    session.subscriptions.set(id, subscription);
  }

  return subscription;
}

function createSubscriptionIncarnation(session, id, operation) {
  const subscription = getSubscription(session, id);
  const incarnation = subscription.nextIncarnation++;
  const state = createSubscriptionIncarnationState(id, incarnation);

  subscription.incarnations.set(incarnation, state);

  if (operation) operation.incarnation = incarnation;

  notifySubscription(session, subscription, state);

  return state;
}

function subscriptionSnapshot(session, subscription, incarnation) {
  const states =
    incarnation === undefined
      ? [...subscription.incarnations.values()]
      : [subscription.incarnations.get(incarnation)].filter(Boolean);
  const sum = (phase) => states.reduce((total, state) => total + state[phase], 0);
  const latest = subscription.nextIncarnation - 1;

  return {
    id: subscription.id,
    incarnation: incarnation ?? latest,
    started: sum("started"),
    finally: sum("finally"),
    emitted: sum("emitted"),
    protocolComplete: sum("protocolComplete"),
    clientComplete: sum("clientComplete"),
    socketClose: session.socketClose,
    active: states.some((state) => state.active),
  };
}

function notifySubscription(session, subscription, incarnationState) {
  if (incarnationState) for (const listener of incarnationState.listeners) listener();

  for (const listener of subscription.listeners) listener();

  for (const listener of session.subscriptionListeners) listener();
}
function waitForSessionSocketsToClose(session) {
  const target = session.socketOpen;

  if (session.socketClose >= target) return { promise: Promise.resolve(), stop: () => undefined };

  let stop = () => undefined;
  const promise = new Promise((resolve) => {
    const check = () => {
      if (session.socketClose < target) return;

      session.subscriptionListeners.delete(check);
      resolve();
    };

    stop = () => session.subscriptionListeners.delete(check);
    session.subscriptionListeners.add(check);
    check();
  });

  return { promise, stop };
}

function subscriptionPhaseReached(session, subscription, phase, count, incarnation) {
  const value =
    phase === "socketClose"
      ? session.socketClose
      : subscriptionSnapshot(session, subscription, incarnation)[phase];

  return typeof value === "number" && value >= count;
}

function waitForSubscription(session, subscription, phase, signal, count = 1, incarnation) {
  if (subscriptionPhaseReached(session, subscription, phase, count, incarnation))
    return Promise.resolve(subscriptionSnapshot(session, subscription, incarnation));

  return new Promise((resolve, reject) => {
    const listeners =
      phase === "socketClose" ? session.subscriptionListeners : subscription.listeners;

    const cleanup = () => {
      clearTimeout(timeout);
      listeners.delete(check);
      signal.removeEventListener("abort", abort);
    };

    const check = () => {
      if (!subscriptionPhaseReached(session, subscription, phase, count, incarnation)) return;

      cleanup();
      resolve(subscriptionSnapshot(session, subscription, incarnation));
    };

    const abort = () => {
      cleanup();
      reject(signal.reason ?? new Error("Control request was aborted"));
    };

    const timeout = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Timed out waiting for subscription ${subscription.id} phase ${phase}${incarnation === undefined ? "" : ` incarnation ${incarnation}`}`,
        ),
      );
    }, 30_000);

    listeners.add(check);
    signal.addEventListener("abort", abort, { once: true });

    if (signal.aborted) abort();
    else check();
  });
}

function queueSubscriptionCommand(subscription, command) {
  const resolve = subscription.waiters.shift();

  if (resolve) resolve(command);
  else subscription.commands.push(command);
}

function nextSubscriptionCommand(subscription) {
  const command = subscription.commands.shift();

  if (command) return Promise.resolve(command);

  return new Promise((resolve) => subscription.waiters.push(resolve));
}

async function* subscriptionEvents(session, subscription, incarnation) {
  try {
    while (true) {
      const command = await nextSubscriptionCommand(incarnation);

      if (command.kind === "finish") return;

      if (command.kind === "cancel") {
        yield { sequence: -1, value: "fixture-cancel-wakeup" };

        continue;
      }

      if (command.kind === "throw")
        throw new Error(`fixture subscription failure: ${subscription.id}`);

      incarnation.emitted += 1;
      notifySubscription(session, subscription, incarnation);

      yield command.event;
    }
  } finally {
    incarnation.finally += 1;
    incarnation.active = false;
    notifySubscription(session, subscription, incarnation);
  }
}
function gatePhaseReached(gate, phase) {
  switch (phase) {
    case "started":
      return gate.started > 0;
    case "aborted":
      return gate.aborted > 0;
    case "completed":
      return gate.completed > 0;
    case "lateCompletion":
      return gate.lateCompletions > 0;
    default:
      return false;
  }
}

function waitForGate(gate, phase, signal) {
  if (gatePhaseReached(gate, phase)) return Promise.resolve(gateSnapshot(gate));

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      gate.listeners.delete(check);
      signal.removeEventListener("abort", abort);
    };

    const check = () => {
      if (!gatePhaseReached(gate, phase)) return;

      cleanup();
      resolve(gateSnapshot(gate));
    };

    const abort = () => {
      cleanup();
      reject(signal.reason ?? new Error("Control request was aborted"));
    };

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for gate ${gate.id} phase ${phase}`));
    }, 30_000);

    gate.listeners.add(check);
    signal.addEventListener("abort", abort, { once: true });

    if (signal.aborted) abort();
    else check();
  });
}

function resolveGate(gates, id, value) {
  const gate = gates.get(id);

  if (!gate?.release) return false;

  const release = gate.release;
  gate.release = undefined;
  release(value);
  notifyGate(gate);

  return true;
}

const queryFields = schema.getQueryType().getFields();
queryFields.echo.resolve = (_root, { value }, context) => {
  context.session.resolverCalls.echo += 1;

  return value;
};
queryFields.contextEcho.resolve = (_root, { value }, context) => {
  context.session.resolverCalls.contextEcho += 1;

  return { value, identity: context.identity };
};
queryFields.partial.resolve = () => ({});
queryFields.error.resolve = () => {
  throw new Error("fixture query field failure");
};
queryFields.rootFailure.resolve = () => {
  throw new Error("fixture root failure");
};
queryFields.state.resolve = (_root, _args, context) => {
  context.session.resolverCalls.state += 1;

  return {
    revision: context.session.state.revision,
    writes: [...context.session.state.writes],
  };
};
const gateResolver = async (_root, { id }, context) => {
  const gates = context.session.gates;
  let gate = gates.get(id);

  if (!gate) {
    gate = createGate(id);
    gates.set(id, gate);
  }

  if (gate.release) throw new Error(`fixture gate ${id} already has a pending resolver`);

  gate.started += 1;
  notifyGate(gate);

  const signal = context.request.signal;
  const observeAbort = () => {
    gate.aborted += 1;
    notifyGate(gate);
  };

  if (signal.aborted) observeAbort();
  else signal.addEventListener("abort", observeAbort, { once: true });

  // Keep the resolver held after client cancellation so a test can observe a late completion.
  const value = await new Promise((resolve) => {
    gate.release = resolve;
  });

  signal.removeEventListener("abort", observeAbort);
  gate.completed += 1;

  if (signal.aborted) gate.lateCompletions += 1;

  notifyGate(gate);

  return value;
};
queryFields.gate.resolve = gateResolver;

const mutationFields = schema.getMutationType().getFields();
mutationFields.writeThenFail.resolve = (_root, { value }, context) => {
  context.session.state.revision += 1;
  context.session.state.writes.push(value);

  return { value };
};
mutationFields.waitAtGate.resolve = gateResolver;

const receiptFields = schema.getType("MutationReceipt").getFields();
receiptFields.failure.resolve = () => {
  throw new Error("fixture mutation field failure");
};

const partialFields = schema.getType("PartialResult").getFields();
partialFields.ok.resolve = () => "partial-ok";
partialFields.broken.resolve = () => {
  throw new Error("fixture partial field failure");
};

const subscriptionFields = schema.getSubscriptionType().getFields();
subscriptionFields.events.resolve = (event) => event;
subscriptionFields.events.subscribe = (_root, { id }, context) => {
  const subscription = getSubscription(context.session, id);
  const operation = context.fixtureSubscriptionOperation;
  const incarnation = createSubscriptionIncarnation(context.session, id, operation);

  return subscriptionEvents(context.session, subscription, incarnation);
};
const nativeEventFields = schema.getType("NativeEvent").getFields();
nativeEventFields.broken.resolve = (event) => {
  if (event.broken) throw new Error("fixture subscription field failure");

  return null;
};
nativeEventFields.fatal.resolve = (event) => {
  if (event.fatal) throw new Error("fixture subscription root failure");

  return "ok";
};

function withFixtureExtension(result) {
  return {
    ...result,
    extensions: {
      ...result.extensions,
      fixture: { instanceId },
    },
  };
}

const yoga = createYoga({
  context: ({ request }) => ({
    request,
    identity: request.headers.get("x-fixture-identity"),
    session: getSession(request.headers.get("x-fixture-session") ?? ""),
  }),
  graphqlEndpoint: "/graphql",
  graphiql: false,
  maskedErrors: false,
  plugins: [
    {
      onExecutionResult({ result, setResult }) {
        setResult(withFixtureExtension(result));
      },
    },
  ],
  schema,
});

function sendJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

async function readJsonRequest(request) {
  const chunks = [];

  for await (const chunk of request) chunks.push(Buffer.from(chunk));

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function readSubscriptionIncarnation(url) {
  const value = url.searchParams.get("incarnation");

  if (value === null) return undefined;

  const incarnation = Number(value);

  if (!Number.isSafeInteger(incarnation) || incarnation < 1)
    throw new Error("expected a positive subscription incarnation");

  return incarnation;
}
function readGateId(url) {
  return url.searchParams.get("gate") ?? "";
}

async function handleControlRequest(request, response, url) {
  const session = getSession(url.searchParams.get("session") ?? "");

  if (request.method === "GET" && url.pathname === "/__fixture/state") {
    sendJson(response, 200, {
      instanceId,
      graphqlWsUrl,
      revision: session.state.revision,
      writes: [...session.state.writes],
      resolverCalls: { ...session.resolverCalls },
      gates: [...session.gates.values()].map(gateSnapshot),
    });

    return true;
  }

  if (request.method === "POST" && url.pathname === "/__fixture/reset") {
    if ([...session.gates.values()].some((gate) => gate.release)) {
      sendJson(response, 409, { error: "cannot reset while a resolver gate is pending" });

      return true;
    }

    session.state.revision = 0;
    session.state.writes.length = 0;
    session.resolverCalls.echo = 0;
    session.resolverCalls.contextEcho = 0;
    session.resolverCalls.state = 0;
    session.gates.clear();
    sendJson(response, 200, { reset: true, instanceId });

    return true;
  }

  if (request.method === "GET" && url.pathname === "/__fixture/wait") {
    const id = readGateId(url);
    const phase = url.searchParams.get("phase") ?? "";
    let gate = session.gates.get(id);
    const validPhases = new Set(["started", "aborted", "completed", "lateCompletion"]);

    if (!id || !validPhases.has(phase)) {
      sendJson(response, 400, { error: "expected a nonempty gate id and a supported phase" });

      return true;
    }

    if (!gate) {
      gate = createGate(id);
      session.gates.set(id, gate);
    }

    const controller = new AbortController();
    controlWaitControllers.add(controller);
    response.once("close", () => {
      if (!response.writableEnded) controller.abort();
    });

    try {
      sendJson(response, 200, await waitForGate(gate, phase, controller.signal));
    } catch (error) {
      if (!response.destroyed)
        sendJson(response, 408, { error: error instanceof Error ? error.message : String(error) });
    } finally {
      controlWaitControllers.delete(controller);
    }

    return true;
  }

  if (request.method === "GET" && url.pathname === "/__fixture/subscription") {
    const id = url.searchParams.get("id") ?? "";
    let incarnation;

    try {
      incarnation = readSubscriptionIncarnation(url);
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });

      return true;
    }

    if (!id) {
      sendJson(response, 400, { error: "expected a nonempty subscription id" });

      return true;
    }

    sendJson(
      response,
      200,
      subscriptionSnapshot(session, getSubscription(session, id), incarnation),
    );

    return true;
  }

  if (request.method === "GET" && url.pathname === "/__fixture/wait-subscription") {
    const id = url.searchParams.get("id") ?? "";
    const phase = url.searchParams.get("phase") ?? "";
    let incarnation;
    const validPhases = new Set([
      "started",
      "finally",
      "emitted",
      "protocolComplete",
      "clientComplete",
      "socketClose",
    ]);

    try {
      incarnation = readSubscriptionIncarnation(url);
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });

      return true;
    }

    if (!id || !validPhases.has(phase)) {
      sendJson(response, 400, {
        error: "expected a nonempty subscription id and a supported phase",
      });

      return true;
    }

    const subscription = getSubscription(session, id);
    const controller = new AbortController();
    controlWaitControllers.add(controller);
    response.once("close", () => {
      if (!response.writableEnded) controller.abort();
    });

    try {
      const count = Number(url.searchParams.get("count") ?? "1");

      if (!Number.isSafeInteger(count) || count < 1)
        throw new Error("Invalid subscription phase count");

      sendJson(
        response,
        200,
        await waitForSubscription(
          session,
          subscription,
          phase,
          controller.signal,
          count,
          incarnation,
        ),
      );
    } catch (error) {
      if (!response.destroyed)
        sendJson(response, 408, { error: error instanceof Error ? error.message : String(error) });
    } finally {
      controlWaitControllers.delete(controller);
    }

    return true;
  }

  if (request.method === "POST" && url.pathname === "/__fixture/subscription-event") {
    const id = url.searchParams.get("id") ?? "";
    let incarnation;

    try {
      incarnation = readSubscriptionIncarnation(url);
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });

      return true;
    }

    let event;

    try {
      event = await readJsonRequest(request);
    } catch {
      sendJson(response, 400, { error: "expected a JSON subscription event" });

      return true;
    }

    if (
      !id ||
      !Number.isSafeInteger(event?.sequence) ||
      event.sequence < 0 ||
      typeof event.value !== "string" ||
      (event.broken !== undefined && typeof event.broken !== "boolean") ||
      (event.fatal !== undefined && typeof event.fatal !== "boolean")
    ) {
      sendJson(response, 400, { error: "expected a subscription id and typed event payload" });

      return true;
    }

    const subscription = getSubscription(session, id);
    const active = [...subscription.incarnations.values()].filter((state) => state.active);
    const target =
      incarnation === undefined ? active.at(-1) : subscription.incarnations.get(incarnation);

    if (!target?.active) {
      sendJson(response, 409, {
        error: `subscription ${id} is not active${incarnation === undefined ? "" : ` at incarnation ${incarnation}`}`,
      });

      return true;
    }

    queueSubscriptionCommand(target, { kind: "event", event });
    sendJson(response, 200, {
      accepted: true,
      id,
      incarnation: target.incarnation,
      sequence: event.sequence,
    });

    return true;
  }

  if (
    request.method === "POST" &&
    [
      "/__fixture/subscription-finish",
      "/__fixture/subscription-throw",
      "/__fixture/subscription-cancel",
    ].includes(url.pathname)
  ) {
    const id = url.searchParams.get("id") ?? "";
    let incarnation;

    try {
      incarnation = readSubscriptionIncarnation(url);
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });

      return true;
    }

    const subscription = id ? getSubscription(session, id) : undefined;
    const active = subscription
      ? [...subscription.incarnations.values()].filter((state) => state.active)
      : [];
    const target =
      incarnation === undefined ? active.at(-1) : subscription?.incarnations.get(incarnation);

    if (!target?.active) {
      sendJson(response, 409, {
        error: `subscription ${id || "<empty>"} is not active${incarnation === undefined ? "" : ` at incarnation ${incarnation}`}`,
      });

      return true;
    }

    const kind = url.pathname.endsWith("-finish")
      ? "finish"
      : url.pathname.endsWith("-throw")
        ? "throw"
        : "cancel";

    queueSubscriptionCommand(target, { kind });
    sendJson(response, 200, { accepted: true, id, incarnation: target.incarnation, command: kind });

    return true;
  }
  if (request.method === "POST" && url.pathname === "/__fixture/release") {
    const id = readGateId(url);

    if (!resolveGate(session.gates, id, `released:${id}`)) {
      sendJson(response, 409, { error: `gate ${id || "<empty>"} is not pending` });

      return true;
    }

    sendJson(response, 200, { released: true, gate: id });

    return true;
  }

  if (request.method === "POST" && url.pathname === "/__fixture/shutdown") {
    sendJson(response, 200, { shuttingDown: true, instanceId });
    response.once("finish", () => void shutdown());

    return true;
  }

  return false;
}

async function shutdown() {
  if (shuttingDown) return;

  shuttingDown = true;

  for (const controller of controlWaitControllers)
    controller.abort(new Error("Fixture is shutting down"));

  for (const session of sessions.values())
    for (const gate of session.gates.values())
      resolveGate(session.gates, gate.id, `released:${gate.id}`);

  const sessionsToClose = [...sessions.values()].filter((session) =>
    [...session.subscriptions.values()].some((subscription) =>
      [...subscription.incarnations.values()].some((incarnation) => incarnation.active),
    ),
  );
  const closeWaits = sessionsToClose.map(waitForSessionSocketsToClose);
  const disposal = disposeGraphQLWebSocketServer();
  let timeout;
  const closed = await Promise.race([
    Promise.all(closeWaits.map(({ promise }) => promise)).then(() => true),
    new Promise((resolve) => {
      timeout = setTimeout(() => resolve(false), 5_000);
    }),
  ]);

  if (timeout !== undefined) clearTimeout(timeout);

  if (!closed) {
    for (const socket of webSocketServer.clients) socket.terminate();

    await Promise.all(closeWaits.map(({ promise }) => promise));
  }

  for (const wait of closeWaits) wait.stop();

  for (const session of sessions.values()) {
    for (const subscription of session.subscriptions.values())
      for (const incarnation of subscription.incarnations.values())
        if (incarnation.active) queueSubscriptionCommand(incarnation, { kind: "cancel" });
  }

  await disposal;

  await new Promise((resolve) => server.close(resolve));
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${host}`);
  const routeControl = async () => {
    if (await handleControlRequest(request, response, url)) return;

    if (request.method === "POST" && url.pathname === "/__fixture/decode-error") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end('{"data":');

      return;
    }

    if (request.method === "POST" && url.pathname === "/__fixture/transport-error") {
      sendJson(response, 503, { error: "fixture transport failure" });

      return;
    }

    void Promise.resolve(yoga(request, response)).catch((error) => {
      if (!response.headersSent)
        sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
      else if (!response.destroyed) response.destroy(error instanceof Error ? error : undefined);
    });
  };

  void routeControl().catch((error) => {
    if (!response.headersSent)
      sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    else if (!response.destroyed) response.destroy(error instanceof Error ? error : undefined);
  });
});

const webSocketServer = new WebSocketServer({ server, path: "/graphql" });
const socketSessions = new WeakMap();
const socketOperations = new WeakMap();

webSocketServer.on("connection", (socket) => {
  socketOperations.set(socket, new Map());
  socket.once("close", () => {
    const session = socketSessions.get(socket);

    if (!session) return;

    session.socketClose += 1;

    for (const subscription of session.subscriptions.values())
      notifySubscription(session, subscription);
  });
  socket.on("message", (data) => {
    let message;

    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }

    if (message.type === "connection_init") {
      const sessionId = typeof message.payload?.session === "string" ? message.payload.session : "";
      let session = socketSessions.get(socket);

      if (!session) {
        session = getSession(sessionId);
        session.socketOpen += 1;
        socketSessions.set(socket, session);
      }

      return;
    }

    const session = socketSessions.get(socket);

    if (!session) return;

    const operations = socketOperations.get(socket);

    if (message.type === "subscribe") {
      const id = message.payload?.variables?.id;

      if (typeof id === "string") {
        getSubscription(session, id);
        operations.set(message.id, { id, incarnation: undefined });
      }

      return;
    }

    if (message.type === "complete") {
      const operation = operations.get(message.id);

      if (!operation) return;

      const subscription = getSubscription(session, operation.id);
      const incarnation =
        operation.incarnation === undefined
          ? undefined
          : subscription.incarnations.get(operation.incarnation);

      if (incarnation) {
        incarnation.clientComplete += 1;
        notifySubscription(session, subscription, incarnation);
      }

      operations.delete(message.id);
    }
  });
});

const enveloped = yoga.getEnveloped();
const graphqlWebSocket = useServer(
  {
    schema: enveloped.schema,
    parse: enveloped.parse,
    validate: enveloped.validate,
    execute: enveloped.execute,
    subscribe: enveloped.subscribe,
    context: async ({ connectionParams, extra }, operationId) => {
      const headers = new Headers(extra.request.headers);
      const sessionId =
        typeof connectionParams?.session === "string"
          ? connectionParams.session
          : (headers.get("x-fixture-session") ?? "");

      headers.set("x-fixture-session", sessionId);

      const request = new Request(new URL(extra.request.url ?? "/graphql", `http://${host}`), {
        headers,
      });
      const requestEnveloped = yoga.getEnveloped({ request });
      const yogaContext = await requestEnveloped.contextFactory();
      const operation = socketOperations.get(extra.socket)?.get(operationId);

      return { ...yogaContext, fixtureSubscriptionOperation: operation };
    },
    onNext(_context, _id, _payload, _args, result) {
      return withFixtureExtension(result);
    },
    onComplete(context, operationId) {
      if (!(operationId in context.subscriptions)) return;

      const operation = socketOperations.get(context.extra.socket)?.get(operationId);

      if (!operation || operation.incarnation === undefined) return;

      const session = socketSessions.get(context.extra.socket);

      if (!session) return;

      const subscription = getSubscription(session, operation.id);
      const incarnation = subscription.incarnations.get(operation.incarnation);

      if (!incarnation) return;

      incarnation.protocolComplete += 1;
      notifySubscription(session, subscription, incarnation);
    },
  },
  webSocketServer,
  0,
);

disposeGraphQLWebSocketServer = graphqlWebSocket.dispose;

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, host, resolve);
});

const address = server.address();

if (!address || typeof address === "string")
  throw new Error("Fixture server did not bind a TCP port");

graphqlWsUrl = `ws://${host}:${address.port}/graphql`;

process.stdout.write(
  `${JSON.stringify({
    type: "ready",
    host,
    port: address.port,
    instanceId,
    graphqlUrl: `http://${host}:${address.port}/graphql`,
    graphqlWsUrl,
    controlUrl: `http://${host}:${address.port}/__fixture`,
  })}\n`,
);

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
