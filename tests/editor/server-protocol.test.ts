import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createConnection,
  createProtocolConnection,
  DefinitionRequest,
  DiagnosticSeverity,
  CompletionRequest,
  DocumentSymbolRequest,
  HoverRequest,
  InitializeRequest,
  PublishDiagnosticsNotification,
  StreamMessageReader,
  StreamMessageWriter,
  type PublishDiagnosticsParams,
} from "vscode-languageserver/node";
import type { ProjectCheckingResult } from "@hesperia/compiler/editor";
import type { Hover } from "../../packages/language-server/src/project.ts";
import { startLanguageServer } from "../../packages/language-server/src/server.ts";

test("language server handles unsaved diagnostics and navigation over an in-process protocol", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-language-server-protocol-"));
  const cleanupPath = resolve(root);
  const cleanupRelative = relative(resolve(tmpdir()), cleanupPath);

  if (
    isAbsolute(cleanupRelative) ||
    !cleanupRelative.startsWith("hesperia-language-server-protocol-") ||
    cleanupRelative.includes("/") ||
    cleanupRelative.includes("\\")
  )
    throw new Error("Invalid test cleanup path");

  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();
  const serverConnection = createConnection(
    new StreamMessageReader(clientToServer),
    new StreamMessageWriter(serverToClient),
  );
  const clientConnection = createProtocolConnection(serverToClient, clientToServer);
  const events: PublishDiagnosticsParams[] = [];
  const waiters = new Set<() => void>();

  clientConnection.onNotification(PublishDiagnosticsNotification.type, (value) => {
    events.push(value);

    for (const notify of waiters) notify();
  });

  await mkdir(join(root, "src"));

  await writeFile(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ESNext",
        module: "ESNext",
        moduleResolution: "Bundler",
        lib: ["ESNext", "DOM"],
        strict: true,
        skipLibCheck: true,
        types: [],
        paths: {
          hesperia: [resolve("packages/hesperia/dist/index.d.ts")],
          "hesperia/*": [resolve("packages/hesperia/dist/*")],
        },
      },
    }),
  );

  const filename = join(root, "src/App.tsx");
  const configurationFilename = join(root, "hesperia.config.json");
  const configurationUri = pathToFileURL(configurationFilename).href;

  await writeFile(configurationFilename, "");

  const uri = pathToFileURL(filename).href;
  const source =
    'export function App(){\n const value: string = "ok";\n return <div>{value.missing}</div>;\n}';
  const corrected = source.replace("value.missing", "value");

  await writeFile(filename, "export const diskVersion = true;");

  function diagnostics(version: number): Promise<PublishDiagnosticsParams> {
    return new Promise((accept, reject) => {
      const timeout = setTimeout(() => {
        waiters.delete(check);

        reject(new Error(`No diagnostics for version ${version}`));
      }, 10000);

      function check(): void {
        const result = events.find((event) => event.uri === uri && event.version === version);

        if (!result) return;

        clearTimeout(timeout);

        waiters.delete(check);

        accept(result);
      }

      waiters.add(check);

      check();
    });
  }

  startLanguageServer(serverConnection);

  clientConnection.listen();

  try {
    const initialized = await clientConnection.sendRequest(InitializeRequest.type, {
      processId: process.pid,
      rootUri: pathToFileURL(root).href,
      capabilities: {},
    });

    expect(initialized.capabilities.hoverProvider).toBe(true);

    expect(initialized.capabilities.documentSymbolProvider).toBe(true);

    expect(initialized.capabilities.completionProvider?.triggerCharacters).toContain(":");

    await clientConnection.sendNotification("initialized", {});

    await clientConnection.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId: "hesperia-tsx", version: 1, text: source },
    });

    const broken = await diagnostics(1);
    const symbols = await clientConnection.sendRequest(DocumentSymbolRequest.type, {
      textDocument: { uri },
    });

    expect(symbols?.map((symbol) => symbol.name)).toStrictEqual(["App"]);

    const configurationError = events.find((event) => event.uri === configurationUri);

    expect(configurationError?.diagnostics[0]?.code).toBe("HES-CONFIG");

    expect(configurationError?.diagnostics[0]?.message).toContain("default configuration");

    const missing = broken.diagnostics.find((item) => item.code === "TS2339");

    expect(missing?.message).toContain("missing");

    const target = {
      textDocument: { uri },
      position: { line: 2, character: " return <div>{value".length },
    };

    expect(JSON.stringify(await clientConnection.sendRequest(HoverRequest.type, target))).toContain(
      "string",
    );

    const definition = await clientConnection.sendRequest(DefinitionRequest.type, {
      ...target,
      position: { line: 2, character: " return <div>{".length },
    });

    expect(definition).toStrictEqual([
      {
        uri,
        range: {
          start: { line: 1, character: " const ".length },
          end: { line: 1, character: " const value".length },
        },
      },
    ]);

    const completions = await clientConnection.sendRequest(CompletionRequest.type, target);

    expect(completions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "value", insertText: "value" }),
        expect.objectContaining({ label: "document", insertText: "document" }),
      ]),
    );

    await clientConnection.sendNotification("textDocument/didChange", {
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: corrected }],
    });

    expect((await diagnostics(2)).diagnostics).toStrictEqual([]);

    await writeFile(configurationFilename, "{}");

    await clientConnection.sendNotification("workspace/didChangeWatchedFiles", {
      changes: [{ uri: configurationUri, type: 2 }],
    });

    await clientConnection.sendRequest(HoverRequest.type, target);

    expect(
      events.filter((event) => event.uri === configurationUri).at(-1)?.diagnostics,
    ).toStrictEqual([]);

    await writeFile(configurationFilename, '{"allowUnsafeHTML":');

    await clientConnection.sendNotification("workspace/didChangeWatchedFiles", {
      changes: [{ uri: configurationUri, type: 2 }],
    });

    const retained = await clientConnection.sendRequest(DefinitionRequest.type, {
      ...target,
      position: { line: 2, character: " return <div>{".length },
    });

    expect(retained).toStrictEqual(definition);

    expect(
      events.filter((event) => event.uri === configurationUri).at(-1)?.diagnostics[0]?.message,
    ).toContain("last valid configuration");

    expect(await clientConnection.sendRequest("shutdown")).toBeNull();

    await clientConnection.sendNotification("exit");
  } finally {
    clientConnection.dispose();

    serverConnection.dispose();

    clientToServer.destroy();

    serverToClient.destroy();

    await rm(cleanupPath, { recursive: true, force: true });
  }
}, 45000);

