import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rmdir, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, parse, resolve, sep } from "node:path";
import { creatorTemplateRoot } from "#hesperia-package-resources";
import { elysiaTemplate } from "./templates/elysia.ts";
import { frontendTemplate } from "./templates/frontend.ts";

export type HostIntegration = "elysia" | "none";

export interface CreatorRequest {
  readonly destination: string;
  readonly hostIntegration: HostIntegration;
  readonly install: boolean;
}

export interface CreatorPlan {
  readonly packageName: string;
  readonly projectRoot: string;
  readonly hostIntegration: HostIntegration;
  readonly install: boolean;
}

export type CreatorProgress =
  | {
      readonly kind: "scaffold";
      readonly relativePath: string;
      readonly completedFiles: number;
      readonly totalFiles: number;
    }
  | { readonly kind: "created"; readonly packageName: string; readonly projectRoot: string }
  | { readonly kind: "install"; readonly status: "started" | "completed" };

export interface CreatorCleanup {
  readonly status: "not-needed" | "complete" | "retained";
  readonly retainedPaths: readonly string[];
  readonly reason?: string;
}

type CreatorOutcome =
  | {
      readonly status: "created";
      readonly packageName: string;
      readonly projectRoot: string;
      readonly installation: "skipped" | "installed";
      readonly cleanup: CreatorCleanup;
    }
  | {
      readonly status: "cancelled";
      readonly projectRoot: string;
      readonly cleanup: CreatorCleanup;
      readonly installer?: CreatorInstallerStop;
    }
  | {
      readonly status: "failed";
      readonly message: string;
      readonly projectRoot: string;
      readonly cleanup: CreatorCleanup;
    };

export type CreatorResult = CreatorOutcome & {
  readonly retirement: "complete" | "incomplete";
};

export interface CreatorInstallerStop {
  readonly pid: number;
  readonly signalRequested: "SIGINT";
  readonly forcedStopRequested: boolean;
  readonly reaped: boolean;
  readonly exitCode: number | null;
  readonly signalCode: string | number | null;
  readonly pendingResource: boolean;
  readonly signalRequestError?: string;
  readonly unrefError?: string;
}

export interface CreatorExecutionOptions {
  readonly signal: AbortSignal;
  readonly installerOutput?: { readonly stdout: number; readonly stderr: number };
  readonly onProgress?: (progress: CreatorProgress) => void;
}

interface PathIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

interface OwnedFile extends PathIdentity {
  readonly contentDigest: string;
}

interface TemplateFile {
  readonly relativePath: string;
  readonly variant: "frontend" | "elysia";
  readonly assetPath: string;
}

interface CreatorRetirementObservation {
  filePending: boolean;
  installerPending: boolean;
}

type InstallOutcome =
  | { readonly status: "installed" }
  | { readonly status: "failed"; readonly message: string }
  | { readonly status: "cancelled"; readonly stop: CreatorInstallerStop };

const projectNamePlaceholder = "HESPERIA_PROJECT_NAME";
const projectNameFiles = new Set(["package.json", "app.tsx", "README.md"]);
const installerStopTimeoutMs = 5_000;

class CreatorCancellation extends Error {
  readonly installer: CreatorInstallerStop | undefined;

  constructor(installer?: CreatorInstallerStop) {
    super("Creator execution was cancelled.");
    this.installer = installer;
  }
}

function packageNameFor(destination: string): string {
  const name = basename(destination)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "");

  return name || "hesperia-app";
}

export function resolveCreator(request: CreatorRequest): CreatorPlan {
  if (request.destination.length === 0) throw new Error("Destination cannot be empty.");

  const projectRoot = resolve(request.destination);

  return {
    packageName: packageNameFor(projectRoot),
    projectRoot,
    hostIntegration: request.hostIntegration,
    install: request.install,
  };
}

function templateFilesFor(hostIntegration: HostIntegration): TemplateFile[] {
  const files = new Map<string, TemplateFile>();

  for (const [relativePath, assetPath] of frontendTemplate) {
    files.set(relativePath, { relativePath, variant: "frontend", assetPath });
  }

  if (hostIntegration === "elysia") {
    for (const [relativePath, assetPath] of elysiaTemplate) {
      files.set(relativePath, { relativePath, variant: "elysia", assetPath });
    }
  }

  return [...files.values()];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;

  return typeof error.code === "string" ? error.code : undefined;
}

