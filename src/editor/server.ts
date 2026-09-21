import { readFile } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createConnection,
  TextDocuments,
  TextDocumentSyncKind,
  DiagnosticSeverity,
  type Connection,
  type Diagnostic,
  type TextDocumentPositionParams,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { readProject } from "../tooling/project.ts";
import { readConfiguration } from "../tooling/configuration.ts";
import { writeProjectTypes } from "../tooling/page-types.ts";
import { EditorProject } from "./project.ts";
import { extractDocumentSymbols } from "./symbols.ts";

/**
 * Serve Hesperia diagnostics and source navigation over standard input/output.
 * Each server owns one application root. Unsaved documents override disk source;
 * watched file changes rebuild the same checking view used by `hesperia check`.
 * Invalid build configuration is reported on its file; editor requests continue
 * with the last valid settings, or defaults before the first valid configuration.
 * Standard output is reserved for protocol messages.
 */
export function startLanguageServer(
  connection: Connection = createConnection(process.stdin, process.stdout),
): void {
  const documents = new TextDocuments(TextDocument);
  let root = process.cwd();
  let project: EditorProject | undefined;
  let configuration: Awaited<ReturnType<typeof readConfiguration>> | undefined;
  let revision = 0;
  let pending: Promise<void> = Promise.resolve();
  let stopped = false;
  let published = new Set<string>();

  function belongs(filename: string): boolean {
    const path = relative(root, filename).replaceAll("\\", "/");
    if (path === ".." || path.startsWith("../") || isAbsolute(path)) return false;
    return !path
      .split("/")
      .some(
        (segment) =>
          segment.toLowerCase() === "node_modules" || segment.toLowerCase() === ".hesperia",
      );
  }

  async function documentFor(filename: string): Promise<TextDocument | undefined> {
    const uri = pathToFileURL(filename).href;
    const open = documents
      .all()
      .find(
        (document) =>
          document.uri.startsWith("file:") &&
          normalize(fileURLToPath(document.uri)) === normalize(filename),
      );
    if (open) return open;
    try {
      return TextDocument.create(uri, "typescriptreact", 0, await readFile(filename, "utf8"));
    } catch {
      return undefined;
    }
  }

  function refresh(): Promise<void> {
    const requested = ++revision;
    pending = pending
      .then(async () => {
        if (stopped || requested !== revision) return;
        const sources = new Map(
          [...(await readProject(root))].map(([filename, source]) => [
            normalize(filename),
            { filename, source },
          ]),
        );
        for (const document of documents.all()) {
          if (!document.uri.startsWith("file:")) continue;
          const filename = fileURLToPath(document.uri);
          if (belongs(filename))
            sources.set(normalize(filename), { filename, source: document.getText() });
        }
        let configurationError: string | undefined;
        try {
          configuration = await readConfiguration(root);
        } catch (error) {
          configurationError = `${error instanceof Error ? error.message : String(error)}. Editor checking uses ${configuration ? "the last valid configuration" : "default configuration"} until this file is repaired.`;
        }
        if (stopped || requested !== revision) return;
        try {
          await writeProjectTypes(
            root,
            new Map([...sources.values()].map(({ filename, source }) => [filename, source])),
          );
        } catch (error) {
          // Read-only projects still receive in-memory checking; route scan
          // errors are reported by the compiler at their authored locations.
          connection.console.warn(error instanceof Error ? error.message : String(error));
        }
        if (stopped || requested !== revision) return;
        const next = new EditorProject([...sources.values()], {
          root,
          ...configuration,
          // The project checker enables shell validation only for this
          // project's exact root app.tsx; child modules remain ordinary views.
          documentShell: true,
        });
        project?.dispose();
        project = next;
        const outgoing = new Map<string, { diagnostics: Diagnostic[]; version?: number }>();
        if (configurationError) {
          const filename = resolve(root, "hesperia.config.json");
          const document =
            (await documentFor(filename)) ??
            TextDocument.create(pathToFileURL(filename).href, "json", 0, "");
          outgoing.set(document.uri, {
            diagnostics: [
              {
                code: "HES-CONFIG",
                source: "hesperia",
                message: configurationError,
                severity: DiagnosticSeverity.Error,
                range: {
                  start: document.positionAt(0),
                  end: document.positionAt(document.getText().length),
                },
              },
            ],
          });
        }
        for (const module of next.diagnostics.modules) {
          const filename = resolve(root, module.filename);
          const document = await documentFor(filename);
          if (!document) continue;
          outgoing.set(document.uri, {
            ...(documents.get(document.uri) ? { version: document.version } : {}),
            diagnostics: module.diagnostics.map((item) => ({
              code: item.code,
              source: "hesperia",
              message: item.message,
              severity:
                item.severity === "error"
                  ? DiagnosticSeverity.Error
                  : item.severity === "warning"
                    ? DiagnosticSeverity.Warning
                    : DiagnosticSeverity.Information,
              range: {
                start: document.positionAt(item.span?.start ?? 0),
                end: document.positionAt(item.span?.end ?? 0),
              },
            })),
          });
        }
        if (stopped || requested !== revision) return;
        for (const uri of published)
          if (!outgoing.has(uri)) await connection.sendDiagnostics({ uri, diagnostics: [] });
        for (const [uri, result] of outgoing) await connection.sendDiagnostics({ uri, ...result });
        published = new Set(outgoing.keys());
      })
      .catch((error) => {
        project?.dispose();
        project = undefined;
        if (!stopped)
          connection.console.error(error instanceof Error ? error.message : String(error));
      });
    return pending;
  }

  async function position(params: TextDocumentPositionParams) {
    await pending;
    const document = documents.get(params.textDocument.uri);
    if (!document || !params.textDocument.uri.startsWith("file:")) return undefined;
    const filename = fileURLToPath(params.textDocument.uri);
    if (!belongs(filename)) return undefined;
    return { filename, offset: document.offsetAt(params.position) };
  }

  function dispose(): void {
    stopped = true;
    revision++;
    project?.dispose();
    project = undefined;
  }

  connection.onInitialize((params) => {
    const uri = params.workspaceFolders?.[0]?.uri ?? params.rootUri;
    if (uri?.startsWith("file:")) root = fileURLToPath(uri);
    return {
      capabilities: {
        textDocumentSync: TextDocumentSyncKind.Incremental,
        hoverProvider: true,
        completionProvider: { triggerCharacters: [".", ":"] },
        definitionProvider: true,
        documentSymbolProvider: true,
      },
    };
  });
  connection.onInitialized(() => {
    void refresh();
  });
  connection.onHover(async (params) => {
    const target = await position(params);
    const value = target && project?.hover(target.filename, target.offset);
    return value
      ? {
          contents: [
            { language: "typescript", value: value.type },
            ...(value.documentation ? [value.documentation] : []),
          ],
        }
      : null;
  });
  connection.onCompletion(async (params) => {
    const target = await position(params);
    const document = documents.get(params.textDocument.uri);
    if (!target || !document) return [];
    return (project?.completions(target.filename, target.offset) ?? []).map(
      ({ replacement, ...item }) => ({
        ...item,
        ...(replacement
          ? {
              textEdit: {
                newText: item.insertText,
                range: {
                  start: document.positionAt(replacement.start),
                  end: document.positionAt(replacement.end),
                },
              },
            }
          : {}),
      }),
    );
  });
  connection.onDefinition(async (params) => {
    const target = await position(params);
    if (!target) return [];
    const locations = project?.definitions(target.filename, target.offset) ?? [];
    return (
      await Promise.all(
        locations.map(async (location) => {
          const document = await documentFor(location.filename);
          return document
            ? {
                uri: document.uri,
                range: {
                  start: document.positionAt(location.start),
                  end: document.positionAt(location.end),
                },
              }
            : undefined;
        }),
      )
    ).filter((location) => location !== undefined);
  });
  connection.onDocumentSymbol(async (params) => {
    if (!params.textDocument.uri.startsWith("file:")) return [];
    const filename = fileURLToPath(params.textDocument.uri);
    if (!belongs(filename)) return [];
    const document = await documentFor(filename);
    return document ? extractDocumentSymbols(filename, document.getText()) : [];
  });
  connection.onDidChangeWatchedFiles(() => {
    void refresh();
  });
  documents.onDidChangeContent(() => {
    void refresh();
  });
  documents.onDidClose(() => {
    void refresh();
  });
  connection.onShutdown(dispose);
  connection.onExit(dispose);
  documents.listen(connection);
  connection.listen();
}

function normalize(filename: string): string {
  const path = resolve(filename).replaceAll("\\", "/");
  return process.platform === "win32" ? path.toLowerCase() : path;
}
