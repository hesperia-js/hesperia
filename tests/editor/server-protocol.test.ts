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
  CompletionRequest,
  DocumentSymbolRequest,
  HoverRequest,
  InitializeRequest,
  PublishDiagnosticsNotification,
  StreamMessageReader,
  StreamMessageWriter,
  type PublishDiagnosticsParams,
} from "vscode-languageserver/node";
import { startLanguageServer } from "../../src/editor/server.ts";

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
          hesperia: [resolve("dist/index.d.ts")],
          "hesperia/*": [resolve("dist/*")],
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
