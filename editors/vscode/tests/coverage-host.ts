import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  readEditorCoverageConfig,
  splitEditorOwnerCoverage,
  writeEditorOwnerCaptureError,
  writeEditorOwnerExit,
  writeEditorOwnerSupportCoverage,
  writeEditorOwnerStart,
} from "../../../scripts/ci/coverage-editor-process.ts";

const config = readEditorCoverageConfig();
const assertions = createRequire(__filename)(config.testHostPath) as { run: () => Promise<void> };
const testHostModule =
  createRequire(__filename).cache[resolve(dirname(config.testHostPath), "coverage-host.cjs")];

interface OwnerStartReceipt {
  readonly format: "hesperia-editor-owner-start";
  readonly version: 1;
  readonly runId: string;
  readonly populationFingerprint: string;
  readonly ownerId: string;
  readonly role: "extension-host" | "language-server";
  readonly pid: number;
  readonly ppid: number;
  readonly execPath: string;
  readonly argv: readonly string[];
  readonly startedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function readJsonIfReady(path: string): unknown {
  if (!existsSync(path)) return undefined;

  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function linuxStarttimeTicks(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");

    if (close < 0) return undefined;

    const fields = stat
      .slice(close + 1)
      .trim()
      .split(/\s+/u);
    const ticks = Number(fields[19]);
    return Number.isSafeInteger(ticks) && ticks > 0 ? ticks : undefined;
  } catch {
    return undefined;
  }
}

function linuxParentPid(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");

    if (close < 0) return undefined;

    const fields = stat
      .slice(close + 1)
      .trim()
      .split(/\s+/u);
    const parentPid = Number(fields[1]);
    return Number.isSafeInteger(parentPid) && parentPid > 0 ? parentPid : undefined;
  } catch {
    return undefined;
  }
}

function linuxExecutable(pid: number): string | undefined {
  try {
    return realpathSync(`/proc/${pid}/exe`);
  } catch {
    return undefined;
  }
}

function linuxCmdline(pid: number): string[] | undefined {
  try {
    const contents = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    const argv = contents.length === 0 ? [] : contents.split("\0");

    if (argv.length > 0 && argv.at(-1) === "") argv.pop();

    return argv;
  } catch {
    return undefined;
  }
}