test("language server maps imported markup definitions from the current unsaved worker snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-language-server-markup-map-"));

  await mkdir(join(root, "src"));

  const appFilename = join(root, "app.tsx");
  const panelFilename = join(root, "src/Panel.html");
  const appUri = pathToFileURL(appFilename).href;
  const panelUri = pathToFileURL(panelFilename).href;
  const appSource =
    'import Panel from "./src/Panel.html" with { type: "html" };\nexport default function App() { return <html><head></head><body><Panel /></body></html>; }';
  const diskMarkup = "<section>disk version</section>";
  const markup = '\r\n<!--🐈--><button data-r06-editor="current">Editor version</button>\r\n';

  await writeFile(appFilename, appSource);

  await writeFile(panelFilename, diskMarkup);

  await writeMarkupWorkerProjectConfig(root);

  const streams = createProtocolHarness();

  startLanguageServer(streams.serverConnection);

  streams.serverStarted = true;

  try {
    await streams.clientConnection.sendRequest(InitializeRequest.type, {
      processId: process.pid,
      rootUri: pathToFileURL(root).href,
      capabilities: {},
    });

    await streams.clientConnection.sendNotification("initialized", {});

    await streams.clientConnection.sendNotification("textDocument/didOpen", {
      textDocument: { uri: appUri, languageId: "typescriptreact", version: 1, text: appSource },
    });

    await streams.clientConnection.sendNotification("textDocument/didOpen", {
      textDocument: { uri: panelUri, languageId: "html", version: 1, text: markup },
    });

    const appDiagnostics = await streams.diagnostics(appUri, 1);

    expect(
      appDiagnostics.diagnostics.filter((item) => item.severity === DiagnosticSeverity.Error),
    ).toStrictEqual([]);

    const offset = appSource.indexOf("<Panel") + 1;
    const definition = await streams.clientConnection.sendRequest(DefinitionRequest.type, {
      textDocument: { uri: appUri },
      position: protocolPosition(appSource, offset),
    });
    const originalStart = markup.indexOf("button");

    expect(definition).toStrictEqual([
      {
        uri: panelUri,
        range: {
          start: protocolPosition(markup, originalStart),
          end: protocolPosition(markup, originalStart + "button".length),
        },
      },
    ]);

    expect(streams.events.some((event) => event.uri === panelUri)).toBe(false);
  } finally {
    await stopProtocolHarness(streams);

    await rm(root, { recursive: true, force: true });
  }
}, 45000);

