import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  realpathSync,
  readFileSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { threadId } from "node:worker_threads";
import { buildCoverageWorkerGraph } from "./coverage-worker-build.ts";
import {
  bindCoverageOwnerRun,
  buildEditorHostSupportBundle,
  coverageOwnerProfile,
  coverageOwnerSources,
  snapshotCoverageOwnerHits,
  writeCoverageOwnerSupportPreload,
} from "./coverage-owner-launcher.ts";
import {
  createCoverageArtifact,
  inventoryCoverageSources,
  mergeCoverageArtifacts,
  prepareCoverageSource,
  writeCoverageFragment,
  writeLcovReport,
  type CoverageArtifact,
  type CoverageFile,
  type CoveragePopulation,
} from "./coverage-collector.ts";
import type {
  EditorCoverageConfig,
  EditorOwnerCoverage,
  EditorOwnerExit,
  EditorOwnerStart,
} from "./coverage-editor-process.ts";
import {
  readEditorCoverageSupportConfig,
  writeEditorCoverageSupportConfig,
} from "./coverage-editor-process.ts";

const repoPath = resolve(import.meta.dir, "../..");
const outputRoot = join(repoPath, ".hesperia", "ec");
const buildRoot = join(repoPath, ".hesperia", "coverage", "editor-builds");
const extensionSource = "editors/vscode/src/extension.ts";
const expectedChecks = 19;
const ownerPackages = ["language-server", "tooling", "compiler", "hosting", "hesperia"] as const;
const ownerStartReceiptKeys = [
  "format",
  "version",
  "runId",
  "populationFingerprint",
  "ownerId",
  "role",
  "pid",
  "ppid",
  "execPath",
  "argv",
  "startedAt",
] as const;

interface NativeProcessRecord {
  readonly pid: number;
  readonly parentPid: number;
  readonly processName: string;
  readonly executablePath: string;
  readonly commandLine: string;
  readonly creationTime: string;
  readonly attached: boolean;
  readonly attachedAt: string;
  readonly exitObserved: boolean;
  readonly processExitTime: string;
  readonly exitObservedAt: string;
  readonly exitCode?: number;
}

interface ExpectedEditorArtifact {
  readonly kind: CoverageArtifact["kind"];
  readonly ownerId: string;
  readonly contextId: string;
  readonly populationIncluded: boolean;
}

interface CapturedRunContext {
  readonly runId: string;
  readonly population: CoveragePopulation;
  readonly code: {
    readonly path: string;
    readonly version: string;
    readonly executablePath: string;
  };
  readonly extensionEntryPath: string;
  readonly configuration: EditorCoverageConfig;
}

type NativeKillControl = "kill-extension-host" | "kill-language-server";

