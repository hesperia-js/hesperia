import { createServer, constants } from "node:http2";

const maxRequestBytes = 16 * 1024;
const closeTimeoutMs = 2_000;

const requestFrames = new Map([
  ["Q", "00000000030a0151"],
  ["M", "00000000030a014d"],
  ["F", "00000000030a0146"],
  ["D", "00000000030a0144"],
  ["U", "00000000030a0155"],
  ["S", "00000000030a0153"],
  ["E", "00000000030a0145"],
  ["C", "00000000030a0143"],
]);

const responseFrames = new Map([
  [0, "0000000000"],
  [7, "00000000020807"],
  [8, "00000000020808"],
  [9, "00000000020809"],
  [14, "0000000002080e"],
  [15, "0000000002080f"],
]);

const errorStatusDetails = encodeErrorStatusDetails();

/**
 * Start a loopback HTTP/2 peer that speaks the small gRPC wire profile used by
 * the native package consumer fixture.
 *
 * The peer records framed request and response bytes, metadata, and RST_STREAM
 * codes. Its expected request frames are constants from the fixture schema;
 * it does not use the Protobuf codec under test to decode or create messages.
 *
 * @returns A ready loopback endpoint, observations, bounded event waits, and
 *   an explicit server/session shutdown function.
 */
export async function startGrpcServerFixture() {
  const observations = {
    calls: [],
    events: [],
    serverErrors: [],
  };
  const eventRecords = new Map();
  const eventWaiters = new Map();
  const sessions = new Set();
  const state = { queryValue: 7 };
  const server = createServer();
  let nextCallId = 0;
  let closePromise;

  const recordEvent = (name, call) => {
    const event = {
      name,
      callId: call.id,
      path: call.path,
      requestLabel: call.requestLabel,
      closeCode: call.closeCode,
    };

    observations.events.push(event);

    if (!eventRecords.has(name)) eventRecords.set(name, event);

    for (const waiter of eventWaiters.get(name) ?? []) {
      clearTimeout(waiter.timer);
      waiter.resolve(event);
    }

    eventWaiters.delete(name);
  };

  const waitForEvent = (name, timeoutMs = closeTimeoutMs) => {
    const existing = eventRecords.get(name);

    if (existing) return Promise.resolve(existing);

    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(new TypeError("event timeout must be a positive finite number"));
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const waiters = eventWaiters.get(name);

          waiters?.delete(waiter);

          if (waiters?.size === 0) eventWaiters.delete(name);

          reject(new Error(`timed out waiting for server event ${name}`));
        }, timeoutMs),
      };
      const waiters = eventWaiters.get(name) ?? new Set();

      waiters.add(waiter);
      eventWaiters.set(name, waiters);
    });
  };

  server.on("error", (error) => observations.serverErrors.push(errorText(error)));
  server.on("sessionError", (error) => observations.serverErrors.push(errorText(error)));
  server.on("session", (session) => {
    sessions.add(session);
    session.once("close", () => sessions.delete(session));
    session.on("error", (error) => observations.serverErrors.push(errorText(error)));
  });
  server.on("stream", (stream, headers) => {
    const call = {
      id: ++nextCallId,
      http2StreamId: stream.id,
      path: headerValue(headers[":path"]),
      requestHeaders: plainHeaders(headers),
      requestFrames: [],
      requestError: undefined,
      requestLabel: undefined,
      responseHeaders: {},
      responseFrames: [],
      responseTrailers: {},
      closeCode: undefined,
      streamErrors: [],
      streamErrorEvents: [],
      pendingTrailers: undefined,
    };

    observations.calls.push(call);

    stream.on("error", (error) => {
      call.streamErrors.push(errorText(error));

      call.streamErrorEvents.push({
        code: error.code ?? null,
        rstCode: stream.rstCode,
        http2StreamId: stream.id,
      });
    });

    stream.once("close", () => {
      call.closeCode = stream.rstCode;

      if (call.requestLabel === "D") recordEvent("deadline-observed", call);
      if (call.requestLabel === "U") recordEvent("unary-cancelled", call);
      if (call.requestLabel === "C") recordEvent("stream-cancelled", call);
    });
    stream.on("wantTrailers", () => {
      if (call.pendingTrailers === undefined) {
        call.streamErrors.push("response ended without configured gRPC trailers");
        stream.close(constants.NGHTTP2_INTERNAL_ERROR);

        return;
      }

      call.responseTrailers = plainHeaders(call.pendingTrailers);
      stream.sendTrailers(call.pendingTrailers);
    });

    void readRequest(stream, call)
      .then(() => dispatch(stream, call, recordEvent, state))
      .catch((error) => {
        call.requestError = errorText(error);

        if (stream.destroyed || stream.headersSent) return;

        sendResponse(stream, call, "request-error", [], {
          "grpc-status": "3",
          "grpc-message": "invalid%20request",
        });
      });
  });

  try {
    await listenLoopback(server);
  } catch (error) {
    server.close();

    throw error;
  }

  const address = server.address();

  if (address === null || typeof address === "string") {
    server.close();

    throw new Error("HTTP/2 fixture did not bind a TCP loopback address");
  }

  const baseUrl = `http://127.0.0.1:${address.port}`;

  const close = () => {
    if (closePromise !== undefined) return closePromise;

    closePromise = closeServer(server, sessions, eventWaiters, observations);

    return closePromise;
  };

  return { baseUrl, observations, waitForEvent, close };
}

