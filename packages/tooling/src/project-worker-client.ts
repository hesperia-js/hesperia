import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectError, type BrowserBuild, type PreparedPluginEditorWire } from "./project.ts";
import { decodePublicValue } from "./public-values.ts";
import type { PluginWatch } from "./plugins.ts";

const PREFIX = "HESPERIA_PROJECT_WORKER:";

type EncodedBlobEntry = readonly [string, string, string];

type ProjectWorkerBuildValueBase = {
  readonly files: readonly EncodedBlobEntry[];
  readonly sources: BrowserBuild["sources"];
  readonly diagnostics: BrowserBuild["diagnostics"];
  readonly styles?: BrowserBuild["styles"];
  readonly styleRevision?: BrowserBuild["styleRevision"];
  readonly developmentDependencies?: BrowserBuild["developmentDependencies"];
  readonly watch?: BrowserBuild["watch"];
};

type WorkerHostingV1 = Extract<BrowserBuild["hosting"], { readonly version: 1 }>;
type WorkerHostingV2 = Extract<BrowserBuild["hosting"], { readonly version: 2 }>;

type ProjectWorkerBuildValue = ProjectWorkerBuildValueBase &
  (
    | { readonly hosting: WorkerHostingV1 }
    | { readonly hosting: WorkerHostingV2; readonly publicFiles: readonly EncodedBlobEntry[] }
  );

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  label: string,
): void {
  const keys = Object.keys(value);

  if (
    keys.some((key) => !allowed.includes(key)) ||
    required.some((key) => !Object.hasOwn(value, key))
  )
    throw new TypeError(`${label} has unsupported or missing fields`);
}

function parseErrorWatch(value: unknown): readonly PluginWatch[] {
  if (!Array.isArray(value)) throw new TypeError("Project worker error.watch must be an array");

  return value.map((entry, index): PluginWatch => {
    const label = `Project worker error.watch[${index}]`;

    if (!isRecord(entry)) throw new TypeError(`${label} must be a record`);

    if (entry.kind === "file") {
      assertOnlyKeys(entry, ["kind", "file"], ["kind", "file"], label);

      if (typeof entry.file !== "string") throw new TypeError(`${label}.file must be a string`);

      return { kind: "file", file: entry.file };
    }

    if (entry.kind === "directory") {
      assertOnlyKeys(entry, ["kind", "dir", "glob"], ["kind", "dir"], label);

      if (typeof entry.dir !== "string") throw new TypeError(`${label}.dir must be a string`);

      if (Object.hasOwn(entry, "glob") && typeof entry.glob !== "string")
        throw new TypeError(`${label}.glob must be a string`);

      return {
        kind: "directory",
        dir: entry.dir,
        ...(typeof entry.glob === "string" ? { glob: entry.glob } : {}),
      };
    }

    throw new TypeError(`${label} has an unsupported kind`);
  });
}

function encodedEntries(value: unknown, label: string): readonly EncodedBlobEntry[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);

  const keys = new Set<string>();

  return value.map((entry, index) => {
    if (
      !Array.isArray(entry) ||
      entry.length !== 3 ||
      typeof entry[0] !== "string" ||
      typeof entry[1] !== "string" ||
      typeof entry[2] !== "string"
    )
      throw new TypeError(`${label}[${index}] must contain a path, content type, and base64 bytes`);

    if (keys.has(entry[0])) throw new TypeError(`${label} contains duplicate path ${entry[0]}`);

    keys.add(entry[0]);

    return [entry[0], entry[1], entry[2]] as const;
  });
}