test("imported SVG diagnostics name the asset without inventing a source span", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-language-server-svg-origin-"));

  await mkdir(join(root, "src"));

  const appFilename = join(root, "app.tsx");
  const svgFilename = join(root, "src/Broken.svg");
  const appUri = pathToFileURL(appFilename).href;
  const svgUri = pathToFileURL(svgFilename).href;
  const appSource =
    'import Broken from "./src/Broken.svg" with { type: "svg" };\nexport const imported = Broken;';
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><g></svg>';

  await writeFile(appFilename, appSource);

  await writeFile(svgFilename, svg);

  await writeMarkupWorkerProjectConfig(root);

  const streams = createProtocolHarness();

  startLanguageServer(streams.serverConnection);

  streams.serverStarted = true;

  try {
    await streams.clientConnection.sendRequest(InitializeRequest.type, {
      processId: process.pid,
      rootUri: pathToFileURL(root).href,
      capabilities: {},
    });

    await streams.clientConnection.sendNotification("initialized", {});

    await streams.clientConnection.sendNotification("textDocument/didOpen", {
      textDocument: { uri: appUri, languageId: "typescriptreact", version: 1, text: appSource },
    });

    await streams.clientConnection.sendNotification("textDocument/didOpen", {
      textDocument: { uri: svgUri, languageId: "xml", version: 1, text: svg },
    });

    const diagnostic = (await streams.diagnostics(svgUri, 1)).diagnostics[0];

    expect(diagnostic?.code).toBe("HES-PLUGIN");

    expect(diagnostic?.severity).toBe(DiagnosticSeverity.Error);

    expect(diagnostic?.message).toContain("Source location unavailable");

    expect(diagnostic?.range.start).toStrictEqual(diagnostic?.range.end);

    expect(diagnostic?.range.start).toStrictEqual(protocolPosition(svg, svg.length));
  } finally {
    await stopProtocolHarness(streams);

    await rm(root, { recursive: true, force: true });
  }
}, 45000);

test("locationless diagnostics keep severity and publish no authored-text highlight", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-language-server-locationless-"));
  const filename = join(root, "src/App.tsx");
  const uri = pathToFileURL(filename).href;
  const source = "export const marker = 1;\n";

  await mkdir(join(root, "src"));

  await writeFile(filename, source);

  await writeFile(join(root, "hesperia.config.json"), "{}");

  const streams = createProtocolHarness();
  const result = resultFor(filename, "TS2322", "Type mismatch");
  const project = fakeProject({
    ...result,
    modules: [
      {
        filename,
        diagnostics: [{ code: "TS2322", severity: "warning", message: "Type mismatch" }],
      },
    ],
  });

  startLanguageServer(streams.serverConnection, async () => project);

  streams.serverStarted = true;

  try {
    await streams.clientConnection.sendRequest(InitializeRequest.type, {
      processId: process.pid,
      rootUri: pathToFileURL(root).href,
      capabilities: {},
    });

    await streams.clientConnection.sendNotification("initialized", {});

    await streams.clientConnection.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId: "hesperia-tsx", version: 1, text: source },
    });

    const diagnostic = (await streams.diagnostics(uri, 1)).diagnostics[0];

    expect(diagnostic?.code).toBe("TS2322");

    expect(diagnostic?.severity).toBe(DiagnosticSeverity.Warning);

    expect(diagnostic?.message).toContain("location unavailable");

    expect(diagnostic?.range).toStrictEqual({
      start: { line: 1, character: 0 },
      end: { line: 1, character: 0 },
    });
  } finally {
    await stopProtocolHarness(streams);

    await rm(root, { recursive: true, force: true });
  }
}, 45000);