async function readRequest(stream, call) {
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk);

    totalBytes += bytes.length;

    if (totalBytes > maxRequestBytes) {
      call.requestError = `request body exceeded ${maxRequestBytes} bytes`;
      stream.close(constants.NGHTTP2_ENHANCE_YOUR_CALM);

      return;
    }

    chunks.push(bytes);
  }

  call.requestFrames = splitGrpcFrames(Buffer.concat(chunks));

  for (const [label, expectedFrame] of requestFrames) {
    if (call.requestFrames.length === 1 && call.requestFrames[0] === expectedFrame) {
      call.requestLabel = label;

      return;
    }
  }

  call.requestError = `unexpected request frames: ${call.requestFrames.join(",")}`;
}

async function dispatch(stream, call, recordEvent, state) {
  if (stream.destroyed) return;

  if (call.requestError !== undefined || call.requestLabel === undefined) {
    sendResponse(stream, call, "request-error", [], {
      "grpc-status": "3",
      "grpc-message": "invalid%20request",
    });

    return;
  }

  if (call.path === "/spec.ServiceAll/Unary") {
    await dispatchUnary(stream, call, recordEvent, state);

    return;
  }

  if (call.path === "/spec.ServiceAll/ServerStream") {
    dispatchServerStream(stream, call, recordEvent);

    return;
  }

  sendResponse(stream, call, "unknown-method", [], {
    "grpc-status": "12",
    "grpc-message": "unimplemented",
  });
}

async function dispatchUnary(stream, call, recordEvent, state) {
  switch (call.requestLabel) {
    case "Q": {
      sendResponse(stream, call, "Q", [responseFrames.get(state.queryValue)], {
        "grpc-status": "0",
        "x-fixture-trailer": "Q-trailer",
      });

      return;
    }
    case "M": {
      state.queryValue = 9;
      sendResponse(stream, call, "M", [responseFrames.get(8)], {
        "grpc-status": "0",
        "x-fixture-trailer": "M-trailer",
      });

      return;
    }
    case "F": {
      sendResponse(stream, call, "F", [], {
        "grpc-status": "7",
        "grpc-message": "permission%20denied",
        "grpc-status-details-bin": errorStatusDetails,
        "x-fixture-error-trailer": "F-trailer",
      });

      return;
    }
    case "D": {
      recordEvent("deadline-held", call);

      return;
    }
    case "U": {
      recordEvent("unary-held", call);

      return;
    }
    default: {
      sendResponse(stream, call, "unknown-unary", [], {
        "grpc-status": "12",
        "grpc-message": "unimplemented",
      });
    }
  }
}

function dispatchServerStream(stream, call, recordEvent) {
  switch (call.requestLabel) {
    case "S": {
      sendResponse(stream, call, "S", [responseFrames.get(7), responseFrames.get(0)], {
        "grpc-status": "0",
        "x-fixture-trailer": "S-trailer",
      });

      return;
    }
    case "E": {
      sendResponse(stream, call, "E", [responseFrames.get(14)], {
        "grpc-status": "7",
        "grpc-message": "stream%20denied",
        "x-fixture-error-trailer": "E-trailer",
      });

      return;
    }
    case "C": {
      beginResponse(stream, call, "C");
      writeFrame(stream, call, responseFrames.get(15));
      recordEvent("stream-held", call);

      return;
    }
    default: {
      sendResponse(stream, call, "unknown-stream", [], {
        "grpc-status": "12",
        "grpc-message": "unimplemented",
      });
    }
  }
}

function sendResponse(stream, call, phase, frames, trailers) {
  beginResponse(stream, call, phase);

  for (const frame of frames) writeFrame(stream, call, frame);

  call.pendingTrailers = trailers;
  stream.end();
}