function assertPublicEntriesMatchInventory(
  records: unknown,
  entries: readonly EncodedBlobEntry[],
): void {
  if (!Array.isArray(records)) throw new TypeError("hosting.publicFiles must be an array");

  const inventory = new Map<string, string>();

  for (const [index, record] of records.entries()) {
    if (
      !isRecord(record) ||
      typeof record.urlPath !== "string" ||
      typeof record.contentType !== "string"
    )
      throw new TypeError(`hosting.publicFiles[${index}] must provide a URL and content type`);

    if (inventory.has(record.urlPath))
      throw new TypeError(`hosting.publicFiles contains duplicate URL ${record.urlPath}`);

    inventory.set(record.urlPath, record.contentType);
  }

  if (inventory.size !== entries.length)
    throw new TypeError("hosting.publicFiles inventory does not match the publicFiles tuples");

  for (const [urlPath, contentType] of entries)
    if (inventory.get(urlPath) !== contentType)
      throw new TypeError(
        `publicFiles tuple metadata does not match hosting.publicFiles for ${urlPath}`,
      );
}

function parseBuildValue(value: unknown): ProjectWorkerBuildValue {
  if (!isRecord(value)) throw new TypeError("Project worker build result must be a record");

  assertOnlyKeys(
    value,
    [
      "files",
      "hosting",
      "publicFiles",
      "sources",
      "diagnostics",
      "styles",
      "styleRevision",
      "developmentDependencies",
      "watch",
    ],
    ["files", "hosting", "sources", "diagnostics"],
    "Project worker build result",
  );

  const files = encodedEntries(value.files, "files");
  const hosting = value.hosting;

  if (isHostingV1(hosting)) {
    if (Object.hasOwn(value, "publicFiles"))
      throw new TypeError("A V1 worker result must omit publicFiles");

    return {
      files,
      hosting,
      sources: value.sources as BrowserBuild["sources"],
      diagnostics: value.diagnostics as BrowserBuild["diagnostics"],
      ...(value.styles !== undefined ? { styles: value.styles as BrowserBuild["styles"] } : {}),
      ...(value.styleRevision !== undefined
        ? { styleRevision: value.styleRevision as BrowserBuild["styleRevision"] }
        : {}),
      ...(value.developmentDependencies !== undefined
        ? {
            developmentDependencies:
              value.developmentDependencies as BrowserBuild["developmentDependencies"],
          }
        : {}),
      ...(value.watch !== undefined ? { watch: value.watch as BrowserBuild["watch"] } : {}),
    };
  }

  if (!Object.hasOwn(value, "publicFiles"))
    throw new TypeError("A V2 worker result must include publicFiles");

  const publicFiles = encodedEntries(value.publicFiles, "publicFiles");

  if (!isHostingV2(hosting)) throw new TypeError("A V2 worker result requires hosting version 2");

  assertPublicEntriesMatchInventory(hosting.publicFiles, publicFiles);

  return {
    files,
    hosting,
    publicFiles,
    sources: value.sources as BrowserBuild["sources"],
    diagnostics: value.diagnostics as BrowserBuild["diagnostics"],
    ...(value.styles !== undefined ? { styles: value.styles as BrowserBuild["styles"] } : {}),
    ...(value.styleRevision !== undefined
      ? { styleRevision: value.styleRevision as BrowserBuild["styleRevision"] }
      : {}),
    ...(value.developmentDependencies !== undefined
      ? {
          developmentDependencies:
            value.developmentDependencies as BrowserBuild["developmentDependencies"],
        }
      : {}),
    ...(value.watch !== undefined ? { watch: value.watch as BrowserBuild["watch"] } : {}),
  };
}

function isHostingV1(value: unknown): value is WorkerHostingV1 {
  return isRecord(value) && value.version === 1;
}

function isHostingV2(value: unknown): value is WorkerHostingV2 {
  return isRecord(value) && value.version === 2;
}

function hydrateBlobMap(entries: readonly EncodedBlobEntry[]): ReadonlyMap<string, Blob> {
  return new Map(
    entries.map(([path, contentType, bytesBase64]) => [
      path,
      new Blob([Buffer.from(bytesBase64, "base64")], { type: contentType }),
    ]),
  );
}