type PrivateVerification = "artifacts" | "artifacts-and-native" | NativeKillControl;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalPath(path: string): string {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function timestamp(value: unknown): number | undefined {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
  ) {
    return undefined;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function linuxTimestampNs(value: unknown): bigint | undefined {
  if (typeof value !== "string") return undefined;

  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/u.exec(
    value,
  );

  if (!match) return undefined;

  const year = Number(match[1]!.slice(0, 4));
  const baseMilliseconds = Date.parse(match[1]! + "Z");

  if (
    year < 1 ||
    !Number.isSafeInteger(baseMilliseconds) ||
    new Date(baseMilliseconds).toISOString().slice(0, 19) !== match[1]
  ) {
    return undefined;
  }

  if (match[3] !== "Z") {
    const offset = /([+-])(\d{2}):(\d{2})/u.exec(match[3]!);

    if (!offset || Number(offset[2]) > 23 || Number(offset[3]) > 59) return undefined;
  }

  const wholeMilliseconds = Date.parse(match[1]! + match[3]!);

  if (!Number.isSafeInteger(wholeMilliseconds)) return undefined;

  const fractionNs = BigInt((match[2] ?? "").padEnd(9, "0"));
  return BigInt(wholeMilliseconds) * 1_000_000n + fractionNs;
}

function isTimestamp(value: unknown): value is string {
  return timestamp(value) !== undefined;
}

function commandLineArgument(commandLine: string, name: string): string | undefined {
  const pattern = new RegExp("(?:^|\\s)--" + name + '(?:=|\\s+)(?:"([^"]+)"|([^\\s]+))', "iu");
  const match = pattern.exec(commandLine);
  return (match?.[1] ?? match?.[2])?.replace(/^["']|["']$/gu, "");
}

function readJson(path: string): unknown {
  const source = readFileSync(path, "utf8");

  try {
    return JSON.parse(source);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Malformed JSON editor evidence: ${path}`, { cause: error });
    }

    throw error;
  }
}

function requirePowerShell(command: string, env: NodeJS.ProcessEnv): string {
  const result = spawnSync("powershell", ["-NoProfile", "-Command", command], {
    cwd: repoPath,
    env,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });

  if (result.error) throw result.error;

  if (result.status !== 0) throw new Error(`PowerShell metadata check failed: ${result.stderr}`);

  return result.stdout.trim();
}

function requireCodeVersion(version: string, codePath: string, expectedVersion?: string): void {
  const manifest = readJson(resolve(repoPath, "editors/vscode/package.json"));

  if (
    !isRecord(manifest) ||
    !isRecord(manifest.engines) ||
    typeof manifest.engines.vscode !== "string"
  ) {
    throw new Error("The extension manifest must declare its VS Code compatibility range");
  }

  if (!Bun.semver.satisfies(version, manifest.engines.vscode)) {
    throw new Error(
      `VS Code version ${version} does not satisfy extension compatibility ${manifest.engines.vscode}: ${codePath}`,
    );
  }

  if (
    expectedVersion !== undefined &&
    !version.startsWith(`${expectedVersion}.`) &&
    version !== expectedVersion
  ) {
    throw new Error(
      `VS Code version ${version} does not match required ${expectedVersion}: ${codePath}`,
    );
  }
}

function verifyCodeExecutable(
  codePathInput: string | undefined,
  expectedVersion?: string,
): {
  readonly path: string;
  readonly version: string;
  readonly executablePath: string;
} {
  if (process.platform === "linux") {
    const requested = codePathInput ?? "code";
    const lookup = requested.includes(sep)
      ? { status: 0, stdout: resolve(requested), error: undefined }
      : spawnSync("which", [requested], { cwd: repoPath, encoding: "utf8" });

    if (lookup.error) throw lookup.error;

    const found = lookup.status === 0 ? String(lookup.stdout).trim() : "";

    if (!found || !existsSync(found))
      throw new Error(`VS Code launcher does not exist: ${requested}`);

    const launcherPath = realpathSync(found);
    const environment = { ...process.env, DONT_PROMPT_WSL_INSTALL: "1" };
    const versionResult = (() => {
      const userDataDirectory = mkdtempSync(join(tmpdir(), "hesperia-code-version-"));

      try {
        return spawnSync(
          launcherPath,
          ["--no-sandbox", `--user-data-dir=${userDataDirectory}`, "--version"],
          {
            cwd: repoPath,
            env: environment,
            encoding: "utf8",
            maxBuffer: 1024 * 1024,
          },
        );
      } finally {
        rmSync(userDataDirectory, { recursive: true, force: true });
      }
    })();

    if (versionResult.error) throw versionResult.error;

    if (versionResult.status !== 0) {
      throw new Error(`VS Code Linux launcher version check failed: ${versionResult.stderr}`);
    }

    const version = versionResult.stdout.trim().split(/\r?\n/u)[0] ?? "";

    requireCodeVersion(version, launcherPath, expectedVersion);

    const executableCandidate = resolve(dirname(launcherPath), "..", "code");

    if (!existsSync(executableCandidate)) {
      throw new Error(`Packaged VS Code Linux executable does not exist: ${executableCandidate}`);
    }

    return {
      path: launcherPath,
      version,
      executablePath: realpathSync(executableCandidate),
    };
  }

  const codePath = resolve(
    codePathInput ??
      join(process.env.LOCALAPPDATA ?? "", "Programs", "Microsoft VS Code", "Code.exe"),
  );

  if (!existsSync(codePath)) throw new Error(`VS Code executable does not exist: ${codePath}`);

  const env = { ...process.env, HESPERIA_EDITOR_CODE_PATH: codePath };
  const version = requirePowerShell(
    "[Diagnostics.FileVersionInfo]::GetVersionInfo($env:HESPERIA_EDITOR_CODE_PATH).ProductVersion",
    env,
  );

  requireCodeVersion(version, codePath, expectedVersion);

  return { path: codePath, version, executablePath: realpathSync(codePath) };
}

function cleanBuildEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.BUN_OPTIONS;
  delete environment.NODE_OPTIONS;

  for (const key of Object.keys(environment)) {
    if (
      key.startsWith("HESPERIA_COVERAGE_") ||
      key.startsWith("HESPERIA_BROWSER_COVERAGE_") ||
      key.startsWith("HESPERIA_EDITOR_COVERAGE_")
    ) {
      delete environment[key];
    }
  }

  return environment;
}

function build(command: readonly string[], cwd: string): void {
  const result = spawnSync(process.execPath, command, {
    cwd,
    env: cleanBuildEnvironment(),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });

  if (result.error) throw result.error;

  if (result.status !== 0) {
    throw new Error(
      `Editor capture build failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`,
    );
  }
}

function writeFragment(
  outputDirectory: string,
  artifact: CoverageArtifact,
  sourcePopulation: CoveragePopulation,
): void {
  writeCoverageFragment({
    directory: outputDirectory,
    contextId: artifact.kind,
    pid: process.pid,
    threadId,
    repoPath,
    artifact,
    sourcePopulation,
  });
}

function validateNativeObservation(
  value: unknown,
  runId: string,
  host: EditorOwnerStart,
  server: EditorOwnerStart,
  codeLaunchPid: number,
  codePath: string,
): {
  readonly host: NativeProcessRecord;
  readonly server: NativeProcessRecord;
  readonly launch: NativeProcessRecord;
} {
  if (
    !isRecord(value) ||
    value.format !== "hesperia-editor-native-process-observation" ||
    value.version !== 1 ||
    value.runId !== runId ||
    !Array.isArray(value.events) ||
    value.codeLaunchPid !== codeLaunchPid ||
    timestamp(value.observerStartedAt) === undefined ||
    timestamp(value.observedAt) === undefined ||
    timestamp(value.observedAt)! < timestamp(value.observerStartedAt)!
  ) {
    throw new Error("Missing, stale, or malformed native editor process observation");
  }

  const observerStartedAt = timestamp(value.observerStartedAt)!;
  const observedAt = timestamp(value.observedAt)!;
  const events: NativeProcessRecord[] = [];
  const eventsByPid = new Map<number, NativeProcessRecord>();

  for (const rawEvent of value.events) {
    if (
      !isRecord(rawEvent) ||
      !Number.isSafeInteger(rawEvent.pid) ||
      Number(rawEvent.pid) <= 0 ||
      !Number.isSafeInteger(rawEvent.parentPid) ||
      Number(rawEvent.parentPid) <= 0 ||
      typeof rawEvent.processName !== "string" ||
      typeof rawEvent.executablePath !== "string" ||
      typeof rawEvent.commandLine !== "string" ||
      typeof rawEvent.attached !== "boolean" ||
      typeof rawEvent.exitObserved !== "boolean" ||
      typeof rawEvent.attachedAt !== "string" ||
      typeof rawEvent.processExitTime !== "string" ||
      typeof rawEvent.exitObservedAt !== "string" ||
      typeof rawEvent.creationTime !== "string"
    ) {
      throw new Error("Native editor process observation contains a malformed process record");
    }

    const event = rawEvent as unknown as NativeProcessRecord;

    if (eventsByPid.has(event.pid)) {
      throw new Error("Native editor process observation contains a duplicate or invalid PID");
    }

    const creationTime = timestamp(event.creationTime);
    const attachedAt = timestamp(event.attachedAt);
    const processExitTime = timestamp(event.processExitTime);
    const exitObservedAt = timestamp(event.exitObservedAt);

    if (
      event.attached !== true ||
      !event.executablePath ||
      !event.commandLine ||
      creationTime === undefined ||
      attachedAt === undefined ||
      processExitTime === undefined ||
      exitObservedAt === undefined ||
      creationTime < observerStartedAt ||
      creationTime > attachedAt ||
      attachedAt > processExitTime ||
      processExitTime > exitObservedAt ||
      exitObservedAt > observedAt ||
      event.exitObserved !== true ||
      !Number.isSafeInteger(event.exitCode)
    ) {
      throw new Error(
        `Native process record is unattached, malformed, or has no observed exit: ${event.pid}`,
      );
    }

    events.push(event);

    eventsByPid.set(event.pid, event);
  }

  const findOwner = (owner: EditorOwnerStart): NativeProcessRecord => {
    const matches = events.filter((event) => event.pid === owner.pid);

    if (matches.length !== 1)
      throw new Error(`Native process observation is missing or duplicates ${owner.role}`);

    const event = matches[0]!;

    if (
      event.attached !== true ||
      event.exitObserved !== true ||
      !Number.isSafeInteger(event.parentPid) ||
      event.parentPid !== owner.ppid ||
      typeof event.creationTime !== "string" ||
      !event.creationTime ||
      typeof event.attachedAt !== "string" ||
      !event.attachedAt ||
      !Number.isFinite(Date.parse(owner.startedAt)) ||
      !Number.isFinite(Date.parse(event.creationTime)) ||
      !Number.isFinite(Date.parse(event.attachedAt)) ||
      Date.parse(String(value.observerStartedAt)) > Date.parse(owner.startedAt) ||
      typeof event.executablePath !== "string" ||
      !event.executablePath ||
      typeof event.commandLine !== "string" ||
      !event.commandLine ||
      !Number.isSafeInteger(event.exitCode) ||
      event.exitCode !== 0
    ) {
      throw new Error(
        `Native ${owner.role} process did not have an independently observed normal exit`,
      );
    }

    const ownerStartedAt = timestamp(owner.startedAt);

    if (
      ownerStartedAt === undefined ||
      timestamp(event.creationTime)! > ownerStartedAt ||
      ownerStartedAt > observedAt
    ) {
      throw new Error(
        `Native ${owner.role} process timing does not bracket its runtime start receipt`,
      );
    }

    return event;
  };

  const hostRecord = findOwner(host);
  const serverRecord = findOwner(server);
  const launchRecord = eventsByPid.get(codeLaunchPid);

  if (
    !launchRecord ||
    launchRecord.attached !== true ||
    launchRecord.exitObserved !== true ||
    launchRecord.exitCode !== 0 ||
    timestamp(launchRecord.creationTime) === undefined ||
    timestamp(launchRecord.attachedAt) === undefined ||
    timestamp(launchRecord.creationTime)! < observerStartedAt ||
    timestamp(launchRecord.creationTime)! > timestamp(launchRecord.attachedAt)! ||
    resolve(launchRecord.executablePath).toLowerCase() !== resolve(codePath).toLowerCase() ||
    !/--user-data-dir=/iu.test(launchRecord.commandLine) ||
    !/--extensions-dir=/iu.test(launchRecord.commandLine) ||
    !/--extensionDevelopmentPath=/iu.test(launchRecord.commandLine) ||
    !/--extensionTestsPath=/iu.test(launchRecord.commandLine)
  ) {
    throw new Error("Native observation does not prove an isolated owned VS Code GUI launch");
  }

  const diagnostics = value.observerDiagnostics;

  if (!isRecord(diagnostics)) {
    throw new Error("Native observation is missing active-owner and fixture-scope diagnostics");
  }

  requireExactKeys(
    diagnostics,
    [
      "receiveCalls",
      "ownerReceiptParseFailures",
      "treeSweepsDeferredUntilOwners",
      "treeSweepsDeferredUntilLauncherExit",
      "treeSweepPerformedAfterLauncherExit",
      "testBudgetSeconds",
      "treeSweepIntervalMilliseconds",
      "nativeLanguageServerAckWritten",
      "nativeLanguageServerAckErrors",
      "fixtureProcessScope",
      "ownerAdmissions",
      "ownerAdmissionFailures",
      "treeSweeps",
    ],
    "Native process observer diagnostics",
  );

  const fixtureScope = diagnostics.fixtureProcessScope;
  const userDataPath = commandLineArgument(launchRecord.commandLine, "user-data-dir");
  const extensionsPath = commandLineArgument(launchRecord.commandLine, "extensions-dir");

  if (
    !Number.isSafeInteger(diagnostics.receiveCalls) ||
    Number(diagnostics.receiveCalls) <= 0 ||
    !Number.isSafeInteger(diagnostics.ownerReceiptParseFailures) ||
    diagnostics.ownerReceiptParseFailures !== 0 ||
    !Number.isSafeInteger(diagnostics.treeSweepsDeferredUntilOwners) ||
    Number(diagnostics.treeSweepsDeferredUntilOwners) < 0 ||
    !Number.isSafeInteger(diagnostics.treeSweepsDeferredUntilLauncherExit) ||
    Number(diagnostics.treeSweepsDeferredUntilLauncherExit) < 0 ||
    diagnostics.treeSweepPerformedAfterLauncherExit !== true ||
    diagnostics.testBudgetSeconds !== 120 ||
    !Number.isSafeInteger(diagnostics.treeSweepIntervalMilliseconds) ||
    Number(diagnostics.treeSweepIntervalMilliseconds) <= 0 ||
    diagnostics.nativeLanguageServerAckWritten !== true ||
    !Array.isArray(diagnostics.nativeLanguageServerAckErrors) ||
    diagnostics.nativeLanguageServerAckErrors.length !== 0 ||
    !Array.isArray(diagnostics.ownerAdmissions) ||
    !Array.isArray(diagnostics.ownerAdmissionFailures) ||
    diagnostics.ownerAdmissionFailures.length !== 0 ||
    !Array.isArray(diagnostics.treeSweeps) ||
    diagnostics.treeSweeps.length > 1 ||
    !isRecord(fixtureScope) ||
    !userDataPath ||
    !extensionsPath
  ) {
    throw new Error(
      "Native observer diagnostics do not prove prioritized capture and clean fixture closure",
    );
  }

  requireExactKeys(
    fixtureScope,
    ["checkedAt", "userDataPath", "extensionsPath", "activeProcessIds"],
    "Isolated fixture process-scope receipt",
  );

  if (
    timestamp(fixtureScope.checkedAt) === undefined ||
    timestamp(fixtureScope.checkedAt)! < timestamp(launchRecord.processExitTime)! ||
    timestamp(fixtureScope.checkedAt)! > observedAt ||
    typeof fixtureScope.userDataPath !== "string" ||
    resolve(fixtureScope.userDataPath).toLowerCase() !== resolve(userDataPath).toLowerCase() ||
    typeof fixtureScope.extensionsPath !== "string" ||
    resolve(fixtureScope.extensionsPath).toLowerCase() !== resolve(extensionsPath).toLowerCase() ||
    !Array.isArray(fixtureScope.activeProcessIds) ||
    fixtureScope.activeProcessIds.length !== 0
  ) {
    throw new Error("Isolated VS Code fixture still had a process or did not match this launch");
  }

  for (const sweep of diagnostics.treeSweeps) {
    if (
      !isRecord(sweep) ||
      timestamp(sweep.startedAt) === undefined ||
      timestamp(sweep.finishedAt) === undefined ||
      timestamp(sweep.startedAt)! < timestamp(launchRecord.processExitTime)! ||
      timestamp(sweep.finishedAt)! < timestamp(sweep.startedAt)! ||
      timestamp(sweep.finishedAt)! > observedAt
    ) {
      throw new Error("Unrelated native discovery preceded the actual GUI launcher exit");
    }
  }

  if (resolve(hostRecord.executablePath).toLowerCase() !== resolve(codePath).toLowerCase()) {
    throw new Error("Extension Host executable does not match the verified VS Code installation");
  }

  if (resolve(host.execPath).toLowerCase() !== resolve(hostRecord.executablePath).toLowerCase()) {
    throw new Error("Extension Host runtime receipt does not match its native executable");
  }

  const launcherUserData = commandLineArgument(launchRecord.commandLine, "user-data-dir");
  const hostUserData = commandLineArgument(hostRecord.commandLine, "user-data-dir");

  if (
    !/--type=utility(?:\s|$)/iu.test(hostRecord.commandLine) ||
    !/--utility-sub-type=node\.mojom\.NodeService(?:\s|$)/iu.test(hostRecord.commandLine) ||
    !launcherUserData ||
    !hostUserData ||
    resolve(launcherUserData).toLowerCase() !== resolve(hostUserData).toLowerCase()
  ) {
    throw new Error(
      "Native Host process does not match the isolated VS Code Extension Host NodeService",
    );
  }

  if (serverRecord.parentPid !== host.pid) {
    throw new Error("Language-server native parent is not the actual Extension Host PID");
  }

  let parentPid = hostRecord.parentPid;
  const ancestry = new Set<number>([host.pid]);
  let childCreationTime = Date.parse(hostRecord.creationTime);

  while (parentPid !== codeLaunchPid) {
    if (ancestry.has(parentPid)) throw new Error("Native VS Code owner ancestry contains a cycle");

    ancestry.add(parentPid);

    const parent = eventsByPid.get(parentPid);

    if (!parent)
      throw new Error("Extension Host ancestry is not connected to the owned VS Code launch");

    const parentCreationTime = Date.parse(parent.creationTime);

    if (!Number.isFinite(parentCreationTime) || parentCreationTime > childCreationTime) {
      throw new Error("Native Host ancestry has inconsistent process creation times");
    }

    childCreationTime = parentCreationTime;
    parentPid = parent.parentPid;
  }

  const launcherCreationTime = Date.parse(launchRecord.creationTime);

  if (
    !Number.isFinite(launcherCreationTime) ||
    launcherCreationTime > childCreationTime ||
    timestamp(launchRecord.attachedAt)! > observedAt
  ) {
    throw new Error("Owned VS Code launch time is later than its Extension Host child");
  }

  const compiledCli = resolve(repoPath, "packages/language-server/dist/cli.js");

  if (
    !serverRecord.commandLine
      .replaceAll("\\", "/")
      .toLowerCase()
      .includes(compiledCli.replaceAll("\\", "/").toLowerCase())
  ) {
    throw new Error("Native language-server command line does not match the original compiled CLI");
  }

  if (
    resolve(server.execPath).toLowerCase() !== resolve(serverRecord.executablePath).toLowerCase()
  ) {
    throw new Error("Language-server runtime receipt does not match its native executable");
  }

  return { host: hostRecord, server: serverRecord, launch: launchRecord };
}

interface LinuxTraceFile {
  readonly file: string;
  readonly pid: number;
  readonly sha256: string;
  readonly lines: readonly string[];
}

interface LinuxTraceTopology {
  readonly rootPid: number;
  readonly processParentByPid: ReadonlyMap<number, number>;
  readonly processByTid: ReadonlyMap<number, number>;
  readonly creatorByPid: ReadonlyMap<
    number,
    {
      readonly parentTid: number;
      readonly startNs: bigint;
      readonly completionNs: bigint;
      readonly imageInheritanceSafe: boolean;
    }
  >;
  readonly execsByPid: ReadonlyMap<number, readonly LinuxExecTransition[]>;
}

interface LinuxExecTransition {
  readonly pid: number;
  readonly tid: number;
  readonly path: string;
  readonly resolvedPath: string | null;
  readonly argv: readonly string[];
  readonly admitted: boolean;
  readonly startNs: bigint;
  readonly completionNs: bigint;
  readonly traceFile: string;
  readonly traceLine: number;
}

interface LinuxCreatorTransition {
  readonly parentTid: number;
  readonly startNs: bigint;
  readonly completionNs: bigint;
  readonly callName: string;
  readonly flags: readonly string[];
  readonly imageInheritanceSafe: boolean;
}

function validateLinuxTraceBundle(
  value: unknown,
  files: ReadonlyMap<string, LinuxTraceFile>,
  expectedTid: number,
  label: string,
): string {
  if (!isRecord(value)) throw new Error(`${label} has no raw strace provenance`);

  const expectedKeys = [
    "completion",
    ...(value.start === undefined ? [] : ["start"]),
    ...(value.interstitial === undefined ? [] : ["interstitial"]),
  ];

  requireExactKeys(value, expectedKeys, `${label} trace reference`);

  const readRef = (
    raw: unknown,
    refLabel: string,
  ): { readonly line: number; readonly text: string } => {
    if (!isRecord(raw)) throw new Error(`${refLabel} is malformed`);

    requireExactKeys(raw, ["file", "line", "sha256"], refLabel);

    if (
      typeof raw.file !== "string" ||
      !/^native-process-trace\.\d+$/u.test(raw.file) ||
      !Number.isSafeInteger(raw.line) ||
      Number(raw.line) <= 0 ||
      typeof raw.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(raw.sha256)
    ) {
      throw new Error(`${refLabel} has invalid file, line, or hash fields`);
    }

    const file = files.get(raw.file);
    const suffix = Number(raw.file.slice("native-process-trace.".length));

    if (!file || suffix !== expectedTid)
      throw new Error(`${refLabel} is not from its recorded TID trace file`);

    const text = file.lines[Number(raw.line) - 1];

    if (
      text === undefined ||
      createHash("sha256").update(text.replace(/\r$/u, "")).digest("hex") !== raw.sha256
    ) {
      throw new Error(`${refLabel} does not match the retained raw strace line`);
    }

    return { line: Number(raw.line), text };
  };

  const completion = readRef(value.completion, `${label} completion trace`);
  let syscallText = completion.text;

  if (value.start !== undefined) {
    const start = readRef(value.start, `${label} unfinished trace`);
    const syscall = /^\d+(?:\.\d+)?\s+([A-Za-z_][A-Za-z_0-9]*)\(/u.exec(start.text)?.[1];
    const marker = start.text.indexOf("<unfinished ...>");
    const resumed = new RegExp(
      `^\\d+(?:\\.\\d+)?\\s+<\\.\\.\\. ${syscall ?? "(?!)"} resumed>(.*)$`,
      "u",
    ).exec(completion.text);

    if (
      start.line >= completion.line ||
      marker < 0 ||
      !new RegExp(`^\\d+(?:\\.\\d+)?\\s+<\\.\\.\\. ${syscall ?? "(?!)"} resumed>`).test(
        completion.text,
      ) ||
      !resumed
    ) {
      throw new Error(`${label} unfinished/resumed trace pair is inconsistent`);
    }

    syscallText = start.text.slice(0, marker) + resumed[1];
  }

  if (value.interstitial !== undefined) {
    if (!Array.isArray(value.interstitial))
      throw new Error(`${label} interstitial trace list is malformed`);

    for (const raw of value.interstitial) {
      const interstitial = readRef(raw, `${label} interstitial trace`);

      if (
        interstitial.line <= Number((value.start as Record<string, unknown>).line) ||
        interstitial.line >= completion.line ||
        !/^\d+(?:\.\d+)?\s+--- SIG/u.test(interstitial.text)
      ) {
        throw new Error(`${label} interstitial signal trace is inconsistent`);
      }
    }
  }

  return syscallText;
}

function isSuccessfulLinuxExec(text: string): boolean {
  return /(?:^|\s)(?:execve\(|<\.\.\. execve resumed>).*\)\s+=\s+0(?:\s|$)/u.test(text);
}

function parseLinuxExecve(text: string): {
  readonly path: string;
  readonly argv: readonly string[];
} {
  const marker = /(?:^|\s)execve\(/u.exec(text);

  if (!marker || marker.index === undefined)
    throw new Error("Raw Linux exec transition does not contain a complete execve call");

  let cursor = marker.index + marker[0].length;

  const parseString = (): string => {
    if (text[cursor] !== '"') throw new Error("Raw Linux execve string is not quoted");

    cursor += 1;
    let value = "";

    while (cursor < text.length) {
      const character = text[cursor++]!;

      if (character === '"') return value;

      if (character !== "\\") {
        if (character.charCodeAt(0) < 0x20)
          throw new Error("Raw Linux execve string contains an unescaped control byte");

        value += character;
        continue;
      }

      if (cursor >= text.length) throw new Error("Raw Linux execve string has a truncated escape");

      const escaped = text[cursor++]!;
      const simpleEscapes: Record<string, string> = {
        "\\": "\\",
        '"': '"',
        "'": "'",
        a: "\u0007",
        b: "\b",
        f: "\f",
        n: "\n",
        r: "\r",
        t: "\t",
        v: "\u000b",
        "?": "?",
      };

      if (Object.hasOwn(simpleEscapes, escaped)) {
        value += simpleEscapes[escaped]!;
        continue;
      }

      if (escaped === "x") {
        const hex = /^[\da-fA-F]{1,2}/u.exec(text.slice(cursor))?.[0];

        if (!hex) throw new Error("Raw Linux execve string has a malformed hexadecimal escape");

        cursor += hex.length;
        value += String.fromCharCode(Number.parseInt(hex, 16));
        continue;
      }

      if (/[0-7]/u.test(escaped)) {
        const octal = escaped + (/^[0-7]{0,2}/u.exec(text.slice(cursor))?.[0] ?? "");
        cursor += octal.length - 1;
        value += String.fromCharCode(Number.parseInt(octal, 8));
        continue;
      }

      throw new Error("Raw Linux execve string uses an unsupported escape");
    }

    throw new Error("Raw Linux execve string is unterminated");
  };

  const skipWhitespace = (): void => {
    while (/\s/u.test(text[cursor] ?? "")) cursor += 1;
  };

  const path = parseString();

  skipWhitespace();

  if (text[cursor++] !== ",") throw new Error("Raw Linux execve path lacks its argument vector");

  skipWhitespace();

  if (text[cursor++] !== "[") throw new Error("Raw Linux execve argv is not a complete array");

  const argv: string[] = [];

  while (true) {
    skipWhitespace();

    if (text[cursor] === "]") {
      cursor += 1;
      break;
    }

    argv.push(parseString());

    skipWhitespace();

    if (text[cursor] === ",") {
      cursor += 1;
      continue;
    }

    if (text[cursor] !== "]") throw new Error("Raw Linux execve argv is truncated or malformed");
  }

  if (argv.length === 0 || argv.some((argument) => argument === "..."))
    throw new Error("Raw Linux execve argv is empty or truncated");

  skipWhitespace();

  if (text[cursor] !== ",")
    throw new Error("Raw Linux execve argv is not followed by its environment vector");

  return { path, argv };
}

function linuxTraceTimestampNs(text: string): bigint {
  const match = /^(\d+)(?:\.(\d+))?\s+/u.exec(text);

  if (!match || (match[2] !== undefined && match[2].length > 9))
    throw new Error("Linux raw syscall has no unambiguous epoch timestamp");

  return BigInt(match[1]!) * 1_000_000_000n + BigInt((match[2] ?? "").padEnd(9, "0") || "0");
}

function linuxTraceInterval(
  traceValue: unknown,
  files: ReadonlyMap<string, LinuxTraceFile>,
  tid: number,
  label: string,
): {
  readonly startNs: bigint;
  readonly completionNs: bigint;
  readonly file: string;
  readonly line: number;
} {
  if (!isRecord(traceValue) || !isRecord(traceValue.completion))
    throw new Error(label + " has no raw completion timestamp");

  const completion = traceValue.completion;

  const readLine = (reference: Record<string, unknown>): string => {
    if (
      typeof reference.file !== "string" ||
      reference.file !== "native-process-trace." + tid ||
      !Number.isSafeInteger(reference.line)
    ) {
      throw new Error(label + " has no exact TID-bound raw line");
    }

    const file = files.get(reference.file);
    const line = file?.lines[Number(reference.line) - 1];

    if (line === undefined) throw new Error(label + " raw timestamp line is missing");

    return line;
  };

  const completionText = readLine(completion);
  const startValue = traceValue.start;
  const startText =
    startValue === undefined
      ? completionText
      : isRecord(startValue)
        ? readLine(startValue)
        : (() => {
            throw new Error(label + " start timestamp reference is malformed");
          })();
  const startNs = linuxTraceTimestampNs(startText);
  const completionNs = linuxTraceTimestampNs(completionText);

  if (startNs > completionNs || (startValue !== undefined && startNs === completionNs))
    throw new Error(label + " syscall interval has ambiguous timestamp ordering");

  return {
    startNs,
    completionNs,
    file: completion.file as string,
    line: Number(completion.line),
  };
}

function validateLinuxTraceEvidence(
  traceValue: unknown,
  outputDirectory: string,
  observerStartedAt: number,
  observedAt: number,
  allowKilledTracer = false,
): ReadonlyMap<string, LinuxTraceFile> {
  if (!isRecord(traceValue)) throw new Error("Linux native observation has no strace evidence");

  requireExactKeys(
    traceValue,
    [
      "format",
      "executablePath",
      "version",
      "command",
      "straceCommand",
      "commandSha256",
      "straceCommandSha256",
      "tracer",
      "cancelledSyscalls",
      "files",
    ],
    "Linux strace evidence",
  );

  const hashVector = (value: unknown): string =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex");

  if (
    traceValue.format !== "strace-ff-process-tree" ||
    typeof traceValue.executablePath !== "string" ||
    realpathSync(traceValue.executablePath) !== traceValue.executablePath ||
    typeof traceValue.version !== "string" ||
    !traceValue.version.startsWith("strace -- version ") ||
    !Array.isArray(traceValue.command) ||
    !traceValue.command.every((argument) => typeof argument === "string") ||
    !Array.isArray(traceValue.straceCommand) ||
    JSON.stringify(traceValue.command) !== JSON.stringify(traceValue.straceCommand) ||
    traceValue.command[0] !== traceValue.executablePath ||
    traceValue.straceCommand[0] !== traceValue.executablePath ||
    traceValue.commandSha256 !== hashVector(traceValue.command) ||
    traceValue.straceCommandSha256 !== hashVector(traceValue.straceCommand) ||
    !Array.isArray(traceValue.files) ||
    !Array.isArray(traceValue.cancelledSyscalls)
  ) {
    throw new Error("Linux strace command, version, or manifest is malformed");
  }

  const tracer = traceValue.tracer;
  const tracerOutcome = isRecord(tracer) && isRecord(tracer.outcome) ? tracer.outcome : undefined;
  const tracerOutcomeValid =
    tracerOutcome !== undefined &&
    ((tracerOutcome.kind === "exit" &&
      (allowKilledTracer
        ? Number.isSafeInteger(tracerOutcome.status) &&
          Number(tracerOutcome.status) >= 0 &&
          Number(tracerOutcome.status) <= 255
        : tracerOutcome.status === 0)) ||
      (allowKilledTracer && tracerOutcome.kind === "signal" && tracerOutcome.signal === "SIGKILL"));

  if (tracerOutcome) {
    requireExactKeys(
      tracerOutcome,
      tracerOutcome.kind === "exit" ? ["kind", "status"] : ["kind", "signal"],
      "Linux strace supervisor outcome",
    );
  }

  if (
    !isRecord(tracer) ||
    !tracerOutcomeValid ||
    !Number.isSafeInteger(tracer.pid) ||
    !Number.isSafeInteger(tracer.parentPid) ||
    !Number.isSafeInteger(tracer.procStarttimeTicks) ||
    !isTimestamp(tracer.pidfdAttachedAt) ||
    !isTimestamp(tracer.pidfdReadyAt) ||
    typeof tracer.executablePath !== "string" ||
    !Array.isArray(tracer.procArgv) ||
    tracer.procArgv.length === 0 ||
    !tracer.procArgv.every((argument) => typeof argument === "string") ||
    realpathSync(traceValue.executablePath) !== traceValue.executablePath ||
    realpathSync(tracer.executablePath) !== traceValue.executablePath ||
    timestamp(tracer.pidfdAttachedAt) === undefined ||
    timestamp(tracer.pidfdReadyAt) === undefined ||
    timestamp(tracer.pidfdAttachedAt)! < observerStartedAt ||
    timestamp(tracer.pidfdAttachedAt)! > timestamp(tracer.pidfdReadyAt)! ||
    timestamp(tracer.pidfdReadyAt)! > observedAt
  ) {
    throw new Error("Linux strace process lacks a retained generation-safe normal exit");
  }

  requireExactKeys(
    tracer,
    [
      "pid",
      "parentPid",
      "procStarttimeTicks",
      "pidfdAttachedAt",
      "pidfdReadyAt",
      "executablePath",
      "procArgv",
      "outcome",
    ],
    "Linux strace supervisor generation",
  );

  if (JSON.stringify(tracer.procArgv) !== JSON.stringify(traceValue.command)) {
    throw new Error(
      "Retained Linux strace process argv does not match the recorded invocation vector",
    );
  }

  if (
    (tracerOutcome!.kind === "exit" &&
      (!Number.isSafeInteger(tracerOutcome!.status) ||
        Number(tracerOutcome!.status) < 0 ||
        Number(tracerOutcome!.status) > 255)) ||
    (tracerOutcome!.kind === "signal" &&
      (typeof tracerOutcome!.signal !== "string" || !/^SIG[A-Z0-9]+$/u.test(tracerOutcome!.signal)))
  ) {
    throw new Error("Linux strace supervisor outcome is malformed");
  }

  const files = new Map<string, LinuxTraceFile>();
  const listed = new Set<string>();

  for (const raw of traceValue.files) {
    if (!isRecord(raw)) throw new Error("Linux strace file manifest contains a malformed entry");

    requireExactKeys(raw, ["file", "pid", "bytes", "sha256"], "Linux strace file manifest entry");

    if (
      typeof raw.file !== "string" ||
      !/^native-process-trace\.\d+$/u.test(raw.file) ||
      !Number.isSafeInteger(raw.pid) ||
      Number(raw.pid) <= 0 ||
      raw.file !== `native-process-trace.${raw.pid}` ||
      !Number.isSafeInteger(raw.bytes) ||
      Number(raw.bytes) <= 0 ||
      typeof raw.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(raw.sha256) ||
      listed.has(raw.file)
    ) {
      throw new Error("Linux strace file manifest has duplicate or invalid entries");
    }

    const bytes = readFileSync(join(outputDirectory, raw.file));

    if (
      bytes.byteLength !== raw.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== raw.sha256 ||
      bytes.byteLength === 0 ||
      bytes[bytes.byteLength - 1] !== 0x0a
    ) {
      throw new Error(`Retained raw strace file does not match its manifest: ${raw.file}`);
    }

    const lines = bytes.toString("utf8").split("\n").slice(0, -1);

    files.set(raw.file, { file: raw.file, pid: Number(raw.pid), sha256: raw.sha256, lines });

    listed.add(raw.file);
  }

  const actual = readdirSync(outputDirectory).filter((name) =>
    name.startsWith("native-process-trace."),
  );

  if (actual.length !== listed.size || actual.some((name) => !listed.has(name))) {
    throw new Error("Linux raw strace output has missing or unlisted trace files");
  }

  for (const raw of traceValue.cancelledSyscalls) {
    if (
      !isRecord(raw) ||
      !Number.isSafeInteger(raw.tid) ||
      !Array.isArray(raw.interstitialTraces)
    ) {
      throw new Error("Linux cancelled-syscall evidence is malformed");
    }

    const unfinished = validateLinuxTraceBundle(
      { completion: raw.unfinishedTrace },
      files,
      Number(raw.tid),
      "Cancelled syscall start",
    );
    const terminal = validateLinuxTraceBundle(
      { completion: raw.terminalTrace },
      files,
      Number(raw.tid),
      "Cancelled syscall terminal",
    );

    if (
      !isRecord(raw.unfinishedTrace) ||
      !isRecord(raw.terminalTrace) ||
      !Array.isArray(raw.interstitialTraces)
    ) {
      throw new Error("Linux cancelled syscall does not retain all raw line references");
    }

    const unfinishedLine = Number(raw.unfinishedTrace.line);
    const terminalLine = Number(raw.terminalTrace.line);
    const interstitialLines = raw.interstitialTraces.map((ref) =>
      isRecord(ref) ? Number(ref.line) : NaN,
    );

    if (
      !unfinished.includes("<unfinished ...>") ||
      !/\+\+\+ (?:exited with \d+|killed by SIG[A-Z0-9]+)/u.test(terminal) ||
      !Number.isSafeInteger(unfinishedLine) ||
      !Number.isSafeInteger(terminalLine) ||
      unfinishedLine >= terminalLine ||
      interstitialLines.some(
        (line) => !Number.isSafeInteger(line) || line <= unfinishedLine || line >= terminalLine,
      )
    ) {
      throw new Error("Linux cancelled syscall is not closed by a process terminal record");
    }

    for (const ref of raw.interstitialTraces) {
      validateLinuxTraceBundle(
        { completion: ref },
        files,
        Number(raw.tid),
        "Cancelled syscall interstitial",
      );
    }
  }

  return files;
}

function validateLinuxNativeEvent(
  rawEvent: unknown,
  files: ReadonlyMap<string, LinuxTraceFile>,
  observedAt: number,
): Record<string, unknown> {
  if (!isRecord(rawEvent)) throw new Error("Linux native event is not an object");

  const optionalOwner = rawEvent.ownerRole === undefined ? [] : ["ownerRole", "ownerArgv"];

  requireExactKeys(
    rawEvent,
    [
      "pid",
      "parentPid",
      "procStarttimeTicks",
      "pidfdAttachedAt",
      "pidfdReadyAt",
      "executions",
      "parents",
      "executablePath",
      "procArgv",
      "threadGroupId",
      "outcome",
      "traceExit",
      "threadExits",
      "execEvents",
      "creator",
      "traceFileSha256",
      ...optionalOwner,
    ],
    "Linux native process event",
  );

  if (
    !Number.isSafeInteger(rawEvent.pid) ||
    Number(rawEvent.pid) <= 0 ||
    !Number.isSafeInteger(rawEvent.parentPid) ||
    Number(rawEvent.parentPid) <= 0 ||
    !Number.isSafeInteger(rawEvent.procStarttimeTicks) ||
    Number(rawEvent.procStarttimeTicks) <= 0 ||
    rawEvent.threadGroupId !== rawEvent.pid ||
    !isTimestamp(rawEvent.pidfdAttachedAt) ||
    !isTimestamp(rawEvent.pidfdReadyAt) ||
    typeof rawEvent.executablePath !== "string" ||
    realpathSync(rawEvent.executablePath) !== rawEvent.executablePath ||
    !Array.isArray(rawEvent.procArgv) ||
    rawEvent.procArgv.length === 0 ||
    !rawEvent.procArgv.every((argument) => typeof argument === "string") ||
    !Array.isArray(rawEvent.parents) ||
    typeof rawEvent.traceFileSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(rawEvent.traceFileSha256)
  ) {
    throw new Error("Linux native process event has invalid generation or argv fields");
  }

  const attachedAt = timestamp(rawEvent.pidfdAttachedAt)!;
  const readyAt = timestamp(rawEvent.pidfdReadyAt)!;
  const attachedAtNs = linuxTimestampNs(rawEvent.pidfdAttachedAt);
  const readyAtNs = linuxTimestampNs(rawEvent.pidfdReadyAt);

  if (attachedAt > readyAt || readyAt > observedAt)
    throw new Error("Linux pidfd lifecycle timestamps are out of order");

  if (attachedAtNs === undefined || readyAtNs === undefined || attachedAtNs > readyAtNs)
    throw new Error("Linux pidfd nanosecond timestamps are malformed or out of order");

  let previousParentAt = -Infinity;

  for (const parent of rawEvent.parents) {
    if (!isRecord(parent)) throw new Error("Linux parent generation history entry is malformed");

    requireExactKeys(parent, ["pid", "observedAt"], "Linux parent generation history entry");

    const parentAt = timestamp(parent.observedAt);

    if (
      !Number.isSafeInteger(parent.pid) ||
      Number(parent.pid) <= 0 ||
      parentAt === undefined ||
      parentAt < attachedAt ||
      parentAt > readyAt ||
      parentAt < previousParentAt
    ) {
      throw new Error("Linux parent generation history has invalid PID or timing");
    }

    previousParentAt = parentAt;
  }

  if (
    rawEvent.parents.length === 0 ||
    !isRecord(rawEvent.parents[0]) ||
    rawEvent.parents[0].pid !== rawEvent.parentPid
  ) {
    throw new Error("Linux native event does not retain its original observed parent PID");
  }

  if (!isRecord(rawEvent.outcome)) throw new Error("Linux native process outcome is malformed");

  if (rawEvent.outcome.kind === "exit") {
    requireExactKeys(rawEvent.outcome, ["kind", "status"], "Linux normal exit outcome");

    if (
      !Number.isSafeInteger(rawEvent.outcome.status) ||
      Number(rawEvent.outcome.status) < 0 ||
      Number(rawEvent.outcome.status) > 255
    ) {
      throw new Error("Linux normal exit status is invalid");
    }
  } else if (rawEvent.outcome.kind === "signal") {
    requireExactKeys(rawEvent.outcome, ["kind", "signal"], "Linux signal exit outcome");

    if (
      typeof rawEvent.outcome.signal !== "string" ||
      !/^SIG[A-Z0-9]+$/u.test(rawEvent.outcome.signal)
    ) {
      throw new Error("Linux terminating signal is invalid");
    }
  } else {
    throw new Error("Linux process outcome must distinguish exit status from terminating signal");
  }

  const terminalText = validateLinuxTraceBundle(
    rawEvent.traceExit,
    files,
    Number(rawEvent.pid),
    "Linux process exit",
  );
  const expectedTerminal =
    rawEvent.outcome.kind === "exit"
      ? new RegExp(`\\+\\+\\+ exited with ${rawEvent.outcome.status} \\+\\+\\+`)
      : new RegExp(`\\+\\+\\+ killed by ${rawEvent.outcome.signal}(?: \\(.*\\))? \\+\\+\\+`);

  if (!expectedTerminal.test(terminalText))
    throw new Error("Raw strace process terminal record disagrees with the Linux outcome");

  const processTrace = files.get(`native-process-trace.${rawEvent.pid}`);

  if (!processTrace || processTrace.sha256 !== rawEvent.traceFileSha256) {
    throw new Error("Linux process event is not bound to its retained raw TID trace file");
  }

  if (!Array.isArray(rawEvent.threadExits) || rawEvent.threadExits.length === 0) {
    throw new Error("Linux process event omits independently traced thread-group exits");
  }

  const threadIds = new Set<number>();

  for (const rawExit of rawEvent.threadExits) {
    if (!isRecord(rawExit)) throw new Error("Linux thread exit is malformed");

    requireExactKeys(rawExit, ["tid", "outcome", "trace"], "Linux thread exit");

    if (
      !Number.isSafeInteger(rawExit.tid) ||
      Number(rawExit.tid) <= 0 ||
      threadIds.has(Number(rawExit.tid))
    ) {
      throw new Error("Linux process event has duplicate or invalid thread exits");
    }

    threadIds.add(Number(rawExit.tid));

    const threadText = validateLinuxTraceBundle(
      rawExit.trace,
      files,
      Number(rawExit.tid),
      "Linux thread exit",
    );

    if (!isRecord(rawExit.outcome)) throw new Error("Linux thread outcome is malformed");

    let threadTerminal: RegExp | undefined;

    if (rawExit.outcome.kind === "exit") {
      requireExactKeys(rawExit.outcome, ["kind", "status"], "Linux thread exit outcome");

      if (
        !Number.isSafeInteger(rawExit.outcome.status) ||
        Number(rawExit.outcome.status) < 0 ||
        Number(rawExit.outcome.status) > 255
      ) {
        throw new Error("Linux thread exit status is invalid");
      }

      threadTerminal = new RegExp(`\\+\\+\\+ exited with ${rawExit.outcome.status} \\+\\+\\+`);
    } else if (rawExit.outcome.kind === "signal") {
      requireExactKeys(rawExit.outcome, ["kind", "signal"], "Linux thread signal outcome");

      if (
        typeof rawExit.outcome.signal !== "string" ||
        !/^SIG[A-Z0-9]+$/u.test(rawExit.outcome.signal)
      ) {
        throw new Error("Linux thread signal name is invalid");
      }

      threadTerminal = new RegExp(
        `\\+\\+\\+ killed by ${rawExit.outcome.signal}(?: \\(.*\\))? \\+\\+\\+`,
      );
    }

    if (!threadTerminal?.test(threadText))
      throw new Error("Raw strace thread outcome is inconsistent");
  }

  if (!threadIds.has(Number(rawEvent.pid)))
    throw new Error("Linux process event omits its leader-thread exit");

  if (!Array.isArray(rawEvent.executions) || rawEvent.executions.length === 0) {
    throw new Error("Linux process event omits its observed executable and argv history");
  }

  let previousExecutionAtNs: bigint | undefined;

  for (const image of rawEvent.executions) {
    if (!isRecord(image)) throw new Error("Linux executable history entry is malformed");

    requireExactKeys(
      image,
      ["executablePath", "argv", "observedAt"],
      "Linux executable history entry",
    );

    const atNs = linuxTimestampNs(image.observedAt);

    if (
      typeof image.executablePath !== "string" ||
      !Array.isArray(image.argv) ||
      !image.argv.every((argument) => typeof argument === "string") ||
      atNs === undefined ||
      atNs < attachedAtNs ||
      atNs > readyAtNs ||
      (previousExecutionAtNs !== undefined && atNs < previousExecutionAtNs)
    ) {
      throw new Error("Linux executable history has invalid paths, vectors, or timing");
    }

    previousExecutionAtNs = atNs;
  }

  const lastImage = rawEvent.executions.at(-1);

  if (
    !isRecord(lastImage) ||
    lastImage.executablePath !== rawEvent.executablePath ||
    JSON.stringify(lastImage.argv) !== JSON.stringify(rawEvent.procArgv)
  ) {
    throw new Error(
      "Linux proc argv vector is not the retained generation's latest native snapshot",
    );
  }

  if (!Array.isArray(rawEvent.execEvents))
    throw new Error("Linux process event has no exec trace list");

  if (
    rawEvent.ownerRole !== undefined &&
    ((rawEvent.ownerRole !== "extension-host" && rawEvent.ownerRole !== "language-server") ||
      !Array.isArray(rawEvent.ownerArgv) ||
      !rawEvent.ownerArgv.every((argument) => typeof argument === "string"))
  ) {
    throw new Error("Linux owner-bound event has an unknown role or malformed runtime argv vector");
  }

  for (const rawExec of rawEvent.execEvents) {
    if (!isRecord(rawExec)) throw new Error("Linux exec trace entry is malformed");

    requireExactKeys(
      rawExec,
      ["tid", "path", "resolvedPath", "argv", "trace"],
      "Linux exec trace entry",
    );

    if (
      !Number.isSafeInteger(rawExec.tid) ||
      typeof rawExec.path !== "string" ||
      (rawExec.resolvedPath !== null && typeof rawExec.resolvedPath !== "string") ||
      !Array.isArray(rawExec.argv) ||
      rawExec.argv.length === 0 ||
      !rawExec.argv.every((argument) => typeof argument === "string")
    ) {
      throw new Error("Linux exec trace path fields are malformed");
    }

    const expectedResolvedPath =
      rawExec.path === "/proc/self/exe"
        ? rawExec.resolvedPath
        : isAbsolute(rawExec.path)
          ? realpathSync(rawExec.path)
          : null;

    if (rawExec.resolvedPath !== expectedResolvedPath) {
      throw new Error("Linux exec trace resolved path does not match the raw syscall path");
    }

    if (
      rawExec.path === "/proc/self/exe" &&
      rawExec.resolvedPath !== null &&
      (!isAbsolute(rawExec.resolvedPath) ||
        realpathSync(rawExec.resolvedPath) !== rawExec.resolvedPath)
    ) {
      throw new Error(
        "Linux tracee-context executable resolution is not a canonical absolute path",
      );
    }

    const execText = validateLinuxTraceBundle(
      rawExec.trace,
      files,
      Number(rawExec.tid),
      "Linux exec trace",
    );

    if (!isSuccessfulLinuxExec(execText) || !execText.includes(JSON.stringify(rawExec.path))) {
      throw new Error("Linux exec trace does not retain its actual syscall path and arguments");
    }

    let argvSearchFrom = 0;

    for (const argument of rawExec.argv) {
      const index = execText.indexOf(JSON.stringify(argument), argvSearchFrom);

      if (index < 0)
        throw new Error("Linux exec argv vector is not present in its raw strace syscall");

      argvSearchFrom = index + JSON.stringify(argument).length;
    }
  }

  if (rawEvent.creator !== null) {
    if (!isRecord(rawEvent.creator)) throw new Error("Linux process creator is malformed");

    requireExactKeys(
      rawEvent.creator,
      ["parentTid", "parentPid", "childPid", "trace"],
      "Linux process creator",
    );

    if (
      rawEvent.creator.childPid !== rawEvent.pid ||
      !Number.isSafeInteger(rawEvent.creator.parentPid) ||
      Number(rawEvent.creator.parentPid) <= 0 ||
      !Number.isSafeInteger(rawEvent.creator.parentTid)
    ) {
      throw new Error("Linux traced creator does not match the retained native parent");
    }

    const creatorText = validateLinuxTraceBundle(
      rawEvent.creator.trace,
      files,
      Number(rawEvent.creator.parentTid),
      "Linux process creation",
    );

    if (
      !/\b(?:clone3?|fork|vfork)\(/u.test(creatorText) ||
      !new RegExp(`=\\s*${rawEvent.pid}(?:\\s|$)`).test(creatorText)
    ) {
      throw new Error("Linux creator trace does not independently show the child PID");
    }
  }

  return rawEvent;
}

function validateLinuxTraceClosure(
  files: ReadonlyMap<string, LinuxTraceFile>,
  events: readonly Record<string, unknown>[],
  codeGuiPid?: number,
  codeExecutable?: string,
): LinuxTraceTopology {
  const ownerByTid = new Map<number, Record<string, unknown>>();
  const creatorByLocation = new Map<string, Record<string, unknown>>();
  const eventByPid = new Map<number, Record<string, unknown>>();
  const execClaims = new Map<
    string,
    { readonly pid: number; readonly item: Record<string, unknown> }
  >();

  for (const event of events) {
    const pid = Number(event.pid);

    if (eventByPid.has(pid)) throw new Error(`Linux PID ${pid} has duplicate native generations`);

    eventByPid.set(pid, event);

    if (!Array.isArray(event.execEvents))
      throw new Error("Linux native generation " + pid + " omits its successful exec events");

    for (const item of event.execEvents) {
      if (!isRecord(item) || !isRecord(item.trace) || !isRecord(item.trace.completion))
        throw new Error("Linux native generation " + pid + " has a malformed exec reference");

      const completion = item.trace.completion;

      if (typeof completion.file !== "string" || !Number.isSafeInteger(completion.line))
        throw new Error("Linux native generation " + pid + " has an imprecise exec reference");

      const key = completion.file + ":" + completion.line;

      if (execClaims.has(key)) throw new Error("Linux exec reference " + key + " is duplicated");

      execClaims.set(key, { pid, item });
    }

    if (!Array.isArray(event.threadExits))
      throw new Error("Linux process event omits its thread exits");

    for (const rawExit of event.threadExits) {
      if (!isRecord(rawExit) || !Number.isSafeInteger(rawExit.tid)) {
        throw new Error("Linux raw trace closure contains a malformed thread exit");
      }

      const tid = Number(rawExit.tid);

      if (ownerByTid.has(tid))
        throw new Error(`Linux raw TID ${tid} is assigned to multiple process generations`);

      ownerByTid.set(tid, event);
    }

    if (event.creator !== null) {
      const creator = event.creator;

      if (!isRecord(creator) || !isRecord(creator.trace) || !isRecord(creator.trace.completion)) {
        throw new Error("Linux raw trace closure contains a malformed process creator");
      }

      const ref = creator.trace.completion;

      if (typeof ref.file !== "string" || !Number.isSafeInteger(ref.line)) {
        throw new Error("Linux process creator has no exact raw trace line");
      }

      const location = `${ref.file}:${ref.line}`;

      if (creatorByLocation.has(location) || creator.childPid !== pid) {
        throw new Error("Linux process creator line is ambiguous or names another generation");
      }

      creatorByLocation.set(location, event);
    }
  }

  const spawnCalls = /^(?:(?:\d+)(?:\.\d+)?\s+)?(clone3?|fork|vfork)\(.*\)\s+=\s+(\d+)(?:\s|$)/u;
  const unfinishedCall =
    /^(?:(?:\d+)(?:\.\d+)?\s+)?([A-Za-z_][A-Za-z_0-9]*)\(.*<unfinished \.\.\.>$/u;
  const resumedCall = /^(?:(?:\d+)(?:\.\d+)?\s+)?<\.\.\. ([A-Za-z_][A-Za-z_0-9]*) resumed>(.*)$/u;
  const terminalCall =
    /^(?:(?:\d+)(?:\.\d+)?\s+)?\+\+\+ (?:exited with \d+|killed by SIG[A-Z0-9]+(?: \(.*\))?) \+\+\+$/u;
  const creations = new Map<
    number,
    {
      readonly parentTid: number;
      readonly isThread: boolean;
      readonly file: string;
      readonly line: number;
      readonly startNs: bigint;
      readonly completionNs: bigint;
      readonly startLine?: number;
    }[]
  >();
  const creatorByPid = new Map<number, LinuxCreatorTransition>();
  const execsByTid = new Map<number, LinuxExecTransition[]>();

  for (const file of files.values()) {
    let terminalCount = 0;
    let pending:
      | { readonly name: string; readonly prefix: string; readonly line: number }
      | undefined;

    for (let index = 0; index < file.lines.length; index += 1) {
      const line = file.lines[index]!;

      if (terminalCall.test(line)) terminalCount += 1;

      const unfinished = unfinishedCall.exec(line);

      if (unfinished) {
        if (unfinished[1] === "execveat") {
          throw new Error(
            "Unsupported pending execveat transition at " + file.file + ":" + (index + 1),
          );
        }

        if (pending)
          throw new Error(`Linux trace contains nested unfinished syscalls in ${file.file}`);

        const marker = line.indexOf("<unfinished ...>");
        pending = { name: unfinished[1]!, prefix: line.slice(0, marker), line: index + 1 };
        continue;
      }

      const resumed = resumedCall.exec(line);
      let syscallLine = line;
      let startLine: number | undefined;

      if (resumed) {
        if (!pending || pending.name !== resumed[1]) {
          throw new Error(
            `Linux trace has an orphan or mismatched resumed syscall in ${file.file}`,
          );
        }

        syscallLine = pending.prefix + resumed[2];
        startLine = pending.line;
        pending = undefined;
      } else if (pending && terminalCall.test(line)) {
        pending = undefined;
      } else if (pending && /^\d+(?:\.\d+)?\s+--- SIG[A-Z0-9]+/u.test(line)) {
        continue;
      } else if (pending) {
        throw new Error(`Linux trace has an unresolved syscall before ${file.file}:${index + 1}`);
      }

      const spawn = spawnCalls.exec(syscallLine);

      if (spawn) {
        const childPid = Number(spawn[2]);
        const intervalStart = startLine === undefined ? line : file.lines[startLine - 1]!;
        const startNs = linuxTraceTimestampNs(intervalStart);
        const completionNs = linuxTraceTimestampNs(line);
        const isThread =
          spawn[1] === "clone" || spawn[1] === "clone3"
            ? syscallLine.includes("CLONE_THREAD")
            : false;
        const edges = creations.get(childPid) ?? [];

        edges.push({
          parentTid: file.pid,
          isThread,
          file: file.file,
          line: index + 1,
          startNs,
          completionNs,
          ...(startLine === undefined ? {} : { startLine }),
        });

        creations.set(childPid, edges);

        if (!isThread) {
          const flagsMatch = /\bflags=([^,})\s]+(?:\|[^,})\s]+)*)/u.exec(syscallLine);
          const flags = new Set(flagsMatch?.[1]?.split("|") ?? []);
          const allowedFlags = new Set(["CLONE_CHILD_CLEARTID", "CLONE_CHILD_SETTID", "SIGCHLD"]);
          const imageInheritanceSafe =
            spawn[1] === "fork" ||
            ((spawn[1] === "clone" || spawn[1] === "clone3") &&
              flags.size > 0 &&
              [...flags].every((flag) => allowedFlags.has(flag)));

          creatorByPid.set(childPid, {
            parentTid: file.pid,
            startNs,
            completionNs,
            callName: spawn[1]!,
            flags: [...flags],
            imageInheritanceSafe,
          });
        }
      }

      if (
        /(?:^|\s)execveat\(/u.test(syscallLine) &&
        /(?:^|\s)(?:execveat\(|<\.\.\. execveat resumed>).*\)\s+=\s+0(?:\s|$)/u.test(syscallLine)
      ) {
        throw new Error(
          "Unsupported successful execveat transition at " + file.file + ":" + (index + 1),
        );
      }

      const execMatch = /(?:^|\s)execve\(/u.exec(syscallLine);

      if (execMatch && isSuccessfulLinuxExec(syscallLine)) {
        const parsedExec = parseLinuxExecve(syscallLine);
        const key = file.file + ":" + (index + 1);
        const claim = execClaims.get(key);
        const intervalStart = startLine === undefined ? line : file.lines[startLine - 1]!;
        const startNs = linuxTraceTimestampNs(intervalStart);
        const completionNs = linuxTraceTimestampNs(line);

        if (startNs > completionNs || (startLine !== undefined && startNs === completionNs))
          throw new Error("Linux exec interval is ambiguous at " + file.file + ":" + (index + 1));

        if (claim) {
          if (claim.item.tid !== file.pid)
            throw new Error("Linux exec reference " + key + " is assigned to another raw TID");

          if (
            claim.item.path !== parsedExec.path ||
            !Array.isArray(claim.item.argv) ||
            JSON.stringify(claim.item.argv) !== JSON.stringify(parsedExec.argv)
          ) {
            throw new Error(
              "Linux native exec claim differs from its exact raw path or argv vector",
            );
          }

          const rawResolvedPath =
            parsedExec.path === "/proc/self/exe"
              ? claim.item.resolvedPath
              : isAbsolute(parsedExec.path)
                ? realpathSync(parsedExec.path)
                : null;

          if (claim.item.resolvedPath !== rawResolvedPath) {
            throw new Error(
              "Linux native exec claim has a resolved path inconsistent with its raw path",
            );
          }

          execClaims.delete(key);
        }

        const transition: LinuxExecTransition = {
          pid: claim?.pid ?? 0,
          tid: file.pid,
          path: parsedExec.path,
          resolvedPath:
            claim &&
            (typeof claim.item.resolvedPath === "string" || claim.item.resolvedPath === null)
              ? claim.item.resolvedPath
              : null,
          argv: parsedExec.argv,
          admitted: claim !== undefined,
          startNs,
          completionNs,
          traceFile: file.file,
          traceLine: index + 1,
        };
        const transitions = execsByTid.get(file.pid) ?? [];

        transitions.push(transition);

        execsByTid.set(file.pid, transitions);
      }
    }

    if (pending?.name === "execveat") {
      throw new Error("Unsupported pending execveat transition in " + file.file);
    }

    if (pending || terminalCount !== 1) {
      throw new Error(
        `Linux raw TID trace ${file.file} has unresolved syscalls or lacks one terminal exit`,
      );
    }
  }

  const traceTids = new Set([...files.values()].map((file) => file.pid));
  const roots = [...traceTids].filter((tid) => !creations.has(tid));

  if (roots.length !== 1)
    throw new Error(
      "Linux raw process trace does not have exactly one initial Code CLI generation",
    );

  for (const [childTid, edges] of creations) {
    if (edges.length !== 1 || !traceTids.has(childTid) || !traceTids.has(edges[0]!.parentTid)) {
      throw new Error(
        `Linux raw process tree has a missing trace file or ambiguous creator for TID ${childTid}`,
      );
    }
  }

  const groupOf = (tid: number, visiting = new Set<number>()): number => {
    if (visiting.has(tid)) throw new Error("Linux raw thread-group ancestry contains a cycle");

    visiting.add(tid);

    const edge = creations.get(tid)?.[0];

    if (!edge || !edge.isThread) return tid;

    return groupOf(edge.parentTid, visiting);
  };

  if (execClaims.size !== 0)
    throw new Error("Native process events omit successful raw exec transitions");

  const execsByPid = new Map<number, LinuxExecTransition[]>();

  for (const [tid, transitions] of execsByTid) {
    const pid = groupOf(tid);
    const nativeEvent = eventByPid.get(pid);

    for (const transition of transitions) {
      if (transition.pid !== 0 && transition.pid !== pid)
        throw new Error("Linux exec reference is assigned to a different thread group");

      if (nativeEvent && transition.pid === 0)
        throw new Error("Native process event omits a successful raw exec transition");
    }

    const groupTransitions = execsByPid.get(pid) ?? [];

    groupTransitions.push(...transitions.map((item) => ({ ...item, pid })));

    execsByPid.set(pid, groupTransitions);
  }

  for (const [pid, transitions] of execsByPid) {
    transitions.sort((left, right) =>
      left.startNs < right.startNs ? -1 : left.startNs > right.startNs ? 1 : 0,
    );

    if (
      transitions.some(
        (item, index) => index > 0 && transitions[index - 1]!.completionNs >= item.startNs,
      )
    ) {
      throw new Error(
        "Linux process " + pid + " has overlapping or tied successful exec intervals",
      );
    }
  }

  const processParentByPid = new Map<number, number>();

  for (const [childPid, edges] of creations) {
    const edge = edges[0]!;

    if (!edge.isThread) processParentByPid.set(childPid, groupOf(edge.parentTid));
  }

  const processGroupPids = new Set([...traceTids].map((tid) => groupOf(tid)));

  let rawOnlyLifetimes:
    | Map<number, { readonly birthNs: bigint; readonly terminalNs: bigint }>
    | undefined;

  const validateRawOnlyTraceTree = () => {
    if (rawOnlyLifetimes) return rawOnlyLifetimes;

    if (execClaims.size !== 0) {
      throw new Error("Linux raw-only creator proof has unclaimed successful exec transitions");
    }

    const lifetimes = new Map<number, { readonly birthNs: bigint; readonly terminalNs: bigint }>();
    const completeSignalDelivery =
      /^(\d+(?:\.\d+)?)\s+--- (SIG[A-Z0-9_]+) \{si_signo=(SIG[A-Z0-9_]+), si_code=[^,\s{}]+(?:, [A-Za-z][A-Za-z0-9_]*=[^,\s{}][^,{}]*)*\} ---$/u;

    for (const file of files.values()) {
      if (file.lines.length === 0) {
        throw new Error(`Linux raw-only creator proof has an empty TID trace: ${file.file}`);
      }

      const timestamps: bigint[] = [];
      let previousLifecycleTimestamp: bigint | undefined;
      const terminals: number[] = [];

      for (let index = 0; index < file.lines.length; index += 1) {
        const line = file.lines[index]!.replace(/\r$/u, "");
        const currentNs = linuxTraceTimestampNs(line);
        const signalDelivery = completeSignalDelivery.exec(line);

        if (!signalDelivery || signalDelivery[2] !== signalDelivery[3]) {
          if (previousLifecycleTimestamp !== undefined && currentNs < previousLifecycleTimestamp) {
            throw new Error(
              `Linux raw-only creator proof has nonmonotonic TID trace: ${file.file}`,
            );
          }

          previousLifecycleTimestamp = currentNs;
        }

        timestamps.push(currentNs);

        if (terminalCall.test(line)) terminals.push(index);
      }

      if (terminals.length !== 1 || terminals[0] !== file.lines.length - 1) {
        throw new Error(
          `Linux raw-only creator proof has records after or multiple terminal trace records: ${file.file}`,
        );
      }

      const edges = creations.get(file.pid) ?? [];

      if (file.pid !== roots[0] && edges.length !== 1) {
        throw new Error(`Linux raw-only creator proof has no unique birth for TID ${file.pid}`);
      }

      if (edges.length > 1 || (file.pid === roots[0] && edges.length !== 0)) {
        throw new Error(
          `Linux raw-only creator proof has an ambiguous raw root or birth for TID ${file.pid}`,
        );
      }

      const birthNs = edges[0]?.startNs ?? timestamps[0]!;
      const terminalNs = timestamps[terminals[0]!];

      if (birthNs >= terminalNs!) {
        throw new Error(
          `Linux raw-only creator proof has an invalid raw lifetime for TID ${file.pid}`,
        );
      }

      lifetimes.set(file.pid, { birthNs, terminalNs: terminalNs! });
    }

    if (creations.size !== traceTids.size - 1) {
      throw new Error("Linux raw-only creator proof has missing or detached raw process births");
    }

    for (const [childTid, edges] of creations) {
      const edge = edges[0];
      const parent = edge && lifetimes.get(edge.parentTid);

      if (
        edges.length !== 1 ||
        !files.has(`native-process-trace.${childTid}`) ||
        !parent ||
        edge!.startNs <= parent.birthNs ||
        edge!.completionNs >= parent.terminalNs
      ) {
        throw new Error(
          `Linux raw-only creator proof has an incomplete raw birth edge for TID ${childTid}`,
        );
      }
    }

    const rootPid = groupOf(roots[0]!);
    const processGroups = new Set([...traceTids].map((tid) => groupOf(tid)));

    for (const initialPid of processGroups) {
      let currentPid = initialPid;
      const ancestry = new Set<number>();

      while (currentPid !== rootPid) {
        if (ancestry.has(currentPid)) {
          throw new Error("Linux raw-only creator proof has a disconnected process cycle");
        }

        ancestry.add(currentPid);

        const parentPid = processParentByPid.get(currentPid);

        if (parentPid === undefined || parentPid === currentPid) {
          throw new Error(
            "Linux raw-only creator proof has a process chain detached from its root",
          );
        }

        currentPid = parentPid;
      }
    }

    rawOnlyLifetimes = lifetimes;
    return lifetimes;
  };

  const rawGroupTerminal = (pid: number, lifetimes = validateRawOnlyTraceTree()): bigint => {
    const members = [...traceTids].filter((tid) => groupOf(tid) === pid);

    if (members.length === 0)
      throw new Error(`Linux raw-only creator group ${pid} has no traced members`);

    return members.reduce((latest, tid) => {
      const lifetime = lifetimes.get(tid);

      if (!lifetime) throw new Error(`Linux raw-only creator group ${pid} has an untraced member`);

      return lifetime.terminalNs > latest ? lifetime.terminalNs : latest;
    }, 0n);
  };

  const rawCreatorCallIsSupported = (creator: LinuxCreatorTransition): boolean => {
    if (creator.callName === "fork" || creator.callName === "vfork") return true;

    if (creator.callName !== "clone" && creator.callName !== "clone3") return false;

    const allowed = new Set([
      "CLONE_CHILD_CLEARTID",
      "CLONE_CHILD_SETTID",
      "CLONE_CLEAR_SIGHAND",
      "CLONE_VM",
      "CLONE_VFORK",
      "SIGCHLD",
    ]);
    return creator.flags.length > 0 && creator.flags.every((flag) => allowed.has(flag));
  };

  const validateRetainedRawLifetime = (
    event: Record<string, unknown>,
    pid: number,
    birthNs: bigint,
    terminalNs: bigint,
    label: string,
  ): void => {
    const parents = Array.isArray(event.parents) ? event.parents : undefined;
    const firstParent = parents?.[0];
    const attachedNs = linuxTimestampNs(event.pidfdAttachedAt);
    const readyNs = linuxTimestampNs(event.pidfdReadyAt);
    const sampleNs = isRecord(firstParent) ? linuxTimestampNs(firstParent.observedAt) : undefined;

    if (
      event.pid !== pid ||
      !Number.isSafeInteger(event.procStarttimeTicks) ||
      Number(event.procStarttimeTicks) <= 0 ||
      attachedNs === undefined ||
      readyNs === undefined ||
      sampleNs === undefined ||
      birthNs >= attachedNs ||
      attachedNs > sampleNs ||
      sampleNs >= terminalNs ||
      readyNs < terminalNs
    ) {
      throw new Error(`Linux ${label} does not bind its native generation to the raw lifetime`);
    }
  };

  const validateRawOnlyCreatorProof = (
    childEvent: Record<string, unknown>,
    rawCreatorPid: number,
  ): void => {
    const lifetimes = validateRawOnlyTraceTree();

    if (!Number.isSafeInteger(codeGuiPid) || Number(codeGuiPid) <= 0 || !codeExecutable) {
      throw new Error("Linux raw-only creator proof has no retained Code GUI anchor");
    }

    const codeGui = eventByPid.get(Number(codeGuiPid));
    const guiLifetime = lifetimes.get(Number(codeGuiPid));
    const guiTerminalNs = rawGroupTerminal(Number(codeGuiPid), lifetimes);

    if (
      !codeGui ||
      !guiLifetime ||
      codeGui.executablePath !== codeExecutable ||
      groupOf(Number(codeGuiPid)) !== Number(codeGuiPid)
    ) {
      throw new Error(
        "Linux raw-only creator proof has no independently retained Code GUI generation",
      );
    }

    validateRetainedRawLifetime(
      codeGui,
      Number(codeGuiPid),
      guiLifetime.birthNs,
      guiTerminalNs,
      "retained Code GUI anchor",
    );

    if (eventByPid.has(rawCreatorPid)) {
      throw new Error(
        `Linux raw-only creator fallback selected a retained creator PID ${rawCreatorPid}`,
      );
    }

    const childPid = Number(childEvent.pid);
    const childCreator = creatorByPid.get(childPid);
    const childLifetime = lifetimes.get(childPid);
    const firstParent = Array.isArray(childEvent.parents) ? childEvent.parents[0] : undefined;
    const childAttachedNs = linuxTimestampNs(childEvent.pidfdAttachedAt);
    const childReadyNs = linuxTimestampNs(childEvent.pidfdReadyAt);
    const childSampleNs = isRecord(firstParent)
      ? linuxTimestampNs(firstParent.observedAt)
      : undefined;
    const childTerminalNs = rawGroupTerminal(childPid, lifetimes);

    if (
      !childCreator ||
      !childLifetime ||
      !isRecord(firstParent) ||
      Number(firstParent.pid) !== Number(childEvent.parentPid) ||
      childEvent.parentPid === rawCreatorPid ||
      childAttachedNs === undefined ||
      childReadyNs === undefined ||
      childSampleNs === undefined ||
      childLifetime.birthNs >= childAttachedNs ||
      childAttachedNs > childSampleNs ||
      childSampleNs >= childTerminalNs ||
      childReadyNs < childTerminalNs
    ) {
      throw new Error(
        `Linux raw-only child ${childPid} pidfd and parent sample do not bind its raw lifetime`,
      );
    }

    const sampledParentPid = Number(childEvent.parentPid);

    if (
      processGroupPids.has(sampledParentPid) &&
      rawGroupTerminal(sampledParentPid, lifetimes) <= childSampleNs!
    ) {
      throw new Error(
        `Linux raw-only child ${childPid} parent sample aliases an exited raw process generation`,
      );
    }

    if (!rawCreatorCallIsSupported(childCreator)) {
      throw new Error(`Linux raw-only child ${childPid} has unsupported raw creator flags`);
    }

    const creatorBirth = creatorByPid.get(rawCreatorPid);
    const creatorLifetime = lifetimes.get(rawCreatorPid);
    const creatorTerminalNs = rawGroupTerminal(rawCreatorPid, lifetimes);

    if (
      !creatorBirth ||
      !creatorLifetime ||
      !rawCreatorCallIsSupported(creatorBirth) ||
      processParentByPid.get(childPid) !== rawCreatorPid
    ) {
      throw new Error(
        `Linux raw-only creator ${rawCreatorPid} has no unique raw lifetime containing the child birth`,
      );
    }

    const creatorParentTid = childCreator.parentTid;
    const creatorParentLifetime = lifetimes.get(creatorParentTid);
    const creatorParentPid = groupOf(creatorParentTid);

    if (
      !creatorParentLifetime ||
      creatorParentPid !== rawCreatorPid ||
      creatorParentLifetime.birthNs >= childCreator.startNs ||
      creatorLifetime.birthNs >= childCreator.startNs ||
      childCreator.completionNs >= creatorParentLifetime.terminalNs ||
      childCreator.completionNs >= creatorTerminalNs ||
      creatorTerminalNs >= childSampleNs
    ) {
      throw new Error(
        `Linux raw-only creator ${rawCreatorPid} did not exit completely before child ${childPid} was sampled`,
      );
    }

    let currentPid = rawCreatorPid;
    const ancestry = new Set<number>();

    while (currentPid !== Number(codeGuiPid)) {
      if (ancestry.has(currentPid)) {
        throw new Error("Linux raw-only creator ancestry contains a cycle");
      }

      ancestry.add(currentPid);

      const creator = creatorByPid.get(currentPid);
      const lifetime = lifetimes.get(currentPid);
      const parentPid = processParentByPid.get(currentPid);

      if (
        !creator ||
        !lifetime ||
        parentPid === undefined ||
        !rawCreatorCallIsSupported(creator) ||
        lifetime.birthNs >= lifetime.terminalNs
      ) {
        throw new Error(
          `Linux raw-only creator PID ${currentPid} has an ambiguous raw ancestry edge`,
        );
      }

      const parentTidLifetime = lifetimes.get(creator.parentTid);

      if (
        !parentTidLifetime ||
        groupOf(creator.parentTid) !== parentPid ||
        parentTidLifetime.birthNs >= creator.startNs ||
        creator.completionNs >= parentTidLifetime.terminalNs ||
        creator.completionNs >= rawGroupTerminal(parentPid, lifetimes)
      ) {
        throw new Error(
          `Linux raw-only creator PID ${currentPid} is not joined to its exact raw parent TID lifetime`,
        );
      }

      for (const exec of execsByPid.get(currentPid) ?? []) {
        if (exec.startNs < lifetime.birthNs || exec.completionNs >= lifetime.terminalNs) {
          throw new Error(
            `Linux raw-only creator PID ${currentPid} has an exec outside its raw lifetime`,
          );
        }
      }

      const retained = eventByPid.get(currentPid);

      if (retained) {
        validateRetainedRawLifetime(
          retained,
          currentPid,
          lifetime.birthNs,
          rawGroupTerminal(currentPid, lifetimes),
          "retained raw ancestor",
        );
      }

      currentPid = parentPid;
    }
  };

  for (const tid of traceTids) {
    if (!ownerByTid.has(tid)) {
      const generation = groupOf(tid);
      const event = eventByPid.get(generation);

      if (event)
        throw new Error(`Admitted Linux process ${generation} omits raw thread TID ${tid}`);
    }

    const event = ownerByTid.get(tid);

    if (event && groupOf(tid) !== event.pid) {
      throw new Error(`Raw trace assigns TID ${tid} to a different native process group`);
    }
  }

  if (ownerByTid.size !== 0) {
    for (const [tid, event] of ownerByTid) {
      if (!traceTids.has(tid) || groupOf(tid) !== event.pid) {
        throw new Error(
          `Native process event contains a thread exit outside its raw thread group: ${tid}`,
        );
      }
    }
  }

  for (const [childPid, edges] of creations) {
    const edge = edges[0]!;

    if (edge.isThread) {
      const parentEvent = ownerByTid.get(edge.parentTid);
      const childEvent = ownerByTid.get(childPid);

      if ((parentEvent || childEvent) && (!parentEvent || parentEvent !== childEvent)) {
        throw new Error(
          `Raw CLONE_THREAD child ${childPid} is not bound to its parent's native process group`,
        );
      }

      continue;
    }

    const event = eventByPid.get(childPid);

    if (!event) continue;

    const location = `${edge.file}:${edge.line}`;
    const creator = creatorByLocation.get(location);

    if (
      !creator ||
      creator !== event ||
      !isRecord(event.creator) ||
      event.creator.parentTid !== edge.parentTid ||
      event.creator.parentPid !== processParentByPid.get(childPid)
    ) {
      throw new Error(
        `Raw strace process creation at ${location} is not bound to its observed native generation`,
      );
    }

    const trace = event.creator.trace;
    const traceStart = isRecord(trace) ? trace.start : undefined;
    const observedCreator = creatorByPid.get(childPid);
    const interval = linuxTraceInterval(trace, files, edge.parentTid, "Linux process creator");

    if (
      !observedCreator ||
      observedCreator.parentTid !== edge.parentTid ||
      observedCreator.startNs !== interval.startNs ||
      observedCreator.completionNs !== interval.completionNs
    ) {
      throw new Error(
        "Linux native creator interval differs from its independently parsed raw call",
      );
    }

    const rawCreatorPid = processParentByPid.get(childPid);

    if (rawCreatorPid === undefined) {
      throw new Error("Linux raw creator group is unresolved");
    }

    if (Number(event.parentPid) !== rawCreatorPid) {
      const creatorGeneration = eventByPid.get(rawCreatorPid);

      if (!creatorGeneration) {
        validateRawOnlyCreatorProof(event, rawCreatorPid);
      } else {
        const creatorParentSample =
          creatorGeneration &&
          Array.isArray(creatorGeneration.parents) &&
          isRecord(creatorGeneration.parents[0])
            ? creatorGeneration.parents[0]
            : undefined;
        const childParentSample =
          Array.isArray(event.parents) && isRecord(event.parents[0]) ? event.parents[0] : undefined;
        const creatorAttachNs = creatorGeneration
          ? linuxTimestampNs(creatorGeneration.pidfdAttachedAt)
          : undefined;
        const creatorReadyNs = creatorGeneration
          ? linuxTimestampNs(creatorGeneration.pidfdReadyAt)
          : undefined;
        const creatorParentSampleNs = creatorParentSample
          ? linuxTimestampNs(creatorParentSample.observedAt)
          : undefined;
        const childParentSampleNs = childParentSample
          ? linuxTimestampNs(childParentSample.observedAt)
          : undefined;
        const creatorMembers = [...traceTids]
          .filter((tid) => groupOf(tid) === rawCreatorPid)
          .sort((left, right) => left - right);
        const creatorExits =
          creatorGeneration && Array.isArray(creatorGeneration.threadExits)
            ? creatorGeneration.threadExits
            : undefined;

        if (
          !creatorGeneration ||
          creatorGeneration.pid !== rawCreatorPid ||
          !Array.isArray(creatorGeneration.threadExits) ||
          !creatorExits ||
          !creatorExits.every(isRecord)
        ) {
          throw new Error(
            "Linux reparent proof lacks the retained creator-group generation and exits",
          );
        }

        const exitTids = creatorExits
          .map((item) => Number(item.tid))
          .sort((left, right) => left - right);

        if (
          creatorMembers.length === 0 ||
          JSON.stringify(exitTids) !== JSON.stringify(creatorMembers) ||
          creatorExits.some((item) => !Number.isSafeInteger(item.tid))
        ) {
          throw new Error(
            "Linux reparent proof lacks complete raw terminal closure for the creator group",
          );
        }

        const groupTerminalNs = creatorExits.reduce((latest, item) => {
          const terminal = validateLinuxTraceBundle(
            item.trace,
            files,
            Number(item.tid),
            "Linux reparent creator-group exit",
          );
          const terminalNs = linuxTraceTimestampNs(terminal);
          return terminalNs > latest ? terminalNs : latest;
        }, 0n);
        const creatorText = validateLinuxTraceBundle(
          event.creator.trace,
          files,
          edge.parentTid,
          "Linux reparent creator",
        );

        if (
          /\bCLONE_PARENT\b/u.test(creatorText) ||
          !creatorParentSample ||
          !childParentSample ||
          Number(childParentSample.pid) !== Number(event.parentPid) ||
          creatorAttachNs === undefined ||
          creatorReadyNs === undefined ||
          creatorParentSampleNs === undefined ||
          childParentSampleNs === undefined ||
          creatorAttachNs > creatorParentSampleNs ||
          creatorParentSampleNs >= observedCreator.startNs ||
          observedCreator.completionNs >= groupTerminalNs ||
          groupTerminalNs >= childParentSampleNs ||
          creatorReadyNs < groupTerminalNs
        ) {
          throw new Error(
            "Linux sampled parent is not proven to follow complete creator-group exit",
          );
        }
      }
    } else if (codeGuiPid !== undefined && !eventByPid.has(rawCreatorPid)) {
      const childParentSample =
        Array.isArray(event.parents) && isRecord(event.parents[0]) ? event.parents[0] : undefined;
      const childParentSampleNs = childParentSample
        ? linuxTimestampNs(childParentSample.observedAt)
        : undefined;

      if (childParentSampleNs === undefined) {
        throw new Error("Linux raw creator parent alias has no precise first parent sample");
      }

      const lifetimes = validateRawOnlyTraceTree();

      if (rawGroupTerminal(rawCreatorPid, lifetimes) <= childParentSampleNs) {
        throw new Error("Linux child parent sample aliases an exited raw creator generation");
      }
    }

    if (
      !isRecord(trace) ||
      (edge.startLine === undefined
        ? traceStart !== undefined
        : !isRecord(traceStart) ||
          !Number.isSafeInteger(traceStart.line) ||
          Number(traceStart.line) !== edge.startLine)
    ) {
      throw new Error(
        `Linux process generation does not retain the exact raw creation syscall lines at ${location}`,
      );
    }
  }

  for (const [pid, event] of eventByPid) {
    if (!traceTids.has(pid) || groupOf(pid) !== pid) {
      throw new Error(`Linux native generation ${pid} is not a raw process-group leader`);
    }

    const groupTids = [...traceTids].filter((tid) => groupOf(tid) === pid).sort((a, b) => a - b);
    const eventTids = Array.isArray(event.threadExits)
      ? event.threadExits
          .filter(isRecord)
          .map((item) => Number(item.tid))
          .sort((a, b) => a - b)
      : [];

    if (JSON.stringify(groupTids) !== JSON.stringify(eventTids)) {
      throw new Error(
        `Linux native generation ${pid} does not account for its complete raw thread group`,
      );
    }
  }

  const processByTid = new Map<number, number>();

  for (const tid of traceTids) processByTid.set(tid, groupOf(tid));

  return { rootPid: roots[0]!, processParentByPid, processByTid, creatorByPid, execsByPid };
}

function validateLinuxExecLineage(
  topology: LinuxTraceTopology,
  events: readonly Record<string, unknown>[],
  codeExecutable: string,
): ReadonlyMap<number, LinuxExecTransition> {
  if (realpathSync(codeExecutable) !== codeExecutable)
    throw new Error("Selected Linux Code ELF path is not canonical");

  const header = Buffer.alloc(20);
  const executableDescriptor = openSync(codeExecutable, "r");
  let headerLength: number;

  try {
    headerLength = readSync(executableDescriptor, header, 0, header.length, 0);
  } finally {
    closeSync(executableDescriptor);
  }

  if (headerLength !== header.length)
    throw new Error("Selected Code executable has a truncated ELF header");

  const byteOrder = header[5] === 1 ? "LE" : header[5] === 2 ? "BE" : undefined;
  const elfType =
    byteOrder === "LE" ? header.readUInt16LE(16) : byteOrder === "BE" ? header.readUInt16BE(16) : 0;
  const machine =
    byteOrder === "LE" ? header.readUInt16LE(18) : byteOrder === "BE" ? header.readUInt16BE(18) : 0;

  if (
    header[0] !== 0x7f ||
    header[1] !== 0x45 ||
    header[2] !== 0x4c ||
    header[3] !== 0x46 ||
    (header[4] !== 1 && header[4] !== 2) ||
    byteOrder === undefined ||
    header[6] !== 1 ||
    (elfType !== 2 && elfType !== 3) ||
    machine === 0
  ) {
    throw new Error("Selected Code executable is not a supported executable ELF image");
  }

  const eventByPid = new Map<number, Record<string, unknown>>();

  for (const event of events) eventByPid.set(Number(event.pid), event);

  const hasCodeProcObservation = (pid: number, afterNs: bigint, beforeNs: bigint): boolean => {
    const event = eventByPid.get(pid);

    if (!event || !Array.isArray(event.executions)) return false;

    return event.executions.some((rawImage) => {
      if (!isRecord(rawImage) || rawImage.executablePath !== codeExecutable) return false;

      const observedAtNs = linuxTimestampNs(rawImage.observedAt);
      return observedAtNs !== undefined && observedAtNs > afterNs && observedAtNs < beforeNs;
    });
  };

  const hasCodeProcImage = (pid: number): boolean => {
    const event = eventByPid.get(pid);
    return (
      event !== undefined &&
      Array.isArray(event.executions) &&
      event.executions.some(
        (rawImage) => isRecord(rawImage) && rawImage.executablePath === codeExecutable,
      )
    );
  };

  const imageAt = (
    pid: number,
    beforeNs: bigint,
    excluded?: LinuxExecTransition,
    visiting = new Set<string>(),
  ): string => {
    const visitKey = pid + ":" + beforeNs;

    if (visiting.has(visitKey)) throw new Error("Linux tracee image ancestry contains a cycle");

    visiting.add(visitKey);

    const isExcluded = (item: LinuxExecTransition): boolean =>
      excluded !== undefined &&
      item.traceFile === excluded.traceFile &&
      item.traceLine === excluded.traceLine;

    const timeline = topology.execsByPid.get(pid) ?? [];

    if (
      timeline.some(
        (item) => !isExcluded(item) && item.startNs <= beforeNs && item.completionNs >= beforeNs,
      )
    ) {
      throw new Error(
        "Linux image boundary overlaps another successful exec interval for PID " + pid,
      );
    }

    const prior = timeline.filter((item) => !isExcluded(item) && item.completionNs < beforeNs);
    const transition = prior.at(-1);

    if (transition) {
      if (transition.path === "/proc/self/exe") {
        const inherited = imageAt(pid, transition.startNs, transition, visiting);

        visiting.delete(visitKey);

        if (!eventByPid.has(pid) || !hasCodeProcImage(pid))
          throw new Error(
            "Linux /proc/self/exe transition lacks retained Code process-image corroboration",
          );

        return inherited;
      }

      let resolvedPath: string | null = null;

      if (isAbsolute(transition.path)) {
        try {
          resolvedPath = realpathSync(transition.path);
        } catch {
          resolvedPath = null;
        }
      }

      if (resolvedPath === codeExecutable) {
        if (!hasCodeProcObservation(pid, transition.completionNs, beforeNs)) {
          throw new Error(
            "Direct Code ELF exec has no retained /proc executable sample after the raw transition",
          );
        }

        visiting.delete(visitKey);

        return codeExecutable;
      }

      visiting.delete(visitKey);

      throw new Error("Linux tracee has no verified Code ELF image before /proc/self/exe");
    }

    const creator = topology.creatorByPid.get(pid);
    const event = eventByPid.get(pid);
    const parentPid = creator ? topology.processByTid.get(creator.parentTid) : undefined;

    if (
      !creator ||
      !creator.imageInheritanceSafe ||
      !event ||
      !hasCodeProcImage(pid) ||
      parentPid === undefined ||
      topology.processParentByPid.get(pid) !== parentPid ||
      event.parentPid !== parentPid ||
      creator.completionNs >= beforeNs
    ) {
      throw new Error("Linux /proc/self/exe image has no unambiguous retained fork-like creator");
    }

    const parentTimeline = topology.execsByPid.get(parentPid) ?? [];

    if (
      parentTimeline.some(
        (item) =>
          (item.startNs <= creator.completionNs && item.completionNs >= creator.startNs) ||
          (item.startNs >= creator.startNs && item.startNs < beforeNs) ||
          (item.startNs <= beforeNs && item.completionNs >= beforeNs),
      )
    ) {
      throw new Error(
        "Linux child image ancestry crosses an overlapping or intervening parent exec",
      );
    }

    const inherited = imageAt(parentPid, creator.startNs, undefined, visiting);

    visiting.delete(visitKey);

    return inherited;
  };

  const latestByPid = new Map<number, LinuxExecTransition>();

  for (const [pid, timeline] of topology.execsByPid) {
    for (const item of timeline) {
      if (item.path !== "/proc/self/exe" || !item.admitted) continue;

      const resolvedPath = imageAt(pid, item.startNs, item);

      if (item.resolvedPath !== resolvedPath) {
        throw new Error(
          "Native /proc/self/exe resolution disagrees with raw creator and exec lineage",
        );
      }

      Object.assign(item, { resolvedPath });
    }

    const latest = timeline.at(-1);

    if (latest) latestByPid.set(pid, latest);
  }

  return latestByPid;
}

function validateLinuxTraceInvocation(
  traceValue: unknown,
  outputDirectory: string,
  launcherPath: string,
  launcherArgv: unknown,
): void {
  if (
    !isRecord(traceValue) ||
    !Array.isArray(launcherArgv) ||
    !launcherArgv.every((argument) => typeof argument === "string")
  ) {
    throw new Error("Linux raw trace invocation is not bound to the selected Code launch vector");
  }

  const expected = [
    traceValue.executablePath,
    "-ff",
    "-ttt",
    "-v",
    "-s",
    "8192",
    "-e",
    "trace=%process",
    "-o",
    join(outputDirectory, "native-process-trace"),
    "--",
    ...launcherArgv,
  ];

  if (
    traceValue.command === undefined ||
    JSON.stringify(traceValue.command) !== JSON.stringify(expected) ||
    JSON.stringify(traceValue.straceCommand) !== JSON.stringify(expected) ||
    launcherArgv[0] !== launcherPath
  ) {
    throw new Error(
      "Linux strace invocation does not trace the selected Code wrapper into the current output directory",
    );
  }
}

function hasLinuxBootstrapRuntimeAnchor(argv: unknown): boolean {
  return (
    Array.isArray(argv) &&
    argv.some(
      (argument) =>
        typeof argument === "string" &&
        argument
          .replaceAll("\\", "/")
          .toLowerCase()
          .endsWith("/resources/app/out/bootstrap-fork.js"),
    )
  );
}

function isLinuxNodeServiceArgv(argv: unknown): boolean {
  if (!Array.isArray(argv)) return false;

  const flagValue = (name: string): string | undefined => {
    const prefix = `--${name}=`;

    for (let index = 0; index < argv.length; index += 1) {
      const argument = argv[index];

      if (typeof argument !== "string") continue;

      if (argument.startsWith(prefix)) return argument.slice(prefix.length);

      if (argument === `--${name}`) {
        return typeof argv[index + 1] === "string" ? argv[index + 1] : undefined;
      }
    }

    return undefined;
  };

  return (
    flagValue("type") === "utility" && flagValue("utility-sub-type") === "node.mojom.NodeService"
  );
}

function hasLinuxNodeServiceProcHistory(
  event: Record<string, unknown>,
  transition: LinuxExecTransition | undefined,
): boolean {
  if (!transition || !Array.isArray(event.executions)) return false;

  return event.executions.some((image) => {
    if (!isRecord(image)) return false;

    const observedAtNs = linuxTimestampNs(image.observedAt);
    return (
      image.executablePath === event.executablePath &&
      isLinuxNodeServiceArgv(image.argv) &&
      observedAtNs !== undefined &&
      observedAtNs > transition.completionNs
    );
  });
}

function hasLinuxCurrentProcImageAfterExec(
  event: Record<string, unknown>,
  transition: LinuxExecTransition | undefined,
): boolean {
  if (!transition || !Array.isArray(event.executions)) return false;

  const current = event.executions.at(-1);

  if (!isRecord(current)) return false;

  const observedAtNs = linuxTimestampNs(current.observedAt);
  return (
    current.executablePath === event.executablePath &&
    transition.resolvedPath === event.executablePath &&
    observedAtNs !== undefined &&
    observedAtNs > transition.completionNs
  );
}

function hasLinuxParentHistoryAtSample(
  event: Record<string, unknown>,
  parentPid: unknown,
  sampleStartedAt: unknown,
): boolean {
  const sampleStartedAtNs = linuxTimestampNs(sampleStartedAt);

  if (
    typeof parentPid !== "number" ||
    !Number.isSafeInteger(parentPid) ||
    parentPid <= 0 ||
    sampleStartedAtNs === undefined ||
    !Array.isArray(event.parents)
  ) {
    return false;
  }

  let previousParentPid: number | undefined;
  let previousParentAtNs: bigint | undefined;
  let sampledParentPid: number | undefined;

  for (const parent of event.parents) {
    if (
      !isRecord(parent) ||
      typeof parent.pid !== "number" ||
      !Number.isSafeInteger(parent.pid) ||
      parent.pid <= 0
    ) {
      return false;
    }

    const parentAtNs = linuxTimestampNs(parent.observedAt);

    if (
      parentAtNs === undefined ||
      (previousParentAtNs !== undefined && parentAtNs < previousParentAtNs) ||
      (parentAtNs === previousParentAtNs && parent.pid !== previousParentPid)
    ) {
      return false;
    }

    if (parentAtNs <= sampleStartedAtNs) sampledParentPid = parent.pid;

    previousParentPid = parent.pid;
    previousParentAtNs = parentAtNs;
  }

  return sampledParentPid === parentPid;
}

function hasLinuxAcknowledgementSampleAfterExec(
  event: Record<string, unknown>,
  executablePath: unknown,
  argv: unknown,
  sampleStartedAt: unknown,
  transition: LinuxExecTransition | undefined,
): boolean {
  const sampleStartedAtNs = linuxTimestampNs(sampleStartedAt);

  if (
    !transition ||
    transition.resolvedPath !== executablePath ||
    sampleStartedAtNs === undefined ||
    sampleStartedAtNs <= transition.completionNs ||
    typeof executablePath !== "string" ||
    !Array.isArray(argv) ||
    !argv.every((argument) => typeof argument === "string") ||
    !Array.isArray(event.executions)
  ) {
    return false;
  }

  const matches = event.executions.filter(
    (image): image is Record<string, unknown> =>
      isRecord(image) &&
      image.executablePath === executablePath &&
      JSON.stringify(image.argv) === JSON.stringify(argv) &&
      linuxTimestampNs(image.observedAt) === sampleStartedAtNs,
  );
  return matches.length === 1;
}

function validateLinuxNativeObservation(
  value: unknown,
  runId: string,
  populationFingerprint: string,
  host: EditorOwnerStart,
  server: EditorOwnerStart,
  serverExit: EditorOwnerExit,
  code: CapturedRunContext["code"],
  extensionRoot: string,
  coverageHostPath: string,
  outputDirectory: string,
  traceOutputDirectory: string,
): {
  readonly host: Record<string, unknown>;
  readonly server: Record<string, unknown>;
  readonly codeCliWrapper: Record<string, unknown>;
  readonly codeCli: Record<string, unknown>;
  readonly gui: Record<string, unknown>;
  readonly files: ReadonlyMap<string, LinuxTraceFile>;
  readonly processParentByPid: ReadonlyMap<number, number>;
  readonly latestExecByPid: ReadonlyMap<number, LinuxExecTransition>;
} {
  if (!isRecord(value)) throw new Error("Linux native editor observation is not an object");

  requireExactKeys(
    value,
    [
      "format",
      "version",
      "platform",
      "runId",
      "populationFingerprint",
      "observerStartedAt",
      "observedAt",
      "codeCliWrapper",
      "codeCli",
      "codeGui",
      "fixtureProcessScope",
      "displayServer",
      "trace",
      "events",
    ],
    "Linux native editor observation",
  );

  if (
    value.format !== "hesperia-editor-linux-native-process-observation" ||
    value.version !== 1 ||
    value.platform !== "linux" ||
    value.runId !== runId ||
    value.populationFingerprint !== populationFingerprint ||
    !isTimestamp(value.observerStartedAt) ||
    !isTimestamp(value.observedAt) ||
    !Array.isArray(value.events)
  ) {
    throw new Error("Missing, stale, or malformed Linux native editor observation");
  }

  const observerStartedAt = timestamp(value.observerStartedAt)!;
  const observedAt = timestamp(value.observedAt)!;

  if (observerStartedAt > observedAt)
    throw new Error("Linux native observation timestamps are out of order");

  const files = validateLinuxTraceEvidence(
    value.trace,
    outputDirectory,
    observerStartedAt,
    observedAt,
  );
  const events = value.events.map((event) => validateLinuxNativeEvent(event, files, observedAt));
  const byPid = new Map<number, Record<string, unknown>>();

  for (const event of events) {
    const pid = Number(event.pid);

    if (byPid.has(pid))
      throw new Error("Linux native observation contains duplicate process generations");

    byPid.set(pid, event);
  }

  const codeGuiPid =
    isRecord(value.codeGui) && Number.isSafeInteger(value.codeGui.pid)
      ? Number(value.codeGui.pid)
      : undefined;
  const topology = validateLinuxTraceClosure(files, events, codeGuiPid, code.executablePath);
  const latestExecByPid = validateLinuxExecLineage(topology, events, code.executablePath);

  const findRole = (pid: number, role: string): Record<string, unknown> => {
    const event = byPid.get(pid);

    if (!event || event.ownerRole !== role || !Array.isArray(event.ownerArgv)) {
      throw new Error(`Linux native observation is missing its ${role} process generation`);
    }

    return event;
  };

  const hostEvent = findRole(host.pid, "extension-host");
  const serverEvent = findRole(server.pid, "language-server");
  const hostLatestExec = latestExecByPid.get(host.pid);
  const serverLatestExec = latestExecByPid.get(server.pid);

  const samePath = (left: unknown, right: string): boolean =>
    typeof left === "string" && realpathSync(left) === realpathSync(right);

  if (
    hostEvent.parentPid !== host.ppid ||
    serverEvent.parentPid !== host.pid ||
    JSON.stringify(hostEvent.ownerArgv) !== JSON.stringify(host.argv) ||
    JSON.stringify(serverEvent.ownerArgv) !== JSON.stringify(server.argv) ||
    !samePath(hostEvent.executablePath, host.execPath) ||
    !samePath(serverEvent.executablePath, server.execPath) ||
    !isRecord(serverEvent.outcome) ||
    serverEvent.outcome.kind !== "exit" ||
    serverEvent.outcome.status !== serverExit.exitCode ||
    !isRecord(hostEvent.outcome) ||
    hostEvent.outcome.kind !== "exit" ||
    hostEvent.outcome.status !== 0
  ) {
    throw new Error(
      "Linux native Host/LS generations do not match the portable process-owned receipts",
    );
  }

  const serverArgv = serverEvent.procArgv;

  const hasSuffix = (argv: unknown, suffix: string): boolean =>
    Array.isArray(argv) &&
    argv.some(
      (argument) =>
        typeof argument === "string" &&
        argument.replaceAll("\\", "/").toLowerCase().endsWith(suffix.toLowerCase()),
    );

  const hasFlag = (argv: unknown, name: string, expected: string): boolean => {
    if (!Array.isArray(argv)) return false;

    const prefix = `--${name}=`;
    return argv.some(
      (argument, index) =>
        typeof argument === "string" &&
        (argument.startsWith(prefix)
          ? argument.slice(prefix.length) === expected
          : argument === `--${name}` && argv[index + 1] === expected),
    );
  };

  if (
    !hasLinuxBootstrapRuntimeAnchor(hostEvent.ownerArgv) ||
    !hasLinuxNodeServiceProcHistory(hostEvent, hostLatestExec) ||
    !hasSuffix(serverArgv, "packages/language-server/dist/cli.js") ||
    !hostLatestExec ||
    hostLatestExec.resolvedPath !== hostEvent.executablePath ||
    !Array.isArray(hostLatestExec.argv) ||
    !isLinuxNodeServiceArgv(hostLatestExec.argv) ||
    !hasLinuxCurrentProcImageAfterExec(hostEvent, hostLatestExec) ||
    !serverLatestExec ||
    serverLatestExec.resolvedPath !== serverEvent.executablePath ||
    !Array.isArray(serverLatestExec.argv) ||
    !hasSuffix(serverLatestExec.argv, "packages/language-server/dist/cli.js") ||
    !hasLinuxCurrentProcImageAfterExec(serverEvent, serverLatestExec) ||
    !Array.isArray(hostEvent.execEvents) ||
    !hostEvent.execEvents.some(
      (item) =>
        isRecord(item) &&
        item.resolvedPath === hostEvent.executablePath &&
        isSuccessfulLinuxExec(
          validateLinuxTraceBundle(item.trace, files, Number(item.tid), "Linux Host exec"),
        ),
    ) ||
    !Array.isArray(serverEvent.execEvents) ||
    !serverEvent.execEvents.some(
      (item) =>
        isRecord(item) &&
        item.resolvedPath === serverEvent.executablePath &&
        isSuccessfulLinuxExec(
          validateLinuxTraceBundle(
            item.trace,
            files,
            Number(item.tid),
            "Linux language-server exec",
          ),
        ),
    )
  ) {
    throw new Error(
      "Linux native Host/LS /proc vectors or traced exec events lack their real role anchors",
    );
  }

  if (!isRecord(value.codeGui))
    throw new Error("Linux Code GUI native generation identity is missing");

  requireExactKeys(
    value.codeGui,
    ["pid", "procStarttimeTicks"],
    "Linux Code GUI native generation identity",
  );

  const displayServer = value.displayServer;

  if (!isRecord(displayServer))
    throw new Error("Linux native observation omits its retained Xvfb generation");

  requireExactKeys(
    displayServer,
    [
      "pid",
      "parentPid",
      "procStarttimeTicks",
      "pidfdAttachedAt",
      "pidfdReadyAt",
      "executablePath",
      "procArgv",
      "requestedSignal",
      "outcome",
    ],
    "Linux Xvfb generation",
  );

  const displayOutcome = displayServer.outcome;
  const displayOutcomeValid =
    isRecord(displayOutcome) &&
    ((displayOutcome.kind === "exit" &&
      Number.isSafeInteger(displayOutcome.status) &&
      Number(displayOutcome.status) >= 0 &&
      Number(displayOutcome.status) <= 255) ||
      (displayOutcome.kind === "signal" && displayOutcome.signal === "SIGTERM"));

  if (isRecord(displayOutcome)) {
    requireExactKeys(
      displayOutcome,
      displayOutcome.kind === "exit" ? ["kind", "status"] : ["kind", "signal"],
      "Linux Xvfb outcome",
    );
  }

  if (
    !Number.isSafeInteger(displayServer.pid) ||
    !Number.isSafeInteger(displayServer.parentPid) ||
    !Number.isSafeInteger(displayServer.procStarttimeTicks) ||
    !isTimestamp(displayServer.pidfdAttachedAt) ||
    !isTimestamp(displayServer.pidfdReadyAt) ||
    typeof displayServer.executablePath !== "string" ||
    !Array.isArray(displayServer.procArgv) ||
    displayServer.requestedSignal !== "SIGTERM" ||
    !displayOutcomeValid ||
    timestamp(displayServer.pidfdAttachedAt)! > timestamp(displayServer.pidfdReadyAt)!
  ) {
    throw new Error("Linux Xvfb cleanup does not retain its generation-safe signal outcome");
  }

  const wrapperSummary = value.codeCliWrapper;
  const cliSummary = value.codeCli;
  const guiSummary = value.codeGui;

  if (!isRecord(wrapperSummary) || !isRecord(cliSummary) || !isRecord(guiSummary)) {
    throw new Error("Linux Code CLI wrapper, Electron CLI, or GUI trace identity is missing");
  }

  requireExactKeys(
    wrapperSummary,
    ["pid", "argv", "traceExec", "traceExit", "outcome"],
    "Linux Code launcher wrapper trace identity",
  );

  requireExactKeys(
    cliSummary,
    ["pid", "executablePath", "argv", "traceExec", "traceExit", "outcome"],
    "Linux Electron CLI trace identity",
  );

  validateLinuxTraceInvocation(value.trace, traceOutputDirectory, code.path, wrapperSummary.argv);

  const validateTraceProcess = (
    identity: Record<string, unknown>,
    label: string,
    expectedPath: string,
  ): void => {
    if (
      !Number.isSafeInteger(identity.pid) ||
      Number(identity.pid) <= 0 ||
      !Array.isArray(identity.argv) ||
      identity.argv.length === 0 ||
      !identity.argv.every((argument) => typeof argument === "string") ||
      !isRecord(identity.outcome) ||
      identity.outcome.kind !== "exit" ||
      identity.outcome.status !== 0
    ) {
      throw new Error(`${label} lacks its raw argv vector or normal traced exit`);
    }

    requireExactKeys(identity.outcome, ["kind", "status"], `${label} outcome`);

    const execText = validateLinuxTraceBundle(
      identity.traceExec,
      files,
      Number(identity.pid),
      `${label} execve`,
    );
    const terminalText = validateLinuxTraceBundle(
      identity.traceExit,
      files,
      Number(identity.pid),
      `${label} terminal`,
    );
    const parsedExec = parseLinuxExecve(execText);
    let resolvedExecPath: string;

    try {
      if (!isAbsolute(parsedExec.path)) throw new Error("exec path is relative");

      resolvedExecPath = realpathSync(parsedExec.path);
    } catch {
      throw new Error(`${label} raw exec path cannot be resolved to its executable`);
    }

    if (
      resolvedExecPath !== realpathSync(expectedPath) ||
      JSON.stringify(parsedExec.argv) !== JSON.stringify(identity.argv) ||
      !isSuccessfulLinuxExec(execText) ||
      !/\+\+\+ exited with 0 \+\+\+/u.test(terminalText)
    ) {
      throw new Error(
        `${label} exact raw exec path/argv or normal exit differs from its process identity`,
      );
    }

    if (label === "Linux Code launcher wrapper" && !identity.argv.includes(expectedPath)) {
      throw new Error("Linux Code launcher argv does not contain the actual selected wrapper path");
    }
  };

  validateTraceProcess(wrapperSummary, "Linux Code launcher wrapper", code.path);

  validateTraceProcess(cliSummary, "Linux Electron CLI", code.executablePath);

  const wrapperPid = Number(wrapperSummary.pid);
  const cliPid = Number(cliSummary.pid);

  if (
    wrapperPid === cliPid ||
    cliPid === Number(guiSummary.pid) ||
    !Array.isArray(cliSummary.argv) ||
    !cliSummary.argv.some(
      (argument) =>
        typeof argument === "string" &&
        argument.replaceAll("\\", "/").endsWith("/resources/app/out/cli.js"),
    )
  ) {
    throw new Error("Linux Code launcher wrapper, CLI, and actual GUI identities were conflated");
  }

  if (topology.rootPid !== wrapperPid)
    throw new Error("Linux Code launcher wrapper is not the actual root tracee");

  const gui = byPid.get(Number(guiSummary.pid));
  const guiArgv = gui?.procArgv;
  const guiLatestExec = gui ? latestExecByPid.get(Number(gui.pid)) : undefined;
  const guiExecArgv = guiLatestExec?.argv;

  if (
    !gui ||
    gui.procStarttimeTicks !== guiSummary.procStarttimeTicks ||
    !samePath(gui.executablePath, code.executablePath) ||
    !isRecord(gui.outcome) ||
    gui.outcome.kind !== "exit" ||
    gui.outcome.status !== 0 ||
    !Array.isArray(guiArgv) ||
    !guiLatestExec ||
    guiLatestExec.resolvedPath !== code.executablePath ||
    !Array.isArray(guiExecArgv) ||
    !hasLinuxCurrentProcImageAfterExec(gui, guiLatestExec) ||
    guiExecArgv.some(
      (argument, index) =>
        typeof argument === "string" &&
        (argument.startsWith("--type=")
          ? argument !== "--type=browser"
          : argument === "--type" && guiExecArgv[index + 1] !== "browser"),
    )
  ) {
    throw new Error(
      "Linux actual GUI generation does not match the selected Code executable and trace identity",
    );
  }

  const scope = value.fixtureProcessScope;

  if (!isRecord(scope)) throw new Error("Linux native observation omits isolated fixture scope");

  requireExactKeys(
    scope,
    ["checkedAt", "userDataPath", "extensionsPath", "activeProcessIds"],
    "Linux fixture process scope",
  );

  if (
    timestamp(scope.checkedAt) === undefined ||
    timestamp(scope.checkedAt)! > observedAt ||
    typeof scope.userDataPath !== "string" ||
    typeof scope.extensionsPath !== "string" ||
    !Array.isArray(scope.activeProcessIds) ||
    scope.activeProcessIds.length !== 0
  ) {
    throw new Error("Linux isolated Code fixture did not reach an empty process scope");
  }

  if (
    !hasFlag(guiExecArgv, "user-data-dir", scope.userDataPath) ||
    !hasFlag(guiExecArgv, "extensions-dir", scope.extensionsPath) ||
    !hasFlag(guiExecArgv, "extensionDevelopmentPath", extensionRoot) ||
    !hasFlag(guiExecArgv, "extensionTestsPath", coverageHostPath)
  ) {
    throw new Error("Actual Linux Code GUI argv does not identify the prepared fixture inputs");
  }

  if (
    !hasFlag(cliSummary.argv, "user-data-dir", scope.userDataPath) ||
    !hasFlag(cliSummary.argv, "extensions-dir", scope.extensionsPath) ||
    !hasFlag(cliSummary.argv, "extensionDevelopmentPath", extensionRoot) ||
    !hasFlag(cliSummary.argv, "extensionTestsPath", coverageHostPath)
  ) {
    throw new Error(
      "Linux Electron CLI or GUI native vector does not distinguish the prepared fixture launch",
    );
  }

  const requireTraceAncestor = (childPid: number, ancestorPid: number): void => {
    const seen = new Set<number>();
    let current = childPid;

    while (current !== ancestorPid) {
      const pid = current;

      if (seen.has(pid)) throw new Error("Linux native process ancestry contains a cycle");

      seen.add(pid);

      const parent = topology.processParentByPid.get(pid);

      if (parent === undefined)
        throw new Error(`Linux raw ancestry is missing a process edge for PID ${pid}`);

      current = parent;
    }
  };

  requireTraceAncestor(cliPid, wrapperPid);

  requireTraceAncestor(Number(gui.pid), cliPid);

  requireTraceAncestor(Number(hostEvent.pid), Number(gui.pid));

  return {
    host: hostEvent,
    server: serverEvent,
    codeCliWrapper: wrapperSummary,
    codeCli: cliSummary,
    gui,
    files,
    processParentByPid: topology.processParentByPid,
    latestExecByPid,
  };
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();

  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Error(`${label} contains missing or unexpected fields`);
  }
}