function validateLinuxLanguageServerCompletion(
  host: OwnerStartReceipt,
  server: OwnerStartReceipt,
  native: Record<string, unknown>,
  raw: Record<string, unknown>,
  exit: Record<string, unknown>,
): Record<string, unknown> {
  const languageServer = native.languageServer;
  const extensionHost = native.extensionHost;
  const codeGui = native.codeGui;

  const samePath = (value: unknown, expected: string): boolean =>
    typeof value === "string" && realpathSync(value) === realpathSync(expected);

  if (!isRecord(languageServer) || !isRecord(extensionHost) || !isRecord(codeGui)) {
    throw new Error("Native Linux completion omits an observed process generation");
  }

  const codeGuiPid = codeGui.pid;

  if (typeof codeGuiPid !== "number" || !Number.isSafeInteger(codeGuiPid) || codeGuiPid <= 0) {
    throw new Error("Native Linux completion has a malformed Code GUI PID");
  }

  if (
    native.format !== "hesperia-editor-linux-native-language-server-exit-ack" ||
    native.version !== 1 ||
    native.runId !== config.runId ||
    native.populationFingerprint !== config.populationFingerprint ||
    native.languageServerOwnerId !== server.ownerId ||
    languageServer.pid !== server.pid ||
    languageServer.parentPid !== host.pid ||
    !samePath(languageServer.executablePath, server.execPath) ||
    !Array.isArray(languageServer.ownerArgv) ||
    JSON.stringify(languageServer.ownerArgv) !== JSON.stringify(server.argv) ||
    !Number.isSafeInteger(languageServer.procStarttimeTicks) ||
    !isTimestamp(languageServer.pidfdAttachedAt) ||
    !isTimestamp(languageServer.pidfdReadyAt) ||
    !isRecord(languageServer.outcome) ||
    languageServer.outcome.kind !== "exit" ||
    languageServer.outcome.status !== 0 ||
    !isRecord(languageServer.traceExit) ||
    !Array.isArray(languageServer.threadExits) ||
    !isRecord(native.languageServerTraceExit) ||
    JSON.stringify(native.languageServerTraceExit) !== JSON.stringify(languageServer.traceExit) ||
    !isTimestamp(native.languageServerOwnerExitedAt) ||
    extensionHost.pid !== host.pid ||
    extensionHost.parentPid !== host.ppid ||
    !samePath(extensionHost.executablePath, host.execPath) ||
    !Array.isArray(extensionHost.ownerArgv) ||
    JSON.stringify(extensionHost.ownerArgv) !== JSON.stringify(host.argv) ||
    !Number.isSafeInteger(extensionHost.procStarttimeTicks) ||
    !isTimestamp(extensionHost.pidfdAttachedAt) ||
    !isTimestamp(extensionHost.aliveObservedAt) ||
    codeGuiPid === host.pid ||
    !Number.isSafeInteger(codeGui.procStarttimeTicks) ||
    typeof codeGui.executablePath !== "string" ||
    !Array.isArray(codeGui.procArgv) ||
    !isTimestamp(codeGui.pidfdAttachedAt) ||
    !isTimestamp(codeGui.aliveObservedAt) ||
    !isTimestamp(native.acknowledgedAt) ||
    !isTimestamp(native.languageServerOwnerExitedAt) ||
    linuxStarttimeTicks(host.pid) !== extensionHost.procStarttimeTicks ||
    linuxParentPid(host.pid) !== extensionHost.parentPid ||
    linuxExecutable(host.pid) !== realpathSync(host.execPath) ||
    linuxStarttimeTicks(codeGuiPid) !== codeGui.procStarttimeTicks ||
    linuxParentPid(codeGuiPid) !== codeGui.parentPid ||
    linuxExecutable(codeGuiPid) !== codeGui.executablePath ||
    extensionHost.aliveObservedAt !== native.acknowledgedAt ||
    codeGui.aliveObservedAt !== native.acknowledgedAt ||
    languageServer.pidfdReadyAt > native.acknowledgedAt ||
    Date.parse(native.languageServerOwnerExitedAt) > Date.parse(languageServer.pidfdReadyAt) ||
    native.languageServerOwnerExitedAt !== exit.exitedAt ||
    exit.format !== "hesperia-editor-owner-exit" ||
    exit.version !== 1 ||
    exit.runId !== config.runId ||
    exit.populationFingerprint !== config.populationFingerprint ||
    exit.ownerId !== server.ownerId ||
    exit.role !== "language-server" ||
    exit.pid !== server.pid ||
    exit.ppid !== server.ppid ||
    exit.execPath !== server.execPath ||
    exit.startedAt !== server.startedAt ||
    exit.exitCode !== 0 ||
    !isTimestamp(exit.exitedAt) ||
    exit.coverageFile !== "language-server-coverage.json" ||
    !isRecord(raw.coverage) ||
    raw.format !== "hesperia-editor-owner-coverage" ||
    raw.version !== 1 ||
    raw.runId !== config.runId ||
    raw.populationFingerprint !== config.populationFingerprint ||
    raw.ownerId !== server.ownerId ||
    raw.role !== "language-server" ||
    raw.pid !== server.pid ||
    raw.ppid !== server.ppid ||
    !Array.isArray(raw.argv) ||
    JSON.stringify(raw.argv) !== JSON.stringify(server.argv)
  ) {
    throw new Error(
      "Linux native language-server acknowledgement does not match live process generations",
    );
  }

  const selfTicks = linuxStarttimeTicks(process.pid);

  if (host.pid !== process.pid || selfTicks !== extensionHost.procStarttimeTicks) {
    throw new Error(
      "Linux Extension Host generation changed while consuming the native acknowledgement",
    );
  }

  const hostArgv = linuxCmdline(host.pid);
  const guiArgv = linuxCmdline(codeGuiPid);
  const serverArgv = languageServer.procArgv;

  const flag = (argv: unknown, name: string): string | undefined => {
    if (!Array.isArray(argv)) return undefined;

    const prefix = `--${name}=`;

    for (let index = 0; index < argv.length; index += 1) {
      const argument = argv[index];

      if (typeof argument !== "string") continue;

      if (argument.startsWith(prefix)) return argument.slice(prefix.length);

      if (argument === `--${name}` && typeof argv[index + 1] === "string") return argv[index + 1];
    }

    return undefined;
  };

  const fixture = native.fixture;

  if (
    !Array.isArray(hostArgv) ||
    JSON.stringify(hostArgv) !== JSON.stringify(extensionHost.procArgv) ||
    !Array.isArray(extensionHost.ownerArgv) ||
    !extensionHost.ownerArgv.some(
      (argument) =>
        typeof argument === "string" &&
        argument
          .replaceAll("\\", "/")
          .toLowerCase()
          .endsWith("/resources/app/out/bootstrap-fork.js"),
    ) ||
    !Array.isArray(serverArgv) ||
    !serverArgv.some((argument) =>
      argument.replaceAll("\\", "/").endsWith("packages/language-server/dist/cli.js"),
    ) ||
    !isRecord(fixture) ||
    typeof fixture.userDataPath !== "string" ||
    typeof fixture.extensionsPath !== "string" ||
    typeof fixture.testHostPath !== "string" ||
    fixture.extensionPath !== config.testHostPath.replace(/[\\/]+dist[\\/]+test-host\.cjs$/u, "") ||
    !testHostModule ||
    resolve(fixture.testHostPath) !== resolve(testHostModule.filename) ||
    !Array.isArray(guiArgv) ||
    JSON.stringify(guiArgv) !== JSON.stringify(codeGui.procArgv) ||
    (flag(guiArgv, "type") !== undefined && flag(guiArgv, "type") !== "browser") ||
    guiArgv.some((argument) =>
      argument.replaceAll("\\", "/").endsWith("/resources/app/out/cli.js"),
    ) ||
    flag(guiArgv, "user-data-dir") !== fixture.userDataPath ||
    flag(guiArgv, "extensions-dir") !== fixture.extensionsPath ||
    flag(guiArgv, "extensionDevelopmentPath") !== fixture.extensionPath ||
    flag(guiArgv, "extensionTestsPath") !== fixture.testHostPath
  ) {
    throw new Error(
      "Linux native vectors do not carry the actual Host, LS, and isolated GUI role anchors",
    );
  }

  return native;
}