test("language server discards superseded builds and delayed results from older documents", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-language-server-stale-"));
  const filename = join(root, "src/App.tsx");
  const uri = pathToFileURL(filename).href;

  await mkdir(join(root, "src"));

  const initialSource = 'export const marker = "initial";';
  const firstSource = 'export const marker = "first";';
  const delayedSource = 'export const marker = "delayed-old-build";';
  const secondSource = 'export const marker = "second";';
  const thirdSource = 'export const marker = "third";';

  await writeFile(filename, initialSource);

  await writeFile(join(root, "hesperia.config.json"), "{}");

  const streams = createProtocolHarness();
  const delayedStarted = deferred<void>();
  const delayedBuild = deferred<ReturnType<typeof fakeProject>>();
  const oldHoverStarted = deferred<void>();
  const oldHover = deferred<Hover | undefined>();
  const initial = fakeProject(resultFor(filename, "HES-INITIAL", "initial source"));
  const first = fakeProject(resultFor(filename, "HES-FIRST", "first source"));
  const stale = fakeProject(resultFor(filename, "HES-STALE", "delayed stale build"));
  const second = fakeProject(resultFor(filename, "HES-SECOND", "second source"), async () => {
    oldHoverStarted.resolve(undefined);

    return await oldHover.promise;
  });
  const third = fakeProject(resultFor(filename, "HES-THIRD", "third source"));

  startLanguageServer(streams.serverConnection, async (modules) => {
    const source = modules.find((module) => module.filename === filename)?.source ?? "";

    if (source === initialSource) return initial;

    if (source === firstSource) return first;

    if (source === delayedSource) {
      delayedStarted.resolve(undefined);

      return await delayedBuild.promise;
    }

    if (source === secondSource) return second;

    if (source === thirdSource) return third;

    throw new Error(`Unexpected editor source: ${source}`);
  });

  streams.serverStarted = true;

  try {
    await streams.clientConnection.sendRequest(InitializeRequest.type, {
      processId: process.pid,
      rootUri: pathToFileURL(root).href,
      capabilities: {},
    });

    await streams.clientConnection.sendNotification("initialized", {});

    expect((await streams.diagnostics(uri, undefined)).diagnostics[0]?.code).toBe("HES-INITIAL");

    await streams.clientConnection.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId: "hesperia-tsx", version: 1, text: firstSource },
    });

    expect((await streams.diagnostics(uri, 1)).diagnostics[0]?.code).toBe("HES-FIRST");

    await streams.clientConnection.sendNotification("textDocument/didChange", {
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: delayedSource }],
    });

    await delayedStarted.promise;

    await streams.clientConnection.sendNotification("textDocument/didChange", {
      textDocument: { uri, version: 3 },
      contentChanges: [{ text: secondSource }],
    });

    await streams.clientConnection.sendRequest(DocumentSymbolRequest.type, {
      textDocument: { uri },
    });

    delayedBuild.resolve(stale);

    expect((await streams.diagnostics(uri, 3)).diagnostics[0]?.code).toBe("HES-SECOND");

    expect(streams.events.some((event) => event.uri === uri && event.version === 2)).toBe(false);

    expect(stale.isDisposed).toBe(true);

    const hoverRequest = streams.clientConnection.sendRequest(HoverRequest.type, {
      textDocument: { uri },
      position: { line: 0, character: 20 },
    });
    await oldHoverStarted.promise;

    await streams.clientConnection.sendNotification("textDocument/didChange", {
      textDocument: { uri, version: 4 },
      contentChanges: [{ text: thirdSource }],
    });

    await streams.clientConnection.sendRequest(DocumentSymbolRequest.type, {
      textDocument: { uri },
    });

    oldHover.resolve({ type: "old result", documentation: "" });

    expect(await hoverRequest).toBeNull();

    expect((await streams.diagnostics(uri, 4)).diagnostics[0]?.code).toBe("HES-THIRD");

    expect(second.isDisposed).toBe(true);
  } finally {
    delayedBuild.resolve(stale);

    oldHover.resolve(undefined);

    await stopProtocolHarness(streams);

    await rm(root, { recursive: true, force: true });
  }
}, 45000);

