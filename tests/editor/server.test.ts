import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { once } from "node:events";
import {
  createProtocolConnection,
  InitializeRequest,
  HoverRequest,
  CompletionRequest,
  DefinitionRequest,
  PublishDiagnosticsNotification,
  type PublishDiagnosticsParams,
} from "vscode-languageserver/node";

test("language server maps unsaved TSX diagnostics and navigation through its stdio protocol", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-language-server-"));
  const cleanupPath = resolve(root);
  const cleanupRelative = relative(resolve(tmpdir()), cleanupPath);
  if (
    isAbsolute(cleanupRelative) ||
    !cleanupRelative.startsWith("hesperia-language-server-") ||
    cleanupRelative.includes("/") ||
    cleanupRelative.includes("\\")
  )
    throw new Error("Invalid test cleanup path");
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
  const shellFilename = join(root, "app.tsx");
  const dependencyFilename = join(root, "node_modules/foreign/broken.ts");
  const generatedFilename = join(root, ".hesperia/generated/broken.ts");
  const originalUri = pathToFileURL(filename).href;
  const shellUri = pathToFileURL(shellFilename).href;
  const dependencyUri = pathToFileURL(dependencyFilename).href;
  const generatedUri = pathToFileURL(generatedFilename).href;
  const uri =
    process.platform === "win32"
      ? originalUri.replace(
          /^file:\/\/\/([A-Z]):/i,
          (_, drive: string) => `file:///${drive.toLowerCase()}%3A`,
        )
      : originalUri;
  await writeFile(filename, "export const diskVersion = true;");
  await writeFile(
    shellFilename,
    "export default function App(){ return <html><head><title>Shell</title></head><body><main>Ready</main></body></html>; }",
  );
  await mkdir(join(root, "node_modules/foreign"), { recursive: true });
  await mkdir(join(root, ".hesperia/generated"), { recursive: true });
  await writeFile(dependencyFilename, "export const invalid: string = 123;\n");
  await writeFile(generatedFilename, "export const invalid: string = 123;\n");
  const executable = resolve(import.meta.dir, "../../dist/tooling/cli.js");
  const child = spawn(process.execPath, [executable, "language-server"], {
    cwd: root,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const connection = createProtocolConnection(child.stdout, child.stdin);
  const events: PublishDiagnosticsParams[] = [];
  const waiters = new Set<() => void>();
  connection.onNotification(PublishDiagnosticsNotification.type, (value) => {
    events.push(value);
    for (const notify of waiters) notify();
  });
  connection.listen();
  function diagnostics(version: number, targetUri = uri): Promise<PublishDiagnosticsParams> {
    return new Promise((accept, reject) => {
      const timeout = setTimeout(() => {
        waiters.delete(check);
        reject(new Error(`No diagnostics for version ${version}: ${stderr}`));
      }, 10000);
      function check(): void {
        const result = events.find((event) => event.uri === targetUri && event.version === version);
        if (!result) return;
        clearTimeout(timeout);
        waiters.delete(check);
        accept(result);
      }
      waiters.add(check);
      check();
    });
  }
  try {
    const initialized = await connection.sendRequest(InitializeRequest.type, {
      processId: process.pid,
      rootUri: pathToFileURL(root).href,
      capabilities: {},
    });
    expect(initialized.capabilities.hoverProvider).toBe(true);
    await connection.sendNotification("initialized", {});
    for (const [excludedUri, excludedFilename] of [
      [dependencyUri, dependencyFilename],
      [generatedUri, generatedFilename],
    ] as const) {
      await connection.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri: excludedUri,
          languageId: "typescript",
          version: 1,
          text: await readFile(excludedFilename, "utf8"),
        },
      });
      const completions = await connection.sendRequest(CompletionRequest.type, {
        textDocument: { uri: excludedUri },
        position: { line: 0, character: 0 },
      });
      expect(completions).toStrictEqual([]);
      expect(
        events.filter((event) => event.uri === excludedUri).flatMap((event) => event.diagnostics),
      ).toStrictEqual([]);
    }
    const shellSource =
      "export default function App(){ return <html><head><title>Shell</title></head><body><main>Ready</main></body></html>; }";
    await connection.sendNotification("textDocument/didOpen", {
      textDocument: { uri: shellUri, languageId: "hesperia-tsx", version: 1, text: shellSource },
    });
    expect((await diagnostics(1, shellUri)).diagnostics).toStrictEqual([]);
    const invalidShell = shellSource.replace(
      "<body><main>Ready</main></body>",
      "<body><html><main>Ready</main></html></body>",
    );
    await connection.sendNotification("textDocument/didChange", {
      textDocument: { uri: shellUri, version: 2 },
      contentChanges: [{ text: invalidShell }],
    });
    const shellDiagnostics = await diagnostics(2, shellUri);
    expect(shellDiagnostics.diagnostics.some((item) => item.code === "HES-DOCUMENT-SHELL")).toBe(
      true,
    );
    const source =
      'export function App(){\r\n const emoji = "🐈"; const field = <input />;\r\n return <div title={field.value}>{field.missing()}</div>;\r\n}';
    await connection.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId: "hesperia-tsx", version: 1, text: source },
    });
    const broken = await diagnostics(1);
    const missing = broken.diagnostics.find((item) => item.code === "TS2339");
    expect(missing?.range.start).toStrictEqual({
      line: 2,
      character: " return <div title={field.value}>{field.".length,
    });
    const target = {
      textDocument: { uri },
      position: { line: 2, character: " return <div title={field.".length },
    };
    const hover = await connection.sendRequest(HoverRequest.type, target);
    expect(JSON.stringify(hover)).toContain("string");
    const completions = await connection.sendRequest(CompletionRequest.type, target);
    expect(JSON.stringify(completions)).toContain('"label":"focus"');
    const definition = await connection.sendRequest(DefinitionRequest.type, {
      ...target,
      position: { line: 2, character: " return <div title={".length },
    });
    expect(definition).toStrictEqual([
      {
        uri,
        range: {
          start: { line: 1, character: ' const emoji = "🐈"; const '.length },
          end: { line: 1, character: ' const emoji = "🐈"; const field'.length },
        },
      },
    ]);
    const corrected = source.replace("field.missing()", "field.value");
    await connection.sendNotification("textDocument/didChange", {
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: corrected }],
    });
    expect((await diagnostics(2)).diagnostics).toStrictEqual([]);

    const pageDirectory = join(root, "src/routes/users/[uid]");
    await mkdir(pageDirectory, { recursive: true });
    const pageFilename = join(pageDirectory, "+page.tsx");
    const pageUri = pathToFileURL(pageFilename).href;
    const pageSource =
      'import type { Page } from "hesperia";\nexport default function User(props: Page.Props<{ queryParams: { tab?: string } }>) {\n return <span>{props.params.uid}:{props.queryParams().get("tab")}</span>;\n}';
    await writeFile(pageFilename, pageSource);
    await connection.sendNotification("textDocument/didOpen", {
      textDocument: { uri: pageUri, languageId: "hesperia-tsx", version: 1, text: pageSource },
    });
    expect((await diagnostics(1, pageUri)).diagnostics).toStrictEqual([]);
    expect(await readFile(join(root, "hesperia.d.ts"), "utf8")).toContain('"uid": string');
    await connection.sendNotification("textDocument/didClose", { textDocument: { uri: pageUri } });
    await connection.sendRequest(HoverRequest.type, {
      textDocument: { uri: pageUri },
      position: { line: 0, character: 0 },
    });
    const renamedDirectory = join(root, "src/routes/users/[userId]");
    await rename(pageDirectory, renamedDirectory);
    const renamedUri = pathToFileURL(join(renamedDirectory, "+page.tsx")).href;
    await connection.sendNotification("workspace/didChangeWatchedFiles", {
      changes: [
        { uri: pageUri, type: 3 },
        { uri: renamedUri, type: 1 },
      ],
    });
    await connection.sendNotification("textDocument/didOpen", {
      textDocument: { uri: renamedUri, languageId: "hesperia-tsx", version: 1, text: pageSource },
    });
    const renamedDiagnostics = await diagnostics(1, renamedUri);
    expect(renamedDiagnostics.diagnostics.some((item) => item.code === "TS2339")).toBe(true);
    expect(await readFile(join(root, "hesperia.d.ts"), "utf8")).toContain('"userId": string');
    const pageCompletions = await connection.sendRequest(CompletionRequest.type, {
      textDocument: { uri: renamedUri },
      position: { line: 2, character: " return <span>{props.params.".length },
    });
    expect(JSON.stringify(pageCompletions)).toContain('"label":"userId"');
    expect(JSON.stringify(pageCompletions)).not.toContain('"label":"uid"');
    await connection.sendNotification("textDocument/didClose", { textDocument: { uri } });
    await connection.sendRequest("shutdown");
    await connection.sendNotification("exit");
    const [code] = await exited;
    expect(code).toBe(0);
    expect(stderr).toBe("");
  } finally {
    connection.dispose();
    if (child.exitCode === null) {
      child.kill();
      await exited;
    }
    await rm(cleanupPath, { recursive: true, force: true });
  }
}, 45000);