function validateLanguageServerCompletion(
  host: OwnerStartReceipt,
): Record<string, unknown> | undefined {
  const nativePath = resolve(config.outputDirectory, "language-server-native-exit-ack.json");
  const rawPath = resolve(config.outputDirectory, "language-server-coverage.json");
  const exitPath = resolve(config.outputDirectory, "language-server-exit.json");
  const native = readJsonIfReady(nativePath);
  const raw = readJsonIfReady(rawPath);
  const exit = readJsonIfReady(exitPath);

  if (!isRecord(native) || !isRecord(raw) || !isRecord(exit)) return undefined;

  const serverStartValue = readJsonIfReady(
    resolve(config.outputDirectory, "language-server-start.json"),
  );

  if (!isRecord(serverStartValue)) return undefined;

  const server = serverStartValue as unknown as OwnerStartReceipt;

  if (
    server.format !== "hesperia-editor-owner-start" ||
    server.version !== 1 ||
    server.runId !== config.runId ||
    server.populationFingerprint !== config.populationFingerprint ||
    server.ownerId !== "vscode-language-server-" + config.runId ||
    server.role !== "language-server" ||
    !Number.isSafeInteger(server.pid) ||
    server.pid <= 0 ||
    !Number.isSafeInteger(server.ppid) ||
    server.ppid !== host.pid
  ) {
    throw new Error(
      "Language-server start receipt does not identify a child of this actual Extension Host",
    );
  }

  if (process.platform === "linux") {
    return validateLinuxLanguageServerCompletion(host, server, native, raw, exit);
  }

  if (
    native.format !== "hesperia-editor-native-language-server-exit-ack" ||
    native.version !== 1 ||
    native.runId !== config.runId ||
    native.populationFingerprint !== config.populationFingerprint ||
    native.languageServerOwnerId !== server.ownerId ||
    !Number.isSafeInteger(native.languageServerPid) ||
    native.languageServerPid !== server.pid ||
    !Number.isSafeInteger(native.languageServerParentPid) ||
    native.languageServerParentPid !== host.pid ||
    typeof native.languageServerExecutablePath !== "string" ||
    resolve(native.languageServerExecutablePath).toLowerCase() !==
      resolve(server.execPath).toLowerCase() ||
    typeof native.languageServerCommandLine !== "string" ||
    native.languageServerExitCode !== 0 ||
    !Number.isSafeInteger(native.extensionHostPid) ||
    native.extensionHostPid !== host.pid ||
    typeof native.extensionHostExecutablePath !== "string" ||
    !isTimestamp(native.extensionHostCreationTime) ||
    !isTimestamp(native.extensionHostAliveObservedAt) ||
    !Number.isSafeInteger(native.codeLaunchPid) ||
    Number(native.codeLaunchPid) <= 0 ||
    typeof native.codeLaunchExecutablePath !== "string" ||
    !isTimestamp(native.codeLaunchCreationTime) ||
    !isTimestamp(native.codeLaunchAliveObservedAt) ||
    !isTimestamp(native.languageServerCreationTime) ||
    !isTimestamp(native.languageServerProcessExitTime) ||
    !isTimestamp(native.languageServerExitObservedAt) ||
    !isTimestamp(native.acknowledgedAt) ||
    exit.format !== "hesperia-editor-owner-exit" ||
    exit.version !== 1 ||
    exit.runId !== config.runId ||
    exit.populationFingerprint !== config.populationFingerprint ||
    exit.ownerId !== server.ownerId ||
    exit.role !== "language-server" ||
    exit.pid !== server.pid ||
    exit.ppid !== server.ppid ||
    exit.execPath !== server.execPath ||
    exit.startedAt !== server.startedAt ||
    !isTimestamp(exit.exitedAt) ||
    exit.exitCode !== 0 ||
    exit.coverageFile !== "language-server-coverage.json" ||
    !isRecord(raw.coverage) ||
    raw.format !== "hesperia-editor-owner-coverage" ||
    raw.version !== 1 ||
    raw.runId !== config.runId ||
    raw.populationFingerprint !== config.populationFingerprint ||
    raw.ownerId !== server.ownerId ||
    raw.role !== "language-server" ||
    raw.pid !== server.pid ||
    raw.ppid !== server.ppid ||
    !Array.isArray(raw.argv) ||
    JSON.stringify(raw.argv) !== JSON.stringify(server.argv)
  ) {
    throw new Error(
      "Native or process-owned language-server completion evidence does not match this run",
    );
  }

  const startedAt = Date.parse(server.startedAt);
  const nativeCreatedAt = Date.parse(native.languageServerCreationTime);
  const nativeExitedAt = Date.parse(native.languageServerProcessExitTime);
  const nativeExitObservedAt = Date.parse(native.languageServerExitObservedAt);
  const nativeAcknowledgedAt = Date.parse(native.acknowledgedAt);
  const processExitedAt = Date.parse(exit.exitedAt);

  if (
    !isTimestamp(server.startedAt) ||
    ![
      startedAt,
      nativeCreatedAt,
      nativeExitedAt,
      nativeExitObservedAt,
      nativeAcknowledgedAt,
      processExitedAt,
    ].every(Number.isFinite) ||
    nativeCreatedAt > startedAt ||
    startedAt > nativeExitedAt ||
    processExitedAt > nativeExitedAt ||
    nativeExitedAt > nativeExitObservedAt ||
    nativeExitObservedAt > nativeAcknowledgedAt ||
    native.extensionHostAliveObservedAt !== native.acknowledgedAt ||
    native.codeLaunchAliveObservedAt !== native.acknowledgedAt
  ) {
    throw new Error("Language-server lifecycle timestamps are invalid or out of order");
  }

  return native;
}

