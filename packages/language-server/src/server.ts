import { existsSync, watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve, relative, isAbsolute, dirname, basename } from "node:path";
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
import {
  readProject,
  readConfiguration,
  preparePluginEditor,
  hasBuiltinAssetImports,
  hydratePluginEditor,
  editorInProjectProcess,
  writeProjectTypes,
  type PreparedPluginEditor,
} from "@hesperia/tooling/project-service";
import {
  type ProjectCheckingOptions,
  type ProjectCheckingResult,
  type VirtualModule,
} from "@hesperia/compiler/editor";
import { EditorProject, type Completion, type Hover, type SourceLocation } from "./project.ts";
import { extractDocumentSymbols } from "./symbols.ts";
import { normalizeAbsolutePath as normalize } from "./utils.ts";

interface ServerProject {
  readonly diagnostics: ProjectCheckingResult;

  hover(filename: string, offset: number): Promise<Hover | undefined>;

  completions(filename: string, offset: number): Promise<readonly Completion[]>;

  definitions(filename: string, offset: number): Promise<readonly SourceLocation[]>;

  dispose(): Promise<void>;
}

type ProjectFactory = (
  modules: readonly VirtualModule[],
  options: ProjectCheckingOptions,
) => Promise<ServerProject>;

interface ServerRequest {
  readonly document: TextDocument;
  readonly filename: string;
  readonly offset: number;
  readonly revision: number;
  readonly project: ServerProject;
  readonly version: number;
}

function pluginServerProject(
  project: ServerProject,
  prepared: PreparedPluginEditor,
): ServerProject {
  const grouped = new Map<
    string,
    ProjectCheckingResult["modules"][number]["diagnostics"][number][]
  >();

  for (const diagnostic of prepared.diagnostics) {
    const prior = grouped.get(diagnostic.filename) ?? [];

    prior.push(diagnostic);

    grouped.set(diagnostic.filename, prior);
  }

  const modules = [
    ...prepared.modules.map(({ filename }) => ({
      filename,
      diagnostics: grouped.get(filename) ?? [],
    })),
    ...[...grouped]
      .filter(([filename]) => !prepared.modules.some((module) => module.filename === filename))
      .map(([filename, diagnostics]) => ({ filename, diagnostics })),
  ];
  return {
    diagnostics: {
      ...project.diagnostics,
      modules,
      diagnostics: modules.flatMap((module) => module.diagnostics),
    },

    hover(filename, offset) {
      return project.hover(filename, prepared.generatedOffset(filename, offset));
    },

    async completions(filename, offset) {
      const entries = await project.completions(
        filename,
        prepared.generatedOffset(filename, offset),
      );
      return entries.map((entry) =>
        entry.replacement
          ? {
              ...entry,
              replacement: {
                start: prepared.authoredOffset(filename, entry.replacement.start),
                end: prepared.authoredOffset(filename, entry.replacement.end),
              },
            }
          : entry,
      );
    },

    async definitions(filename, offset) {
      const locations = await project.definitions(
        filename,
        prepared.generatedOffset(filename, offset),
      );
      return locations.map((location) => {
        const mapped = prepared.declarationLocation(
          location.filename,
          location.start,
          location.end,
        );

        if (mapped) return mapped;

        const origin = prepared.declarationOrigin(location.filename);

        if (origin) return origin;

        return {
          ...location,
          start: prepared.authoredOffset(location.filename, location.start),
          end: prepared.authoredOffset(location.filename, location.end),
        };
      });
    },

    dispose() {
      return project.dispose();
    },
  };
}

/**
 * Serve Hesperia diagnostics and source navigation over standard input/output.
 * Unsaved authored documents override captured disk source. Each refresh owns a
 * revision; only its current project can publish diagnostics or return requests.
 *
 * @param connection - LSP connection, defaulting to process standard input/output.
 * @param createProject - Project factory used by the server; callers normally omit it.
 * @param readSources - Project source reader; test harnesses can hold a read boundary.
 * @param prepareEditor - Project-root worker adapter; test harnesses can observe worker starts.
 */