function validateEditorLifecycleEvidence(
  outputDirectory: string,
  runId: string,
  populationFingerprint: string,
  host: EditorOwnerStart,
  server: EditorOwnerStart,
  serverExit: EditorOwnerExit,
  hostRecord: NativeProcessRecord,
  serverRecord: NativeProcessRecord,
  launchRecord: NativeProcessRecord,
  extensionEntryPath: string,
): void {
  const startValue = readJson(join(outputDirectory, "extension-host-deactivate-start.json"));
  const completeValue = readJson(join(outputDirectory, "extension-host-deactivate.json"));
  const acknowledgementValue = readJson(
    join(outputDirectory, "language-server-native-exit-ack.json"),
  );

  if (!isRecord(startValue) || !isRecord(completeValue) || !isRecord(acknowledgementValue)) {
    throw new Error("Missing staged-extension shutdown or native language-server exit evidence");
  }

  requireExactKeys(
    startValue,
    [
      "format",
      "version",
      "runId",
      "populationFingerprint",
      "extensionHostOwnerId",
      "extensionHostPid",
      "extensionEntryPath",
      "moduleCachePath",
      "moduleCacheLoaded",
      "deactivateExport",
      "assertionsCompletedAt",
      "deactivateStartedAt",
    ],
    "Extension Host deactivation start receipt",
  );

  requireExactKeys(
    completeValue,
    [
      "format",
      "version",
      "runId",
      "populationFingerprint",
      "extensionHostOwnerId",
      "extensionHostPid",
      "extensionEntryPath",
      "moduleCachePath",
      "moduleCacheLoaded",
      "deactivateExport",
      "assertionsCompletedAt",
      "deactivateStartedAt",
      "deactivateResolvedAt",
      "nativeAcknowledgedAt",
      "languageServerPid",
      "languageServerProcessExitTime",
      "languageServerExitCode",
    ],
    "Extension Host deactivation completion receipt",
  );

  requireExactKeys(
    acknowledgementValue,
    [
      "format",
      "version",
      "runId",
      "populationFingerprint",
      "languageServerOwnerId",
      "languageServerPid",
      "languageServerParentPid",
      "languageServerExecutablePath",
      "languageServerCommandLine",
      "languageServerCreationTime",
      "languageServerProcessExitTime",
      "languageServerExitObservedAt",
      "languageServerExitCode",
      "extensionHostPid",
      "extensionHostExecutablePath",
      "extensionHostCreationTime",
      "extensionHostAliveObservedAt",
      "codeLaunchPid",
      "codeLaunchExecutablePath",
      "codeLaunchCreationTime",
      "codeLaunchAliveObservedAt",
      "acknowledgedAt",
    ],
    "Native language-server exit acknowledgement",
  );

  const start = startValue;
  const complete = completeValue;
  const acknowledgement = acknowledgementValue;
  const expectedPath = resolve(extensionEntryPath);

  const samePath = (value: unknown, expected: string): boolean =>
    typeof value === "string" && resolve(value).toLowerCase() === expected.toLowerCase();

  const startTimes = [timestamp(start.assertionsCompletedAt), timestamp(start.deactivateStartedAt)];
  const completionTimes = [
    timestamp(complete.assertionsCompletedAt),
    timestamp(complete.deactivateStartedAt),
    timestamp(complete.deactivateResolvedAt),
    timestamp(complete.nativeAcknowledgedAt),
  ];
  const acknowledgementTimes = [
    timestamp(acknowledgement.languageServerCreationTime),
    timestamp(acknowledgement.languageServerProcessExitTime),
    timestamp(acknowledgement.languageServerExitObservedAt),
    timestamp(acknowledgement.extensionHostCreationTime),
    timestamp(acknowledgement.extensionHostAliveObservedAt),
    timestamp(acknowledgement.codeLaunchCreationTime),
    timestamp(acknowledgement.codeLaunchAliveObservedAt),
    timestamp(acknowledgement.acknowledgedAt),
  ];

  if (
    start.format !== "hesperia-editor-deactivate-start" ||
    start.version !== 1 ||
    start.runId !== runId ||
    start.populationFingerprint !== populationFingerprint ||
    start.extensionHostOwnerId !== host.ownerId ||
    start.extensionHostPid !== host.pid ||
    !samePath(start.extensionEntryPath, expectedPath) ||
    !samePath(start.moduleCachePath, expectedPath) ||
    start.moduleCacheLoaded !== true ||
    start.deactivateExport !== "deactivate" ||
    startTimes.some((value) => value === undefined) ||
    startTimes[0]! > startTimes[1]! ||
    startTimes[1]! < timestamp(host.startedAt)! ||
    complete.format !== "hesperia-editor-deactivate-complete" ||
    complete.version !== 1 ||
    complete.runId !== runId ||
    complete.populationFingerprint !== populationFingerprint ||
    complete.extensionHostOwnerId !== host.ownerId ||
    complete.extensionHostPid !== host.pid ||
    !samePath(complete.extensionEntryPath, expectedPath) ||
    !samePath(complete.moduleCachePath, expectedPath) ||
    complete.moduleCacheLoaded !== true ||
    complete.deactivateExport !== "deactivate" ||
    complete.assertionsCompletedAt !== start.assertionsCompletedAt ||
    complete.deactivateStartedAt !== start.deactivateStartedAt ||
    completionTimes.some((value) => value === undefined) ||
    completionTimes[0]! > completionTimes[1]! ||
    completionTimes[1]! > completionTimes[2]! ||
    completionTimes[1]! > completionTimes[3]! ||
    complete.languageServerPid !== server.pid ||
    complete.languageServerProcessExitTime !== acknowledgement.languageServerProcessExitTime ||
    complete.languageServerExitCode !== 0 ||
    complete.nativeAcknowledgedAt !== acknowledgement.acknowledgedAt ||
    acknowledgement.format !== "hesperia-editor-native-language-server-exit-ack" ||
    acknowledgement.version !== 1 ||
    acknowledgement.runId !== runId ||
    acknowledgement.populationFingerprint !== populationFingerprint ||
    acknowledgement.languageServerOwnerId !== server.ownerId ||
    acknowledgement.languageServerPid !== server.pid ||
    acknowledgement.languageServerParentPid !== host.pid ||
    !samePath(acknowledgement.languageServerExecutablePath, server.execPath) ||
    acknowledgement.languageServerCommandLine !== serverRecord.commandLine ||
    acknowledgement.languageServerCreationTime !== serverRecord.creationTime ||
    acknowledgement.languageServerProcessExitTime !== serverRecord.processExitTime ||
    acknowledgement.languageServerExitObservedAt !== serverRecord.exitObservedAt ||
    acknowledgement.languageServerExitCode !== 0 ||
    acknowledgement.extensionHostPid !== host.pid ||
    !samePath(acknowledgement.extensionHostExecutablePath, hostRecord.executablePath) ||
    acknowledgement.extensionHostCreationTime !== hostRecord.creationTime ||
    acknowledgement.codeLaunchPid !== launchRecord.pid ||
    !samePath(acknowledgement.codeLaunchExecutablePath, launchRecord.executablePath) ||
    acknowledgement.codeLaunchCreationTime !== launchRecord.creationTime ||
    acknowledgement.extensionHostAliveObservedAt !== acknowledgement.acknowledgedAt ||
    acknowledgement.codeLaunchAliveObservedAt !== acknowledgement.acknowledgedAt ||
    acknowledgementTimes.some((value) => value === undefined) ||
    acknowledgementTimes[0]! > timestamp(server.startedAt)! ||
    timestamp(server.startedAt)! > acknowledgementTimes[1]! ||
    timestamp(serverExit.exitedAt)! < timestamp(server.startedAt)! ||
    timestamp(serverExit.exitedAt)! > acknowledgementTimes[1]! ||
    acknowledgementTimes[1]! > acknowledgementTimes[2]! ||
    acknowledgementTimes[2]! > acknowledgementTimes[7]! ||
    acknowledgementTimes[4]! !== acknowledgementTimes[7]! ||
    acknowledgementTimes[6]! !== acknowledgementTimes[7]! ||
    acknowledgementTimes[3]! > timestamp(host.startedAt)! ||
    acknowledgementTimes[5]! > acknowledgementTimes[7]! ||
    acknowledgementTimes[7]! >= timestamp(hostRecord.processExitTime)! ||
    acknowledgementTimes[7]! >= timestamp(launchRecord.processExitTime)!
  ) {
    throw new Error(
      "Staged-extension shutdown or native language-server exit evidence is inconsistent",
    );
  }
}