test("language server skips a worker when its source read was superseded", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-language-server-read-race-"));
  const filename = join(root, "app.tsx");
  const uri = pathToFileURL(filename).href;

  await mkdir(join(root, "src"));

  await writeFile(filename, 'export const marker = "disk";');

  await writeFile(join(root, "hesperia.config.ts"), "export default {};");

  const streams = createProtocolHarness();
  const firstReadStarted = deferred<void>();
  const releaseFirstRead = deferred<void>();
  let reads = 0;
  let workerStarts = 0;

  startLanguageServer(
    streams.serverConnection,
    async () => fakeProject(resultFor(filename, "HES-TEST", "test")),
    async () => {
      reads++;

      if (reads === 1) {
        firstReadStarted.resolve(undefined);

        await releaseFirstRead.promise;
      }

      return new Map([[filename, 'export const marker = "disk";']]);
    },
    async (projectRoot, sources) => {
      workerStarts++;
      return {
        root: projectRoot,
        configuration: {
          allowUnsafeHTML: false,
          mountURL: "/",
          resolutionOverrides: { browser: {} },
        },
        modules: [...sources].map(([name, source]) => ({ filename: name, source })),
        additionalFiles: [],
        checkingRoots: [],
        browserSources: [],
        generatedImports: [],
        resolutionOverrides: { browser: {} },
        diagnostics: [],
        watch: [],
        transformed: [],
        declarationOrigins: [],
        declarationMaps: [],
      };
    },
  );

  streams.serverStarted = true;

  try {
    await streams.clientConnection.sendRequest(InitializeRequest.type, {
      processId: process.pid,
      rootUri: pathToFileURL(root).href,
      capabilities: {},
    });

    await streams.clientConnection.sendNotification("initialized", {});

    await firstReadStarted.promise;

    await streams.clientConnection.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: "hesperia-tsx",
        version: 1,
        text: 'export const marker = "new";',
      },
    });

    await streams.clientConnection.sendRequest(DocumentSymbolRequest.type, {
      textDocument: { uri },
    });

    releaseFirstRead.resolve(undefined);

    await streams.diagnostics(uri, 1);

    expect(workerStarts).toBe(1);

    expect(reads).toBe(2);
  } finally {
    releaseFirstRead.resolve(undefined);

    await stopProtocolHarness(streams);

    await rm(root, { recursive: true, force: true });
  }
}, 45000);

