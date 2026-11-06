import { isAbsolute, resolve } from "node:path";
import { compile } from "@hesperia/compiler";
import { createHost } from "../../packages/hosting/src/index.ts";
import { prepareBuild } from "../../packages/tooling/src/project.ts";
import {
  browserCssCoverageEnabled,
  captureBrowserCssPageRequest,
  createBrowserCssCoverageBuildPlugin,
  withBrowserCssCoverageFixtureBuild,
} from "../../scripts/ci/browser-css-coverage-preload.ts";
import { createBrowserCssStartupJournal } from "./fixture-startup-journal.ts";

interface NativeGraphQLReady {
  readonly origin: string;
  readonly controlUrl: string;
}

interface CapturedOutput {
  tail: string;
  error?: string;
}

interface NativeGraphQLFixture {
  readonly child: ReturnType<typeof Bun.spawn>;
  readonly stdout: CapturedOutput;
  readonly stderr: CapturedOutput;
  readonly ready: Promise<NativeGraphQLReady>;
  readonly stdoutDrained: Promise<void>;
  readonly stderrDrained: Promise<void>;
  origin?: string;
  controlUrl?: string;
  stopPromise?: Promise<void>;
}

const nativeGraphQLPrefix = "/__graphql-native";
const nativeGraphQLStartupTimeout = 15_000;
const nativeGraphQLExitTimeout = 5_000;
const nativeGraphQLOutputLimit = 16_384;
const nativeGraphQLPath = resolve(import.meta.dir, "../data/fixtures/graphql-server.fixture.mjs");

function captureOutput(output: CapturedOutput, text: string): void {
  output.tail = `${output.tail}${text}`.slice(-nativeGraphQLOutputLimit);
}

function drainProcessOutput(
  stream: ReadableStream<Uint8Array> | null,
  output: CapturedOutput,
  onText: (text: string) => void,
  onEnd: () => void,
): Promise<void> {
  if (!stream) {
    const error = "The native GraphQL child did not expose a piped output stream";
    output.error = error;
    onEnd();

    return Promise.resolve();
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();

  return (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) break;

        const text = decoder.decode(value, { stream: true });

        if (text) {
          captureOutput(output, text);
          onText(text);
        }
      }

      const remainder = decoder.decode();

      if (remainder) {
        captureOutput(output, remainder);
        onText(remainder);
      }

      onEnd();
    } catch (error) {
      output.error = error instanceof Error ? error.message : String(error);
      onEnd();
    } finally {
      reader.releaseLock();
    }
  })();
}