/** Run one project revision in a fresh project-root Bun process. */
export async function runProjectWorker(
  root: string,
  request:
    | { readonly kind: "check" }
    | { readonly kind: "build"; readonly development: boolean }
    | { readonly kind: "editor"; readonly sources: readonly (readonly [string, string])[] },
  signal?: AbortSignal,
): Promise<unknown> {
  signal?.throwIfAborted();

  const filename = resolve(fileURLToPath(new URL("../dist/project-worker.js", import.meta.url)));
  const child = Bun.spawn([process.execPath, filename], {
    cwd: resolve(root),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  const abort = () => child.kill();

  signal?.addEventListener("abort", abort, { once: true });

  try {
    child.stdin.write(JSON.stringify(request));

    await child.stdin.end();

    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    signal?.throwIfAborted();

    const line = stdout.split(/\r?\n/u).findLast((item) => item.startsWith(PREFIX));

    if (!line)
      throw new Error(`Project worker returned no result (exit ${code}): ${stderr || stdout}`);

    const result = JSON.parse(line.slice(PREFIX.length)) as {
      readonly ok: boolean;
      readonly value?: unknown;
      readonly error?: {
        readonly name: string;
        readonly message: string;
        readonly diagnostics?: ProjectError["diagnostics"];
        readonly watch?: unknown;
      };
    };

    if (!result.ok) {
      const error = result.error;

      if (error?.name === "ProjectError") {
        const watch = error.watch === undefined ? undefined : parseErrorWatch(error.watch);

        throw new ProjectError(
          error.message,
          error.diagnostics,
          watch === undefined ? undefined : { watch },
        );
      }

      throw new Error(error?.message ?? `Project worker exited ${code}`);
    }

    if (code !== 0) throw new Error(`Project worker exited ${code}: ${stderr}`);

    return result.value;
  } catch (error) {
    if (signal?.aborted) signal.throwIfAborted();

    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);

    child.kill();
  }
}

/** Check a complete project while its executable configuration stays in the worker. */
export async function checkInProjectProcess(
  root: string,
): Promise<readonly import("./project.ts").ProjectDiagnostic[]> {
  return (await runProjectWorker(root, {
    kind: "check",
  })) as readonly import("./project.ts").ProjectDiagnostic[];
}

/** Rebuild Blob artifacts returned by a project-root worker. */
export async function buildInProjectProcess(
  root: string,
  development: boolean,
  signal?: AbortSignal,
): Promise<BrowserBuild> {
  const value = parseBuildValue(
    await runProjectWorker(root, { kind: "build", development }, signal),
  );
  const files = hydrateBlobMap(value.files);
  const common = {
    files,
    sources: value.sources,
    diagnostics: value.diagnostics,
    ...(value.styles ? { styles: value.styles } : {}),
    ...(value.styleRevision ? { styleRevision: value.styleRevision } : {}),
    ...(value.developmentDependencies
      ? { developmentDependencies: value.developmentDependencies }
      : {}),
    ...(value.watch ? { watch: value.watch } : {}),
  };

  if (!("publicFiles" in value)) {
    if (value.hosting.version !== 1)
      throw new TypeError("A V1 worker result requires hosting version 1");

    return { ...common, hosting: value.hosting };
  }

  if (value.hosting.version !== 2)
    throw new TypeError("A V2 worker result requires hosting version 2");

  return {
    ...common,
    hosting: value.hosting,
    publicFiles: hydrateBlobMap(value.publicFiles),
  };
}

/** Prepare an editor revision without evaluating TypeScript config in the LSP process. */
export async function editorInProjectProcess(
  root: string,
  sources: ReadonlyMap<string, string>,
  signal?: AbortSignal,
): Promise<
  PreparedPluginEditorWire & {
    readonly configuration: import("./configuration.ts").ProjectConfiguration;
  }
> {
  const wire = (await runProjectWorker(
    root,
    {
      kind: "editor",
      sources: [...sources],
    },
    signal,
  )) as PreparedPluginEditorWire;
  return {
    ...wire,
    configuration: {
      ...wire.configuration,
      ...(wire.publicData
        ? {
            public: decodePublicValue(wire.publicData) as Readonly<
              Record<string, import("./public-values.ts").PublicValue>
            >,
          }
        : {}),
    },
  };
}