test("language server keeps the current project alive after an asynchronous refresh failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-language-server-failure-"));
  const filename = join(root, "src/App.tsx");
  const uri = pathToFileURL(filename).href;

  await mkdir(join(root, "src"));

  const initialSource = 'export const marker = "initial";';
  const currentSource = 'export const marker = "current";';
  const failureSource = 'export const marker = "fails";';
  const replacementSource = 'export const marker = "replacement";';

  await writeFile(filename, initialSource);

  await writeFile(join(root, "hesperia.config.json"), "{}");

  const streams = createProtocolHarness();
  const failureStarted = deferred<void>();
  const initial = fakeProject(resultFor(filename, "HES-INITIAL", "initial source"));
  const current = fakeProject(resultFor(filename, "HES-CURRENT", "current source"));
  const replacement = fakeProject(resultFor(filename, "HES-REPLACEMENT", "replacement source"));

  startLanguageServer(streams.serverConnection, async (modules) => {
    const source = modules.find((module) => module.filename === filename)?.source ?? "";

    if (source === initialSource) return initial;

    if (source === currentSource) return current;

    if (source === failureSource) {
      failureStarted.resolve(undefined);

      throw new Error("expected checker failure");
    }

    if (source === replacementSource) return replacement;

    throw new Error(`Unexpected editor source: ${source}`);
  });

  streams.serverStarted = true;

  try {
    await streams.clientConnection.sendRequest(InitializeRequest.type, {
      processId: process.pid,
      rootUri: pathToFileURL(root).href,
      capabilities: {},
    });

    await streams.clientConnection.sendNotification("initialized", {});

    await streams.diagnostics(uri, undefined);

    await streams.clientConnection.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId: "hesperia-tsx", version: 1, text: currentSource },
    });

    expect((await streams.diagnostics(uri, 1)).diagnostics[0]?.code).toBe("HES-CURRENT");

    await streams.clientConnection.sendNotification("textDocument/didChange", {
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: failureSource }],
    });

    await failureStarted.promise;
    const result = await streams.clientConnection.sendRequest(HoverRequest.type, {
      textDocument: { uri },
      position: { line: 0, character: 20 },
    });

    expect(result).toBeNull();

    expect(current.isDisposed).toBe(false);

    expect(streams.events.some((event) => event.uri === uri && event.version === 2)).toBe(false);

    await streams.clientConnection.sendNotification("textDocument/didChange", {
      textDocument: { uri, version: 3 },
      contentChanges: [{ text: replacementSource }],
    });

    expect((await streams.diagnostics(uri, 3)).diagnostics[0]?.code).toBe("HES-REPLACEMENT");

    expect(current.isDisposed).toBe(true);
  } finally {
    await stopProtocolHarness(streams);

    await rm(root, { recursive: true, force: true });
  }
}, 45000);

test("language server shutdown waits for an in-flight semantic request before disposal", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-language-server-shutdown-"));
  const filename = join(root, "src/App.tsx");
  const uri = pathToFileURL(filename).href;

  await mkdir(join(root, "src"));

  const diskSource = "export const marker = 'disk';";
  const source = "export const marker = 'current';";

  await writeFile(filename, diskSource);

  await writeFile(join(root, "hesperia.config.json"), "{}");

  const streams = createProtocolHarness();
  const hoverStarted = deferred<void>();
  const hoverResult = deferred<Hover | undefined>();
  const disposalStarted = deferred<void>();
  const initial = fakeProject(resultFor(filename, "HES-INITIAL", "initial source"));
  const current = fakeProject(
    resultFor(filename, "HES-CURRENT", "current source"),
    async () => {
      hoverStarted.resolve(undefined);

      return await hoverResult.promise;
    },
    () => disposalStarted.resolve(undefined),
  );

  startLanguageServer(streams.serverConnection, async (modules) => {
    const module = modules.find((item) => item.filename === filename);

    if (module?.source === diskSource) return initial;

    if (module?.source === source) return current;

    throw new Error(`Unexpected editor source: ${module?.source}`);
  });

  streams.serverStarted = true;

  try {
    await streams.clientConnection.sendRequest(InitializeRequest.type, {
      processId: process.pid,
      rootUri: pathToFileURL(root).href,
      capabilities: {},
    });

    await streams.clientConnection.sendNotification("initialized", {});

    await streams.diagnostics(uri, undefined);

    await streams.clientConnection.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId: "hesperia-tsx", version: 1, text: source },
    });

    await streams.diagnostics(uri, 1);

    const request = streams.clientConnection.sendRequest(HoverRequest.type, {
      textDocument: { uri },
      position: { line: 0, character: 20 },
    });
    await hoverStarted.promise;
    let shutdownSettled = false;
    const shutdown = streams.clientConnection.sendRequest("shutdown").then((result) => {
      shutdownSettled = true;
      return result;
    });
    await disposalStarted.promise;
    await new Promise<void>((accept) => setImmediate(accept));

    expect(current.isDisposed).toBe(false);

    expect(shutdownSettled).toBe(false);

    hoverResult.resolve({ type: "string", documentation: "" });

    expect(await request).toBeNull();

    expect(await shutdown).toBeNull();

    expect(current.isDisposed).toBe(true);

    await streams.clientConnection.sendNotification("exit");

    streams.serverStarted = false;
  } finally {
    hoverResult.resolve(undefined);

    await stopProtocolHarness(streams);

    await rm(root, { recursive: true, force: true });
  }
}, 45000);