function beginResponse(stream, call, phase) {
  const headers = {
    ":status": 200,
    "content-type": "application/grpc+proto",
    "x-fixture-header": `${phase}-header`,
  };

  call.responseHeaders = plainHeaders(headers);
  stream.respond(headers, { waitForTrailers: true });
}

function writeFrame(stream, call, frameHex) {
  if (frameHex === undefined) {
    throw new Error("fixture has no response frame for the requested value");
  }

  const frame = Buffer.from(frameHex, "hex");

  call.responseFrames.push(frame.toString("hex"));
  stream.write(frame);
}

function splitGrpcFrames(bytes) {
  const frames = [];
  let offset = 0;

  while (offset < bytes.length) {
    if (bytes.length - offset < 5) {
      throw new Error("incomplete gRPC envelope header");
    }

    const compressionFlag = bytes[offset];
    const messageLength = bytes.readUInt32BE(offset + 1);
    const end = offset + 5 + messageLength;

    if (compressionFlag !== 0)
      throw new Error("compressed gRPC requests are not in this fixture profile");

    if (end > bytes.length) throw new Error("incomplete gRPC envelope payload");

    frames.push(bytes.subarray(offset, end).toString("hex"));
    offset = end;
  }

  return frames;
}

function encodeErrorStatusDetails() {
  const typeUrl = Buffer.from("type.googleapis.com/google.protobuf.StringValue", "utf8");
  const detailValue = encodeBytesField(1, Buffer.from("permission-detail", "utf8"));
  const anyMessage = Buffer.concat([
    encodeBytesField(1, typeUrl),
    encodeBytesField(2, detailValue),
  ]);
  const status = Buffer.concat([
    encodeVarintField(1, 7),
    encodeBytesField(2, Buffer.from("permission denied", "utf8")),
    encodeBytesField(3, anyMessage),
  ]);

  return status.toString("base64");
}

function encodeVarintField(fieldNumber, value) {
  return Buffer.concat([encodeVarint(fieldNumber << 3), encodeVarint(value)]);
}

function encodeBytesField(fieldNumber, value) {
  return Buffer.concat([encodeVarint((fieldNumber << 3) | 2), encodeVarint(value.length), value]);
}

function encodeVarint(value) {
  const bytes = [];
  let remaining = value;

  while (remaining > 0x7f) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining = Math.floor(remaining / 0x80);
  }

  bytes.push(remaining);

  return Buffer.from(bytes);
}

function plainHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers)
      .filter(([name, value]) => !name.startsWith(":") && value !== undefined)
      .map(([name, value]) => [name.toLowerCase(), headerValue(value)]),
  );
}

function headerValue(value) {
  return Array.isArray(value) ? value.map(String).join(",") : String(value);
}

function errorText(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

async function listenLoopback(server) {
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
}

async function closeServer(server, sessions, eventWaiters, observations) {
  const retainedSessions = [...sessions];
  const sessionClosures = retainedSessions.map(
    (session) => new Promise((resolve) => session.once("close", resolve)),
  );
  const closed = new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });

  for (const session of sessions) {
    if (!session.destroyed && !session.closed) session.close();
  }

  let forced = false;

  try {
    await withTimeout(
      Promise.all([closed, ...sessionClosures]),
      closeTimeoutMs,
      "HTTP/2 fixture server or peer sessions did not close cleanly",
    );
  } catch (error) {
    forced = true;

    for (const session of sessions) {
      if (!session.destroyed) session.destroy();
    }

    try {
      await withTimeout(
        Promise.all([closed, ...sessionClosures]),
        closeTimeoutMs,
        "HTTP/2 fixture survived forced session cleanup",
      );
    } catch (closeError) {
      rejectEventWaiters(eventWaiters, closeError);

      throw new AggregateError([error, closeError], "HTTP/2 fixture cleanup failed");
    }
  }

  rejectEventWaiters(eventWaiters, new Error("HTTP/2 fixture closed before the requested event"));

  if (sessions.size !== 0) {
    throw new Error(`HTTP/2 fixture closed with ${sessions.size} retained peer sessions`);
  }

  if (observations.serverErrors.length > 0) {
    throw new Error(`HTTP/2 fixture server errors: ${observations.serverErrors.join("; ")}`);
  }

  if (forced) {
    throw new Error("HTTP/2 fixture required forced session destruction during cleanup");
  }
}

function rejectEventWaiters(eventWaiters, reason) {
  for (const waiters of eventWaiters.values()) {
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(reason);
    }
  }

  eventWaiters.clear();
}

async function withTimeout(promise, timeoutMs, message) {
  let timer;

  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