function checkCancellation(signal: AbortSignal): void {
  if (signal.aborted) throw new CreatorCancellation();
}

function emitProgress(options: CreatorExecutionOptions, progress: CreatorProgress): void {
  options.onProgress?.(progress);
  checkCancellation(options.signal);
}

async function ensureDirectoryChain(
  directory: string,
  ownedDirectories: Map<string, PathIdentity | undefined>,
): Promise<void> {
  const target = resolve(directory);
  const { root } = parse(target);
  let current = root;

  for (const segment of target.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, segment);

    try {
      await mkdir(current);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;

      const existing = await stat(current, { bigint: true });

      if (!existing.isDirectory()) throw error;

      continue;
    }

    try {
      const created = await lstat(current, { bigint: true });

      if (!created.isDirectory()) {
        throw new Error(`Created directory changed before use: ${current}`);
      }

      ownedDirectories.set(current, { device: created.dev, inode: created.ino });
    } catch (error) {
      ownedDirectories.set(current, undefined);
      throw error;
    }
  }
}

async function writeOwnedFile(
  filename: string,
  contents: string | Uint8Array,
  ownedFiles: Map<string, OwnedFile | undefined>,
  signal: AbortSignal,
  retirement: CreatorRetirementObservation,
): Promise<void> {
  const file = await open(filename, "wx");

  retirement.filePending = true;

  let identity: PathIdentity | undefined;

  try {
    const created = await file.stat({ bigint: true });

    identity = { device: created.dev, inode: created.ino };
    ownedFiles.set(filename, {
      ...identity,
      contentDigest: createHash("sha256").update("").digest("hex"),
    });
    checkCancellation(signal);
    await file.writeFile(contents);
    ownedFiles.set(filename, {
      ...identity,
      contentDigest: createHash("sha256").update(contents).digest("hex"),
    });
  } catch (error) {
    if (identity === undefined) ownedFiles.set(filename, undefined);

    throw error;
  } finally {
    await file.close();
    retirement.filePending = false;
  }
}

function directoryDepth(path: string): number {
  return resolve(path).split(sep).length;
}

async function cleanupOwnedPaths(
  ownedFiles: Map<string, OwnedFile | undefined>,
  ownedDirectories: Map<string, PathIdentity | undefined>,
): Promise<CreatorCleanup> {
  const retainedPaths = new Set<string>();

  for (const [filename, ownedFile] of [...ownedFiles.entries()].reverse()) {
    if (ownedFile === undefined) {
      retainedPaths.add(filename);
      continue;
    }

    try {
      const current = await lstat(filename, { bigint: true });

      if (!current.isFile() || !matchesIdentity(ownedFile, current)) {
        retainedPaths.add(filename);
        continue;
      }

      const contents = await readFile(filename);

      if (createHash("sha256").update(contents).digest("hex") !== ownedFile.contentDigest) {
        retainedPaths.add(filename);
        continue;
      }

      const verified = await lstat(filename, { bigint: true });

      if (!verified.isFile() || !matchesIdentity(ownedFile, verified)) {
        retainedPaths.add(filename);
        continue;
      }

      await unlink(filename);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") retainedPaths.add(filename);
    }
  }

  const directories = [...ownedDirectories.entries()].sort(
    ([left], [right]) => directoryDepth(right) - directoryDepth(left),
  );

  for (const [directory, ownedDirectory] of directories) {
    if (ownedDirectory === undefined) {
      retainedPaths.add(directory);
      continue;
    }

    try {
      const current = await lstat(directory, { bigint: true });

      if (!current.isDirectory() || !matchesIdentity(ownedDirectory, current)) {
        retainedPaths.add(directory);
        continue;
      }

      await rmdir(directory);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") retainedPaths.add(directory);
    }
  }

  return {
    status: retainedPaths.size === 0 ? "complete" : "retained",
    retainedPaths: [...retainedPaths],
  };
}