function validateLinuxEditorLifecycleEvidence(
  outputDirectory: string,
  runId: string,
  populationFingerprint: string,
  host: EditorOwnerStart,
  hostExit: EditorOwnerExit,
  server: EditorOwnerStart,
  serverExit: EditorOwnerExit,
  native: ReturnType<typeof validateLinuxNativeObservation>,
  extensionEntryPath: string,
  testHostPath: string,
): void {
  const startValue = readJson(join(outputDirectory, "extension-host-deactivate-start.json"));
  const completeValue = readJson(join(outputDirectory, "extension-host-deactivate.json"));
  const acknowledgementValue = readJson(
    join(outputDirectory, "language-server-native-exit-ack.json"),
  );

  if (!isRecord(startValue) || !isRecord(completeValue) || !isRecord(acknowledgementValue)) {
    throw new Error(
      "Missing staged-extension shutdown or Linux native language-server exit evidence",
    );
  }

  const lifecycleStartKeys = [
    "format",
    "version",
    "runId",
    "populationFingerprint",
    "extensionHostOwnerId",
    "extensionHostPid",
    "extensionEntryPath",
    "moduleCachePath",
    "moduleCacheLoaded",
    "deactivateExport",
    "assertionsCompletedAt",
    "deactivateStartedAt",
  ];

  requireExactKeys(startValue, lifecycleStartKeys, "Extension Host deactivation start receipt");

  requireExactKeys(
    completeValue,
    [
      ...lifecycleStartKeys,
      "deactivateResolvedAt",
      "nativeAcknowledgedAt",
      "languageServerPid",
      "languageServerOwnerExitedAt",
      "languageServerOutcome",
    ],
    "Linux Extension Host deactivation completion receipt",
  );

  const acknowledgement = acknowledgementValue;

  requireExactKeys(
    acknowledgement,
    [
      "format",
      "version",
      "runId",
      "populationFingerprint",
      "languageServerOwnerId",
      "languageServerOwnerExitedAt",
      "languageServer",
      "extensionHost",
      "codeGui",
      "fixture",
      "languageServerTraceExit",
      "acknowledgedAt",
    ],
    "Linux native language-server exit acknowledgement",
  );

  const languageServer = acknowledgement.languageServer;
  const extensionHost = acknowledgement.extensionHost;
  const codeGui = acknowledgement.codeGui;
  const fixture = acknowledgement.fixture;

  if (
    !isRecord(languageServer) ||
    !isRecord(extensionHost) ||
    !isRecord(codeGui) ||
    !isRecord(fixture)
  ) {
    throw new Error(
      "Linux native language-server acknowledgement has malformed generation records",
    );
  }

  requireExactKeys(
    languageServer,
    [
      "pid",
      "parentPid",
      "executablePath",
      "procArgv",
      "ownerArgv",
      "procStarttimeTicks",
      "pidfdAttachedAt",
      "pidfdReadyAt",
      "outcome",
      "traceExit",
      "threadExits",
    ],
    "Linux language-server generation acknowledgement",
  );

  requireExactKeys(
    extensionHost,
    [
      "pid",
      "parentPid",
      "executablePath",
      "procArgv",
      "ownerArgv",
      "procStarttimeTicks",
      "pidfdAttachedAt",
      "sampleStartedAt",
      "sampleFinishedAt",
      "aliveObservedAt",
    ],
    "Linux Extension Host generation acknowledgement",
  );

  requireExactKeys(
    codeGui,
    [
      "pid",
      "parentPid",
      "executablePath",
      "procArgv",
      "procStarttimeTicks",
      "pidfdAttachedAt",
      "sampleStartedAt",
      "sampleFinishedAt",
      "aliveObservedAt",
    ],
    "Linux Code GUI generation acknowledgement",
  );

  requireExactKeys(
    fixture,
    ["userDataPath", "extensionsPath", "extensionPath", "testHostPath"],
    "Linux fixture acknowledgement",
  );

  const acknowledgedCodeGuiArgv = codeGui.procArgv;

  if (!Array.isArray(acknowledgedCodeGuiArgv)) {
    throw new Error("Linux Code GUI acknowledgement omits its genuine native argv vector");
  }

  const start = startValue;
  const complete = completeValue;
  const expectedPath = resolve(extensionEntryPath);

  const samePath = (value: unknown, expected: string): boolean =>
    typeof value === "string" && resolve(value) === expected;

  const startTime = timestamp(start.deactivateStartedAt);
  const assertionsTime = timestamp(start.assertionsCompletedAt);
  const resolvedTime = timestamp(complete.deactivateResolvedAt);
  const ackTime = timestamp(acknowledgement.acknowledgedAt);
  const acknowledgedAtNs = linuxTimestampNs(acknowledgement.acknowledgedAt);
  const ownerExitTime = timestamp(acknowledgement.languageServerOwnerExitedAt);
  const serverReadyTime = timestamp(languageServer.pidfdReadyAt);
  const serverAttachTime = timestamp(languageServer.pidfdAttachedAt);
  const serverEvent = native.server;
  const hostEvent = native.host;
  const guiEvent = native.gui;
  const hostAttachTime = timestamp(extensionHost.pidfdAttachedAt);
  const hostAttachNs = linuxTimestampNs(extensionHost.pidfdAttachedAt);
  const hostEventAttachNs = linuxTimestampNs(hostEvent.pidfdAttachedAt);
  const hostSampleStartedNs = linuxTimestampNs(extensionHost.sampleStartedAt);
  const hostSampleFinishedNs = linuxTimestampNs(extensionHost.sampleFinishedAt);
  const hostAliveTime = timestamp(extensionHost.aliveObservedAt);
  const guiAttachTime = timestamp(codeGui.pidfdAttachedAt);
  const guiAttachNs = linuxTimestampNs(codeGui.pidfdAttachedAt);
  const guiEventAttachNs = linuxTimestampNs(guiEvent.pidfdAttachedAt);
  const guiSampleStartedNs = linuxTimestampNs(codeGui.sampleStartedAt);
  const guiSampleFinishedNs = linuxTimestampNs(codeGui.sampleFinishedAt);
  const guiAliveTime = timestamp(codeGui.aliveObservedAt);
  const serverLatestExec = native.latestExecByPid.get(server.pid);
  const hostLatestExec = native.latestExecByPid.get(host.pid);
  const guiLatestExec = native.latestExecByPid.get(Number(native.gui.pid));
  const guiLatestArgv = guiLatestExec?.argv;
  const serverTrace = validateLinuxTraceBundle(
    languageServer.traceExit,
    native.files,
    server.pid,
    "Acknowledged Linux language-server exit",
  );
  const eventTrace = validateLinuxTraceBundle(
    serverEvent.traceExit,
    native.files,
    server.pid,
    "Observed Linux language-server exit",
  );

  if (acknowledgedAtNs === undefined) {
    throw new Error("Linux acknowledgement timestamp is malformed at nanosecond precision");
  }

  if (
    start.format !== "hesperia-editor-deactivate-start" ||
    start.version !== 1 ||
    start.runId !== runId ||
    start.populationFingerprint !== populationFingerprint ||
    start.extensionHostOwnerId !== host.ownerId ||
    start.extensionHostPid !== host.pid ||
    !samePath(start.extensionEntryPath, expectedPath) ||
    !samePath(start.moduleCachePath, expectedPath) ||
    start.moduleCacheLoaded !== true ||
    start.deactivateExport !== "deactivate" ||
    assertionsTime === undefined ||
    startTime === undefined ||
    assertionsTime > startTime ||
    startTime < timestamp(host.startedAt)! ||
    complete.format !== "hesperia-editor-deactivate-complete" ||
    complete.version !== 1 ||
    complete.runId !== runId ||
    complete.populationFingerprint !== populationFingerprint ||
    complete.extensionHostOwnerId !== host.ownerId ||
    complete.extensionHostPid !== host.pid ||
    !samePath(complete.extensionEntryPath, expectedPath) ||
    !samePath(complete.moduleCachePath, expectedPath) ||
    complete.moduleCacheLoaded !== true ||
    complete.deactivateExport !== "deactivate" ||
    complete.assertionsCompletedAt !== start.assertionsCompletedAt ||
    complete.deactivateStartedAt !== start.deactivateStartedAt ||
    resolvedTime === undefined ||
    ackTime === undefined ||
    resolvedTime < startTime ||
    resolvedTime > ackTime ||
    complete.nativeAcknowledgedAt !== acknowledgement.acknowledgedAt ||
    complete.languageServerPid !== server.pid ||
    complete.languageServerOwnerExitedAt !== acknowledgement.languageServerOwnerExitedAt ||
    JSON.stringify(complete.languageServerOutcome) !== JSON.stringify(languageServer.outcome) ||
    acknowledgement.format !== "hesperia-editor-linux-native-language-server-exit-ack" ||
    acknowledgement.version !== 1 ||
    acknowledgement.runId !== runId ||
    acknowledgement.populationFingerprint !== populationFingerprint ||
    acknowledgement.languageServerOwnerId !== server.ownerId ||
    acknowledgement.languageServerOwnerExitedAt !== serverExit.exitedAt ||
    ownerExitTime === undefined ||
    ownerExitTime < timestamp(server.startedAt)! ||
    ownerExitTime > ackTime ||
    languageServer.pid !== server.pid ||
    languageServer.parentPid !== host.pid ||
    !samePath(languageServer.executablePath, server.execPath) ||
    JSON.stringify(languageServer.procArgv) !== JSON.stringify(serverEvent.procArgv) ||
    JSON.stringify(languageServer.ownerArgv) !== JSON.stringify(server.argv) ||
    languageServer.procStarttimeTicks !== serverEvent.procStarttimeTicks ||
    languageServer.outcome === undefined ||
    JSON.stringify(languageServer.outcome) !== JSON.stringify(serverEvent.outcome) ||
    JSON.stringify(languageServer.threadExits) !== JSON.stringify(serverEvent.threadExits) ||
    !serverLatestExec ||
    serverLatestExec.resolvedPath !== serverEvent.executablePath ||
    !hostLatestExec ||
    hostLatestExec.resolvedPath !== hostEvent.executablePath ||
    JSON.stringify(acknowledgement.languageServerTraceExit) !==
      JSON.stringify(languageServer.traceExit) ||
    JSON.stringify(languageServer.traceExit) !== JSON.stringify(serverEvent.traceExit) ||
    serverTrace !== eventTrace ||
    !isRecord(languageServer.outcome) ||
    languageServer.outcome.kind !== "exit" ||
    languageServer.outcome.status !== serverExit.exitCode ||
    serverReadyTime === undefined ||
    serverAttachTime === undefined ||
    serverAttachTime > serverReadyTime ||
    ownerExitTime > serverReadyTime ||
    serverReadyTime > ackTime ||
    serverReadyTime !== timestamp(serverEvent.pidfdReadyAt) ||
    serverAttachTime !== timestamp(serverEvent.pidfdAttachedAt) ||
    extensionHost.pid !== host.pid ||
    extensionHost.parentPid !== host.ppid ||
    !samePath(extensionHost.executablePath, host.execPath) ||
    JSON.stringify(extensionHost.procArgv) !== JSON.stringify(hostEvent.procArgv) ||
    JSON.stringify(extensionHost.ownerArgv) !== JSON.stringify(host.argv) ||
    extensionHost.procStarttimeTicks !== hostEvent.procStarttimeTicks ||
    hostAttachTime === undefined ||
    hostAttachNs === undefined ||
    hostEventAttachNs === undefined ||
    hostSampleStartedNs === undefined ||
    hostSampleFinishedNs === undefined ||
    hostAliveTime === undefined ||
    hostAttachTime > hostAliveTime ||
    hostAliveTime !== ackTime ||
    hostAttachNs !== hostEventAttachNs ||
    hostSampleStartedNs < hostAttachNs ||
    hostSampleStartedNs > hostSampleFinishedNs ||
    hostSampleFinishedNs > acknowledgedAtNs ||
    !hasLinuxAcknowledgementSampleAfterExec(
      hostEvent,
      extensionHost.executablePath,
      extensionHost.procArgv,
      extensionHost.sampleStartedAt,
      hostLatestExec,
    ) ||
    hostAttachTime !== timestamp(hostEvent.pidfdAttachedAt) ||
    !isRecord(hostEvent.outcome) ||
    hostEvent.outcome.kind !== "exit" ||
    hostEvent.outcome.status !== 0 ||
    timestamp(hostEvent.pidfdReadyAt) === undefined ||
    timestamp(hostEvent.pidfdReadyAt)! < timestamp(hostExit.exitedAt)! ||
    timestamp(hostEvent.pidfdReadyAt)! <= ackTime ||
    codeGui.pid !== native.gui.pid ||
    !hasLinuxParentHistoryAtSample(guiEvent, codeGui.parentPid, codeGui.sampleStartedAt) ||
    !samePath(codeGui.executablePath, String(native.gui.executablePath)) ||
    JSON.stringify(acknowledgedCodeGuiArgv) !== JSON.stringify(native.gui.procArgv) ||
    codeGui.procStarttimeTicks !== native.gui.procStarttimeTicks ||
    guiAttachTime === undefined ||
    guiAttachNs === undefined ||
    guiEventAttachNs === undefined ||
    guiSampleStartedNs === undefined ||
    guiSampleFinishedNs === undefined ||
    guiAliveTime === undefined ||
    guiAttachTime > guiAliveTime ||
    guiAliveTime !== ackTime ||
    guiAttachNs !== guiEventAttachNs ||
    guiSampleStartedNs < guiAttachNs ||
    guiSampleStartedNs > guiSampleFinishedNs ||
    guiSampleFinishedNs > acknowledgedAtNs ||
    !hasLinuxAcknowledgementSampleAfterExec(
      guiEvent,
      codeGui.executablePath,
      codeGui.procArgv,
      codeGui.sampleStartedAt,
      guiLatestExec,
    ) ||
    guiAttachTime !== timestamp(guiEvent.pidfdAttachedAt) ||
    !isRecord(guiEvent.outcome) ||
    guiEvent.outcome.kind !== "exit" ||
    guiEvent.outcome.status !== 0 ||
    timestamp(guiEvent.pidfdReadyAt) === undefined ||
    timestamp(guiEvent.pidfdReadyAt)! <= ackTime ||
    !guiLatestExec ||
    guiLatestExec.resolvedPath !== guiEvent.executablePath ||
    !Array.isArray(guiLatestArgv) ||
    guiLatestArgv.some(
      (argument, index) =>
        typeof argument === "string" &&
        (argument.startsWith("--type=")
          ? argument !== "--type=browser"
          : argument === "--type" && guiLatestArgv[index + 1] !== "browser"),
    ) ||
    guiLatestArgv.some(
      (argument) =>
        typeof argument === "string" &&
        argument.replaceAll("\\", "/").endsWith("/resources/app/out/cli.js"),
    ) ||
    typeof fixture.userDataPath !== "string" ||
    typeof fixture.extensionsPath !== "string" ||
    typeof fixture.extensionPath !== "string" ||
    typeof fixture.testHostPath !== "string" ||
    resolve(fixture.extensionPath) !== resolve(dirname(testHostPath), "..") ||
    resolve(fixture.testHostPath) !== resolve(testHostPath) ||
    !guiLatestArgv.some(
      (argument, index) =>
        typeof argument === "string" &&
        (argument === `--user-data-dir=${fixture.userDataPath}` ||
          (argument === "--user-data-dir" && guiLatestArgv[index + 1] === fixture.userDataPath)),
    ) ||
    !guiLatestArgv.some(
      (argument, index) =>
        typeof argument === "string" &&
        (argument === `--extensions-dir=${fixture.extensionsPath}` ||
          (argument === "--extensions-dir" && guiLatestArgv[index + 1] === fixture.extensionsPath)),
    ) ||
    !guiLatestArgv.some(
      (argument, index) =>
        typeof argument === "string" &&
        (argument === `--extensionDevelopmentPath=${fixture.extensionPath}` ||
          (argument === "--extensionDevelopmentPath" &&
            guiLatestArgv[index + 1] === fixture.extensionPath)),
    ) ||
    !guiLatestArgv.some(
      (argument, index) =>
        typeof argument === "string" &&
        (argument === `--extensionTestsPath=${fixture.testHostPath}` ||
          (argument === "--extensionTestsPath" &&
            guiLatestArgv[index + 1] === fixture.testHostPath)),
    )
  ) {
    throw new Error(
      "Linux staged-extension shutdown or native process-generation acknowledgement is inconsistent",
    );
  }
}