async function waitForLanguageServerCompletion(
  host: OwnerStartReceipt,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    const native = validateLanguageServerCompletion(host);

    if (native) return native;

    await new Promise((accept) => setTimeout(accept, 25));
  }

  throw new Error(
    "Actual language-server shutdown did not produce matching raw/exit receipts and an independently observed live-ancestry exit acknowledgement",
  );
}

async function runLinuxRawCreatorFixture(): Promise<void> {
  if (process.platform !== "linux" || config.verificationControl) return;

  const python = process.env.HESPERIA_LINUX_RAW_CREATOR_PYTHON;
  const script = process.env.HESPERIA_LINUX_RAW_CREATOR_SCRIPT;
  const scope = process.env.HESPERIA_LINUX_RAW_CREATOR_SCOPE;

  if (
    !python ||
    !script ||
    !scope ||
    !isAbsolute(python) ||
    !isAbsolute(script) ||
    !isAbsolute(scope) ||
    realpathSync(python) !== python ||
    realpathSync(script) !== script ||
    realpathSync(scope) !== scope ||
    script !== resolve(scope, "creator.py") ||
    !statSync(scope).isDirectory() ||
    (statSync(scope).mode & 0o777) !== 0o700
  ) {
    throw new Error("Linux raw-creator fixture lacks its isolated observer scope");
  }

  const deadline = Date.now() + 30_000;
  const helper = spawn(python, [script, scope], { stdio: "ignore" });
  await new Promise<void>((accept, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Linux raw-creator helper did not exit before its fixture deadline")),
      Math.max(1, deadline - Date.now()),
    );

    helper.once("error", (error) => {
      clearTimeout(timeout);

      reject(error);
    });

    helper.once("exit", (code, signal) => {
      clearTimeout(timeout);

      if (code === 0 && signal === null) accept();
      else reject(new Error(`Linux raw-creator helper failed: exit=${code}, signal=${signal}`));
    });
  });

  while (Date.now() < deadline) {
    if (existsSync(resolve(scope, "abort"))) {
      throw new Error("Linux observer aborted the private raw-creator fixture");
    }

    if (existsSync(resolve(scope, "complete"))) return;

    await new Promise((accept) => setTimeout(accept, 25));
  }

  throw new Error(
    "Linux observer did not confirm raw-creator child completion before deactivation",
  );
}

