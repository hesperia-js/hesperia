import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectError, type BrowserBuild, type PreparedPluginEditorWire } from "./project.ts";
import { decodePublicValue } from "./public-values.ts";

const PREFIX = "HESPERIA_PROJECT_WORKER:";

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
      };
    };

    if (!result.ok) {
      const error = result.error;

      if (error?.name === "ProjectError") throw new ProjectError(error.message, error.diagnostics);

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
  const value = (await runProjectWorker(root, { kind: "build", development }, signal)) as {
    readonly files: readonly (readonly [string, string, string])[];
    readonly hosting: BrowserBuild["hosting"];
    readonly sources: BrowserBuild["sources"];
    readonly diagnostics: BrowserBuild["diagnostics"];
    readonly styles?: BrowserBuild["styles"];
    readonly styleRevision?: BrowserBuild["styleRevision"];
    readonly developmentDependencies?: BrowserBuild["developmentDependencies"];
    readonly watch?: BrowserBuild["watch"];
  };
  return {
    hosting: value.hosting,
    files: new Map(
      value.files.map(([path, type, encoded]) => [
        path,
        new Blob([Buffer.from(encoded, "base64")], { type }),
      ]),
    ),
    sources: value.sources,
    diagnostics: value.diagnostics,
    ...(value.styles ? { styles: value.styles } : {}),
    ...(value.styleRevision ? { styleRevision: value.styleRevision } : {}),
    ...(value.developmentDependencies
      ? { developmentDependencies: value.developmentDependencies }
      : {}),
    ...(value.watch ? { watch: value.watch } : {}),
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