function validateOwnerReceipts(
  outputDirectory: string,
  runId: string,
  populationFingerprint: string,
  role: EditorOwnerStart["role"],
  expectedOwnerId: string,
): {
  readonly start: EditorOwnerStart;
  readonly exit: EditorOwnerExit;
  readonly raw: EditorOwnerCoverage;
} {
  const requireReceipt = (name: string, description: string): unknown => {
    const path = join(outputDirectory, name);

    if (!existsSync(path)) throw new Error(`Missing ${role} ${description}`);

    return readJson(path);
  };

  const startValue = requireReceipt(`${role}-start.json`, "start receipt");
  const exitValue = requireReceipt(`${role}-exit.json`, "exit receipt");
  const rawValue = requireReceipt(`${role}-coverage.json`, "raw coverage");

  if (isRecord(startValue))
    requireExactKeys(startValue, ownerStartReceiptKeys, `${role} start receipt`);

  if (isRecord(exitValue))
    requireExactKeys(
      exitValue,
      [...ownerStartReceiptKeys, "exitCode", "coverageFile", "exitedAt"],
      `${role} exit receipt`,
    );

  if (isRecord(rawValue))
    requireExactKeys(
      rawValue,
      [
        "format",
        "version",
        "runId",
        "populationFingerprint",
        "ownerId",
        "role",
        "pid",
        "ppid",
        "argv",
        "coverage",
      ],
      `${role} raw coverage`,
    );

  if (
    !isRecord(startValue) ||
    startValue.format !== "hesperia-editor-owner-start" ||
    startValue.version !== 1 ||
    startValue.runId !== runId ||
    startValue.populationFingerprint !== populationFingerprint ||
    startValue.ownerId !== expectedOwnerId ||
    startValue.role !== role ||
    !Number.isSafeInteger(startValue.pid) ||
    Number(startValue.pid) <= 0 ||
    !Number.isSafeInteger(startValue.ppid) ||
    Number(startValue.ppid) <= 0 ||
    typeof startValue.execPath !== "string" ||
    !startValue.execPath ||
    !Array.isArray(startValue.argv) ||
    !startValue.argv.every((argument) => typeof argument === "string") ||
    timestamp(startValue.startedAt) === undefined
  ) {
    throw new Error(`Missing, stale, or malformed ${role} start receipt`);
  }

  if (
    !isRecord(exitValue) ||
    exitValue.format !== "hesperia-editor-owner-exit" ||
    exitValue.version !== 1 ||
    exitValue.runId !== runId ||
    exitValue.populationFingerprint !== populationFingerprint ||
    exitValue.ownerId !== expectedOwnerId ||
    exitValue.role !== role ||
    exitValue.pid !== startValue.pid ||
    exitValue.ppid !== startValue.ppid ||
    exitValue.execPath !== startValue.execPath ||
    exitValue.startedAt !== startValue.startedAt ||
    JSON.stringify(exitValue.argv) !== JSON.stringify(startValue.argv) ||
    exitValue.exitCode !== 0 ||
    timestamp(exitValue.exitedAt) === undefined ||
    timestamp(exitValue.exitedAt)! < timestamp(startValue.startedAt)! ||
    exitValue.coverageFile !== `${role}-coverage.json`
  ) {
    throw new Error(`Missing, stale, or mismatched ${role} exit receipt`);
  }

  if (
    !isRecord(rawValue) ||
    rawValue.format !== "hesperia-editor-owner-coverage" ||
    rawValue.version !== 1 ||
    rawValue.runId !== runId ||
    rawValue.populationFingerprint !== populationFingerprint ||
    rawValue.ownerId !== expectedOwnerId ||
    rawValue.role !== role ||
    rawValue.pid !== startValue.pid ||
    rawValue.ppid !== startValue.ppid ||
    JSON.stringify(rawValue.argv) !== JSON.stringify(startValue.argv) ||
    !isRecord(rawValue.coverage)
  ) {
    throw new Error(`Missing, stale, or malformed ${role} raw coverage`);
  }

  return {
    start: startValue as unknown as EditorOwnerStart,
    exit: exitValue as unknown as EditorOwnerExit,
    raw: rawValue as unknown as EditorOwnerCoverage,
  };
}

function validateEditorArtifact(
  value: unknown,
  expected: ExpectedEditorArtifact,
  runId: string,
  population: CoveragePopulation,
): CoverageArtifact {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          "format",
          "version",
          "kind",
          "runId",
          "ownerId",
          "platform",
          "populationFingerprint",
          "population",
          "ownerFiles",
          "coverage",
        ].includes(key),
    ) ||
    value.format !== "hesperia-coverage" ||
    value.version !== 2 ||
    value.kind !== expected.kind ||
    value.runId !== runId ||
    value.ownerId !== expected.ownerId ||
    value.platform !== process.platform ||
    value.populationFingerprint !== population.fingerprint ||
    !Array.isArray(value.ownerFiles) ||
    !isRecord(value.coverage)
  ) {
    throw new Error(
      `Unexpected, stale, or malformed ${expected.kind} editor artifact for ${expected.ownerId}`,
    );
  }

  const hasPopulation = Object.prototype.hasOwnProperty.call(value, "population");

  if (hasPopulation !== expected.populationIncluded) {
    throw new Error(`Editor artifact population payload is invalid for ${expected.ownerId}`);
  }

  if (
    expected.populationIncluded &&
    JSON.stringify(value.population) !== JSON.stringify(population)
  ) {
    throw new Error(
      `Editor artifact population does not match the current run for ${expected.ownerId}`,
    );
  }

  return value as unknown as CoverageArtifact;
}

function hasHits(coverage: CoverageFile): boolean {
  return (
    Object.values(coverage.s).some((count) => count > 0) ||
    Object.values(coverage.f).some((count) => count > 0) ||
    Object.values(coverage.b).some((counts) => counts.some((count) => count > 0))
  );
}

function sourceCoverage(
  coverage: Record<string, unknown>,
  source: string,
): CoverageFile | undefined {
  const absolute = resolve(repoPath, source.replaceAll("/", sep));
  const entry = Object.entries(coverage).find(([path]) => resolve(path) === absolute)?.[1];
  return entry && typeof entry === "object" ? (entry as CoverageFile) : undefined;
}

function supportArtifactSourcesMatch(
  artifact: CoverageArtifact,
  sources: readonly string[],
): boolean {
  const actual = Object.keys(artifact.coverage).map(canonicalPath).sort();
  const expected = sources
    .map((source) => canonicalPath(resolve(repoPath, source.replaceAll("/", sep))))
    .sort();
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function validateOwnerSupportCoverage(options: {
  readonly context: CapturedRunContext;
  readonly outputDirectory: string;
  readonly role: EditorOwnerStart["role"];
  readonly start: EditorOwnerStart;
  readonly exit: EditorOwnerExit;
}): Record<string, CoverageFile> | undefined {
  const supportConfig = readEditorCoverageSupportConfig(options.context.configuration);

  if (!supportConfig) return undefined;

  const supportOwner =
    options.role === "extension-host" ? supportConfig.extensionHost : supportConfig.languageServer;
  const path = join(options.outputDirectory, `${options.role}-support-coverage.json`);
  const value = readJson(path);

  if (!isRecord(value)) throw new Error(`${options.role} support coverage is malformed`);

  requireExactKeys(
    value,
    [
      "format",
      "version",
      "runId",
      "populationFingerprint",
      "ownerId",
      "role",
      "pid",
      "ppid",
      "execPath",
      "argv",
      "threadId",
      "startedAt",
      "exitedAt",
      "coverage",
    ],
    `${options.role} support coverage`,
  );

  if (
    !isRecord(value) ||
    value.format !== "hesperia-editor-owner-support-coverage" ||
    value.version !== 1 ||
    value.runId !== options.context.runId ||
    value.populationFingerprint !== options.context.population.fingerprint ||
    value.ownerId !== supportOwner.ownerId ||
    value.role !== options.role ||
    value.pid !== options.start.pid ||
    value.ppid !== options.start.ppid ||
    value.execPath !== options.start.execPath ||
    JSON.stringify(value.argv) !== JSON.stringify(options.start.argv) ||
    value.threadId !== 0 ||
    value.startedAt !== options.start.startedAt ||
    timestamp(value.exitedAt) === undefined ||
    timestamp(options.exit.exitedAt) === undefined ||
    timestamp(value.exitedAt)! < timestamp(options.exit.exitedAt)! ||
    !isRecord(value.coverage)
  ) {
    throw new Error(`Actual ${options.role} support coverage does not match its process receipts`);
  }

  const actualPaths = Object.keys(value.coverage).map(canonicalPath).sort();
  const expectedPaths = supportOwner.sourcePaths.map(canonicalPath).sort();

  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error(
      `Actual ${options.role} support coverage does not match its exact source allowlist`,
    );
  }

  const coverage = value.coverage as Record<string, CoverageFile>;
  const profileKey = options.role === "extension-host" ? "extension-host" : "language-server";
  const profile = coverageOwnerProfile(profileKey);

  if (!profile) throw new Error(`Current editor capture has no ${options.role} support profile`);

  for (const source of profile.requiredHitSources) {
    const file = sourceCoverage(coverage, source);

    if (!file || !hasHits(file)) {
      throw new Error(`Actual ${options.role} process has no authored support hits for ${source}`);
    }
  }

  return coverage;
}

function validateCapturedOwnerEvidence(context: CapturedRunContext, outputDirectory: string) {
  const { runId, population, code } = context;
  const hostOwnerId = `vscode-extension-host-${runId}`;
  const serverOwnerId = `vscode-language-server-${runId}`;
  const reportValue = readJson(join(outputDirectory, "editor-result.json"));

  if (
    !isRecord(reportValue) ||
    reportValue.passed !== true ||
    !Array.isArray(reportValue.checks) ||
    reportValue.checks.length !== expectedChecks
  ) {
    throw new Error("Existing VS Code editor result did not report all 19 checks passed");
  }

  const host = validateOwnerReceipts(
    outputDirectory,
    runId,
    population.fingerprint,
    "extension-host",
    hostOwnerId,
  );
  const server = validateOwnerReceipts(
    outputDirectory,
    runId,
    population.fingerprint,
    "language-server",
    serverOwnerId,
  );

  for (const role of ["extension-host", "language-server"] as const) {
    if (existsSync(join(outputDirectory, `${role}-capture-error.json`))) {
      throw new Error(`Actual ${role} owner reported a coverage capture error`);
    }
  }

  const nativeValue = readJson(join(outputDirectory, "native-process-observation.json"));
  let native:
    | ({ readonly platform: "linux" } & ReturnType<typeof validateLinuxNativeObservation>)
    | ({ readonly platform: "windows" } & ReturnType<typeof validateNativeObservation>);

  if (process.platform === "linux") {
    const linuxNative = validateLinuxNativeObservation(
      nativeValue,
      runId,
      population.fingerprint,
      host.start,
      server.start,
      server.exit,
      code,
      resolve(dirname(context.configuration.testHostPath), ".."),
      join(dirname(context.configuration.testHostPath), "coverage-host.cjs"),
      outputDirectory,
      context.configuration.outputDirectory,
    );

    validateLinuxEditorLifecycleEvidence(
      outputDirectory,
      runId,
      population.fingerprint,
      host.start,
      host.exit,
      server.start,
      server.exit,
      linuxNative,
      context.extensionEntryPath,
      join(dirname(context.configuration.testHostPath), "coverage-host.cjs"),
    );

    native = { platform: "linux", ...linuxNative };
  } else {
    if (
      !isRecord(nativeValue) ||
      !Number.isSafeInteger(nativeValue.codeLaunchPid) ||
      Number(nativeValue.codeLaunchPid) <= 0
    ) {
      throw new Error("Native process observation has no valid Code launch PID");
    }

    const windowsNative = validateNativeObservation(
      nativeValue,
      runId,
      host.start,
      server.start,
      Number(nativeValue.codeLaunchPid),
      code.path,
    );

    if (
      windowsNative.host.pid !== host.start.pid ||
      windowsNative.server.pid !== server.start.pid
    ) {
      throw new Error("Native process observation does not match process-owned capture receipts");
    }

    if (
      host.exit.exitCode !== windowsNative.host.exitCode ||
      server.exit.exitCode !== windowsNative.server.exitCode
    ) {
      throw new Error("Process-owned and native exit codes disagree");
    }

    const nativeObservedAt = timestamp(nativeValue.observedAt)!;

    if (
      timestamp(host.exit.exitedAt)! > nativeObservedAt ||
      timestamp(server.exit.exitedAt)! > nativeObservedAt ||
      timestamp(windowsNative.host.attachedAt)! > timestamp(host.exit.exitedAt)! ||
      timestamp(windowsNative.server.attachedAt)! > timestamp(server.exit.exitedAt)!
    ) {
      throw new Error("Native process attachment and process-owned exit receipts are out of order");
    }

    if (
      resolve(windowsNative.server.executablePath).toLowerCase() !==
        resolve(server.start.execPath).toLowerCase() ||
      !server.start.argv.some((argument) =>
        argument.replaceAll("\\", "/").endsWith("packages/language-server/dist/cli.js"),
      )
    ) {
      throw new Error(
        "Language-server runtime receipt does not identify the original compiled CLI entry",
      );
    }

    if (server.start.ppid !== host.start.pid) {
      throw new Error(
        "Language-server process receipt parent does not match the actual Extension Host PID",
      );
    }

    if (
      !host.start.argv.some((argument) =>
        argument
          .replaceAll("\\", "/")
          .toLowerCase()
          .endsWith("/resources/app/out/bootstrap-fork.js"),
      )
    ) {
      throw new Error(
        "Extension Host runtime receipt does not identify the VS Code bootstrap-fork entry",
      );
    }

    validateEditorLifecycleEvidence(
      outputDirectory,
      runId,
      population.fingerprint,
      host.start,
      server.start,
      server.exit,
      windowsNative.host,
      windowsNative.server,
      windowsNative.launch,
      context.extensionEntryPath,
    );

    native = { platform: "windows", ...windowsNative };
  }

  const hostHits = host.raw.coverage as Record<string, CoverageFile>;
  const serverHits = server.raw.coverage as Record<string, CoverageFile>;
  const extensionCoverage = sourceCoverage(hostHits, extensionSource);

  if (!extensionCoverage || !hasHits(extensionCoverage)) {
    throw new Error("Actual Extension Host capture contains no authored extension.ts hits");
  }

  for (const source of [
    "packages/language-server/src/cli.ts",
    "packages/language-server/src/server.ts",
    "packages/language-server/src/project.ts",
  ]) {
    const coverage = sourceCoverage(serverHits, source);

    if (!coverage || !hasHits(coverage)) {
      throw new Error(`Actual language-server process contains no authored hits for ${source}`);
    }
  }

  const hostSupportHits = validateOwnerSupportCoverage({
    context,
    outputDirectory,
    role: "extension-host",
    start: host.start,
    exit: host.exit,
  });
  const serverSupportHits = validateOwnerSupportCoverage({
    context,
    outputDirectory,
    role: "language-server",
    start: server.start,
    exit: server.exit,
  });

  return {
    reportValue,
    host,
    server,
    native,
    hostHits,
    serverHits,
    ...(hostSupportHits ? { hostSupportHits } : {}),
    ...(serverSupportHits ? { serverSupportHits } : {}),
  };
}