export function startLanguageServer(
  connection: Connection = createConnection(process.stdin, process.stdout),
  createProject: ProjectFactory = EditorProject.create,
  readSources: typeof readProject = readProject,
  prepareEditor: typeof editorInProjectProcess = editorInProjectProcess,
): void {
  const documents = new TextDocuments(TextDocument);
  let root = process.cwd();
  let project: ServerProject | undefined;
  let projectRevision = 0;
  let configuration: Awaited<ReturnType<typeof readConfiguration>> | undefined;
  let lastPluginInputs: PreparedPluginEditor | undefined;
  let revision = 0;
  let pending: Promise<void> = Promise.resolve();
  let stopped = false;
  let published = new Set<string>();
  let disposal: Promise<void> | undefined;
  let workerAbort: AbortController | undefined;
  const pluginWatchers = new Map<string, FSWatcher>();

  function watchPluginInputs(inputs: PreparedPluginEditor["watch"]): void {
    const requested = new Set<string>();

    for (const input of inputs) {
      const target = resolve(input.kind === "file" ? input.file : input.dir);
      const key = `${input.kind}:${normalize(target)}`;

      requested.add(key);

      if (pluginWatchers.has(key)) continue;

      try {
        const watcher =
          input.kind === "file"
            ? watch(dirname(target), (_event, changed) => {
                if (changed && normalize(String(changed)) === normalize(basename(target)))
                  void refresh();
              })
            : watch(target, { recursive: true }, () => {
                void refresh();
              });

        watcher.on("error", (error) => connection.console.warn(error.message));

        pluginWatchers.set(key, watcher);
      } catch (error) {
        connection.console.warn(error instanceof Error ? error.message : String(error));
      }
    }

    for (const [key, watcher] of pluginWatchers)
      if (!requested.has(key)) {
        watcher.close();

        pluginWatchers.delete(key);
      }
  }

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

  function current(request: ServerRequest): boolean {
    return (
      !stopped &&
      revision === request.revision &&
      project === request.project &&
      documents.get(request.document.uri)?.version === request.version
    );
  }

  async function refresh(): Promise<void> {
    const requested = ++revision;

    workerAbort?.abort();

    pending = pending
      .then(async () => {
        if (stopped || requested !== revision) return;

        const sources = new Map(
          [...(await readSources(root))].map(([filename, source]) => [
            normalize(filename),
            { filename, source },
          ]),
        );
        const versions = new Map<string, number>();

        for (const document of documents.all()) {
          if (!document.uri.startsWith("file:")) continue;

          const filename = fileURLToPath(document.uri);

          if (!belongs(filename)) continue;

          sources.set(normalize(filename), { filename, source: document.getText() });

          versions.set(normalize(filename), document.version);
        }

        if (stopped || requested !== revision) return;

        let configurationError: string | undefined;
        let pluginInputs: PreparedPluginEditor | undefined;
        const typescriptConfiguration = existsSync(resolve(root, "hesperia.config.ts"));

        try {
          if (typescriptConfiguration) {
            const controller = new AbortController();
            workerAbort = controller;
            let wire: Awaited<ReturnType<typeof editorInProjectProcess>>;

            try {
              wire = await prepareEditor(
                root,
                new Map([...sources.values()].map(({ filename, source }) => [filename, source])),
                controller.signal,
              );
            } finally {
              if (workerAbort === controller) workerAbort = undefined;
            }

            configuration = wire.configuration;
            pluginInputs = hydratePluginEditor(wire);
          } else configuration = await readConfiguration(root);
        } catch (error) {
          const fallback =
            typescriptConfiguration && lastPluginInputs
              ? "the last valid project snapshot"
              : configuration
                ? "the last valid configuration"
                : "default configuration";
          configurationError = `${error instanceof Error ? error.message : String(error)}. Editor checking uses ${fallback} until this file is repaired.`;

          if (typescriptConfiguration) pluginInputs = lastPluginInputs;
        }

        if (stopped || requested !== revision) return;

        if (typescriptConfiguration && configurationError && !pluginInputs) {
          const filename = resolve(root, "hesperia.config.ts");
          const document =
            (await documentFor(filename)) ??
            TextDocument.create(pathToFileURL(filename).href, "typescript", 0, "");

          await connection.sendDiagnostics({
            uri: document.uri,
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

          published.add(document.uri);

          return;
        }

        try {
          await writeProjectTypes(
            root,
            new Map([...sources.values()].map(({ filename, source }) => [filename, source])),
            configuration,
          );
        } catch (error) {
          connection.console.warn(error instanceof Error ? error.message : String(error));
        }

        if (stopped || requested !== revision) return;

        let candidate: ServerProject | undefined;

        try {
          const editorSources = new Map(
            [...sources.values()].map(({ filename, source }) => [filename, source]),
          );
          pluginInputs ??=
            configuration &&
            (configuration.plugins?.length ||
              configuration.public !== undefined ||
              hasBuiltinAssetImports(editorSources))
              ? await preparePluginEditor(editorSources, root, configuration)
              : undefined;
          const checked = await createProject(pluginInputs?.modules ?? [...sources.values()], {
            root,
            ...configuration,
            documentShell: true,
            ...(pluginInputs
              ? {
                  additionalFiles: pluginInputs.additionalFiles,
                  checkingRoots: pluginInputs.checkingRoots,
                  resolution: pluginInputs.resolution,
                }
              : {}),
          });
          candidate = pluginInputs ? pluginServerProject(checked, pluginInputs) : checked;

          if (stopped || requested !== revision) {
            await candidate.dispose();

            candidate = undefined;
            return;
          }

          const outgoingProject = candidate;
          const previous = project;
          project = outgoingProject;
          projectRevision = requested;

          if (typescriptConfiguration && !configurationError) lastPluginInputs = pluginInputs;
          else if (!typescriptConfiguration) lastPluginInputs = undefined;

          candidate = undefined;

          watchPluginInputs(pluginInputs?.watch ?? []);

          if (previous) {
            try {
              await previous.dispose();
            } catch (error) {
              connection.console.error(error instanceof Error ? error.message : String(error));
            }
          }

          if (stopped || requested !== revision || project !== outgoingProject) return;

          const outgoing = new Map<string, { diagnostics: Diagnostic[]; version?: number }>();

          if (configurationError) {
            const filename = resolve(
              root,
              typescriptConfiguration ? "hesperia.config.ts" : "hesperia.config.json",
            );
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

          for (const module of outgoingProject.diagnostics.modules) {
            if (stopped || requested !== revision || project !== outgoingProject) return;

            const filename = resolve(root, module.filename);
            const document = await documentFor(filename);

            if (!document) continue;

            outgoing.set(document.uri, {
              ...(versions.has(normalize(filename))
                ? { version: versions.get(normalize(filename))! }
                : {}),
              diagnostics: module.diagnostics.map((item) => {
                const end = document.positionAt(document.getText().length);
                return {
                  code: item.code,
                  source: "hesperia",
                  message: item.span
                    ? item.message
                    : item.message.includes("location unavailable")
                      ? item.message
                      : `${item.message} (Source location unavailable.)`,
                  severity:
                    item.severity === "error"
                      ? DiagnosticSeverity.Error
                      : item.severity === "warning"
                        ? DiagnosticSeverity.Warning
                        : DiagnosticSeverity.Information,
                  range: item.span
                    ? {
                        start: document.positionAt(item.span.start),
                        end: document.positionAt(item.span.end),
                      }
                    : { start: end, end },
                };
              }),
            });
          }

          if (stopped || requested !== revision || project !== outgoingProject) return;

          for (const uri of published) {
            if (stopped || requested !== revision || project !== outgoingProject) return;

            if (!outgoing.has(uri)) await connection.sendDiagnostics({ uri, diagnostics: [] });
          }

          for (const [uri, result] of outgoing) {
            if (stopped || requested !== revision || project !== outgoingProject) return;

            await connection.sendDiagnostics({ uri, ...result });

            published.add(uri);
          }

          published = new Set(outgoing.keys());
        } catch (error) {
          await candidate?.dispose();

          throw error;
        }
      })
      .catch((error) => {
        if (!stopped && requested === revision)
          connection.console.error(error instanceof Error ? error.message : String(error));
      });
    await pending;
  }

  async function requestFor(
    params: TextDocumentPositionParams,
  ): Promise<ServerRequest | undefined> {
    while (!stopped) {
      const work = pending;
      await work;

      if (work === pending) break;
    }

    const document = documents.get(params.textDocument.uri);

    if (!document || !params.textDocument.uri.startsWith("file:")) return undefined;

    const filename = fileURLToPath(params.textDocument.uri);

    if (!belongs(filename) || !project || projectRevision !== revision) return undefined;

    return {
      document,
      filename,
      offset: document.offsetAt(params.position),
      revision: projectRevision,
      project,
      version: document.version,
    };
  }

  function dispose(): Promise<void> {
    if (disposal) return disposal;

    stopped = true;
    revision++;

    workerAbort?.abort();

    disposal = (async () => {
      await pending;
      const currentProject = project;
      project = undefined;

      for (const watcher of pluginWatchers.values()) watcher.close();

      pluginWatchers.clear();

      if (currentProject) await currentProject.dispose();
    })();
    return disposal;
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
    const request = await requestFor(params);

    if (!request) return null;

    const value = await request.project.hover(request.filename, request.offset);

    if (!current(request) || !value) return null;

    return {
      contents: [
        { language: "typescript", value: value.type },
        ...(value.documentation ? [value.documentation] : []),
      ],
    };
  });

  connection.onCompletion(async (params) => {
    const request = await requestFor(params);

    if (!request) return [];

    const completions = await request.project.completions(request.filename, request.offset);

    if (!current(request)) return [];

    return completions.map(({ replacement, ...item }) => ({
      ...item,
      ...(replacement
        ? {
            textEdit: {
              newText: item.insertText,
              range: {
                start: request.document.positionAt(replacement.start),
                end: request.document.positionAt(replacement.end),
              },
            },
          }
        : {}),
    }));
  });

  connection.onDefinition(async (params) => {
    const request = await requestFor(params);

    if (!request) return [];

    const locations = await request.project.definitions(request.filename, request.offset);

    if (!current(request)) return [];

    const results = await Promise.all(
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
    );
    return current(request) ? results.filter((location) => location !== undefined) : [];
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

  connection.onExit(() => {
    void dispose();
  });

  documents.listen(connection);

  connection.listen();
}
