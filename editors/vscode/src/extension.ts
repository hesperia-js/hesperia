import * as vscode from "vscode";
import { createRequire } from "node:module";
import { isAbsolute, join, relative } from "node:path";
import {
  LanguageClient,
  type LanguageClientOptions,
  type ServerOptions,
} from "vscode-languageclient/node";

const clients = new Map<string, LanguageClient>();

/** Start one project-owned Hesperia language server per trusted workspace folder. */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  if (!vscode.workspace.isTrusted) return;

  async function attach(folder: vscode.WorkspaceFolder): Promise<void> {
    if (clients.has(folder.uri.toString()) || folder.uri.scheme !== "file") return;

    let server: string;

    try {
      const require = createRequire(join(folder.uri.fsPath, "package.json"));
      server = require.resolve("@hesperia/language-server/bin");
    } catch {
      return;
    }

    const sourcePattern = new vscode.RelativePattern(folder, "src/**/*.{ts,tsx,mts}");
    const sources = vscode.workspace.createFileSystemWatcher(sourcePattern);
    const rootShell = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folder, "app.tsx"),
    );
    const typedDependencies = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folder, "**/*.{ts,mts}"),
    );
    const config = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folder, "{tsconfig.json,hesperia.config.json,hesperia.config.ts}"),
    );

    context.subscriptions.push(sources, rootShell, typedDependencies, config);

    const serverOptions: ServerOptions = {
      command: "bun",
      args: [server],
      options: { cwd: folder.uri.fsPath },
    };
    const clientOptions: LanguageClientOptions = {
      workspaceFolder: folder,
      documentSelector: [
        {
          scheme: "file",
          language: "hesperia-tsx",
          pattern: { baseUri: folder.uri.toString(), pattern: "src/**/*.{ts,tsx,mts}" },
        },
        {
          scheme: "file",
          language: "hesperia-tsx",
          pattern: { baseUri: folder.uri.toString(), pattern: "app.tsx" },
        },
        {
          scheme: "file",
          language: "typescript",
          pattern: { baseUri: folder.uri.toString(), pattern: "**/*.{ts,mts}" },
        },
      ],
      synchronize: { fileEvents: [sources, rootShell, typedDependencies, config] },
      middleware: {
        didOpen(document, next) {
          return isAuthoredPath(folder, document.uri.fsPath) ? next(document) : Promise.resolve();
        },

        didChange(event, next) {
          return isAuthoredPath(folder, event.document.uri.fsPath)
            ? next(event)
            : Promise.resolve();
        },

        didClose(document, next) {
          return isAuthoredPath(folder, document.uri.fsPath) ? next(document) : Promise.resolve();
        },

        workspace: {
          didChangeWatchedFile(event, next) {
            return isAuthoredPath(folder, vscode.Uri.parse(event.uri).fsPath)
              ? next(event)
              : Promise.resolve();
          },
        },

        handleDiagnostics(uri, diagnostics, next) {
          next(
            uri,
            uri.fsPath.endsWith(".tsx")
              ? diagnostics
              : diagnostics.filter((diagnostic) => {
                  const code =
                    typeof diagnostic.code === "object" ? diagnostic.code.value : diagnostic.code;
                  return typeof code === "string" && code.startsWith("HES-");
                }),
          );
        },
      },
    };
    const client = new LanguageClient(
      `hesperia:${folder.name}`,
      "Hesperia",
      serverOptions,
      clientOptions,
    );

    clients.set(folder.uri.toString(), client);

    try {
      await client.start();
    } catch (error) {
      clients.delete(folder.uri.toString());

      await client.dispose();

      throw error;
    }

    for (const document of vscode.workspace.textDocuments) await recognize(document);
  }

  async function recognize(document: vscode.TextDocument): Promise<void> {
    if (
      document.uri.scheme !== "file" ||
      !document.fileName.endsWith(".tsx") ||
      document.languageId === "hesperia-tsx"
    )
      return;

    const folder = vscode.workspace.getWorkspaceFolder(document.uri);

    if (!folder || !clients.has(folder.uri.toString())) return;

    if (!isAuthoredPath(folder, document.uri.fsPath)) return;

    const workspacePath = relative(folder.uri.fsPath, document.uri.fsPath).replaceAll("\\", "/");

    if (workspacePath !== "app.tsx" && !workspacePath.startsWith("src/")) return;

    await vscode.languages.setTextDocumentLanguage(document, "hesperia-tsx");
  }

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((document) => {
      void recognize(document);
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders((event) => {
      for (const folder of event.removed) {
        const key = folder.uri.toString();
        const client = clients.get(key);

        clients.delete(key);

        void client?.dispose();
      }

      for (const folder of event.added) void attach(folder);
    }),
  );

  await Promise.all((vscode.workspace.workspaceFolders ?? []).map(attach));
}

function isAuthoredPath(folder: vscode.WorkspaceFolder, filename: string): boolean {
  const path = relative(folder.uri.fsPath, filename).replaceAll("\\", "/");

  if (path === ".." || path.startsWith("../") || isAbsolute(path)) return false;

  return !path
    .split("/")
    .some(
      (segment) =>
        segment.toLowerCase() === "node_modules" || segment.toLowerCase() === ".hesperia",
    );
}

/** Stop all language servers when the extension host unloads this extension. */
export async function deactivate(): Promise<void> {
  await Promise.all([...clients.values()].map((client) => client.dispose()));

  clients.clear();
}
