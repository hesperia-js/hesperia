import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { existsSync, watch } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createConnection,
  createProtocolConnection,
  HoverRequest,
  InitializeRequest,
  PublishDiagnosticsNotification,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-languageserver/node";
import { startLanguageServer } from "../../packages/language-server/src/server.ts";
import { linkFrameworkPackages, unlinkFrameworkPackages } from "../tooling/fixture-dependencies.ts";

test("language server reloads TypeScript configuration without restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-editor-config-"));
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();
  const client = createProtocolConnection(serverToClient, clientToServer);
  const events: string[] = [];
  const configErrors: string[] = [];
  const logs: string[] = [];

  client.onNotification("window/logMessage", (event: { message: string }) => {
    logs.push(event.message);
  });

  const waiters = new Set<() => void>();

  client.onNotification(PublishDiagnosticsNotification.type, (event) => {
    events.push(event.uri);

    if (event.uri.endsWith("hesperia.config.ts"))
      configErrors.push(...event.diagnostics.map((diagnostic) => String(diagnostic.message)));

    for (const notify of waiters) notify();
  });

  const server = createConnection(
    new StreamMessageReader(clientToServer),
    new StreamMessageWriter(serverToClient),
  );
  const filename = join(root, "app.tsx");
  const configFilename = join(root, "hesperia.config.ts");
  const inputFilename = join(root, "extra.txt");
  const inputDirectory = join(root, "assets");
  const paletteFilename = join(root, "palette.dat");
  const source =
    'import { LABEL } from "hesperia/config/public"; import palette from "./palette.dat" with { type: "palette" }; export default function App() { return <html><head></head><body>{LABEL}{palette}</body></html>; }';

  const config = (label: string) =>
    `import { defineConfig } from "@hesperia/tooling"; export default defineConfig({ public: { LABEL: "${label}", SPECIAL: [undefined, Infinity] }, plugins: [{ name: "watch-inputs", importTypes: { palette: async (input) => ({ declaration: { code: "declare const value: string; export default value;", origin: input.importSpan }, browser: { code: "export default " + JSON.stringify(await input.file.blob.text()) + ";", origin: input.importSpan } }) }, transformSource(input) { return { code: input.current, watch: [{ kind: "file", file: ${JSON.stringify(inputFilename)} }, { kind: "directory", dir: ${JSON.stringify(inputDirectory)} }] }; } }] });`;

  try {
    await linkFrameworkPackages(root);

    await mkdir(join(root, "src"));

    await mkdir(inputDirectory);

    await writeFile(inputFilename, "first");

    await writeFile(paletteFilename, "red,blue");

    await writeFile(filename, source);

    await writeFile(configFilename, config("first"));

    startLanguageServer(server);

    client.listen();

    await client.sendRequest(InitializeRequest.type, {
      processId: process.pid,
      rootUri: pathToFileURL(root).href,
      capabilities: {},
    });

    await client.sendNotification("initialized", {});

    const uri = pathToFileURL(filename).href;

    function published(count: number): Promise<void> {
      return new Promise((accept, reject) => {
        const timeout = setTimeout(() => {
          waiters.delete(check);

          reject(new Error(`No editor revision ${count}: ${logs.join(" | ")}`));
        }, 10_000);

        function check(): void {
          if (events.filter((item) => item === uri).length < count) return;

          clearTimeout(timeout);

          waiters.delete(check);

          accept();
        }

        waiters.add(check);

        check();
      });
    }

    await client.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId: "hesperia-tsx", version: 1, text: source },
    });

    await published(1);

    const request = {
      textDocument: { uri },
      position: { line: 0, character: source.indexOf("LABEL") + 2 },
    };
    const first = await client.sendRequest(HoverRequest.type, request);

    expect(JSON.stringify(first)).toContain("first");

    const paletteHover = await client.sendRequest(HoverRequest.type, {
      textDocument: { uri },
      position: { line: 0, character: source.indexOf("palette from") + 2 },
    });

    expect(JSON.stringify(paletteHover)).toContain("string");

    await writeFile(configFilename, config("second"));

    await client.sendNotification("workspace/didChangeWatchedFiles", {
      changes: [{ uri: pathToFileURL(configFilename).href, type: 2 }],
    });

    await published(2);

    const second = await client.sendRequest(HoverRequest.type, request);

    expect(JSON.stringify(second)).toContain("second");

    expect(JSON.stringify(second)).not.toContain("first");

    await writeFile(inputFilename, "second");

    await published(3);

    await writeFile(join(inputDirectory, "new.txt"), "created");

    await published(4);

    await writeFile(configFilename, "export default { public:");

    await client.sendNotification("workspace/didChangeWatchedFiles", {
      changes: [{ uri: pathToFileURL(configFilename).href, type: 2 }],
    });

    await published(5);

    expect(configErrors.some((message) => message.includes("last valid project snapshot"))).toBe(
      true,
    );

    await writeFile(configFilename, config("third"));

    await client.sendNotification("workspace/didChangeWatchedFiles", {
      changes: [{ uri: pathToFileURL(configFilename).href, type: 2 }],
    });

    await published(6);

    expect(JSON.stringify(await client.sendRequest(HoverRequest.type, request))).toContain("third");

    async function startPending(marker: string): Promise<void> {
      const started = new Promise<void>((accept, reject) => {
        const watcher = watch(root, () => {
          if (!existsSync(marker)) return;

          clearTimeout(timeout);

          watcher.close();

          accept();
        });
        const timeout = setTimeout(() => {
          watcher.close();

          reject(new Error("Editor worker did not start"));
        }, 10_000);
      });

      await writeFile(
        configFilename,
        `import { defineConfig } from "@hesperia/tooling"; setInterval(() => {}, 3_600_000); export default defineConfig({ plugins: [{ name: "pending", importTypes: { palette: (input) => ({ declaration: { code: "declare const value: string; export default value;", origin: input.importSpan }, browser: { code: "export default 'red';", origin: input.importSpan } }) }, async transformSource() { await Bun.write(${JSON.stringify(marker)}, "started"); await new Promise(() => {}); } }] });`,
      );

      await client.sendNotification("workspace/didChangeWatchedFiles", {
        changes: [{ uri: pathToFileURL(configFilename).href, type: 2 }],
      });

      await started;
    }

    await startPending(join(root, "superseded-worker-started"));

    await writeFile(configFilename, config("fourth"));

    await client.sendNotification("workspace/didChangeWatchedFiles", {
      changes: [{ uri: pathToFileURL(configFilename).href, type: 2 }],
    });

    await published(7);

    expect(JSON.stringify(await client.sendRequest(HoverRequest.type, request))).toContain(
      "fourth",
    );

    await startPending(join(root, "shutdown-worker-started"));

    expect(await client.sendRequest("shutdown")).toBeNull();

    await client.sendNotification("exit");
  } finally {
    client.dispose();

    server.dispose();

    await unlinkFrameworkPackages(root);

    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