function fixtureDiagnostics(fixture: NativeGraphQLFixture): string {
  return [
    `stdout: ${fixture.stdout.tail || "<empty>"}`,
    fixture.stdout.error ? `stdout read error: ${fixture.stdout.error}` : undefined,
    `stderr: ${fixture.stderr.tail || "<empty>"}`,
    fixture.stderr.error ? `stderr read error: ${fixture.stderr.error}` : undefined,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function parseNativeGraphQLReady(line: string): NativeGraphQLReady {
  let value: unknown;

  try {
    value = JSON.parse(line);
  } catch (error) {
    throw new Error(`The native GraphQL fixture returned invalid readiness JSON: ${line}`, {
      cause: error,
    });
  }

  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("The native GraphQL fixture returned a non-object readiness record");

  const record = value as Record<string, unknown>;
  const host = record.host;
  const port = record.port;

  if (
    record.type !== "ready" ||
    host !== "127.0.0.1" ||
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    typeof record.instanceId !== "string" ||
    record.instanceId.length === 0 ||
    typeof record.graphqlUrl !== "string" ||
    typeof record.controlUrl !== "string"
  ) {
    throw new Error(`The native GraphQL fixture returned invalid readiness data: ${line}`);
  }

  const origin = `http://${host}:${port}`;
  let graphqlUrl: URL;
  let controlUrl: URL;

  try {
    graphqlUrl = new URL(record.graphqlUrl);
    controlUrl = new URL(record.controlUrl);
  } catch (error) {
    throw new Error(`The native GraphQL fixture returned invalid URLs: ${line}`, { cause: error });
  }

  if (
    graphqlUrl.origin !== origin ||
    graphqlUrl.pathname !== "/graphql" ||
    graphqlUrl.search !== "" ||
    graphqlUrl.hash !== "" ||
    controlUrl.origin !== origin ||
    controlUrl.pathname !== "/__fixture" ||
    controlUrl.search !== "" ||
    controlUrl.hash !== ""
  ) {
    throw new Error(`The native GraphQL fixture announced an unexpected origin: ${line}`);
  }

  return { origin, controlUrl: controlUrl.href };
}

function startNativeGraphQLFixture(): NativeGraphQLFixture {
  const nodeOverride = process.env.HESPERIA_GRAPHQL_NODE;

  if (nodeOverride !== undefined && !isAbsolute(nodeOverride))
    throw new Error(
      "HESPERIA_GRAPHQL_NODE must be an absolute Node 22.23.2 executable path when supplied",
    );

  const nodePath = nodeOverride ?? Bun.which("node");

  if (!nodePath) throw new Error("Node 22.23.2 was not found on PATH");

  const child = Bun.spawn([nodePath, nativeGraphQLPath], {
    cwd: resolve(import.meta.dir, "../.."),
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  const stdout: CapturedOutput = { tail: "" };
  const stderr: CapturedOutput = { tail: "" };
  let readySettled = false;
  let readyLine = "";
  let resolveReadyLine!: (line: string) => void;
  let rejectReadyLine!: (error: Error) => void;

  const readyLinePromise = new Promise<string>((resolveReady, rejectReady) => {
    resolveReadyLine = resolveReady;
    rejectReadyLine = rejectReady;
  });

  const rejectReady = (error: Error) => {
    if (readySettled) return;

    readySettled = true;
    rejectReadyLine(error);
  };

  const stdoutDrained = drainProcessOutput(
    child.stdout,
    stdout,
    (text) => {
      if (readySettled) return;

      readyLine += text;
      const newline = readyLine.indexOf("\n");

      if (newline >= 0 && newline <= nativeGraphQLOutputLimit) {
        readySettled = true;
        resolveReadyLine(readyLine.slice(0, newline).trimEnd());
      } else if (readyLine.length > nativeGraphQLOutputLimit) {
        rejectReady(new Error("The native GraphQL readiness line exceeded its size limit"));
      }
    },
    () => {
      rejectReady(new Error("The native GraphQL fixture closed stdout before readiness"));
    },
  );
  const stderrDrained = drainProcessOutput(
    child.stderr,
    stderr,
    () => undefined,
    () => undefined,
  );

  return {
    child,
    stdout,
    stderr,
    stdoutDrained,
    stderrDrained,
    ready: readyLinePromise.then(parseNativeGraphQLReady),
  };
}

async function waitForNativeGraphQLReady(
  fixture: NativeGraphQLFixture,
): Promise<NativeGraphQLReady> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const timeoutResult = new Promise<{ readonly kind: "timeout" }>((resolveTimeout) => {
    timeout = setTimeout(() => resolveTimeout({ kind: "timeout" }), nativeGraphQLStartupTimeout);
  });
  const readyResult = fixture.ready.then((ready) => ({ kind: "ready" as const, ready }));
  const exitResult = fixture.child.exited.then((status) => ({ kind: "exit" as const, status }));

  try {
    const result = await Promise.race([readyResult, exitResult, timeoutResult]);

    if (result.kind === "ready") return result.ready;

    if (result.kind === "exit")
      throw new Error(`The native GraphQL fixture exited before readiness (${result.status})`);

    throw new Error(
      `Timed out after ${nativeGraphQLStartupTimeout} ms waiting for native GraphQL readiness`,
    );
  } catch (error) {
    await waitForNativeGraphQLExit(fixture, 500);

    throw new Error(`Could not start the native GraphQL fixture.\n${fixtureDiagnostics(fixture)}`, {
      cause: error,
    });
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function waitForNativeGraphQLExit(
  fixture: NativeGraphQLFixture,
  timeoutMs: number,
): Promise<number | undefined> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const exitAndDrain = Promise.all([
    fixture.child.exited,
    fixture.stdoutDrained,
    fixture.stderrDrained,
  ]).then(([status]) => status);
  const timeoutResult = new Promise<undefined>((resolveTimeout) => {
    timeout = setTimeout(() => resolveTimeout(undefined), timeoutMs);
  });

  try {
    return await Promise.race([exitAndDrain, timeoutResult]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function stopNativeGraphQLFixture(fixture: NativeGraphQLFixture): Promise<void> {
  if (fixture.stopPromise) return fixture.stopPromise;

  fixture.stopPromise = (async () => {
    let shutdownFailure: string | undefined;

    if (fixture.controlUrl) {
      try {
        const response = await fetch(new URL(`${fixture.controlUrl}/shutdown`), {
          method: "POST",
          signal: AbortSignal.timeout(2_000),
        });

        const body = await response.text();

        if (!response.ok)
          throw new Error(`Native GraphQL shutdown returned ${response.status}: ${body}`);
      } catch (error) {
        shutdownFailure = error instanceof Error ? error.message : String(error);
        fixture.child.kill("SIGKILL");
      }
    } else {
      fixture.child.kill("SIGKILL");
    }

    const gracefulExit = await waitForNativeGraphQLExit(fixture, nativeGraphQLExitTimeout);

    if (gracefulExit !== undefined) {
      if (shutdownFailure) {
        process.stderr.write(
          `Native GraphQL shutdown request failed; child exited during cleanup: ${shutdownFailure}\n`,
        );
      }

      return;
    }

    shutdownFailure ??= [
      "Native GraphQL fixture did not exit",
      `within ${nativeGraphQLExitTimeout} ms after graceful shutdown`,
    ].join(" ");
    fixture.child.kill("SIGKILL");

    if ((await waitForNativeGraphQLExit(fixture, nativeGraphQLExitTimeout)) === undefined) {
      const shutdownDetail = shutdownFailure ? ` Shutdown issue: ${shutdownFailure}.` : "";
      const diagnostics = fixtureDiagnostics(fixture);

      throw new Error(
        [
          `Native GraphQL fixture cleanup is incomplete after forced termination.${shutdownDetail}`,
          diagnostics,
        ].join("\n"),
      );
    }

    if (fixture.controlUrl)
      process.stderr.write(
        `Native GraphQL fixture required forced termination after graceful shutdown: ${shutdownFailure}\n`,
      );
  })();

  return fixture.stopPromise;
}

async function proxyNativeGraphQL(request: Request, url: URL, fixture: NativeGraphQLFixture) {
  const origin = fixture.origin;

  if (!origin) return new Response("Native GraphQL fixture is unavailable", { status: 503 });

  const path = url.pathname.slice(nativeGraphQLPrefix.length);
  const target = new URL(`${path}${url.search}`, origin);

  if (!path.startsWith("/") || target.origin !== origin)
    return new Response("Invalid native GraphQL proxy target", { status: 400 });

  const headers = new Headers(request.headers);

  for (const name of [
    "connection",
    "host",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ])
    headers.delete(name);

  const response = await fetch(target, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    signal: request.signal,
    redirect: "manual",
  });

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

const startupJournal = createBrowserCssStartupJournal("fixture-server");

startupJournal.mark("fixture-body-enter");

const browserCoverageBuildPlugin = createBrowserCssCoverageBuildPlugin();

startupJournal.mark("initial-build-begin");

const built = await Bun.build({
  entrypoints: [
    resolve(import.meta.dir, "fixtures/entry.fixture.mts"),
    resolve(import.meta.dir, "fixtures/raw.fixture.mts"),
    resolve(import.meta.dir, "fixtures/structure.fixture.mts"),
    resolve(import.meta.dir, "fixtures/async.fixture.mts"),
    resolve(import.meta.dir, "fixtures/native.fixture.mts"),
    resolve(import.meta.dir, "fixtures/event-options-cache.fixture.mts"),
    resolve(import.meta.dir, "fixtures/props.fixture.mts"),
    resolve(import.meta.dir, "fixtures/functions.fixture.mts"),
    resolve(import.meta.dir, "fixtures/document.fixture.mts"),
    resolve(import.meta.dir, "fixtures/route-host.fixture.mts"),
    resolve(import.meta.dir, "fixtures/blob-attributes.fixture.mts"),
    resolve(import.meta.dir, "fixtures/css-runtime.fixture.mts"),
    resolve(import.meta.dir, "fixtures/error-boundary.fixture.mts"),
    resolve(import.meta.dir, "fixtures/stream.fixture.mts"),
    resolve(import.meta.dir, "fixtures/embed.fixture.mts"),
    resolve(import.meta.dir, "fixtures/graphql.fixture.mts"),
  ],
  target: "browser",
  format: "esm",
  sourcemap: "inline",
  plugins: [
    {
      name: "hesperia-browser-fixtures",

      setup(builder) {
        builder.onLoad({ filter: /\.tsx$/u }, async ({ path }) => {
          const result = await compile(await Bun.file(path).text(), {
            filename: path,
            allowUnsafeHTML: path.endsWith("Structure.tsx"),
            documentShell: path.endsWith("AppShell.tsx"),
          });

          if (result.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
            throw new Error(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
          }

          return { contents: result.code, loader: "js" };
        });
      },
    },
    ...(browserCoverageBuildPlugin ? [browserCoverageBuildPlugin] : []),
  ],
});

startupJournal.mark("initial-build-end", { success: built.success, outputs: built.outputs.length });

if (!built.success) throw new AggregateError(built.logs, "Browser fixture compilation failed");

const output = built.outputs.find(
  (artifact) => artifact.kind === "entry-point" && artifact.path.endsWith("entry.fixture.js"),
);
const rawOutput = built.outputs.find(
  (artifact) => artifact.kind === "entry-point" && artifact.path.endsWith("raw.fixture.js"),
);
const structureOutput = built.outputs.find(
  (artifact) => artifact.kind === "entry-point" && artifact.path.endsWith("structure.fixture.js"),
);
const asyncOutput = built.outputs.find(
  (artifact) => artifact.kind === "entry-point" && artifact.path.endsWith("async.fixture.js"),
);
const nativeOutput = built.outputs.find(
  (artifact) => artifact.kind === "entry-point" && artifact.path.endsWith("native.fixture.js"),
);
const eventOptionsCacheOutput = built.outputs.find(
  (artifact) =>
    artifact.kind === "entry-point" && artifact.path.endsWith("event-options-cache.fixture.js"),
);
const propsOutput = built.outputs.find(
  (artifact) => artifact.kind === "entry-point" && artifact.path.endsWith("props.fixture.js"),
);
const functionsOutput = built.outputs.find(
  (artifact) => artifact.kind === "entry-point" && artifact.path.endsWith("functions.fixture.js"),
);
const documentOutput = built.outputs.find(
  (artifact) => artifact.kind === "entry-point" && artifact.path.endsWith("document.fixture.js"),
);
const routeHostOutput = built.outputs.find(
  (artifact) => artifact.kind === "entry-point" && artifact.path.endsWith("route-host.fixture.js"),
);
const blobAttributesOutput = built.outputs.find(
  (artifact) =>
    artifact.kind === "entry-point" && artifact.path.endsWith("blob-attributes.fixture.js"),
);
const cssRuntimeOutput = built.outputs.find(
  (artifact) => artifact.kind === "entry-point" && artifact.path.endsWith("css-runtime.fixture.js"),
);
const errorBoundaryOutput = built.outputs.find(
  (artifact) =>
    artifact.kind === "entry-point" && artifact.path.endsWith("error-boundary.fixture.js"),
);
const streamOutput = built.outputs.find(
  (artifact) => artifact.kind === "entry-point" && artifact.path.endsWith("stream.fixture.js"),
);
const embedOutput = built.outputs.find(
  (artifact) => artifact.kind === "entry-point" && artifact.path.endsWith("embed.fixture.js"),
);

const graphqlOutput = built.outputs.find(
  (artifact) => artifact.kind === "entry-point" && artifact.path.endsWith("graphql.fixture.js"),
);

if (
  !output ||
  !rawOutput ||
  !structureOutput ||
  !asyncOutput ||
  !nativeOutput ||
  !eventOptionsCacheOutput ||
  !propsOutput ||
  !functionsOutput ||
  !documentOutput ||
  !routeHostOutput ||
  !blobAttributesOutput ||
  !cssRuntimeOutput ||
  !errorBoundaryOutput ||
  !streamOutput ||
  !embedOutput ||
  !graphqlOutput
)
  throw new Error("The browser fixture build produced no entry point");

const importedMarkupRoot = resolve(import.meta.dir, "fixtures/imported-markup");

startupJournal.mark("markup-prepare-begin");

const importedMarkupBuild = await withBrowserCssCoverageFixtureBuild(importedMarkupRoot, () =>
  prepareBuild(importedMarkupRoot),
);

startupJournal.mark("markup-prepare-end");
const importedMarkupFiles = new Map(
  importedMarkupBuild.hosting.assets.map((asset) => {
    const file = importedMarkupBuild.files.get(asset.path);

    if (!file) throw new Error(`Missing imported markup browser asset ${asset.path}`);

    return [asset.path, file] as const;
  }),
);
startupJournal.mark("host-create-begin");

const importedMarkupHost = await createHost({
  hosting: importedMarkupBuild.hosting,
  files: importedMarkupFiles,
});

startupJournal.mark("host-create-end");

const browserPort = Number.parseInt(process.env.HESPERIA_BROWSER_PORT ?? "4178", 10);

if (!Number.isInteger(browserPort) || browserPort < 1 || browserPort > 65535)
  throw new Error("HESPERIA_BROWSER_PORT must be a valid TCP port");

let startupHealthRecorded = false;
let nativeGraphQLFixture: NativeGraphQLFixture | undefined;
let browserServer: ReturnType<typeof Bun.serve> | undefined;
let shutdownPromise: Promise<void> | undefined;

async function stopBrowserServer(): Promise<void> {
  if (!browserServer) return;

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const stop = Promise.resolve(browserServer.stop(true)).then(() => true);
  const timeoutResult = new Promise<false>((resolveTimeout) => {
    timeout = setTimeout(() => resolveTimeout(false), 1_000);
  });

  try {
    if (!(await Promise.race([stop, timeoutResult])))
      throw new Error("The browser fixture server did not stop within 1000 ms");
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function shutdownBrowserFixture(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;

  shutdownPromise = (async () => {
    const errors: unknown[] = [];

    try {
      await stopBrowserServer();
    } catch (error) {
      errors.push(error);
    }

    try {
      if (nativeGraphQLFixture) await stopNativeGraphQLFixture(nativeGraphQLFixture);
    } catch (error) {
      errors.push(error);
    }

    if (errors.length === 1) throw errors[0];
    if (errors.length > 1)
      throw new AggregateError(errors, "Browser fixture cleanup was incomplete");
  })();

  return shutdownPromise;
}

function handleBrowserFixtureSignal(signal: "SIGINT" | "SIGTERM"): void {
  void shutdownBrowserFixture().catch((error) => {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);

    process.stderr.write(`Browser fixture ${signal} cleanup failed:\n${detail}\n`);
    process.exitCode = 1;
  });
}

async function initializeNativeGraphQLFixture(): Promise<{
  readonly fixture: NativeGraphQLFixture;
  readonly ready: NativeGraphQLReady;
}> {
  const fixture = startNativeGraphQLFixture();
  nativeGraphQLFixture = fixture;
  const ready = await waitForNativeGraphQLReady(fixture);

  return { fixture, ready };
}

async function failBrowserFixtureSetup(error: unknown): Promise<never> {
  try {
    await shutdownBrowserFixture();
  } catch (cleanupError) {
    throw new AggregateError(
      [error, cleanupError],
      "Browser fixture setup failed and native GraphQL cleanup was incomplete",
    );
  }

  throw error;
}

process.once("SIGINT", () => handleBrowserFixtureSignal("SIGINT"));
process.once("SIGTERM", () => handleBrowserFixtureSignal("SIGTERM"));

startupJournal.mark("serve-begin");

startupJournal.mark("native-graphql-ready-begin");

const initializedNativeGraphQLFixture = await initializeNativeGraphQLFixture().catch((error) => {
  return failBrowserFixtureSetup(error);
});
const { fixture: activeNativeGraphQLFixture, ready: nativeGraphQLReady } =
  initializedNativeGraphQLFixture;

startupJournal.mark("native-graphql-ready-end", { origin: nativeGraphQLReady.origin });

if (shutdownPromise)
  await failBrowserFixtureSetup(new Error("Browser fixture shutdown began during GraphQL startup"));

activeNativeGraphQLFixture.origin = nativeGraphQLReady.origin;
activeNativeGraphQLFixture.controlUrl = nativeGraphQLReady.controlUrl;

const browserServerOptions = {
  hostname: "127.0.0.1",
  port: browserPort,

  fetch(request: Request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/health") {
      if (!startupHealthRecorded) {
        startupHealthRecorded = true;

        startupJournal.mark("first-health-request", { method: request.method });
        startupJournal.finish();
      }

      return new Response("ready");
    }

    if (path === nativeGraphQLPrefix || path.startsWith(`${nativeGraphQLPrefix}/`)) {
      const fixture = nativeGraphQLFixture;

      if (!fixture) return new Response("Native GraphQL fixture is unavailable", { status: 503 });

      return proxyNativeGraphQL(request, url, fixture);
    }

    if (path === "/__coverage/browser-css-page") {
      if (!browserCssCoverageEnabled) return new Response("Not found", { status: 404 });

      return captureBrowserCssPageRequest(request);
    }

    if (path === "/" && url.searchParams.has("importedMarkup")) {
      return importedMarkupHost.handle(request) ?? new Response(null, { status: 404 });
    }

    if (path.startsWith("/_hesperia/"))
      return importedMarkupHost.handle(request) ?? new Response(null, { status: 404 });

    const importedMarkupFile = importedMarkupBuild.files.get(path);

    if (importedMarkupFile) {
      const hostedAsset = importedMarkupBuild.hosting.assets.find((asset) => asset.path === path);
      const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
      const contentType =
        hostedAsset?.contentType ||
        importedMarkupFile.type ||
        new Map([
          [".js", "text/javascript"],
          [".css", "text/css"],
          [".json", "application/json"],
          [".png", "image/png"],
          [".svg", "image/svg+xml"],
          [".jpg", "image/jpeg"],
          [".jpeg", "image/jpeg"],
          [".gif", "image/gif"],
          [".webp", "image/webp"],
          [".woff2", "font/woff2"],
        ]).get(extension) ||
        "application/octet-stream";
      return new Response(importedMarkupFile, { headers: { "content-type": contentType } });
    }

    if (path === "/css/imported-markup.css")
      return new Response(".markup-panel { color: rgb(70, 80, 90); }", {
        headers: { "content-type": "text/css" },
      });

    if (path === "/css/imported-markup-print.css")
      return new Response(".markup-panel { border-top: 7px solid rgb(2, 3, 4); }", {
        headers: { "content-type": "text/css" },
      });

    if (path === "/css/imported-markup-disabled.css")
      return new Response(".markup-panel { border-bottom: 9px solid rgb(2, 3, 4); }", {
        headers: { "content-type": "text/css" },
      });

    if (path === "/css/imported-markup-alternate.css")
      return new Response(".markup-panel { letter-spacing: 13px; }", {
        headers: { "content-type": "text/css" },
      });

    if (path === "/css/imported-native-sri-failure.css")
      return new Response(
        ".markup-panel { text-indent: 23px; } .managed-bad-sri-target { color: rgb(255, 1, 2); }",
        { headers: { "content-type": "text/css" } },
      );

    if (path === "/embed-browser.js")
      return new Response(embedOutput, { headers: { "content-type": "text/javascript" } });

    if (path === "/embed-browser")
      return new Response(
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Embed browser proof</title></head><body><div id="app"></div><script type="module" src="/embed-browser.js"></script></body></html>',
        { headers: { "content-type": "text/html" } },
      );

    if (path === "/css-runtime.js")
      return new Response(cssRuntimeOutput, { headers: { "content-type": "text/javascript" } });

    if (path === "/css/red.css")
      return new Response(
        ".css-red-node { color: rgb(220, 0, 0); } .order-node { color: rgb(220, 0, 0); }",
        {
          headers: { "content-type": "text/css" },
        },
      );

    if (path === "/css/blue.css")
      return new Response(
        ".css-blue-node { color: rgb(0, 0, 220); } .order-node { color: rgb(0, 0, 220); }",
        {
          headers: { "content-type": "text/css" },
        },
      );

    if (path === "/css/red-next.css")
      return new Response(".css-red-node { color: rgb(0, 180, 0); }", {
        headers: { "content-type": "text/css" },
      });

    if (path === "/css/document.css")
      return new Response(".css-document-node { color: rgb(80, 0, 160); }", {
        headers: { "content-type": "text/css" },
      });

    if (path === "/css-runtime")
      return new Response(
        '<!doctype html><html><head><title>CSS runtime</title></head><body><div id="first-target"><i id="existing-element">existing</i>existing text</div><div id="second-target"></div><div id="blue-target"></div><div id="nested-target"></div><div id="conditional-target"></div><div id="ordered-target"></div><script type="module" src="/css-runtime.js"></script></body></html>',
        { headers: { "content-type": "text/html" } },
      );

    if (path === "/blob-attributes-browser.js")
      return new Response(blobAttributesOutput, { headers: { "content-type": "text/javascript" } });

    if (path === "/blob-attributes-cache")
      return new Response(
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Blob route cache</title></head><body><div id="app"></div><script type="module" src="/blob-attributes-browser.js"></script></body></html>',
        { headers: { "content-type": "text/html" } },
      );

    if (path === "/stream.js")
      return new Response(streamOutput, { headers: { "content-type": "text/javascript" } });

    if (path === "/stream")
      return new Response(
        '<!doctype html><html><head><title>Shared streams</title></head><body><div id="app"></div><script type="module" src="/stream.js"></script></body></html>',
        { headers: { "content-type": "text/html" } },
      );

    if (path === "/error-boundary.js")
      return new Response(errorBoundaryOutput, { headers: { "content-type": "text/javascript" } });

    if (path === "/error-boundary")
      return new Response(
        '<!doctype html><html><head><title>Error boundaries</title></head><body><div id="app"></div><script type="module" src="/error-boundary.js"></script></body></html>',
        { headers: { "content-type": "text/html" } },
      );

    if (path === "/route-host.js")
      return new Response(routeHostOutput, { headers: { "content-type": "text/javascript" } });

    if (path === "/route-host")
      return new Response(
        '<!doctype html><html><head><title>Persistent route layouts</title></head><body><div id="app"></div><script type="module" src="/route-host.js"></script></body></html>',
        { headers: { "content-type": "text/html" } },
      );

    if (path === "/document.js")
      return new Response(documentOutput, { headers: { "content-type": "text/javascript" } });

    if (path === "/graphql.js")
      return new Response(graphqlOutput, { headers: { "content-type": "text/javascript" } });

    if (path === "/graphql")
      return new Response(
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Native GraphQL</title></head><body><div id="app"></div><script type="module" src="/graphql.js"></script></body></html>',
        { headers: { "content-type": "text/html" } },
      );

    if (path === "/document")
      return new Response(
        '<!doctype html><html><head><title>Bootstrap shell</title></head><body><script type="module" src="/document.js"></script></body></html>',
        { headers: { "content-type": "text/html" } },
      );

    if (path === "/functions.js")
      return new Response(functionsOutput, { headers: { "content-type": "text/javascript" } });

    if (path === "/functions")
      return new Response(
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Function components</title></head><body><div id="app"></div><script type="module" src="/functions.js"></script></body></html>',
        { headers: { "content-type": "text/html" } },
      );

    if (path === "/props.js")
      return new Response(propsOutput, { headers: { "content-type": "text/javascript" } });

    if (path === "/props")
      return new Response(
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Component prop fixture</title></head><body><div id="app"></div><script type="module" src="/props.js"></script></body></html>',
        { headers: { "content-type": "text/html" } },
      );

    if (path === "/app.js")
      return new Response(output, { headers: { "content-type": "text/javascript" } });

    if (path === "/raw.js")
      return new Response(rawOutput, { headers: { "content-type": "text/javascript" } });

    if (path === "/structure.js")
      return new Response(structureOutput, { headers: { "content-type": "text/javascript" } });

    if (path === "/async.js")
      return new Response(asyncOutput, { headers: { "content-type": "text/javascript" } });

    if (path === "/native.js")
      return new Response(nativeOutput, { headers: { "content-type": "text/javascript" } });

    if (path === "/native")
      return new Response(
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Native binding fixture</title></head><body><div id="app"></div><script type="module" src="/native.js"></script></body></html>',
        { headers: { "content-type": "text/html" } },
      );

    if (path === "/event-options-cache.js")
      return new Response(eventOptionsCacheOutput, {
        headers: { "content-type": "text/javascript" },
      });

    if (path === "/event-options-cache")
      return new Response(
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Cached event options</title></head><body><div id="app"></div><script type="module" src="/event-options-cache.js"></script></body></html>',
        { headers: { "content-type": "text/html" } },
      );

    if (path === "/raw")
      return new Response(
        '<!doctype html><html><head><meta charset="utf-8"><title>Raw HTML runtime fixture</title></head><body><div id="app"></div><script type="module" src="/raw.js"></script></body></html>',
        {
          headers: {
            "content-type": "text/html",
            ...(url.searchParams.has("trusted")
              ? {
                  "content-security-policy":
                    "require-trusted-types-for 'script'; trusted-types hesperia-test",
                }
              : {}),
          },
        },
      );

    if (path === "/structure")
      return new Response(
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Compiled structure fixture</title></head><body><div id="app"></div><button id="remove">Remove application</button><script type="module" src="/structure.js"></script></body></html>',
        { headers: { "content-type": "text/html" } },
      );

    if (path === "/async")
      return new Response(
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Compiled async fixture</title></head><body><div id="async-app"></div><div id="independent-app"></div><script type="module" src="/async.js"></script></body></html>',
        { headers: { "content-type": "text/html" } },
      );

    return new Response(
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Compiled Hesperia fixture</title></head><body><div id="app"></div><button id="remove">Remove application</button><script type="module" src="/app.js"></script></body></html>',
      {
        headers: { "content-type": "text/html" },
      },
    );
  },
};

try {
  browserServer = Bun.serve(browserServerOptions);
  startupJournal.mark("serve-return");
} catch (error) {
  await failBrowserFixtureSetup(error);
}