function validateCapturedConfiguration(context: CapturedRunContext, outputDirectory: string): void {
  const value = readJson(join(outputDirectory, "editor-coverage-config.json"));

  if (!isRecord(value)) throw new Error("Editor capture configuration is malformed");

  const expected = context.configuration;

  requireExactKeys(
    value,
    [
      "format",
      "version",
      "runId",
      "repoPath",
      "outputDirectory",
      "populationFingerprint",
      "testHostPath",
      "languageServerSourcePaths",
      "outputs",
      ...(expected.supportConfigPath === undefined ? [] : ["supportConfigPath"]),
      ...(expected.verificationControl === undefined ? [] : ["verificationControl"]),
    ],
    "Editor capture configuration",
  );

  if (!Array.isArray(value.outputs))
    throw new Error("Editor capture configuration outputs are malformed");

  for (const output of value.outputs) {
    if (!isRecord(output)) throw new Error("Editor capture configuration output is malformed");

    requireExactKeys(
      output,
      ["originalPath", "compiledPath"],
      "Editor capture configuration output",
    );
  }

  if (
    value.format !== expected.format ||
    value.version !== expected.version ||
    value.runId !== context.runId ||
    value.runId !== expected.runId ||
    value.populationFingerprint !== context.population.fingerprint ||
    value.populationFingerprint !== expected.populationFingerprint ||
    value.repoPath !== expected.repoPath ||
    value.outputDirectory !== expected.outputDirectory ||
    value.testHostPath !== expected.testHostPath ||
    value.supportConfigPath !== expected.supportConfigPath ||
    value.verificationControl !== expected.verificationControl ||
    !Array.isArray(value.languageServerSourcePaths) ||
    JSON.stringify(value.languageServerSourcePaths) !==
      JSON.stringify(expected.languageServerSourcePaths) ||
    value.outputs.length !== expected.outputs.length ||
    value.outputs.some(
      (output, index) =>
        !isRecord(output) ||
        output.originalPath !== expected.outputs[index]?.originalPath ||
        output.compiledPath !== expected.outputs[index]?.compiledPath,
    )
  ) {
    throw new Error("Editor capture configuration does not match the current generated run");
  }
}

async function validateCapturedRun(
  context: CapturedRunContext,
  outputDirectory: string,
  driverHitPhase: "required" | "pending" = "required",
) {
  validateCapturedConfiguration(context, outputDirectory);

  const { runId, population } = context;
  const hostCoverageOwnerId = "host";
  const serverCoverageOwnerId = "ls";
  const evidence = validateCapturedOwnerEvidence(context, outputDirectory);
  const fixedArtifacts = new Set([
    "editor-coverage-config.json",
    "editor-result.json",
    "native-process-observation.json",
    "extension-host-start.json",
    "extension-host-exit.json",
    "extension-host-coverage.json",
    "language-server-start.json",
    "language-server-exit.json",
    "language-server-coverage.json",
    "extension-host-deactivate-start.json",
    "extension-host-deactivate.json",
    "language-server-native-exit-ack.json",
  ]);

  if (context.configuration.supportConfigPath) {
    fixedArtifacts.add("extension-host-support-coverage.json");

    fixedArtifacts.add("language-server-support-coverage.json");

    fixedArtifacts.add("editor-coverage-support.json");
  }

  for (const name of readdirSync(outputDirectory)) {
    if (fixedArtifacts.has(name)) continue;

    if (process.platform === "linux" && /^native-process-trace\.\d+$/u.test(name)) continue;

    if (name.startsWith(`${runId}-`) && name.endsWith(".json")) continue;

    throw new Error(`Unexpected or stale editor capture artifact: ${name}`);
  }

  const expectedArtifacts: ExpectedEditorArtifact[] = [
    {
      kind: "seed",
      ownerId: "vscode-editor-canonical",
      contextId: "seed",
      populationIncluded: true,
    },
    {
      kind: "seed",
      ownerId: hostCoverageOwnerId,
      contextId: "seed",
      populationIncluded: false,
    },
    {
      kind: "seed",
      ownerId: serverCoverageOwnerId,
      contextId: "seed",
      populationIncluded: false,
    },
    {
      kind: "hits",
      ownerId: hostCoverageOwnerId,
      contextId: "hits",
      populationIncluded: false,
    },
    {
      kind: "hits",
      ownerId: serverCoverageOwnerId,
      contextId: "hits",
      populationIncluded: false,
    },
  ];

  if (context.configuration.supportConfigPath) {
    expectedArtifacts.push(
      {
        kind: "seed",
        ownerId: "vscode-editor-driver",
        contextId: "editor-driver-seed",
        populationIncluded: false,
      },
      ...(driverHitPhase === "required"
        ? [
            {
              kind: "hits" as const,
              ownerId: "vscode-editor-driver",
              contextId: "editor-driver-hits",
              populationIncluded: false,
            },
          ]
        : []),
      {
        kind: "seed",
        ownerId: "vscode-editor-host-support",
        contextId: "editor-host-support-seed",
        populationIncluded: false,
      },
      {
        kind: "hits",
        ownerId: "vscode-editor-host-support",
        contextId: "editor-host-support-hits",
        populationIncluded: false,
      },
      {
        kind: "seed",
        ownerId: "vscode-editor-ls-support",
        contextId: "editor-ls-support-seed",
        populationIncluded: false,
      },
      {
        kind: "hits",
        ownerId: "vscode-editor-ls-support",
        contextId: "editor-ls-support-hits",
        populationIncluded: false,
      },
    );
  }

  const artifactFiles = readdirSync(outputDirectory).filter(
    (name) => name.startsWith(`${runId}-`) && name.endsWith(".json"),
  );
  const artifactsByKey = new Map<string, CoverageArtifact>();

  for (const name of artifactFiles) {
    const expected = expectedArtifacts.find((candidate) =>
      name.startsWith(`${runId}-${candidate.ownerId}-${candidate.contextId}-`),
    );

    if (!expected) throw new Error(`Unknown or orphan editor coverage artifact: ${name}`);

    const prefix = `${runId}-${expected.ownerId}-${expected.contextId}-`;
    const suffix = name.slice(prefix.length);
    const filenameIdentity =
      /^(\d+)-(\d+)-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.json$/u.exec(
        suffix,
      );

    if (
      !filenameIdentity ||
      Number(filenameIdentity[1]) !== process.pid ||
      Number(filenameIdentity[2]) !== threadId
    ) {
      throw new Error(`Editor coverage artifact filename has an invalid owner identity: ${name}`);
    }

    const key = `${expected.kind}:${expected.ownerId}`;

    if (artifactsByKey.has(key)) throw new Error(`Duplicate editor coverage artifact: ${key}`);

    const artifact = validateEditorArtifact(
      readJson(join(outputDirectory, name)),
      expected,
      runId,
      population,
    );

    artifactsByKey.set(key, artifact);
  }

  if (artifactsByKey.size !== expectedArtifacts.length) {
    throw new Error("Editor coverage artifacts are missing or duplicated by owner");
  }

  const seeds = expectedArtifacts
    .filter((expected) => expected.kind === "seed")
    .map((expected) => artifactsByKey.get(`${expected.kind}:${expected.ownerId}`)!);
  const hits = expectedArtifacts
    .filter((expected) => expected.kind === "hits")
    .map((expected) => artifactsByKey.get(`${expected.kind}:${expected.ownerId}`)!);

  if (context.configuration.supportConfigPath) {
    const supportConfig = readEditorCoverageSupportConfig(context.configuration);

    if (!supportConfig) throw new Error("Editor capture omitted its trusted support configuration");

    const supportEvidence = [
      ["driver", supportConfig.driver.ownerId, undefined, driverHitPhase === "required"],
      ["extension-host", supportConfig.extensionHost.ownerId, evidence.hostSupportHits, true],
      ["language-server", supportConfig.languageServer.ownerId, evidence.serverSupportHits, true],
    ] as const;

    for (const [key, ownerId, rawCoverage, requireHit] of supportEvidence) {
      const profile = coverageOwnerProfile(key);
      const seed = artifactsByKey.get(`seed:${ownerId}`);
      const hit = artifactsByKey.get(`hits:${ownerId}`);
      const sourcePaths =
        key === "driver"
          ? supportConfig.driver.sourcePaths
          : key === "extension-host"
            ? supportConfig.extensionHost.sourcePaths
            : supportConfig.languageServer.sourcePaths;

      if (
        !profile ||
        !seed ||
        (requireHit && !hit) ||
        !supportArtifactSourcesMatch(seed, profile.sources) ||
        (hit !== undefined && !supportArtifactSourcesMatch(hit, profile.sources)) ||
        (requireHit &&
          profile.requiredHitSources.some((source) => {
            const file = hit && sourceCoverage(hit.coverage, source);
            return !file || !hasHits(file);
          })) ||
        (rawCoverage !== undefined &&
          (!hit || JSON.stringify(hit.coverage) !== JSON.stringify(rawCoverage))) ||
        JSON.stringify(sourcePaths.map(canonicalPath).sort()) !==
          JSON.stringify(
            profile.sources.map((source) => canonicalPath(resolve(repoPath, source))).sort(),
          )
      ) {
        throw new Error(`Editor ${key} support artifacts do not match their current source owner`);
      }
    }
  }

  const expectedSources = inventoryCoverageSources(repoPath);
  const merged = await mergeCoverageArtifacts({
    repoPath,
    expectedSources,
    seeds,
    fragments: hits,
  });

  if (merged.files().length !== expectedSources.length) {
    throw new Error("Editor coverage merge did not preserve the full authored-source inventory");
  }

  return { ...evidence, merged };
}

async function admitCapturedRun(context: CapturedRunContext, outputDirectory: string) {
  const captured = await validateCapturedRun(context, outputDirectory);
  const lcovPath = join(outputDirectory, "lcov.info");

  writeLcovReport(captured.merged, lcovPath);

  return { ...captured, lcovPath };
}

function createDriverControlPreview(context: CapturedRunContext): CoverageArtifact {
  const profile = coverageOwnerProfile("driver");

  if (!profile) throw new Error("Editor artifact controls have no trusted driver profile");

  const rawCoverage = Reflect.get(globalThis, "__hesperiaCoverage__");

  if (!isRecord(rawCoverage)) {
    throw new Error("Editor artifact controls have no live driver coverage counters");
  }

  const preparedPaths = new Map<string, string>();

  for (const source of profile.sources) {
    const path = resolve(repoPath, source.replaceAll("/", sep));
    const identity = canonicalPath(path);

    if (preparedPaths.has(identity)) {
      throw new Error(`Editor driver profile contains a duplicate source path: ${source}`);
    }

    preparedPaths.set(identity, path);
  }

  const coverage: Record<string, CoverageFile> = {};

  for (const [rawPath, value] of Object.entries(rawCoverage)) {
    const identity = canonicalPath(rawPath);
    const preparedPath = preparedPaths.get(identity);

    if (
      !preparedPath ||
      !isRecord(value) ||
      typeof value.path !== "string" ||
      canonicalPath(value.path) !== identity ||
      Object.hasOwn(coverage, preparedPath)
    ) {
      throw new Error(`Coverage owner captured an unprepared support source: ${rawPath}`);
    }

    coverage[preparedPath] = value as unknown as CoverageFile;
  }

  const artifact = createCoverageArtifact({
    repoPath,
    kind: "hits",
    runId: context.runId,
    ownerId: profile.ownerId,
    populationFingerprint: context.population.fingerprint,
    sourcePopulation: context.population,
    coverage,
  });

  if (!supportArtifactSourcesMatch(artifact, profile.sources)) {
    throw new Error("Editor driver preview has an incomplete source allowlist");
  }

  for (const source of profile.requiredHitSources) {
    const file = sourceCoverage(artifact.coverage, source);

    if (!file || !hasHits(file)) {
      throw new Error(`Coverage owner support hit is missing: ${source}`);
    }
  }

  return JSON.parse(JSON.stringify(artifact)) as CoverageArtifact;
}

async function verifyArtifactRejections(
  context: CapturedRunContext,
  outputDirectory: string,
  driverPreview?: CoverageArtifact,
) {
  const controlRoot = join(repoPath, ".hesperia", "coverage", "editor-controls", context.runId);

  mkdirSync(controlRoot, { recursive: true });

  const makeCopy = (name: string, sourceDirectory = outputDirectory): string => {
    const directory = join(controlRoot, name);

    mkdirSync(directory);

    for (const file of readdirSync(sourceDirectory).filter(
      (entry) => entry !== "lcov.info" && entry !== "editor-capture-summary.json",
    )) {
      copyFileSync(join(sourceDirectory, file), join(directory, file));
    }

    return directory;
  };

  const baselineDirectory = makeCopy("positive-replay");

  if (driverPreview) {
    const profile = coverageOwnerProfile("driver");

    if (!profile || driverPreview.ownerId !== profile.ownerId) {
      throw new Error("Editor driver preview does not match its trusted owner profile");
    }

    writeCoverageFragment({
      directory: baselineDirectory,
      contextId: `${profile.contextId}-hits`,
      pid: process.pid,
      threadId,
      repoPath,
      artifact: driverPreview,
      sourcePopulation: context.population,
    });
  }

  const originals = readdirSync(baselineDirectory).filter(
    (name) => name !== "lcov.info" && name !== "editor-capture-summary.json",
  );
  const admittedBaseline = await admitCapturedRun(context, baselineDirectory);
  const selected = originals.find((name) =>
    name.startsWith(`${context.runId}-vscode-editor-canonical-seed-`),
  );

  if (!selected) throw new Error("Validated capture has no canonical fragment for controls");

  const cases: {
    name: string;
    sourceDirectory?: string;
    mutate: (directory: string) => void;
    rejection: (message: string) => boolean;
  }[] = [];

  if (process.platform === "linux") {
    const nativePath = join(baselineDirectory, "native-process-observation.json");
    const nativeValue = readJson(nativePath);

    if (
      !isRecord(nativeValue) ||
      !Array.isArray(nativeValue.events) ||
      !isRecord(nativeValue.codeGui) ||
      !Number.isSafeInteger(nativeValue.codeGui.pid)
    ) {
      throw new Error("Linux raw-only creator control has no admitted native process observation");
    }

    const nativeEvents = nativeValue.events.filter(isRecord);
    const eventByPid = new Map(nativeEvents.map((event) => [Number(event.pid), event]));
    const codeGuiPid = Number(nativeValue.codeGui.pid);

    if (admittedBaseline.native.platform !== "linux") {
      throw new Error("Linux raw-only creator control has no admitted Linux trace topology");
    }

    const admittedTraceFiles = admittedBaseline.native.files;
    const topology = validateLinuxTraceClosure(
      admittedTraceFiles,
      nativeEvents,
      codeGuiPid,
      context.code.executablePath,
    );

    const isDescendantOf = (pid: number, ancestorPid: number): boolean => {
      const visited = new Set<number>();
      let current = pid;

      while (current !== ancestorPid) {
        if (visited.has(current)) return false;

        visited.add(current);

        const parentPid = topology.processParentByPid.get(current);

        if (parentPid === undefined) return false;

        current = parentPid;
      }

      return true;
    };

    const terminalCall =
      /^(?:(?:\d+)(?:\.\d+)?\s+)?\+\+\+ (?:exited with \d+|killed by SIG[A-Z0-9]+(?: \(.*\))?) \+\+\+$/u;

    const rawGroupTerminalNs = (pid: number): bigint => {
      const memberTids = [...topology.processByTid]
        .filter(([, groupPid]) => groupPid === pid)
        .map(([tid]) => tid);

      if (memberTids.length === 0) {
        throw new Error(`Linux raw-only creator control has no traced members for PID ${pid}`);
      }

      return memberTids.reduce((latest, tid) => {
        const trace = admittedTraceFiles.get(`native-process-trace.${tid}`);
        const terminal = trace?.lines.at(-1)?.replace(/\r$/u, "");

        if (!terminal || !terminalCall.test(terminal)) {
          throw new Error(`Linux raw-only creator control has no terminal trace for TID ${tid}`);
        }

        const terminalNs = linuxTraceTimestampNs(terminal);
        return terminalNs > latest ? terminalNs : latest;
      }, 0n);
    };

    const protectedPids = new Set<number>([codeGuiPid]);

    for (const raw of [
      nativeValue.displayServer,
      nativeValue.codeCliWrapper,
      nativeValue.codeCli,
    ]) {
      if (isRecord(raw) && Number.isSafeInteger(raw.pid)) protectedPids.add(Number(raw.pid));
    }

    if (isRecord(nativeValue.trace) && isRecord(nativeValue.trace.tracer)) {
      const tracerPid = nativeValue.trace.tracer.pid;

      if (Number.isSafeInteger(tracerPid)) protectedPids.add(Number(tracerPid));
    }

    const candidate = nativeEvents
      .filter((event) => {
        if (
          !Number.isSafeInteger(event.pid) ||
          !Number.isSafeInteger(event.parentPid) ||
          !isRecord(event.creator) ||
          !Number.isSafeInteger(event.creator.parentPid) ||
          event.creator.childPid !== event.pid ||
          event.parentPid === event.creator.parentPid ||
          protectedPids.has(Number(event.pid)) ||
          protectedPids.has(Number(event.creator.parentPid)) ||
          event.ownerRole !== undefined
        ) {
          return false;
        }

        const childParents = Array.isArray(event.parents) ? event.parents : undefined;
        const firstParent = childParents?.[0];
        const firstSampleNs = isRecord(firstParent)
          ? linuxTimestampNs(firstParent.observedAt)
          : undefined;
        const creatorPid = Number(event.creator.parentPid);

        if (
          firstSampleNs === undefined ||
          topology.processParentByPid.get(Number(event.pid)) !== creatorPid ||
          !isDescendantOf(Number(event.pid), codeGuiPid) ||
          !isDescendantOf(creatorPid, codeGuiPid) ||
          rawGroupTerminalNs(creatorPid) >= firstSampleNs
        ) {
          return false;
        }

        const creatorEvent = eventByPid.get(Number(event.creator.parentPid));
        return (
          !creatorEvent ||
          (creatorEvent.ownerRole === undefined && !protectedPids.has(Number(creatorEvent.pid)))
        );
      })
      .sort((left, right) => Number(left.pid) - Number(right.pid))[0];

    if (!candidate || !isRecord(candidate.creator)) {
      throw new Error(
        "Linux native capture has no genuine reparented child with an unmeasured non-owner raw creator",
      );
    }

    const childPid = Number(candidate.pid);
    const creatorPid = Number(candidate.creator.parentPid);
    const creatorEventOmitted = eventByPid.has(creatorPid);
    const positiveName = "raw-only-creator-positive-replay";
    const positiveDirectory = makeCopy(positiveName, baselineDirectory);

    if (creatorEventOmitted) {
      const positiveNativePath = join(positiveDirectory, "native-process-observation.json");
      const positiveNative = readJson(positiveNativePath);

      if (!isRecord(positiveNative) || !Array.isArray(positiveNative.events)) {
        throw new Error("Linux raw-only creator replay has malformed native events");
      }

      const filtered = positiveNative.events.filter(
        (event) => !isRecord(event) || Number(event.pid) !== creatorPid,
      );

      if (filtered.length !== positiveNative.events.length - 1) {
        throw new Error(
          "Linux raw-only creator replay did not omit exactly its authentic helper event",
        );
      }

      positiveNative.events = filtered;

      writeFileSync(positiveNativePath, JSON.stringify(positiveNative));
    }

    await admitCapturedRun(context, positiveDirectory);

    const mutateNativeObservation = (
      directory: string,
      mutate: (value: Record<string, unknown>, events: Record<string, unknown>[]) => void,
    ): void => {
      const path = join(directory, "native-process-observation.json");
      const value = readJson(path);

      if (!isRecord(value) || !Array.isArray(value.events)) {
        throw new Error("Linux raw-only creator control has malformed native events");
      }

      const events = value.events.filter(isRecord);

      mutate(value, events);

      writeFileSync(path, JSON.stringify(value));
    };

    let retainedCreatorPid: number | undefined;
    let omittedCreatorTid: number | undefined;

    for (const childEvent of nativeEvents) {
      const rawCreator = childEvent.creator;

      if (!isRecord(rawCreator) || childEvent.parentPid !== rawCreator.parentPid) continue;

      const creatorPid = Number(rawCreator.parentPid);
      const creatorEvent = eventByPid.get(creatorPid);

      if (!creatorEvent || !Array.isArray(creatorEvent.threadExits)) continue;

      const members = new Set<number>();
      let nonleaderTid: number | undefined;

      for (const [tid, groupPid] of topology.processByTid) {
        if (groupPid !== creatorPid) continue;

        members.add(tid);

        if (tid !== creatorPid && nonleaderTid === undefined) nonleaderTid = tid;
      }

      const exitTids = new Set<number>();

      for (const rawExit of creatorEvent.threadExits) {
        if (isRecord(rawExit)) exitTids.add(Number(rawExit.tid));
      }

      let completeExits =
        members.size >= 2 &&
        members.has(creatorPid) &&
        nonleaderTid !== undefined &&
        exitTids.size === creatorEvent.threadExits.length &&
        exitTids.size === members.size;

      for (const tid of members) if (!exitTids.has(tid)) completeExits = false;

      if (!completeExits) continue;

      retainedCreatorPid = creatorPid;
      omittedCreatorTid = nonleaderTid;
      break;
    }

    if (retainedCreatorPid === undefined || omittedCreatorTid === undefined) {
      throw new Error(
        "Linux retained-creator completeness control has no same-parent multi-TID specimen",
      );
    }

    const selectedCreatorPid = retainedCreatorPid;
    const selectedNonleaderTid = omittedCreatorTid;

    cases.push({
      name: "retained-creator-nonleader-thread-exit-omitted",
      sourceDirectory: baselineDirectory,
      mutate: (directory) =>
        mutateNativeObservation(directory, (_value, events) => {
          const creatorEvent = events.find((event) => Number(event.pid) === selectedCreatorPid);

          if (!creatorEvent || !Array.isArray(creatorEvent.threadExits)) {
            throw new Error("Linux completeness control lost its retained creator event");
          }

          const exitCount = creatorEvent.threadExits.length;
          const remainingExits = creatorEvent.threadExits.filter(
            (rawExit) => isRecord(rawExit) && Number(rawExit.tid) !== selectedNonleaderTid,
          );

          if (remainingExits.length !== exitCount - 1) {
            throw new Error("Linux completeness control did not remove exactly one creator exit");
          }

          creatorEvent.threadExits = remainingExits;
        }),
      rejection: (message) =>
        message ===
          `Admitted Linux process ${selectedCreatorPid} omits raw thread TID ${selectedNonleaderTid}` ||
        message ===
          `Linux native generation ${selectedCreatorPid} does not account for its complete raw thread group`,
    });

    cases.push(
      {
        name: "raw-only-creator-terminal-followed-by-record",
        sourceDirectory: positiveDirectory,
        mutate: (directory) => {
          const traceName = `native-process-trace.${creatorPid}`;
          const tracePath = join(directory, traceName);
          const originalBytes = readFileSync(tracePath);
          const newline = originalBytes.includes(Buffer.from("\r\n")) ? "\r\n" : "\n";
          const lines = originalBytes
            .toString("utf8")
            .replace(/(?:\r?\n)$/u, "")
            .split(/\r?\n/u);
          const terminal = lines.at(-1)?.replace(/\r$/u, "");
          const controlTerminalCall =
            /^(?:(?:\d+)(?:\.\d+)?\s+)?\+\+\+ (?:exited with \d+|killed by SIG[A-Z0-9]+(?: \(.*\))?) \+\+\+$/u;

          if (!terminal || !controlTerminalCall.test(terminal)) {
            throw new Error(
              "Linux raw-only creator control has no final helper terminal to corrupt",
            );
          }

          const nextNs = linuxTraceTimestampNs(terminal) + 1n;
          const afterTerminal = `${nextNs / 1_000_000_000n}.${(nextNs % 1_000_000_000n)
            .toString()
            .padStart(9, "0")} getpid() = ${creatorPid}`;
          const mutatedBytes = Buffer.from([...lines, afterTerminal, ""].join(newline), "utf8");

          writeFileSync(tracePath, mutatedBytes);

          mutateNativeObservation(directory, (value) => {
            if (!isRecord(value.trace) || !Array.isArray(value.trace.files)) {
              throw new Error("Linux raw-only creator control has no trace file manifest");
            }

            const manifest = value.trace.files.find(
              (item) => isRecord(item) && item.file === traceName,
            );

            if (!isRecord(manifest)) {
              throw new Error(
                "Linux raw-only creator control omits the helper trace manifest entry",
              );
            }

            manifest.bytes = mutatedBytes.byteLength;
            manifest.sha256 = createHash("sha256").update(mutatedBytes).digest("hex");
          });
        },
        rejection: (message) =>
          message.startsWith(
            "Linux raw-only creator proof has records after or multiple terminal trace records:",
          ),
      },
      {
        name: "raw-only-child-sample-at-pidfd-readiness",
        sourceDirectory: positiveDirectory,
        mutate: (directory) =>
          mutateNativeObservation(directory, (_value, events) => {
            const child = events.find((event) => Number(event.pid) === childPid);

            if (!child || !Array.isArray(child.parents) || child.parents.length === 0) {
              throw new Error("Linux raw-only creator control has no child parent history");
            }

            for (const parent of child.parents) {
              if (!isRecord(parent)) throw new Error("Linux child parent sample is malformed");

              parent.observedAt = child.pidfdReadyAt;
            }
          }),
        rejection: (message) =>
          message ===
          `Linux raw-only child ${childPid} pidfd and parent sample do not bind its raw lifetime`,
      },
      {
        name: "raw-only-code-gui-sample-at-pidfd-readiness",
        sourceDirectory: positiveDirectory,
        mutate: (directory) =>
          mutateNativeObservation(directory, (_value, events) => {
            const gui = events.find((event) => Number(event.pid) === codeGuiPid);

            if (!gui || !Array.isArray(gui.parents) || gui.parents.length === 0) {
              throw new Error(
                "Linux raw-only creator control has no retained Code GUI parent history",
              );
            }

            for (const parent of gui.parents) {
              if (!isRecord(parent)) throw new Error("Linux Code GUI parent sample is malformed");

              parent.observedAt = gui.pidfdReadyAt;
            }
          }),
        rejection: (message) =>
          message ===
          "Linux retained Code GUI anchor does not bind its native generation to the raw lifetime",
      },
      {
        name: "raw-only-dead-creator-parent-alias",
        sourceDirectory: positiveDirectory,
        mutate: (directory) =>
          mutateNativeObservation(directory, (_value, events) => {
            const child = events.find((event) => Number(event.pid) === childPid);

            if (!child || !Array.isArray(child.parents) || child.parents.length === 0) {
              throw new Error("Linux raw-only creator control has no child parent history");
            }

            child.parentPid = creatorPid;

            for (const parent of child.parents) {
              if (!isRecord(parent)) throw new Error("Linux child parent sample is malformed");

              parent.pid = creatorPid;
            }
          }),
        rejection: (message) =>
          message === "Linux child parent sample aliases an exited raw creator generation",
      },
    );
  }

  if (process.platform === "win32") {
    if (admittedBaseline.native.platform !== "windows") {
      throw new Error("Windows artifact controls have no admitted native observation");
    }

    const windowsNative = admittedBaseline.native;

    const mutateNativeEvents = (
      directory: string,
      mutate: (events: Record<string, unknown>[]) => void,
    ): void => {
      const path = join(directory, "native-process-observation.json");
      const value = readJson(path);

      if (!isRecord(value) || !Array.isArray(value.events)) {
        throw new Error("Validated Windows native observation is malformed");
      }

      const events = value.events.filter(isRecord);

      if (events.length !== value.events.length) {
        throw new Error("Validated Windows native observation has malformed events");
      }

      mutate(events);

      writeFileSync(path, JSON.stringify(value));
    };

    let impossibleAttachmentPid: number | undefined;

    cases.push(
      {
        name: "native-process-attachment-after-exit",
        mutate: (directory) =>
          mutateNativeEvents(directory, (events) => {
            const target = events.find((event) => {
              const processExitTime = timestamp(event.processExitTime);
              const exitObservedAt = timestamp(event.exitObservedAt);
              return (
                Number.isSafeInteger(event.pid) &&
                processExitTime !== undefined &&
                exitObservedAt !== undefined &&
                exitObservedAt > processExitTime
              );
            });

            if (!target) {
              throw new Error(
                "Validated Windows observation has no process with a later exit observation",
              );
            }

            target.attachedAt = target.exitObservedAt;
            impossibleAttachmentPid = Number(target.pid);
          }),
        rejection: (message) =>
          impossibleAttachmentPid !== undefined &&
          message ===
            `Native process record is unattached, malformed, or has no observed exit: ${impossibleAttachmentPid}`,
      },
      {
        name: "native-extension-host-nonzero-exit",
        mutate: (directory) =>
          mutateNativeEvents(directory, (events) => {
            const host = events.find((event) => Number(event.pid) === windowsNative.host.pid);

            if (!host) throw new Error("Validated Windows observation omits its Extension Host");

            host.exitCode = 1;
          }),
        rejection: (message) =>
          message ===
          "Native extension-host process did not have an independently observed normal exit",
      },
      {
        name: "unloaded-staged-extension-shutdown",
        mutate: (directory) => {
          const path = join(directory, "extension-host-deactivate-start.json");
          const start = readJson(path);

          if (!isRecord(start)) {
            throw new Error("Validated Windows capture has no deactivation start receipt");
          }

          start.moduleCacheLoaded = false;

          writeFileSync(path, JSON.stringify(start));
        },
        rejection: (message) =>
          message ===
          "Staged-extension shutdown or native language-server exit evidence is inconsistent",
      },
    );
  }

  for (const role of ["extension-host", "language-server"] as const) {
    for (const [suffix, description] of [
      ["start", "start receipt"],
      ["exit", "exit receipt"],
      ["coverage", "raw coverage"],
    ] as const) {
      cases.push({
        name: `omit-${role}-${suffix}`,
        mutate: (directory) => unlinkSync(join(directory, `${role}-${suffix}.json`)),
        rejection: (message) => message === `Missing ${role} ${description}`,
      });

      cases.push({
        name: `unknown-field-${role}-${suffix}`,
        mutate: (directory) => {
          const path = join(directory, `${role}-${suffix}.json`);
          const value = readJson(path);

          if (!isRecord(value)) throw new Error("Validated owner receipt is malformed");

          value.unexpectedControlField = true;

          writeFileSync(path, JSON.stringify(value));
        },
        rejection: (message) =>
          message === `${role} ${description} contains missing or unexpected fields`,
      });
    }
  }

  if (context.configuration.supportConfigPath) {
    for (const [ownerId, contextId] of [
      ["vscode-editor-driver", "editor-driver-seed"],
      ["vscode-editor-driver", "editor-driver-hits"],
      ["vscode-editor-host-support", "editor-host-support-seed"],
      ["vscode-editor-host-support", "editor-host-support-hits"],
      ["vscode-editor-ls-support", "editor-ls-support-seed"],
      ["vscode-editor-ls-support", "editor-ls-support-hits"],
    ] as const) {
      const prefix = `${context.runId}-${ownerId}-${contextId}-`;
      const fragment = originals.find((name) => name.startsWith(prefix));

      if (!fragment) throw new Error(`Validated capture is missing support fragment: ${prefix}`);

      cases.push({
        name: `omit-support-${ownerId}-${contextId}`,
        mutate: (directory) => unlinkSync(join(directory, fragment)),
        rejection: (message) =>
          message === "Editor coverage artifacts are missing or duplicated by owner",
      });
    }
  }

  let invalidOwnerFilename: string | undefined;

  for (const [name, field, value] of [
    ["stale-run", "runId", randomUUID()],
    ["wrong-population", "populationFingerprint", "0".repeat(64)],
  ] as const) {
    cases.push({
      name,
      mutate: (directory) => {
        const path = join(directory, selected);
        const artifact = readJson(path);

        if (!isRecord(artifact)) throw new Error("Validated canonical fragment is malformed");

        artifact[field] = value;

        writeFileSync(path, JSON.stringify(artifact));
      },
      rejection: (message) =>
        message ===
        "Unexpected, stale, or malformed seed editor artifact for vscode-editor-canonical",
    });
  }

  cases.push(
    {
      name: "canonical-fragment-foreign-pid",
      mutate: (directory) => {
        const prefix = `${context.runId}-vscode-editor-canonical-seed-`;
        const identity =
          /^(\d+)-(\d+)-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.json$/u.exec(
            selected.slice(prefix.length),
          );

        if (!identity) throw new Error("Validated canonical fragment has an invalid filename");

        const foreignPid = Number(identity[1]) === 1 ? "2" : "1";
        invalidOwnerFilename = `${prefix}${foreignPid}-${identity[2]}-${identity[3]}.json`;

        renameSync(join(directory, selected), join(directory, invalidOwnerFilename));
      },
      rejection: (message) =>
        invalidOwnerFilename !== undefined &&
        message ===
          `Editor coverage artifact filename has an invalid owner identity: ${invalidOwnerFilename}`,
    },
    {
      name: "unknown-field-config",
      mutate: (directory) => {
        const path = join(directory, "editor-coverage-config.json");
        const value = readJson(path);

        if (!isRecord(value)) throw new Error("Validated capture configuration is malformed");

        value.unexpectedControlField = true;

        writeFileSync(path, JSON.stringify(value));
      },
      rejection: (message) =>
        message === "Editor capture configuration contains missing or unexpected fields",
    },
    {
      name: "unknown-field-config-output",
      mutate: (directory) => {
        const path = join(directory, "editor-coverage-config.json");
        const value = readJson(path);

        if (!isRecord(value) || !Array.isArray(value.outputs) || !isRecord(value.outputs[0])) {
          throw new Error("Validated capture configuration has no mapped output entry");
        }

        value.outputs[0].unexpectedControlField = true;

        writeFileSync(path, JSON.stringify(value));
      },
      rejection: (message) =>
        message === "Editor capture configuration output contains missing or unexpected fields",
    },
    {
      name: "malformed-json",
      mutate: (directory) => writeFileSync(join(directory, selected), "{"),
      rejection: (message) =>
        message.startsWith("Malformed JSON editor evidence: ") && message.endsWith(selected),
    },
    {
      name: "duplicate-fragment",
      mutate: (directory) =>
        copyFileSync(
          join(directory, selected),
          join(
            directory,
            `${context.runId}-vscode-editor-canonical-seed-${process.pid}-${threadId}-${randomUUID()}.json`,
          ),
        ),
      rejection: (message) =>
        message === "Duplicate editor coverage artifact: seed:vscode-editor-canonical",
    },
    {
      name: "unknown-file",
      mutate: (directory) =>
        copyFileSync(join(directory, selected), join(directory, "unknown-evidence.json")),
      rejection: (message) =>
        message === "Unexpected or stale editor capture artifact: unknown-evidence.json",
    },
    {
      name: "orphan-fragment",
      mutate: (directory) => {
        const name = `${context.runId}-orphan-seed-${process.pid}-${threadId}-${randomUUID()}.json`;

        copyFileSync(join(directory, selected), join(directory, name));

        unlinkSync(join(directory, selected));
      },
      rejection: (message) =>
        message.startsWith(
          `Unknown or orphan editor coverage artifact: ${context.runId}-orphan-seed-`,
        ),
    },
  );

  const results: { name: string; directory: string; rejection: string; lcovAbsent: true }[] = [];

  for (const control of cases) {
    const directory = makeCopy(control.name, control.sourceDirectory ?? baselineDirectory);

    control.mutate(directory);

    let rejection: string | undefined;

    try {
      await admitCapturedRun(context, directory);
    } catch (error) {
      rejection = error instanceof Error ? error.message : String(error);
    }

    if (!rejection || !control.rejection(rejection) || existsSync(join(directory, "lcov.info"))) {
      throw new Error(
        `Editor control ${control.name} failed its precise rejection/no-LCOV requirement: ${rejection ?? "accepted"}`,
      );
    }

    results.push({ name: control.name, directory, rejection, lcovAbsent: true });
  }

  writeFileSync(
    join(controlRoot, "control-results.json"),
    JSON.stringify({
      format: "hesperia-editor-artifact-rejection-controls",
      version: 1,
      runId: context.runId,
      populationFingerprint: context.population.fingerprint,
      driverPid: process.pid,
      driverThreadId: threadId,
      evidenceOrigin: "post-validation-copy-of-current-genuine-capture",
      baselineDirectory,
      originalOutputDirectory: outputDirectory,
      results,
    }),
  );

  console.log(
    JSON.stringify({
      status: "artifact-controls-passed",
      runId: context.runId,
      controlRoot,
      cases: results.length,
    }),
  );
}

