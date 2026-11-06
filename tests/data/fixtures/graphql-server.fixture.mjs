import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { buildSchema } from "graphql";
import { createYoga } from "graphql-yoga";

if (process.versions.node !== "22.23.2")
  throw new Error(`Expected Node 22.23.2; received ${process.versions.node}`);

const host = "127.0.0.1";
const instanceId = randomUUID();
const sessions = new Map();
const controlWaitControllers = new Set();
let shuttingDown = false;

function createSession() {
  return {
    state: { revision: 0, writes: [] },
    resolverCalls: { echo: 0, contextEcho: 0, state: 0 },
    gates: new Map(),
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
        setResult({
          ...result,
          extensions: {
            ...result.extensions,
            fixture: { instanceId },
          },
        });
      },
    },
  ],
  schema,
});

function sendJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

function readGateId(url) {
  return url.searchParams.get("gate") ?? "";
}

async function handleControlRequest(request, response, url) {
  const session = getSession(url.searchParams.get("session") ?? "");

  if (request.method === "GET" && url.pathname === "/__fixture/state") {
    sendJson(response, 200, {
      instanceId,
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

  for (const session of sessions.values()) {
    for (const gate of session.gates.values())
      resolveGate(session.gates, gate.id, `released:${gate.id}`);
  }

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

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, host, resolve);
});

const address = server.address();

if (!address || typeof address === "string")
  throw new Error("Fixture server did not bind a TCP port");

process.stdout.write(
  `${JSON.stringify({
    type: "ready",
    host,
    port: address.port,
    instanceId,
    graphqlUrl: `http://${host}:${address.port}/graphql`,
    controlUrl: `http://${host}:${address.port}/__fixture`,
  })}\n`,
);

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