export async function run(): Promise<void> {
  if (typeof assertions.run !== "function")
    throw new Error("Existing editor host runner is missing");

  const start = writeEditorOwnerStart(config, "extension-host");

  process.once("exit", (exitCode) => {
    try {
      const raw = Reflect.get(globalThis, "__hesperiaCoverage__") as
        | Record<string, Record<string, unknown>>
        | undefined;
      const { packageCoverage, supportCoverage } = splitEditorOwnerCoverage(
        config,
        "extension-host",
        raw ?? {},
      );

      writeEditorOwnerExit(config, start, exitCode, packageCoverage);

      writeEditorOwnerSupportCoverage(config, start, supportCoverage);
    } catch (error) {
      try {
        writeEditorOwnerCaptureError(config, start, error);
      } catch {}
    }
  });

  await assertions.run();

  await runLinuxRawCreatorFixture();

  if (config.verificationControl) {
    writeFileSync(
      resolve(config.outputDirectory, "owner-kill-ready.json"),
      JSON.stringify({
        format: "hesperia-editor-owner-kill-ready",
        version: 1,
        runId: config.runId,
        populationFingerprint: config.populationFingerprint,
        mode: config.verificationControl,
        extensionHostPid: start.pid,
        assertionsCompletedAt: new Date().toISOString(),
      }),
      { flag: "wx" },
    );

    const deadline = Date.now() + 30_000;

    while (Date.now() < deadline) {
      if (existsSync(resolve(config.outputDirectory, "owner-kill-control.json"))) {
        throw new Error(
          "Private native owner kill control completed after the original editor assertions",
        );
      }

      await new Promise((accept) => setTimeout(accept, 25));
    }

    throw new Error(
      "Private native owner kill control did not complete at the post-assertion barrier",
    );
  }

  const stageRoot = resolve(dirname(config.testHostPath), "..");
  const stagedPackage = JSON.parse(readFileSync(resolve(stageRoot, "package.json"), "utf8")) as {
    readonly main?: unknown;
  };

  if (stagedPackage.main !== "./dist/extension.cjs") {
    throw new Error(
      "Prepared extension package does not resolve its original staged CommonJS entry",
    );
  }

  const extensionRequire = createRequire(config.testHostPath);
  const extensionEntryPath = resolve(stageRoot, stagedPackage.main);
  const resolvedEntryPath = extensionRequire.resolve(extensionEntryPath);

  if (resolve(resolvedEntryPath).toLowerCase() !== extensionEntryPath.toLowerCase()) {
    throw new Error(
      "Staged extension package entry resolution changed during the Extension Host test",
    );
  }

  const cachedEntries = Object.entries(extensionRequire.cache).filter(
    ([path, cachedModule]) =>
      cachedModule !== undefined &&
      resolve(path).toLowerCase() === extensionEntryPath.toLowerCase() &&
      cachedModule.loaded &&
      resolve(cachedModule.filename).toLowerCase() === extensionEntryPath.toLowerCase(),
  );

  if (cachedEntries.length !== 1) {
    throw new Error(
      "The exact staged extension entry is not uniquely present in the active Extension Host module cache",
    );
  }

  const activeEntry = cachedEntries[0];

  if (!activeEntry || !activeEntry[1]) {
    throw new Error("The staged extension module cache entry disappeared before shutdown");
  }

  const extensionExports = activeEntry[1].exports as {
    readonly activate?: unknown;
    readonly deactivate?: () => Promise<void> | void;
  };

  if (
    typeof extensionExports.activate !== "function" ||
    typeof extensionExports.deactivate !== "function"
  ) {
    throw new Error(
      "The active staged extension module does not expose its original activate/deactivate exports",
    );
  }

  const lifecycleStart = {
    format: "hesperia-editor-deactivate-start",
    version: 1,
    runId: config.runId,
    populationFingerprint: config.populationFingerprint,
    extensionHostOwnerId: start.ownerId,
    extensionHostPid: start.pid,
    extensionEntryPath,
    moduleCachePath: activeEntry[0],
    moduleCacheLoaded: true,
    deactivateExport: "deactivate",
    assertionsCompletedAt: new Date().toISOString(),
    deactivateStartedAt: new Date().toISOString(),
  };

  writeFileSync(
    resolve(config.outputDirectory, "extension-host-deactivate-start.json"),
    JSON.stringify(lifecycleStart),
    { flag: "wx" },
  );

  await extensionExports.deactivate();

  const deactivateResolvedAt = new Date().toISOString();
  const nativeAcknowledgement = await waitForLanguageServerCompletion(start);
  const completion =
    process.platform === "linux"
      ? {
          ...lifecycleStart,
          format: "hesperia-editor-deactivate-complete",
          deactivateResolvedAt,
          nativeAcknowledgedAt: nativeAcknowledgement.acknowledgedAt,
          languageServerPid: (nativeAcknowledgement.languageServer as Record<string, unknown>).pid,
          languageServerOwnerExitedAt: nativeAcknowledgement.languageServerOwnerExitedAt,
          languageServerOutcome: (nativeAcknowledgement.languageServer as Record<string, unknown>)
            .outcome,
        }
      : {
          ...lifecycleStart,
          format: "hesperia-editor-deactivate-complete",
          deactivateResolvedAt,
          nativeAcknowledgedAt: nativeAcknowledgement.acknowledgedAt,
          languageServerPid: nativeAcknowledgement.languageServerPid,
          languageServerProcessExitTime: nativeAcknowledgement.languageServerProcessExitTime,
          languageServerExitCode: nativeAcknowledgement.languageServerExitCode,
        };

  writeFileSync(
    resolve(config.outputDirectory, "extension-host-deactivate.json"),
    JSON.stringify(completion),
    { flag: "wx" },
  );
}