function verifyLinuxNativeKillRejection(
  mode: "kill-extension-host" | "kill-language-server",
  context: CapturedRunContext,
  outputDirectory: string,
): void {
  const controlValue = readJson(join(outputDirectory, "owner-kill-control.json"));
  const failureValue = readJson(join(outputDirectory, "native-process-failure.json"));
  const readyValue = readJson(join(outputDirectory, "owner-kill-ready.json"));
  const reportValue = readJson(join(outputDirectory, "editor-result.json"));

  if (
    !isRecord(controlValue) ||
    !isRecord(failureValue) ||
    !isRecord(readyValue) ||
    !isRecord(reportValue)
  ) {
    throw new Error("Linux postassertion kill control is missing its native receipts");
  }

  const control = controlValue;
  const failure = failureValue;
  const ready = readyValue;
  const role = mode === "kill-extension-host" ? "extension-host" : "language-server";
  const startValue = readJson(join(outputDirectory, `${role}-start.json`));
  const hostValue = readJson(join(outputDirectory, "extension-host-start.json"));
  const serverValue = readJson(join(outputDirectory, "language-server-start.json"));

  if (!isRecord(startValue) || !isRecord(hostValue) || !isRecord(serverValue)) {
    throw new Error("Linux native kill control lacks its process-owned Host/LS start receipts");
  }

  const start = startValue;
  const host = hostValue;
  const server = serverValue;
  const hostExecPath = host.execPath;
  const serverExecPath = server.execPath;

  if (
    typeof hostExecPath !== "string" ||
    hostExecPath.length === 0 ||
    typeof serverExecPath !== "string" ||
    serverExecPath.length === 0
  ) {
    throw new Error("Linux native kill control lacks process-owned executable paths");
  }

  requireExactKeys(
    control,
    [
      "format",
      "version",
      "runId",
      "populationFingerprint",
      "mode",
      "role",
      "pid",
      "parentPid",
      "executablePath",
      "procArgv",
      "ownerArgv",
      "procStarttimeTicks",
      "pidfdAttachedAt",
      "assertionsCompletedAt",
      "requestedSignal",
      "signalSentAt",
      "pidfdReadyAt",
      "outcome",
      "traceExit",
    ],
    "Linux native kill control",
  );

  requireExactKeys(
    ready,
    [
      "format",
      "version",
      "runId",
      "populationFingerprint",
      "mode",
      "extensionHostPid",
      "assertionsCompletedAt",
    ],
    "Linux native kill barrier",
  );

  requireExactKeys(
    failure,
    [
      "format",
      "version",
      "platform",
      "runId",
      "populationFingerprint",
      "observerStartedAt",
      "observedAt",
      "failure",
      "failureExceptionType",
      "failureTraceback",
      "failureErrno",
      "failureFilename",
      "failureFilename2",
      "codeCliWrapper",
      "codeCli",
      "forcedPids",
      "cleanupFailures",
      "diagnosticErrors",
      "displayServer",
      "fixtureProcessScope",
      "trace",
      "events",
    ],
    "Linux native process failure",
  );

  requireExactKeys(start, ownerStartReceiptKeys, `${role} start receipt`);

  requireExactKeys(host, ownerStartReceiptKeys, "extension-host start receipt");

  requireExactKeys(server, ownerStartReceiptKeys, "language-server start receipt");

  const observerStartedAt = timestamp(failure.observerStartedAt);
  const observedAt = timestamp(failure.observedAt);
  const attachedAt = timestamp(control.pidfdAttachedAt);
  const assertionsAt = timestamp(control.assertionsCompletedAt);
  const signalAt = timestamp(control.signalSentAt);
  const readyAt = timestamp(control.pidfdReadyAt);
  const expectedFailure = `Private native owner kill control terminated ${role} PID ${start.pid}`;

  if (
    control.format !== "hesperia-editor-linux-native-owner-kill-control" ||
    control.version !== 1 ||
    control.runId !== context.runId ||
    control.populationFingerprint !== context.population.fingerprint ||
    control.mode !== mode ||
    control.role !== role ||
    control.pid !== start.pid ||
    control.parentPid !== start.ppid ||
    control.executablePath !== start.execPath ||
    JSON.stringify(control.ownerArgv) !== JSON.stringify(start.argv) ||
    !Array.isArray(control.procArgv) ||
    !control.procArgv.every((argument) => typeof argument === "string") ||
    !Number.isSafeInteger(control.procStarttimeTicks) ||
    control.requestedSignal !== "SIGKILL" ||
    attachedAt === undefined ||
    assertionsAt === undefined ||
    signalAt === undefined ||
    readyAt === undefined ||
    signalAt < attachedAt ||
    signalAt < assertionsAt ||
    readyAt < signalAt ||
    readyAt > observedAt! ||
    !isRecord(control.outcome) ||
    JSON.stringify(control.outcome) !== JSON.stringify({ kind: "signal", signal: "SIGKILL" }) ||
    ready.format !== "hesperia-editor-owner-kill-ready" ||
    ready.version !== 1 ||
    ready.runId !== context.runId ||
    ready.populationFingerprint !== context.population.fingerprint ||
    ready.mode !== mode ||
    ready.extensionHostPid !== host.pid ||
    ready.assertionsCompletedAt !== control.assertionsCompletedAt ||
    start.format !== "hesperia-editor-owner-start" ||
    start.version !== 1 ||
    start.runId !== context.runId ||
    start.populationFingerprint !== context.population.fingerprint ||
    start.ownerId !== `vscode-${role}-${context.runId}` ||
    start.role !== role ||
    (role === "extension-host" ? server.ppid !== host.pid : start.ppid !== host.pid) ||
    failure.format !== "hesperia-editor-linux-native-process-failure" ||
    failure.version !== 1 ||
    failure.platform !== "linux" ||
    failure.runId !== context.runId ||
    failure.populationFingerprint !== context.population.fingerprint ||
    observerStartedAt === undefined ||
    observedAt === undefined ||
    observerStartedAt > observedAt ||
    typeof failure.failure !== "string" ||
    failure.failure !== expectedFailure ||
    failure.failureExceptionType !== "__main__.CaptureError" ||
    typeof failure.failureTraceback !== "string" ||
    failure.failureTraceback.length === 0 ||
    !failure.failureTraceback.includes(expectedFailure) ||
    failure.failureErrno !== null ||
    failure.failureFilename !== null ||
    failure.failureFilename2 !== null ||
    !Array.isArray(failure.forcedPids) ||
    !failure.forcedPids.every((pid) => Number.isSafeInteger(pid) && Number(pid) > 0) ||
    !Array.isArray(failure.cleanupFailures) ||
    failure.cleanupFailures.length !== 0 ||
    !Array.isArray(failure.diagnosticErrors) ||
    failure.diagnosticErrors.length !== 0 ||
    !Array.isArray(failure.events) ||
    reportValue.passed !== true ||
    !Array.isArray(reportValue.checks) ||
    reportValue.checks.length !== expectedChecks ||
    existsSync(join(outputDirectory, `${role}-exit.json`)) ||
    existsSync(join(outputDirectory, `${role}-coverage.json`)) ||
    existsSync(join(outputDirectory, "lcov.info"))
  ) {
    throw new Error(
      "Linux native kill control did not prove postassertion SIGKILL and rejected coverage capture",
    );
  }

  const files = validateLinuxTraceEvidence(
    failure.trace,
    outputDirectory,
    observerStartedAt!,
    observedAt!,
    true,
  );
  const events = failure.events.map((event) => validateLinuxNativeEvent(event, files, observedAt!));
  const scope = failure.fixtureProcessScope;

  if (!isRecord(scope)) throw new Error("Linux failed-run fixture scope is missing");

  requireExactKeys(
    scope,
    ["checkedAt", "userDataPath", "extensionsPath", "activeProcessIds"],
    "Linux failed-run fixture scope",
  );

  const scopeUserDataPath = scope.userDataPath;
  const scopeExtensionsPath = scope.extensionsPath;

  if (
    timestamp(scope.checkedAt) === undefined ||
    timestamp(scope.checkedAt)! > observedAt! ||
    typeof scopeUserDataPath !== "string" ||
    typeof scopeExtensionsPath !== "string" ||
    !Array.isArray(scope.activeProcessIds) ||
    scope.activeProcessIds.length !== 0
  ) {
    throw new Error("Linux failed run did not close the isolated fixture process scope");
  }

  const hasSuffix = (argv: unknown, suffix: string): boolean => {
    if (!Array.isArray(argv)) return false;

    for (const argument of argv) {
      if (
        typeof argument === "string" &&
        argument.replaceAll("\\", "/").toLowerCase().endsWith(suffix.toLowerCase())
      )
        return true;
    }

    return false;
  };

  const hasFlag = (
    argv: unknown,
    name: string,
    expected?: string,
  ): string | boolean | undefined => {
    if (!Array.isArray(argv)) return undefined;

    for (let index = 0; index < argv.length; index += 1) {
      const argument = argv[index];

      if (typeof argument !== "string") continue;

      if (argument.startsWith(`--${name}=`)) {
        const value = argument.slice(`--${name}=`.length);
        return expected === undefined ? value : value === expected;
      }

      if (argument === `--${name}`) {
        const value = argv[index + 1];
        return expected === undefined
          ? typeof value === "string"
            ? value
            : undefined
          : value === expected;
      }
    }

    return expected === undefined ? undefined : false;
  };

  const coverageHostPath = join(dirname(context.configuration.testHostPath), "coverage-host.cjs");
  const provisionalGuiCandidates = events.filter((event) => {
    const procArgv = event.procArgv;
    const latestImage = Array.isArray(event.executions) ? event.executions.at(-1) : undefined;
    const rawCodeExec = Array.isArray(event.execEvents)
      ? event.execEvents.some(
          (exec) =>
            isRecord(exec) &&
            exec.resolvedPath === context.code.executablePath &&
            JSON.stringify(exec.argv) === JSON.stringify(procArgv) &&
            (hasFlag(exec.argv, "type") === undefined ||
              hasFlag(exec.argv, "type") === "browser") &&
            hasFlag(exec.argv, "user-data-dir", scopeUserDataPath) === true &&
            hasFlag(exec.argv, "extensions-dir", scopeExtensionsPath) === true &&
            hasFlag(
              exec.argv,
              "extensionDevelopmentPath",
              resolve(dirname(context.configuration.testHostPath), ".."),
            ) === true &&
            hasFlag(exec.argv, "extensionTestsPath", coverageHostPath) === true,
        )
      : false;
    return (
      event.executablePath === context.code.executablePath &&
      event.ownerRole === undefined &&
      Array.isArray(procArgv) &&
      isRecord(latestImage) &&
      latestImage.executablePath === context.code.executablePath &&
      JSON.stringify(latestImage.argv) === JSON.stringify(procArgv) &&
      rawCodeExec &&
      !hasSuffix(procArgv, "/resources/app/out/cli.js") &&
      (hasFlag(procArgv, "type") === undefined || hasFlag(procArgv, "type") === "browser") &&
      hasFlag(procArgv, "user-data-dir", scopeUserDataPath) === true &&
      hasFlag(procArgv, "extensions-dir", scopeExtensionsPath) === true &&
      hasFlag(
        procArgv,
        "extensionDevelopmentPath",
        resolve(dirname(context.configuration.testHostPath), ".."),
      ) === true &&
      hasFlag(procArgv, "extensionTestsPath", coverageHostPath) === true &&
      isRecord(event.outcome)
    );
  });

  if (provisionalGuiCandidates.length !== 1) {
    throw new Error("Linux failed run has no unique prepared Code GUI anchor for raw closure");
  }

  const provisionalGuiPid = Number(provisionalGuiCandidates[0]!.pid);
  const topology = validateLinuxTraceClosure(
    files,
    events,
    provisionalGuiPid,
    context.code.executablePath,
  );
  const latestExecByPid = validateLinuxExecLineage(topology, events, context.code.executablePath);
  const wrapper = failure.codeCliWrapper;
  const cli = failure.codeCli;

  const validateFailedTraceIdentity = (
    identity: unknown,
    label: string,
    executablePath: string,
  ): Record<string, unknown> => {
    if (!isRecord(identity)) throw new Error(`${label} trace identity is absent`);

    requireExactKeys(
      identity,
      label === "Linux Code launcher wrapper"
        ? ["pid", "argv", "traceExec", "traceExit", "outcome"]
        : ["pid", "executablePath", "argv", "traceExec", "traceExit", "outcome"],
      label,
    );

    if (
      !Number.isSafeInteger(identity.pid) ||
      !Array.isArray(identity.argv) ||
      identity.argv.length === 0 ||
      !identity.argv.every((argument) => typeof argument === "string") ||
      !isRecord(identity.outcome)
    ) {
      throw new Error(`${label} has malformed raw PID, argv, or terminal outcome`);
    }

    requireExactKeys(
      identity.outcome,
      identity.outcome.kind === "exit" ? ["kind", "status"] : ["kind", "signal"],
      `${label} outcome`,
    );

    const terminal = validateLinuxTraceBundle(
      identity.traceExit,
      files,
      Number(identity.pid),
      `${label} terminal`,
    );
    const exec = validateLinuxTraceBundle(
      identity.traceExec,
      files,
      Number(identity.pid),
      `${label} execve`,
    );
    const parsedExec = parseLinuxExecve(exec);
    let resolvedExecPath: string;

    try {
      if (!isAbsolute(parsedExec.path)) throw new Error("exec path is relative");

      resolvedExecPath = realpathSync(parsedExec.path);
    } catch {
      throw new Error(`${label} raw exec path cannot be resolved to its executable`);
    }

    if (
      resolvedExecPath !== realpathSync(executablePath) ||
      JSON.stringify(parsedExec.argv) !== JSON.stringify(identity.argv) ||
      !isSuccessfulLinuxExec(exec)
    ) {
      throw new Error(`${label} exact raw exec path or argv differs from its process identity`);
    }

    if (identity.outcome.kind === "exit") {
      if (
        !Number.isSafeInteger(identity.outcome.status) ||
        !new RegExp(`\\+\\+\\+ exited with ${identity.outcome.status} \\+\\+\\+`).test(terminal)
      )
        throw new Error(`${label} raw exit status is inconsistent`);
    } else if (identity.outcome.kind === "signal") {
      if (
        typeof identity.outcome.signal !== "string" ||
        !/^SIG[A-Z0-9]+$/u.test(identity.outcome.signal) ||
        !new RegExp(`\\+\\+\\+ killed by ${identity.outcome.signal}(?: \\(.*\\))? \\+\\+\\+`).test(
          terminal,
        )
      )
        throw new Error(`${label} raw terminating signal is inconsistent`);
    } else {
      throw new Error(`${label} does not distinguish exit status from signal`);
    }

    return identity;
  };

  const wrapperIdentity = validateFailedTraceIdentity(
    wrapper,
    "Linux Code launcher wrapper",
    context.code.path,
  );
  const cliIdentity = validateFailedTraceIdentity(
    cli,
    "Linux Electron CLI",
    context.code.executablePath,
  );

  validateLinuxTraceInvocation(
    failure.trace,
    context.configuration.outputDirectory,
    context.code.path,
    wrapperIdentity.argv,
  );

  if (
    wrapperIdentity.pid !== topology.rootPid ||
    wrapperIdentity.pid === cliIdentity.pid ||
    !Array.isArray(cliIdentity.argv) ||
    !cliIdentity.argv.some(
      (argument) =>
        typeof argument === "string" &&
        argument.replaceAll("\\", "/").endsWith("/resources/app/out/cli.js"),
    )
  ) {
    throw new Error(
      "Linux failed run does not distinguish the traced shell wrapper and Electron CLI",
    );
  }

  const processParentByPid = topology.processParentByPid;

  const requireTraceAncestor = (childPid: number, ancestorPid: number): void => {
    const seen = new Set<number>();
    let current = childPid;

    while (current !== ancestorPid) {
      if (seen.has(current)) throw new Error("Linux failed-run ancestry contains a cycle");

      seen.add(current);

      const parent = processParentByPid.get(current);

      if (parent === undefined)
        throw new Error("Linux failed-run raw process graph omits an ancestry edge");

      current = parent;
    }
  };

  requireTraceAncestor(Number(cliIdentity.pid), Number(wrapperIdentity.pid));

  const targetMatches = events.filter(
    (event) => event.pid === control.pid && event.ownerRole === role,
  );
  const target = targetMatches[0];

  if (
    targetMatches.length !== 1 ||
    !target ||
    target.parentPid !== control.parentPid ||
    target.executablePath !== control.executablePath ||
    target.procStarttimeTicks !== control.procStarttimeTicks ||
    target.pidfdAttachedAt !== control.pidfdAttachedAt ||
    target.pidfdReadyAt !== control.pidfdReadyAt ||
    JSON.stringify(target.procArgv) !== JSON.stringify(control.procArgv) ||
    JSON.stringify(target.ownerArgv) !== JSON.stringify(control.ownerArgv) ||
    JSON.stringify(target.outcome) !== JSON.stringify(control.outcome) ||
    JSON.stringify(target.traceExit) !== JSON.stringify(control.traceExit) ||
    !/\+\+\+ killed by SIGKILL(?: \(.*\))? \+\+\+/u.test(
      validateLinuxTraceBundle(
        control.traceExit,
        files,
        Number(control.pid),
        "Linux postassertion SIGKILL",
      ),
    ) ||
    (role === "extension-host" &&
      topology.processParentByPid.get(Number(server.pid)) !== Number(host.pid))
  ) {
    throw new Error(
      "Linux kill control is not bound to the exact /proc generation and independent SIGKILL trace",
    );
  }

  const guiCandidates = events.filter((event) => {
    const procArgv = event.procArgv;
    const latest = latestExecByPid.get(Number(event.pid));
    const argv = latest?.argv;
    return (
      event.executablePath === context.code.executablePath &&
      Array.isArray(procArgv) &&
      latest?.resolvedPath === context.code.executablePath &&
      Array.isArray(argv) &&
      hasLinuxCurrentProcImageAfterExec(event, latest) &&
      !hasSuffix(argv, "/resources/app/out/cli.js") &&
      (hasFlag(argv, "type") === undefined || hasFlag(argv, "type") === "browser") &&
      hasFlag(argv, "user-data-dir", scopeUserDataPath) === true &&
      hasFlag(argv, "extensions-dir", scopeExtensionsPath) === true &&
      hasFlag(
        argv,
        "extensionDevelopmentPath",
        resolve(dirname(context.configuration.testHostPath), ".."),
      ) === true &&
      hasFlag(argv, "extensionTestsPath", coverageHostPath) === true &&
      isRecord(event.outcome)
    );
  });

  if (guiCandidates.length !== 1)
    throw new Error(
      "Linux failed run has no unique actual Code GUI generation for the isolated fixture",
    );

  const gui = guiCandidates[0]!;

  if (Number(gui.pid) !== provisionalGuiPid)
    throw new Error("Linux failed-run GUI differs from the raw closure anchor");

  requireTraceAncestor(Number(gui.pid), Number(cliIdentity.pid));

  const hostEvents = events.filter(
    (event) => event.pid === host.pid && event.ownerRole === "extension-host",
  );
  const serverEvents = events.filter(
    (event) => event.pid === server.pid && event.ownerRole === "language-server",
  );
  const hostLatestExec = latestExecByPid.get(Number(host.pid));
  const serverLatestExec = latestExecByPid.get(Number(server.pid));

  if (
    hostEvents.length !== 1 ||
    serverEvents.length !== 1 ||
    hostEvents[0]!.parentPid !== host.ppid ||
    serverEvents[0]!.parentPid !== host.pid ||
    hostEvents[0]!.executablePath !== realpathSync(hostExecPath) ||
    serverEvents[0]!.executablePath !== realpathSync(serverExecPath) ||
    JSON.stringify(hostEvents[0]!.ownerArgv) !== JSON.stringify(host.argv) ||
    JSON.stringify(serverEvents[0]!.ownerArgv) !== JSON.stringify(server.argv) ||
    !hostLatestExec ||
    hostLatestExec.resolvedPath !== hostEvents[0]!.executablePath ||
    !Array.isArray(hostLatestExec.argv) ||
    !isLinuxNodeServiceArgv(hostLatestExec.argv) ||
    !hasLinuxCurrentProcImageAfterExec(hostEvents[0]!, hostLatestExec) ||
    !serverLatestExec ||
    serverLatestExec.resolvedPath !== serverEvents[0]!.executablePath ||
    !Array.isArray(serverLatestExec.argv) ||
    !hasSuffix(serverLatestExec.argv, "packages/language-server/dist/cli.js") ||
    !hasLinuxCurrentProcImageAfterExec(serverEvents[0]!, serverLatestExec) ||
    !Array.isArray(hostEvents[0]!.execEvents) ||
    !hostEvents[0]!.execEvents.some(
      (item) =>
        isRecord(item) &&
        item.resolvedPath === realpathSync(hostExecPath) &&
        isSuccessfulLinuxExec(
          validateLinuxTraceBundle(item.trace, files, Number(item.tid), "Linux failed Host exec"),
        ),
    ) ||
    !Array.isArray(serverEvents[0]!.execEvents) ||
    !serverEvents[0]!.execEvents.some(
      (item) =>
        isRecord(item) &&
        item.resolvedPath === realpathSync(serverExecPath) &&
        isSuccessfulLinuxExec(
          validateLinuxTraceBundle(
            item.trace,
            files,
            Number(item.tid),
            "Linux failed language-server exec",
          ),
        ),
    ) ||
    !hasLinuxBootstrapRuntimeAnchor(hostEvents[0]!.ownerArgv) ||
    !hasLinuxNodeServiceProcHistory(hostEvents[0]!, hostLatestExec) ||
    !hasSuffix(serverEvents[0]!.procArgv, "packages/language-server/dist/cli.js")
  ) {
    throw new Error(
      "Linux failed run does not bind actual Host and LS role anchors to their native generations",
    );
  }

  requireTraceAncestor(Number(host.pid), Number(gui.pid));

  requireTraceAncestor(Number(server.pid), Number(host.pid));

  const displayServer = failure.displayServer;

  if (!isRecord(displayServer))
    throw new Error("Linux failed run omits generation-safe Xvfb cleanup evidence");

  requireExactKeys(
    displayServer,
    [
      "pid",
      "parentPid",
      "procStarttimeTicks",
      "pidfdAttachedAt",
      "pidfdReadyAt",
      "executablePath",
      "procArgv",
      "outcome",
    ],
    "Linux failed Xvfb generation",
  );

  if (
    !Number.isSafeInteger(displayServer.pid) ||
    !Number.isSafeInteger(displayServer.procStarttimeTicks) ||
    !isTimestamp(displayServer.pidfdAttachedAt) ||
    !isTimestamp(displayServer.pidfdReadyAt) ||
    !isRecord(displayServer.outcome) ||
    displayServer.outcome.kind !== "signal" ||
    displayServer.outcome.signal !== "SIGKILL"
  ) {
    throw new Error("Linux failed run did not clean the retained Xvfb generation by pidfd");
  }
}