function matchesIdentity(
  identity: PathIdentity,
  stats: { readonly dev: bigint; readonly ino: bigint },
): boolean {
  return identity.device === stats.dev && identity.inode === stats.ino;
}

async function waitForExit(
  installation: Bun.Subprocess,
  timeoutMs: number,
): Promise<number | null> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<null>((resolveTimeout) => {
    timeout = setTimeout(() => resolveTimeout(null), timeoutMs);
  });

  try {
    return await Promise.race([installation.exited, timedOut]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function stopInstallation(installation: Bun.Subprocess): Promise<CreatorInstallerStop> {
  let signalRequestError: string | undefined;
  let unrefError: string | undefined;
  let forcedStopRequested = false;

  try {
    installation.kill("SIGINT");
  } catch (error) {
    signalRequestError = errorMessage(error);
  }

  let exitCode = await waitForExit(installation, installerStopTimeoutMs);

  if (exitCode === null) {
    forcedStopRequested = true;

    try {
      installation.kill("SIGKILL");
    } catch (error) {
      signalRequestError ??= errorMessage(error);
    }

    exitCode = await waitForExit(installation, installerStopTimeoutMs);
  }

  const reaped = exitCode !== null;

  if (!reaped) {
    try {
      installation.unref();
    } catch (error) {
      unrefError = errorMessage(error);
    }
  }

  return {
    pid: installation.pid,
    signalRequested: "SIGINT",
    forcedStopRequested,
    reaped,
    exitCode: installation.exitCode,
    signalCode: installation.signalCode,
    pendingResource: !reaped,
    ...(signalRequestError === undefined ? {} : { signalRequestError }),
    ...(unrefError === undefined ? {} : { unrefError }),
  };
}

async function installDependencies(
  projectRoot: string,
  signal: AbortSignal,
  output: { readonly stdout: number; readonly stderr: number },
  options: CreatorExecutionOptions,
  retirement: CreatorRetirementObservation,
): Promise<InstallOutcome> {
  checkCancellation(signal);

  emitProgress(options, { kind: "install", status: "started" });

  retirement.installerPending = true;
  const installation = Bun.spawn([process.execPath, "install"], {
    cwd: projectRoot,
    stdout: output.stdout,
    stderr: output.stderr,
  });

  let resolveAbort!: () => void;
  const aborted = new Promise<void>((resolveAbortPromise) => {
    resolveAbort = resolveAbortPromise;
  });
  const onAbort = (): void => resolveAbort();

  signal.addEventListener("abort", onAbort, { once: true });

  try {
    if (signal.aborted) onAbort();

    const outcome = await Promise.race([
      installation.exited.then((exitCode) => {
        retirement.installerPending = false;
        return { status: "exited" as const, exitCode };
      }),
      aborted.then(() => ({ status: "cancelled" as const })),
    ]);

    if (outcome.status === "cancelled") {
      const stop = await stopInstallation(installation);

      retirement.installerPending = !stop.reaped || stop.pendingResource;
      return { status: "cancelled", stop };
    }

    if (outcome.exitCode !== 0) {
      return {
        status: "failed",
        message: `Dependency installation failed with exit code ${outcome.exitCode}.`,
      };
    }

    return { status: "installed" };
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function retainedCompletedProject(projectRoot: string, reason: string): CreatorCleanup {
  return { status: "retained", retainedPaths: [projectRoot], reason };
}

export async function executeCreator(
  plan: CreatorPlan,
  options: CreatorExecutionOptions,
): Promise<CreatorResult> {
  const ownedFiles = new Map<string, OwnedFile | undefined>();
  const ownedDirectories = new Map<string, PathIdentity | undefined>();
  const retirement: CreatorRetirementObservation = { filePending: false, installerPending: false };
  const finish = (result: CreatorOutcome): CreatorResult => ({
    ...result,
    retirement:
      retirement.filePending ||
      retirement.installerPending ||
      (result.status === "cancelled" && result.installer?.pendingResource === true)
        ? "incomplete"
        : "complete",
  });
  let scaffoldComplete = false;

  try {
    checkCancellation(options.signal);
    await ensureDirectoryChain(plan.projectRoot, ownedDirectories);
    checkCancellation(options.signal);

    if ((await readdir(plan.projectRoot)).length > 0) {
      throw new Error(`Destination must be empty: ${plan.projectRoot}`);
    }

    const templateFiles = templateFilesFor(plan.hostIntegration);

    for (const [index, template] of templateFiles.entries()) {
      checkCancellation(options.signal);

      const filename = join(plan.projectRoot, template.relativePath);

      await ensureDirectoryChain(dirname(filename), ownedDirectories);
      checkCancellation(options.signal);

      const source = join(creatorTemplateRoot, template.variant, template.assetPath);
      const sourceContents = await readFile(source);

      checkCancellation(options.signal);
      let contents: string | Uint8Array = sourceContents;

      if (projectNameFiles.has(template.relativePath)) {
        contents = sourceContents
          .toString("utf8")
          .replaceAll(projectNamePlaceholder, plan.packageName);
      }

      await writeOwnedFile(filename, contents, ownedFiles, options.signal, retirement);

      emitProgress(options, {
        kind: "scaffold",
        relativePath: template.relativePath,
        completedFiles: index + 1,
        totalFiles: templateFiles.length,
      });
    }

    scaffoldComplete = true;

    emitProgress(options, {
      kind: "created",
      packageName: plan.packageName,
      projectRoot: plan.projectRoot,
    });

    if (!plan.install) {
      return finish({
        status: "created",
        packageName: plan.packageName,
        projectRoot: plan.projectRoot,
        installation: "skipped",
        cleanup: { status: "not-needed", retainedPaths: [] },
      });
    }

    if (options.installerOutput === undefined) {
      throw new Error("Dependency installation requires caller-owned output streams.");
    }

    const installation = await installDependencies(
      plan.projectRoot,
      options.signal,
      options.installerOutput,
      options,
      retirement,
    );

    if (installation.status === "cancelled") {
      if (!installation.stop.reaped) {
        return finish({
          status: "cancelled",
          projectRoot: plan.projectRoot,
          cleanup: retainedCompletedProject(
            plan.projectRoot,
            "The installer remained active; its project files were retained.",
          ),
          installer: installation.stop,
        });
      }

      throw new CreatorCancellation(installation.stop);
    }

    if (installation.status === "failed") {
      return finish({
        status: "failed",
        message: installation.message,
        projectRoot: plan.projectRoot,
        cleanup: { status: "not-needed", retainedPaths: [] },
      });
    }

    emitProgress(options, { kind: "install", status: "completed" });

    return finish({
      status: "created",
      packageName: plan.packageName,
      projectRoot: plan.projectRoot,
      installation: "installed",
      cleanup: { status: "not-needed", retainedPaths: [] },
    });
  } catch (error) {
    const cancelled = options.signal.aborted || error instanceof CreatorCancellation;

    if (scaffoldComplete) {
      const cleanup = retainedCompletedProject(
        plan.projectRoot,
        cancelled
          ? "The scaffold completed before cancellation, so it was kept."
          : "The scaffold was complete and remains available after a later operation failed.",
      );

      if (cancelled) {
        return finish({
          status: "cancelled",
          projectRoot: plan.projectRoot,
          cleanup,
          ...(error instanceof CreatorCancellation && error.installer !== undefined
            ? { installer: error.installer }
            : {}),
        });
      }

      return finish({
        status: "failed",
        message: errorMessage(error),
        projectRoot: plan.projectRoot,
        cleanup,
      });
    }

    const cleanup = await cleanupOwnedPaths(ownedFiles, ownedDirectories);

    if (cancelled) {
      return finish({
        status: "cancelled",
        projectRoot: plan.projectRoot,
        cleanup,
        ...(error instanceof CreatorCancellation && error.installer !== undefined
          ? { installer: error.installer }
          : {}),
      });
    }

    return finish({
      status: "failed",
      message: errorMessage(error),
      projectRoot: plan.projectRoot,
      cleanup,
    });
  }
}