function resultFor(filename: string, code: string, message: string): ProjectCheckingResult {
  return {
    diagnostics: [],
    checkingInputs: [],
    modules: [
      {
        filename,
        diagnostics: [{ code, severity: "error", message, span: { start: 0, end: 1 } }],
      },
    ],
    snapshotId: 0,
  };
}

function protocolPosition(source: string, offset: number): { line: number; character: number } {
  const before = source.slice(0, offset);
  return {
    line: before.split("\n").length - 1,
    character: offset - before.lastIndexOf("\n") - 1,
  };
}

async function writeMarkupWorkerProjectConfig(root: string): Promise<void> {
  await writeFile(join(root, "hesperia.config.ts"), "export default { allowUnsafeHTML: true };");

  await writeFile(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ESNext",
        module: "ESNext",
        moduleResolution: "Bundler",
        jsx: "preserve",
        lib: ["ESNext", "DOM"],
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: [],
        paths: {
          hesperia: [resolve("packages/hesperia/dist/index.d.ts")],
          "hesperia/*": [resolve("packages/hesperia/dist/*")],
        },
      },
      include: ["app.tsx", "src/**/*.tsx"],
    }),
  );
}

function fakeProject(
  diagnostics: ProjectCheckingResult,
  hover: () => Promise<Hover | undefined> = async () => undefined,
  onDispose: () => void = () => undefined,
) {
  let activeRequests = 0;
  let finishDisposal: (() => void) | undefined;
  let disposePromise: Promise<void> | undefined;
  let isDisposed = false;
  return {
    diagnostics,

    get isDisposed() {
      return isDisposed;
    },

    async hover() {
      activeRequests++;

      try {
        return await hover();
      } finally {
        activeRequests--;

        if (activeRequests === 0) finishDisposal?.();
      }
    },

    async completions() {
      return [];
    },

    async definitions() {
      return [];
    },

    dispose() {
      if (disposePromise) return disposePromise;

      disposePromise = new Promise<void>((resolve) => {
        if (activeRequests === 0) {
          isDisposed = true;

          resolve();
        } else {
          finishDisposal = () => {
            isDisposed = true;

            resolve();
          };
        }
      });

      onDispose();

      return disposePromise;
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function createProtocolHarness() {
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();
  const serverConnection = createConnection(
    new StreamMessageReader(clientToServer),
    new StreamMessageWriter(serverToClient),
  );
  const clientConnection = createProtocolConnection(serverToClient, clientToServer);
  const events: PublishDiagnosticsParams[] = [];
  const waiters = new Set<() => void>();
  let serverStarted = false;

  clientConnection.onNotification(PublishDiagnosticsNotification.type, (value) => {
    events.push(value);

    for (const notify of waiters) notify();
  });

  clientConnection.listen();

  function diagnostics(
    uri: string,
    version: number | undefined,
  ): Promise<PublishDiagnosticsParams> {
    return new Promise((accept, reject) => {
      const timeout = setTimeout(() => {
        waiters.delete(check);

        reject(new Error(`No diagnostics for ${uri} at version ${version}`));
      }, 10000);

      function check(): void {
        const result = events.find((event) => event.uri === uri && event.version === version);

        if (!result) return;

        clearTimeout(timeout);

        waiters.delete(check);

        accept(result);
      }

      waiters.add(check);

      check();
    });
  }

  return {
    clientConnection,
    diagnostics,
    events,

    get serverStarted() {
      return serverStarted;
    },

    set serverStarted(value: boolean) {
      serverStarted = value;
    },

    serverConnection,
    clientToServer,
    serverToClient,
  };
}

async function stopProtocolHarness(streams: ReturnType<typeof createProtocolHarness>) {
  if (streams.serverStarted) {
    try {
      await streams.clientConnection.sendRequest("shutdown");

      await streams.clientConnection.sendNotification("exit");
    } catch {
      // The protocol may already have closed after a failed assertion.
    }
  }

  streams.clientConnection.dispose();

  streams.serverConnection.dispose();

  streams.clientToServer.destroy();

  streams.serverToClient.destroy();
}