function verifyNativeKillRejection(
  mode: "kill-extension-host" | "kill-language-server",
  context: CapturedRunContext,
  outputDirectory: string,
): void {
  if (process.platform === "linux") {
    verifyLinuxNativeKillRejection(mode, context, outputDirectory);

    return;
  }

  validateCapturedConfiguration(context, outputDirectory);

  const control = readJson(join(outputDirectory, "owner-kill-control.json"));
  const failure = readJson(join(outputDirectory, "native-process-failure.json"));
  const ready = readJson(join(outputDirectory, "owner-kill-ready.json"));
  const report = readJson(join(outputDirectory, "editor-result.json"));

  if (!isRecord(control) || !isRecord(failure) || !isRecord(ready) || !isRecord(report)) {
    throw new Error("Private native kill control is missing actual termination/failure evidence");
  }

  requireExactKeys(
    control,
    [
      "format",
      "version",
      "runId",
      "populationFingerprint",
      "mode",
      "role",
      "pid",
      "parentPid",
      "executablePath",
      "commandLine",
      "creationTime",
      "attachedAt",
      "assertionsCompletedAt",
      "terminatedAt",
      "processExitTime",
      "exitObservedAt",
      "exitCode",
      "ancestry",
    ],
    "Private native kill control",
  );

  requireExactKeys(
    ready,
    [
      "format",
      "version",
      "runId",
      "populationFingerprint",
      "mode",
      "extensionHostPid",
      "assertionsCompletedAt",
    ],
    "Private native kill barrier",
  );

  requireExactKeys(
    failure,
    [
      "format",
      "version",
      "runId",
      "observerStartedAt",
      "codeLaunchPid",
      "observedAt",
      "failure",
      "observerErrors",
      "forcedPids",
      "cleanupFailures",
      "events",
      "observerDiagnostics",
    ],
    "Private native kill failure",
  );

  const role = mode === "kill-extension-host" ? "extension-host" : "language-server";
  const start = readJson(join(outputDirectory, `${role}-start.json`));
  const host = readJson(join(outputDirectory, "extension-host-start.json"));
  const server = readJson(join(outputDirectory, "language-server-start.json"));

  if (isRecord(host)) requireExactKeys(host, ownerStartReceiptKeys, "extension-host start receipt");

  if (isRecord(server))
    requireExactKeys(server, ownerStartReceiptKeys, "language-server start receipt");

  const diagnostics = failure.observerDiagnostics;

  if (
    !isRecord(start) ||
    !isRecord(host) ||
    !isRecord(server) ||
    !isRecord(diagnostics) ||
    control.format !== "hesperia-editor-native-owner-kill-control" ||
    control.version !== 1 ||
    control.runId !== context.runId ||
    control.populationFingerprint !== context.population.fingerprint ||
    control.mode !== mode ||
    control.role !== role ||
    !Number.isSafeInteger(control.pid) ||
    Number(control.pid) <= 0 ||
    !Number.isSafeInteger(control.parentPid) ||
    Number(control.parentPid) <= 0 ||
    !Number.isSafeInteger(control.exitCode) ||
    control.exitCode === 0 ||
    ready.format !== "hesperia-editor-owner-kill-ready" ||
    ready.version !== 1 ||
    ready.runId !== context.runId ||
    ready.populationFingerprint !== context.population.fingerprint ||
    ready.mode !== mode ||
    ready.extensionHostPid !== host.pid ||
    ready.assertionsCompletedAt !== control.assertionsCompletedAt ||
    start.format !== "hesperia-editor-owner-start" ||
    start.version !== 1 ||
    start.role !== role ||
    start.ownerId !== `vscode-${role}-${context.runId}` ||
    start.runId !== context.runId ||
    start.populationFingerprint !== context.population.fingerprint ||
    start.pid !== control.pid ||
    start.ppid !== control.parentPid ||
    start.execPath !== control.executablePath ||
    host.runId !== context.runId ||
    server.runId !== context.runId ||
    host.populationFingerprint !== context.population.fingerprint ||
    server.populationFingerprint !== context.population.fingerprint ||
    server.ppid !== host.pid ||
    report.passed !== true ||
    !Array.isArray(report.checks) ||
    report.checks.length !== expectedChecks ||
    failure.format !== "hesperia-editor-native-process-failure" ||
    failure.version !== 1 ||
    failure.runId !== context.runId ||
    timestamp(failure.observerStartedAt) === undefined ||
    timestamp(failure.observedAt) === undefined ||
    !Number.isSafeInteger(failure.codeLaunchPid) ||
    Number(failure.codeLaunchPid) <= 0 ||
    typeof failure.failure !== "string" ||
    !failure.failure.startsWith(`Private native owner kill control terminated ${role} PID `) ||
    !Array.isArray(failure.events) ||
    !Array.isArray(failure.observerErrors) ||
    failure.observerErrors.length !== 0 ||
    !Array.isArray(failure.cleanupFailures) ||
    failure.cleanupFailures.length !== 0 ||
    !Array.isArray(failure.forcedPids) ||
    !failure.forcedPids.every((pid) => Number.isSafeInteger(pid) && pid > 0) ||
    !Array.isArray(diagnostics.ownerAdmissionFailures) ||
    diagnostics.ownerAdmissionFailures.length !== 0 ||
    diagnostics.testBudgetSeconds !== 120 ||
    !Array.isArray(control.ancestry) ||
    control.ancestry.length < 2 ||
    existsSync(join(outputDirectory, `${role}-exit.json`)) ||
    existsSync(join(outputDirectory, `${role}-coverage.json`)) ||
    existsSync(join(outputDirectory, "lcov.info"))
  ) {
    throw new Error(
      "Private native kill control did not prove actual nonzero termination and rejected capture",
    );
  }

  requireExactKeys(
    diagnostics,
    [
      "receiveCalls",
      "ownerReceiptParseFailures",
      "treeSweepsDeferredUntilOwners",
      "treeSweepsDeferredUntilLauncherExit",
      "treeSweepPerformedAfterLauncherExit",
      "testBudgetSeconds",
      "treeSweepIntervalMilliseconds",
      "nativeLanguageServerAckWritten",
      "nativeLanguageServerAckErrors",
      "fixtureProcessScope",
      "ownerAdmissions",
      "ownerAdmissionFailures",
      "treeSweeps",
    ],
    "Private native kill observer diagnostics",
  );

  const times = [
    "creationTime",
    "attachedAt",
    "assertionsCompletedAt",
    "terminatedAt",
    "processExitTime",
    "exitObservedAt",
  ].map((key) => timestamp(control[key]));

  if (
    times.some((time) => time === undefined) ||
    times.some((time, index) => index > 0 && time! < times[index - 1]!)
  ) {
    throw new Error("Private native kill control has invalid kernel/verification timing");
  }

  const events = failure.events;
  const seenPids = new Set<number>();

  for (const event of events) {
    if (!isRecord(event))
      throw new Error("Private native kill cleanup has a malformed process record");

    requireExactKeys(
      event,
      [
        "pid",
        "parentPid",
        "processName",
        "executablePath",
        "commandLine",
        "creationTime",
        "attached",
        "attachedAt",
        "exitObserved",
        "exitObservedAt",
        "processExitTime",
        "exitCode",
        "stillLive",
      ],
      "Private native kill process record",
    );

    if (
      !Number.isSafeInteger(event.pid) ||
      Number(event.pid) <= 0 ||
      seenPids.has(Number(event.pid)) ||
      !Number.isSafeInteger(event.parentPid) ||
      Number(event.parentPid) <= 0 ||
      typeof event.executablePath !== "string" ||
      !event.executablePath ||
      typeof event.commandLine !== "string" ||
      !event.commandLine ||
      event.stillLive !== false ||
      event.attached !== true ||
      event.exitObserved !== true ||
      timestamp(event.creationTime) === undefined ||
      timestamp(event.attachedAt) === undefined ||
      timestamp(event.processExitTime) === undefined ||
      timestamp(event.exitObservedAt) === undefined ||
      timestamp(event.creationTime)! > timestamp(event.attachedAt)! ||
      timestamp(event.attachedAt)! > timestamp(event.processExitTime)! ||
      timestamp(event.processExitTime)! > timestamp(event.exitObservedAt)! ||
      !Number.isSafeInteger(event.exitCode)
    ) {
      throw new Error("Private native kill cleanup left a live or unobserved admitted generation");
    }

    if (
      timestamp(event.creationTime)! < timestamp(failure.observerStartedAt)! ||
      timestamp(event.exitObservedAt)! > timestamp(failure.observedAt)!
    ) {
      throw new Error(
        "Private native kill process timing falls outside the actual observer lifetime",
      );
    }

    seenPids.add(Number(event.pid));
  }

  const target = events.filter((event) => isRecord(event) && event.pid === control.pid);

  if (
    target.length !== 1 ||
    !isRecord(target[0]) ||
    [
      "parentPid",
      "executablePath",
      "commandLine",
      "creationTime",
      "attachedAt",
      "processExitTime",
      "exitObservedAt",
      "exitCode",
    ].some((key) => target[0]![key] !== control[key])
  ) {
    throw new Error(
      "Private native kill record disagrees with the final retained target generation",
    );
  }

  let previous: Record<string, unknown> | undefined;

  for (const ancestor of control.ancestry) {
    if (!isRecord(ancestor)) throw new Error("Private native kill ancestry is malformed");

    requireExactKeys(
      ancestor,
      ["pid", "parentPid", "executablePath", "commandLine", "creationTime", "verifiedAliveAt"],
      "Private native kill ancestor",
    );

    const matching = events.filter((event) => isRecord(event) && event.pid === ancestor.pid);

    if (
      matching.length !== 1 ||
      !isRecord(matching[0]) ||
      ["parentPid", "executablePath", "commandLine", "creationTime"].some(
        (key) => matching[0]![key] !== ancestor[key],
      ) ||
      timestamp(ancestor.verifiedAliveAt) === undefined ||
      timestamp(ancestor.verifiedAliveAt)! > timestamp(control.terminatedAt)! ||
      timestamp(ancestor.verifiedAliveAt)! >= timestamp(matching[0].processExitTime)! ||
      (previous ? previous.parentPid !== ancestor.pid : ancestor.pid !== control.pid)
    ) {
      throw new Error(
        "Private native kill ancestry was not independently retained alive before termination",
      );
    }

    previous = ancestor;
  }

  const launcher = previous;
  const fixture = diagnostics.fixtureProcessScope;
  const hostRecord = events.find((event) => isRecord(event) && event.pid === host.pid);
  const serverRecord = events.find((event) => isRecord(event) && event.pid === server.pid);

  if (
    !isRecord(hostRecord) ||
    !isRecord(serverRecord) ||
    hostRecord.parentPid !== host.ppid ||
    serverRecord.parentPid !== host.pid ||
    hostRecord.executablePath !== host.execPath ||
    serverRecord.executablePath !== server.execPath ||
    typeof hostRecord.commandLine !== "string" ||
    !/--type=utility/iu.test(hostRecord.commandLine) ||
    !/--utility-sub-type=node\.mojom\.NodeService/iu.test(hostRecord.commandLine) ||
    typeof serverRecord.commandLine !== "string" ||
    !serverRecord.commandLine
      .replaceAll("/", "\\")
      .toLowerCase()
      .includes(resolve(repoPath, "packages/language-server/dist/cli.js").toLowerCase())
  ) {
    throw new Error("Private native kill evidence lost the actual Host/LS native owner chain");
  }

  if (
    !launcher ||
    launcher.pid !== failure.codeLaunchPid ||
    typeof launcher.executablePath !== "string" ||
    resolve(launcher.executablePath).toLowerCase() !== resolve(context.code.path).toLowerCase() ||
    typeof launcher.commandLine !== "string" ||
    !isRecord(fixture)
  ) {
    throw new Error(
      "Private native kill ancestry does not end at the selected isolated GUI launcher",
    );
  }

  requireExactKeys(
    fixture,
    ["checkedAt", "userDataPath", "extensionsPath", "activeProcessIds"],
    "Private kill fixture scope",
  );

  if (
    timestamp(fixture.checkedAt) === undefined ||
    timestamp(fixture.checkedAt)! < timestamp(control.processExitTime)! ||
    timestamp(fixture.checkedAt)! > timestamp(failure.observedAt)! ||
    typeof fixture.userDataPath !== "string" ||
    typeof fixture.extensionsPath !== "string" ||
    commandLineArgument(launcher.commandLine, "user-data-dir") !== fixture.userDataPath ||
    commandLineArgument(launcher.commandLine, "extensions-dir") !== fixture.extensionsPath ||
    commandLineArgument(launcher.commandLine, "extensionTestsPath") !==
      join(resolve(context.extensionEntryPath, ".."), "coverage-host.cjs") ||
    !Array.isArray(fixture.activeProcessIds) ||
    fixture.activeProcessIds.length !== 0
  ) {
    throw new Error(
      "Private native kill control did not independently verify an empty current fixture scope",
    );
  }

  console.log(
    JSON.stringify({
      status: "native-kill-control-rejected-cleanly",
      runId: context.runId,
      mode,
      pid: control.pid,
      exitCode: control.exitCode,
      checks: report.checks.length,
      lcovAbsent: true,
    }),
  );
}

function runNativeEditorTest(options: {
  readonly code: CapturedRunContext["code"];
  readonly environment: Record<string, string | undefined>;
  readonly extensionRoot: string;
  readonly coverageHostPath: string;
  readonly outputDirectory: string;
}) {
  const { code, environment, extensionRoot, coverageHostPath, outputDirectory } = options;
  return process.platform === "linux"
    ? spawnSync(
        "python3",
        [
          resolve(repoPath, "editors/vscode/test-linux.py"),
          "--code-launcher",
          code.path,
          "--code-executable",
          code.executablePath,
          "--extension-path",
          extensionRoot,
          "--coverage-host-path",
          coverageHostPath,
          "--trace-directory",
          outputDirectory,
        ],
        {
          cwd: repoPath,
          env: environment,
          encoding: "utf8",
          maxBuffer: 8 * 1024 * 1024,
        },
      )
    : spawnSync(
        "powershell",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          resolve(repoPath, "editors/vscode/test.ps1"),
          "-CodePath",
          code.path,
          "-ExtensionPath",
          extensionRoot,
          "-TestHostPath",
          coverageHostPath,
        ],
        {
          cwd: repoPath,
          env: environment,
          encoding: "utf8",
          maxBuffer: 8 * 1024 * 1024,
        },
      );
}

async function main(): Promise<void> {
  let runId: string | undefined;
  let outputDirectory: string | undefined;

  try {
    const [codePathInput, versionOrVerification, thirdArgument] = Bun.argv.slice(2);
    const verificationWithoutVersion = versionOrVerification?.startsWith("--verify=") ?? false;
    const expectedVersion = verificationWithoutVersion ? undefined : versionOrVerification;
    const verificationInput = verificationWithoutVersion ? versionOrVerification : thirdArgument;

    if (
      Bun.argv.length > 5 ||
      (verificationWithoutVersion && thirdArgument !== undefined) ||
      (verificationInput !== undefined &&
        ![
          "--verify=artifacts",
          "--verify=artifacts-and-native",
          "--verify=kill-extension-host",
          "--verify=kill-language-server",
        ].includes(verificationInput))
    ) {
      throw new Error(
        "Usage: bun run scripts/ci/run-editor-coverage.ts [Code.exe] [expected-version-prefix]",
      );
    }

    const verification = verificationInput?.slice("--verify=".length) as
      | PrivateVerification
      | undefined;
    const artifactVerification =
      verification === "artifacts" || verification === "artifacts-and-native";
    const code = verifyCodeExecutable(codePathInput, expectedVersion);
    runId = randomUUID();
    outputDirectory = join(outputRoot, runId);
    const buildDirectory = join(buildRoot, runId);

    mkdirSync(outputDirectory, { recursive: true });

    mkdirSync(buildDirectory, { recursive: true });

    if (readdirSync(outputDirectory).length !== 0)
      throw new Error("New editor run directory is not empty");

    const sourcePaths = inventoryCoverageSources(repoPath);
    const graph = await buildCoverageWorkerGraph({
      repoPath,
      directory: join(buildDirectory, "language-server-graph"),
      sources: sourcePaths,
      packages: ownerPackages,
    });
    const preparedExtension = await prepareCoverageSource(extensionSource, repoPath);
    const population = graph.sourcePopulation;
    const hostCoverageOwnerId = "host";
    const serverCoverageOwnerId = "ls";
    const driverSupportProfile = coverageOwnerProfile("driver");
    const hostSupportProfile = coverageOwnerProfile("extension-host");
    const serverSupportProfile = coverageOwnerProfile("language-server");
    let supportConfigPath: string | undefined;

    if (driverSupportProfile) {
      if (!hostSupportProfile || !serverSupportProfile) {
        throw new Error("Editor support launch is missing a prepared native owner profile");
      }

      supportConfigPath = writeEditorCoverageSupportConfig({
        runId,
        populationFingerprint: population.fingerprint,
        repoPath,
        outputDirectory,
        driverSources: coverageOwnerSources("driver"),
        extensionHostSources: coverageOwnerSources("extension-host"),
        languageServerSources: coverageOwnerSources("language-server"),
      });

      bindCoverageOwnerRun({ runId, outputDirectory, population });
    }

    if (verification === "artifacts-and-native" && !supportConfigPath) {
      throw new Error("Combined editor controls require the measured driver owner profile");
    }

    const canonicalSeed = createCoverageArtifact({
      repoPath,
      kind: "seed",
      runId,
      ownerId: "vscode-editor-canonical",
      populationFingerprint: population.fingerprint,
      population,
      coverage: graph.canonicalSeedCoverage,
    });

    writeFragment(outputDirectory, canonicalSeed, population);

    const hostSeed: Record<string, CoverageFile> = {
      [preparedExtension.path]: preparedExtension.seed,
    };
    const hostSeedArtifact = createCoverageArtifact({
      repoPath,
      kind: "seed",
      runId,
      ownerId: hostCoverageOwnerId,
      populationFingerprint: population.fingerprint,
      sourcePopulation: population,
      coverage: hostSeed,
    });

    writeFragment(outputDirectory, hostSeedArtifact, population);

    const serverSeedArtifact = createCoverageArtifact({
      repoPath,
      kind: "seed",
      runId,
      ownerId: serverCoverageOwnerId,
      populationFingerprint: population.fingerprint,
      sourcePopulation: population,
      coverage: graph.seedCoverage,
    });

    writeFragment(outputDirectory, serverSeedArtifact, population);

    const extensionRoot = join(buildDirectory, "vscode-extension");
    const distDirectory = join(extensionRoot, "dist");
    const sourceDirectory = join(buildDirectory, "extension-source");

    mkdirSync(distDirectory, { recursive: true });

    mkdirSync(sourceDirectory, { recursive: true });

    const dependencySource = resolve(repoPath, "editors/vscode/node_modules");
    const languageClientPackage = join(dependencySource, "vscode-languageclient");

    if (!existsSync(languageClientPackage)) {
      throw new Error(
        "VS Code extension vscode-languageclient dependency is required to resolve its authored bundle",
      );
    }

    const dependencyLink = join(sourceDirectory, "node_modules");

    mkdirSync(dependencyLink, { recursive: true });

    for (const entry of readdirSync(dependencySource, { withFileTypes: true })) {
      if (entry.name === ".bin") continue;

      const sourceEntry = join(dependencySource, entry.name);
      const destinationEntry = join(dependencyLink, entry.name);

      if (entry.isDirectory()) {
        mkdirSync(destinationEntry, { recursive: true });

        for (const scopedEntry of readdirSync(sourceEntry, { withFileTypes: true })) {
          symlinkSync(
            realpathSync(join(sourceEntry, scopedEntry.name)),
            join(destinationEntry, scopedEntry.name),
            process.platform === "win32" ? "junction" : "dir",
          );
        }
      } else {
        symlinkSync(
          realpathSync(sourceEntry),
          destinationEntry,
          process.platform === "win32" ? "junction" : "dir",
        );
      }
    }

    copyFileSync(
      join(repoPath, "editors", "vscode", "package.json"),
      join(extensionRoot, "package.json"),
    );

    copyFileSync(
      join(repoPath, "editors", "vscode", "language-configuration.json"),
      join(extensionRoot, "language-configuration.json"),
    );

    mkdirSync(join(extensionRoot, "syntaxes"), { recursive: true });

    copyFileSync(
      join(repoPath, "editors", "vscode", "syntaxes", "hesperia.tmLanguage.json"),
      join(extensionRoot, "syntaxes", "hesperia.tmLanguage.json"),
    );

    const instrumentedExtensionPath = join(sourceDirectory, "extension.ts");

    writeFileSync(instrumentedExtensionPath, preparedExtension.instrumentedCode);

    build(
      [
        "build",
        instrumentedExtensionPath,
        "--target=node",
        "--format=cjs",
        "--external=vscode",
        `--outfile=${join(distDirectory, "extension.cjs")}`,
      ],
      repoPath,
    );

    build(
      [
        "build",
        "editors/vscode/tests/host.ts",
        "--target=node",
        "--format=cjs",
        "--external=vscode",
        `--outfile=${join(distDirectory, "test-host.cjs")}`,
      ],
      repoPath,
    );

    const config: EditorCoverageConfig = {
      format: "hesperia-editor-coverage-config",
      version: 1,
      runId,
      repoPath,
      outputDirectory,
      populationFingerprint: population.fingerprint,
      testHostPath: join(distDirectory, "test-host.cjs"),
      languageServerSourcePaths: graph.sourcePaths.map((sourcePath) =>
        resolve(repoPath, sourcePath),
      ),
      outputs: graph.outputs,
      ...(supportConfigPath ? { supportConfigPath } : {}),
      ...(verification?.startsWith("kill-")
        ? { verificationControl: verification as "kill-extension-host" | "kill-language-server" }
        : {}),
    };
    const configPath = join(outputDirectory, "editor-coverage-config.json");

    writeFileSync(configPath, JSON.stringify(config), { flag: "wx" });

    const preloadPath = resolve(repoPath, "scripts/ci/coverage-editor-preload.ts");
    const coverageHostPath = join(distDirectory, "coverage-host.cjs");

    if (hostSupportProfile) {
      await buildEditorHostSupportBundle({
        entrypoint: resolve(repoPath, "editors/vscode/tests/coverage-host.ts"),
        outfile: coverageHostPath,
      });
    } else {
      build(
        [
          "build",
          "editors/vscode/tests/coverage-host.ts",
          "--target=node",
          "--format=cjs",
          "--external=vscode",
          `--outfile=${coverageHostPath}`,
        ],
        repoPath,
      );
    }

    const serverSupportPreloadPath = serverSupportProfile
      ? writeCoverageOwnerSupportPreload("language-server", buildDirectory, preloadPath)
      : preloadPath;

    const environment = { ...process.env };

    for (const key of Object.keys(environment)) {
      if (
        key.startsWith("HESPERIA_COVERAGE_") ||
        key.startsWith("HESPERIA_BROWSER_COVERAGE_") ||
        key.startsWith("HESPERIA_EDITOR_COVERAGE_")
      ) {
        delete environment[key];
      }
    }

    delete environment.NODE_OPTIONS;
    delete environment.BUN_OPTIONS;
    environment.HESPERIA_EDITOR_COVERAGE_CONFIG = configPath;
    environment.HESPERIA_EDITOR_COVERAGE_OUTPUT_DIR = outputDirectory;
    environment.HESPERIA_EDITOR_COVERAGE_ROLE = "language-server";
    environment.BUN_OPTIONS = `--preload=${serverSupportPreloadPath}`;
    const test = runNativeEditorTest({
      code,
      environment,
      extensionRoot,
      coverageHostPath,
      outputDirectory,
    });

    if (test.error) throw test.error;

    if (test.stdout) process.stdout.write(test.stdout);

    if (test.stderr) process.stderr.write(test.stderr);

    if (test.status !== 0) {
      try {
        snapshotCoverageOwnerHits();
      } catch {}

      if (verification === "kill-extension-host" || verification === "kill-language-server") {
        verifyNativeKillRejection(
          verification,
          {
            runId,
            population,
            code,
            extensionEntryPath: join(distDirectory, "extension.cjs"),
            configuration: config,
          },
          outputDirectory,
        );
      }

      throw new Error(
        `VS Code ${code.version} editor checks or native observation failed (exit ${test.status})`,
      );
    }

    if (verification === "kill-extension-host" || verification === "kill-language-server") {
      throw new Error("Private native kill control unexpectedly accepted the editor capture");
    }

    const context: CapturedRunContext = {
      runId,
      population,
      code,
      extensionEntryPath: join(distDirectory, "extension.cjs"),
      configuration: config,
    };
    const evidence = validateCapturedOwnerEvidence(context, outputDirectory);
    const { hostHits, serverHits } = evidence;
    const hostHitArtifact = createCoverageArtifact({
      repoPath,
      kind: "hits",
      runId,
      ownerId: hostCoverageOwnerId,
      populationFingerprint: population.fingerprint,
      sourcePopulation: population,
      coverage: hostHits,
    });
    const serverHitArtifact = createCoverageArtifact({
      repoPath,
      kind: "hits",
      runId,
      ownerId: serverCoverageOwnerId,
      populationFingerprint: population.fingerprint,
      sourcePopulation: population,
      coverage: serverHits,
    });

    writeFragment(outputDirectory, hostHitArtifact, population);

    writeFragment(outputDirectory, serverHitArtifact, population);

    if (evidence.hostSupportHits || evidence.serverSupportHits) {
      if (!evidence.hostSupportHits || !evidence.serverSupportHits) {
        throw new Error("Editor support raw coverage is missing one native owner role");
      }

      for (const [key, coverage] of [
        ["extension-host", evidence.hostSupportHits],
        ["language-server", evidence.serverSupportHits],
      ] as const) {
        const profile = coverageOwnerProfile(key);

        if (!profile) throw new Error(`Editor support capture has no ${key} profile`);

        const artifact = createCoverageArtifact({
          repoPath,
          kind: "hits",
          runId,
          ownerId: profile.ownerId,
          populationFingerprint: population.fingerprint,
          sourcePopulation: population,
          coverage,
        });

        writeCoverageFragment({
          directory: outputDirectory,
          contextId: `${profile.contextId}-hits`,
          pid: process.pid,
          threadId,
          repoPath,
          artifact,
          sourcePopulation: population,
        });
      }
    }

    let artifactControlsVerified = false;

    if (context.configuration.supportConfigPath) {
      await validateCapturedRun(context, outputDirectory, "pending");

      if (artifactVerification) {
        const driverPreview = createDriverControlPreview(context);

        await verifyArtifactRejections(context, outputDirectory, driverPreview);

        artifactControlsVerified = true;
      }
    }

    if (verification === "artifacts-and-native") {
      if (!driverSupportProfile || !hostSupportProfile || !serverSupportProfile) {
        throw new Error("Combined editor controls require all measured native owner profiles");
      }

      for (const mode of ["kill-extension-host", "kill-language-server"] as const) {
        const controlOutputDirectory = join(
          repoPath,
          ".hesperia",
          "coverage",
          "editor-controls",
          runId,
          mode,
        );

        if (existsSync(controlOutputDirectory)) {
          throw new Error(`Native control output already exists: ${controlOutputDirectory}`);
        }

        mkdirSync(controlOutputDirectory, { recursive: true });

        const controlSupportConfigPath = writeEditorCoverageSupportConfig({
          runId,
          populationFingerprint: population.fingerprint,
          repoPath,
          outputDirectory: controlOutputDirectory,
          driverSources: coverageOwnerSources("driver"),
          extensionHostSources: coverageOwnerSources("extension-host"),
          languageServerSources: coverageOwnerSources("language-server"),
        });
        const controlConfig: EditorCoverageConfig = {
          ...config,
          outputDirectory: controlOutputDirectory,
          supportConfigPath: controlSupportConfigPath,
          verificationControl: mode,
        };
        const controlConfigPath = join(controlOutputDirectory, "editor-coverage-config.json");

        writeFileSync(controlConfigPath, JSON.stringify(controlConfig), { flag: "wx" });

        const controlContext: CapturedRunContext = {
          ...context,
          configuration: controlConfig,
        };
        const controlEnvironment = {
          ...environment,
          HESPERIA_EDITOR_COVERAGE_CONFIG: controlConfigPath,
          HESPERIA_EDITOR_COVERAGE_OUTPUT_DIR: controlOutputDirectory,
        };
        const controlTest = runNativeEditorTest({
          code,
          environment: controlEnvironment,
          extensionRoot,
          coverageHostPath,
          outputDirectory: controlOutputDirectory,
        });

        if (controlTest.error) throw controlTest.error;

        if (controlTest.stdout) process.stdout.write(controlTest.stdout);

        if (controlTest.stderr) process.stderr.write(controlTest.stderr);

        if (controlTest.status === null || controlTest.status === 0) {
          throw new Error(
            `Native ${mode} control did not return its required failure; see ${controlOutputDirectory}`,
          );
        }

        verifyNativeKillRejection(mode, controlContext, controlOutputDirectory);
      }
    }

    snapshotCoverageOwnerHits();

    if (artifactVerification && !artifactControlsVerified) {
      await validateCapturedRun(context, outputDirectory);

      await verifyArtifactRejections(context, outputDirectory);
    }

    const { reportValue, host, server, native, merged, lcovPath } = await admitCapturedRun(
      context,
      outputDirectory,
    );
    const nativeSummary =
      native.platform === "linux"
        ? {
            extensionHostNativeGeneration: {
              pid: native.host.pid,
              procStarttimeTicks: native.host.procStarttimeTicks,
              outcome: native.host.outcome,
            },
            languageServerNativeGeneration: {
              pid: native.server.pid,
              procStarttimeTicks: native.server.procStarttimeTicks,
              outcome: native.server.outcome,
            },
            codeGuiNativeGeneration: {
              pid: native.gui.pid,
              procStarttimeTicks: native.gui.procStarttimeTicks,
              outcome: native.gui.outcome,
            },
          }
        : {
            hostNativeCreationTime: native.host.creationTime,
            hostExitCode: native.host.exitCode,
            languageServerNativeCreationTime: native.server.creationTime,
            languageServerExitCode: native.server.exitCode,
          };

    writeFileSync(
      join(outputDirectory, "editor-capture-summary.json"),
      JSON.stringify({
        format: "hesperia-editor-capture-summary",
        version: 1,
        runId,
        codeVersion: code.version,
        codePath: code.path,
        checks: reportValue.checks,
        hostPid: host.start.pid,
        hostParentPid: host.start.ppid,
        languageServerPid: server.start.pid,
        languageServerParentPid: server.start.ppid,
        ...nativeSummary,
        shutdownMethod: "loaded-staged-extension-deactivate",
        processGraph: "extension-host -> Bun language-server",
        sourceCount: merged.files().length,
        lcovPath,
      }),
    );

    console.log(
      JSON.stringify({
        status: "completed",
        runId,
        outputDirectory,
        lcovPath,
        checks: expectedChecks,
        version: code.version,
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        status: "failed",
        ...(runId === undefined ? {} : { runId }),
        ...(outputDirectory === undefined ? {} : { outputDirectory }),
        error: error instanceof Error ? error.message : String(error),
      }),
    );

    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
