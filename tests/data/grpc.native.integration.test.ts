import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(import.meta.dir, "../..");
const serverFixture = resolve(import.meta.dir, "fixtures/grpc-server.fixture.mjs");
const nodeVersion = "22.23.2";
const setupWorkBudgetMs = 35_000;
const nodeProbeTimeoutMs = 3_000;
const compilerTimeoutMs = 15_000;
const nativeTimeoutMs = 25_000;
const startupTimeoutMs = 12_000;
const cleanupTimeoutMs = 1_500;
const retainedOutputBytes = 128 * 1024;
const retainedLineCharacters = 32 * 1024;
const retainedRecordCount = 32;

type JsonRecord = Record<string, unknown>;

type ModuleResolutionRecord = {
  readonly hesperiaGrpc: string;
  readonly hesperiaGrpcNative: string;
  readonly connectNode: string;
  readonly protobuf: string;
  readonly aeolia: string;
};

type RecordWaiter = {
  readonly resolve: (record: JsonRecord) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
};

class OutputCapture {
  readonly done: Promise<void>;
  readonly records: JsonRecord[] = [];
  readonly readErrors: string[] = [];
  totalBytes = 0;
  totalRecords = 0;
  truncated = false;
  private storedBytes = 0;
  private readonly chunks: Uint8Array[] = [];
  private readonly waiters = new Map<string, Set<RecordWaiter>>();
  private readonly decoder = new TextDecoder();
  private partialLine = "";
  private discardingLine = false;

  constructor(private readonly stream: ReadableStream<Uint8Array>) {
    this.done = this.consume();
  }

  findRecord(event: string): JsonRecord | undefined {
    return this.records.find((record) => record.event === event);
  }

  waitForRecord(event: string, timeoutMs: number): Promise<JsonRecord> {
    const existing = this.findRecord(event);

    if (existing !== undefined) return Promise.resolve(existing);

    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(new TypeError("record timeout must be a positive finite number"));
    }

    return new Promise((resolveRecord, reject) => {
      const waiter: RecordWaiter = {
        resolve: resolveRecord,
        reject,
        timer: setTimeout(() => {
          const waiters = this.waiters.get(event);

          waiters?.delete(waiter);

          if (waiters?.size === 0) this.waiters.delete(event);

          reject(new Error(`timed out waiting for child stdout record ${event}`));
        }, timeoutMs),
      };
      const waiters = this.waiters.get(event) ?? new Set<RecordWaiter>();

      waiters.add(waiter);
      this.waiters.set(event, waiters);
    });
  }

  text(): string {
    return Buffer.concat(this.chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
  }

  private async consume(): Promise<void> {
    const reader = this.stream.getReader();

    try {
      while (true) {
        const result = await reader.read();

        if (result.done) break;

        this.retain(result.value);
        this.consumeLines(this.decoder.decode(result.value, { stream: true }));
      }

      this.consumeLines(this.decoder.decode());

      if (this.partialLine.length > 0 && !this.discardingLine) {
        this.processLine(this.partialLine);
      }

      this.rejectWaiters(new Error("child stdout ended before the requested record"));
    } catch (error) {
      this.readErrors.push(errorText(error));
      this.rejectWaiters(new Error(`could not read child stdout: ${errorText(error)}`));
    } finally {
      reader.releaseLock();
    }
  }

  private retain(chunk: Uint8Array): void {
    this.totalBytes += chunk.byteLength;

    const remaining = retainedOutputBytes - this.storedBytes;

    if (remaining > 0) {
      const retained = chunk.slice(0, remaining);

      this.chunks.push(retained);
      this.storedBytes += retained.byteLength;
    }

    if (chunk.byteLength > remaining) this.truncated = true;
  }

  private consumeLines(text: string): void {
    let remaining = text;

    while (remaining.length > 0) {
      const newline = remaining.indexOf("\n");

      if (newline < 0) {
        this.appendPartial(remaining);

        return;
      }

      const line = remaining.slice(0, newline);

      if (this.discardingLine) {
        this.discardingLine = false;
        this.partialLine = "";
      } else if (this.partialLine.length + line.length > retainedLineCharacters) {
        this.truncated = true;
        this.partialLine = "";
      } else {
        this.processLine(`${this.partialLine}${line}`.replace(/\r$/u, ""));
        this.partialLine = "";
      }

      remaining = remaining.slice(newline + 1);
    }
  }

  private appendPartial(text: string): void {
    if (this.discardingLine) return;

    if (this.partialLine.length + text.length > retainedLineCharacters) {
      this.partialLine = "";
      this.discardingLine = true;
      this.truncated = true;

      return;
    }

    this.partialLine += text;
  }

  private processLine(line: string): void {
    if (line.length === 0) return;

    if (line.length > retainedLineCharacters) {
      this.truncated = true;

      return;
    }

    let value: unknown;

    try {
      value = JSON.parse(line);
    } catch {
      return;
    }

    if (typeof value !== "object" || value === null || Array.isArray(value)) return;

    const record = value as JsonRecord;

    this.totalRecords += 1;

    if (this.records.length < retainedRecordCount) this.records.push(record);
    else this.truncated = true;

    if (typeof record.event !== "string") return;

    const waiters = this.waiters.get(record.event);

    if (waiters === undefined) return;

    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(record);
    }

    this.waiters.delete(record.event);
  }

  private rejectWaiters(error: Error): void {
    for (const waiters of this.waiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    }

    this.waiters.clear();
  }
}

function optionalAbsoluteEnvironmentPath(name: string): string | undefined {
  const configured = process.env[name];

  if (configured === undefined) return undefined;

  const value = configured.trim();

  if (value.length === 0) throw new Error(`${name} cannot be empty when set`);

  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path, received ${value}`);

  return resolve(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

async function awaitRecord(
  capture: OutputCapture,
  child: ReturnType<typeof Bun.spawn>,
  event: string,
  timeoutMs: number,
): Promise<JsonRecord> {
  const existing = capture.findRecord(event);

  if (existing !== undefined) return existing;

  const record = capture.waitForRecord(event, timeoutMs);
  const exited = child.exited.then((code) => {
    return withTimeout(
      capture.done,
      timeoutMs,
      `Node consumer exited with code ${code}, but stdout did not finish draining`,
    ).then(() => {
      const emitted = capture.findRecord(event);

      if (emitted !== undefined) return emitted;

      throw new Error(`Node consumer exited with code ${code} before stdout record ${event}`);
    });
  });

  return Promise.race([record, exited]);
}

async function stopChild(child: ReturnType<typeof Bun.spawn>): Promise<string | undefined> {
  if (child.exitCode !== null) return undefined;

  try {
    child.kill();
  } catch (error) {
    return `could not request child termination: ${errorText(error)}`;
  }

  try {
    await withTimeout(child.exited, cleanupTimeoutMs, "child did not exit after termination");

    return undefined;
  } catch (firstError) {
    try {
      child.kill("SIGKILL");
    } catch (error) {
      return `${errorText(firstError)}; could not force child termination: ${errorText(error)}`;
    }

    try {
      await withTimeout(child.exited, cleanupTimeoutMs, "child survived forced termination");

      return `child required forced termination after ${errorText(firstError)}`;
    } catch (secondError) {
      return `${errorText(firstError)}; ${errorText(secondError)}`;
    }
  }
}

function requireRecordField(
  record: JsonRecord,
  field: string,
  expected: string,
  label: string,
): void {
  expect(record[field], `${label}.${field}`).toBe(expected);
}

async function requireRuntimeExecutable(
  record: JsonRecord,
  expectedExecutable: string,
  label: string,
): Promise<void> {
  if (typeof record.nodeExecutable !== "string" || !isAbsolute(record.nodeExecutable)) {
    throw new Error(`${label} must report an absolute Node executable path`);
  }

  const actualExecutable = await realpath(record.nodeExecutable);
  const selectedExecutable = await realpath(expectedExecutable);

  if (comparablePath(actualExecutable) !== comparablePath(selectedExecutable)) {
    throw new Error(
      `${label} ran ${actualExecutable}; the version probe selected ${selectedExecutable}`,
    );
  }
}

function processCaptureReceipt(capture: OutputCapture) {
  return {
    byteCount: capture.totalBytes,
    recordCount: capture.totalRecords,
    truncated: capture.truncated,
    readErrors: capture.readErrors,
  };
}

function requireStringField(record: Record<string, unknown>, name: string): string {
  const value = record[name];

  if (typeof value !== "string") {
    throw new Error(`completed.moduleResolutions is missing string URL ${name}`);
  }

  return value;
}

function requireResolutionRecord(value: unknown): ModuleResolutionRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("completed.moduleResolutions must be an object of resolved module URLs");
  }

  const resolutions = value as Record<string, unknown>;

  return {
    hesperiaGrpc: requireStringField(resolutions, "hesperiaGrpc"),
    hesperiaGrpcNative: requireStringField(resolutions, "hesperiaGrpcNative"),
    connectNode: requireStringField(resolutions, "connectNode"),
    protobuf: requireStringField(resolutions, "protobuf"),
    aeolia: requireStringField(resolutions, "aeolia"),
  };
}

type ProcessRun = {
  readonly command: readonly string[];
  readonly pid: number;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly timeoutError?: string;
  readonly cleanupError?: string;
  readonly stdout: OutputCapture;
  readonly stderr: OutputCapture;
};

async function runBoundedProcess(
  command: readonly string[],
  timeoutMs: number,
  label: string,
): Promise<ProcessRun> {
  const child = Bun.spawn([...command], {
    cwd: packageRoot,
    env: { ...process.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new OutputCapture(child.stdout as ReadableStream<Uint8Array>);
  const stderr = new OutputCapture(child.stderr as ReadableStream<Uint8Array>);
  let exitCode: number | null = null;
  let timedOut = false;
  let timeoutError: string | undefined;
  let cleanupError: string | undefined;

  try {
    exitCode = await withTimeout(child.exited, timeoutMs, `${label} exceeded ${timeoutMs} ms`);
  } catch (error) {
    timedOut = true;
    timeoutError = errorText(error);
    cleanupError = await stopChild(child);
  }

  if (child.exitCode !== null) exitCode = child.exitCode;

  try {
    await withTimeout(
      Promise.all([stdout.done, stderr.done]),
      cleanupTimeoutMs,
      `${label} output pipes did not close`,
    );
  } catch (error) {
    cleanupError = [cleanupError, errorText(error)].filter(Boolean).join("; ");
  }

  return {
    command,
    pid: child.pid,
    exitCode,
    timedOut,
    timeoutError,
    cleanupError,
    stdout,
    stderr,
  };
}

function remainingBudget(deadline: number, label: string): number {
  const remaining = deadline - Date.now();

  if (remaining <= 0) throw new Error(`native gRPC setup exceeded its work budget before ${label}`);

  return remaining;
}

function requireProcessSuccess(run: ProcessRun, label: string): void {
  if (run.timedOut) throw new Error(`${label} timed out: ${run.timeoutError}`);

  if (run.exitCode !== 0) {
    throw new Error(
      `${label} exited with ${String(run.exitCode)}\n${run.stdout.text()}\n${run.stderr.text()}`,
    );
  }

  if (run.cleanupError !== undefined)
    throw new Error(`${label} cleanup failed: ${run.cleanupError}`);

  for (const [channel, capture] of [
    ["stdout", run.stdout],
    ["stderr", run.stderr],
  ] as const) {
    if (capture.truncated) throw new Error(`${label} ${channel} exceeded its capture bound`);

    if (capture.readErrors.length > 0) {
      throw new Error(`${label} ${channel} capture failed: ${capture.readErrors.join("; ")}`);
    }
  }
}

function processReceipt(run: ProcessRun) {
  return {
    command: run.command,
    pid: run.pid,
    exitCode: run.exitCode,
    timedOut: run.timedOut,
    timeoutError: run.timeoutError ?? null,
    cleanupError: run.cleanupError ?? null,
    stdout: run.stdout.text(),
    stderr: run.stderr.text(),
    stdoutBytes: run.stdout.totalBytes,
    stderrBytes: run.stderr.totalBytes,
    stdoutTruncated: run.stdout.truncated,
    stderrTruncated: run.stderr.truncated,
    stdoutReadErrors: run.stdout.readErrors,
    stderrReadErrors: run.stderr.readErrors,
  };
}

async function createRunDirectories(
  evidenceRootOverride: string | undefined,
): Promise<{ runRoot: string; evidenceDirectory: string }> {
  const workspaceEvidenceRoot = join(packageRoot, ".hesperia");

  await mkdir(workspaceEvidenceRoot, { recursive: true });

  const runRoot = await mkdtemp(join(workspaceEvidenceRoot, "grpc-native-"));

  if (evidenceRootOverride === undefined) return { runRoot, evidenceDirectory: runRoot };

  await mkdir(evidenceRootOverride, { recursive: true });

  return {
    runRoot,
    evidenceDirectory: await mkdtemp(join(evidenceRootOverride, "grpc-native-")),
  };
}

function comparablePath(value: string): string {
  const normalized = resolve(value).replaceAll("\\", "/");

  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function requireCanonicalFileUrl(
  value: string,
  expectedPath: string,
  label: string,
): Promise<string> {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} did not resolve to a valid local file URL`);
  }

  if (
    url.protocol !== "file:" ||
    url.host !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(`${label} must be a local file URL without query or fragment`);
  }

  const resolvedPath = await realpath(fileURLToPath(url));
  const expectedRealPath = await realpath(expectedPath);

  if (comparablePath(resolvedPath) !== comparablePath(expectedRealPath)) {
    throw new Error(`${label} resolved to ${resolvedPath}; expected ${expectedRealPath}`);
  }

  return resolvedPath;
}

const requiredChecks = [
  "query-mutation-effects",
  "error-details",
  "deadline",
  "unary-cancel",
  "stream",
  "late-error",
  "early-return",
];

test("native gRPC works through the emitted package on Node 22.23.2", async () => {
  const evidenceRootOverride = optionalAbsoluteEnvironmentPath("HESPERIA_GRPC_EVIDENCE_ROOT");
  const { runRoot, evidenceDirectory } = await createRunDirectories(evidenceRootOverride);
  const emittedRoot = join(runRoot, "emitted");
  const configPath = join(runRoot, "tsconfig.node.json");
  const freshConsumerPath = join(emittedRoot, "package", "fixtures", "grpc-native.mjs");
  const freshDescriptorPath = join(emittedRoot, "data", "fixtures", "grpc", "service-all_pb.js");
  const compilerPath = join(packageRoot, "node_modules", "typescript", "bin", "tsc");
  const nodeTypesPath = join(packageRoot, "node_modules", "@types", "node", "package.json");
  const publicIndexPath = join(packageRoot, "packages", "grpc", "dist", "index.js");
  const publicNativePath = join(packageRoot, "packages", "grpc", "dist", "native.js");
  const compileStdoutPath = join(evidenceDirectory, "compiler.stdout.log");
  const compileStderrPath = join(evidenceDirectory, "compiler.stderr.log");
  const probeStdoutPath = join(evidenceDirectory, "node-probe.stdout.log");
  const probeStderrPath = join(evidenceDirectory, "node-probe.stderr.log");
  const stdoutPath = join(evidenceDirectory, "consumer.stdout.log");
  const stderrPath = join(evidenceDirectory, "consumer.stderr.log");
  const receiptPath = join(evidenceDirectory, "receipt.json");
  const workDeadline = Date.now() + setupWorkBudgetMs;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let stdout: OutputCapture | undefined;
  let stderr: OutputCapture | undefined;
  let compilerRun: ProcessRun | undefined;
  let nodeProbeRun: ProcessRun | undefined;
  let primaryError: unknown;
  let cleanupError: string | undefined;
  let readyRecord: JsonRecord | undefined;
  let completedRecord: JsonRecord | undefined;
  let nodeCommand: string | undefined;
  let nodeExecutable: string | undefined;
  let selectedConsumerPath = freshConsumerPath;
  let consumerMode = "fresh-emit";
  let command: string[] = [];
  let exitCode: number | null = null;
  let nativeTimedOut = false;
  let moduleResolutions: ModuleResolutionRecord | undefined;
  let nodeProbeRecord:
    | { readonly nodeExecutable: string; readonly nodeVersion: string }
    | undefined;
  let expectedPackageDistPaths: { readonly root: string; readonly native: string } | undefined;
  let validatedPackageModulePaths: { readonly root: string; readonly native: string } | undefined;

  try {
    const nodeOverride = optionalAbsoluteEnvironmentPath("HESPERIA_GRPC_NODE");
    const selectedNodeCommand = nodeOverride ?? "node";

    nodeCommand = selectedNodeCommand;

    expectedPackageDistPaths = {
      root: await realpath(publicIndexPath),
      native: await realpath(publicNativePath),
    };

    await realpath(compilerPath);
    await realpath(nodeTypesPath);

    await mkdir(emittedRoot, { recursive: true });

    const nodeNextConfig = {
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        lib: ["ESNext", "DOM", "DOM.Iterable"],
        strict: true,
        noUncheckedIndexedAccess: true,
        verbatimModuleSyntax: true,
        noEmit: false,
        noEmitOnError: true,
        skipLibCheck: false,
        types: ["node"],
        rootDir: resolve(packageRoot, "tests"),
        outDir: emittedRoot,
      },
      files: [
        resolve(packageRoot, "tests/package/fixtures/grpc-native.mts"),
        resolve(packageRoot, "tests/data/fixtures/grpc/service-all_pb.ts"),
      ],
    };

    await writeFile(configPath, `${JSON.stringify(nodeNextConfig, null, 2)}\n`, "utf8");

    const compilerCommand = [process.execPath, compilerPath, "--project", configPath];
    const compilerBudget = Math.min(
      compilerTimeoutMs,
      remainingBudget(workDeadline, "TypeScript emission"),
    );

    compilerRun = await runBoundedProcess(
      compilerCommand,
      compilerBudget,
      "NodeNext consumer compiler",
    );

    requireProcessSuccess(compilerRun, "NodeNext consumer compiler");

    await stat(freshConsumerPath);
    await stat(freshDescriptorPath);

    const consumerOverride = optionalAbsoluteEnvironmentPath("HESPERIA_GRPC_CONSUMER");

    if (consumerOverride !== undefined) {
      const diagnosticConsumerPath = await realpath(consumerOverride);
      const diagnosticDescriptorPath = resolve(
        dirname(diagnosticConsumerPath),
        "../../data/fixtures/grpc/service-all_pb.js",
      );
      const [freshConsumer, diagnosticConsumer, freshDescriptor, diagnosticDescriptor] =
        await Promise.all([
          readFile(freshConsumerPath),
          readFile(diagnosticConsumerPath),
          readFile(freshDescriptorPath),
          readFile(diagnosticDescriptorPath),
        ]);

      if (!freshConsumer.equals(diagnosticConsumer)) {
        throw new Error("HESPERIA_GRPC_CONSUMER differs from this run's emitted consumer");
      }

      if (!freshDescriptor.equals(diagnosticDescriptor)) {
        throw new Error(
          "HESPERIA_GRPC_CONSUMER companion descriptor differs from this run's emission",
        );
      }

      selectedConsumerPath = diagnosticConsumerPath;
      consumerMode =
        comparablePath(diagnosticConsumerPath) === comparablePath(freshConsumerPath)
          ? "fresh-emit"
          : "verified-diagnostic-copy";
    }

    const probeSource =
      'process.stdout.write(JSON.stringify({ nodeExecutable: process.execPath, nodeVersion: process.versions.node }) + "\\n");';
    const probeBudget = Math.min(
      nodeProbeTimeoutMs,
      remainingBudget(workDeadline, "Node version probe"),
    );

    nodeProbeRun = await runBoundedProcess(
      [selectedNodeCommand, "-e", probeSource],
      probeBudget,
      "Node version probe",
    );

    requireProcessSuccess(nodeProbeRun, "Node version probe");

    const probeLines = nodeProbeRun.stdout.text().trim().split(/\r?\n/u);

    if (probeLines.length !== 1)
      throw new Error("Node version probe did not emit exactly one JSON record");

    const probeValue = JSON.parse(probeLines[0]!) as unknown;

    if (typeof probeValue !== "object" || probeValue === null || Array.isArray(probeValue)) {
      throw new Error("Node version probe returned a malformed identity record");
    }

    const probeRecord = probeValue as Record<string, unknown>;
    const probedExecutable = probeRecord.nodeExecutable;
    const probedVersion = probeRecord.nodeVersion;

    if (typeof probedExecutable !== "string" || typeof probedVersion !== "string") {
      throw new Error("Node version probe returned a malformed identity record");
    }

    nodeProbeRecord = {
      nodeExecutable: probedExecutable,
      nodeVersion: probedVersion,
    };

    if (nodeProbeRecord.nodeVersion !== nodeVersion) {
      throw new Error(`Expected Node ${nodeVersion}, received ${nodeProbeRecord.nodeVersion}`);
    }

    if (!isAbsolute(nodeProbeRecord.nodeExecutable)) {
      throw new Error(
        `Node probe returned a non-absolute executable path: ${nodeProbeRecord.nodeExecutable}`,
      );
    }

    const selectedNodeExecutable = await realpath(nodeProbeRecord.nodeExecutable);

    nodeExecutable = selectedNodeExecutable;

    if (
      nodeOverride !== undefined &&
      comparablePath(selectedNodeExecutable) !== comparablePath(await realpath(nodeOverride))
    ) {
      throw new Error(
        "The Node version probe did not use the configured HESPERIA_GRPC_NODE executable",
      );
    }

    command = [selectedNodeExecutable, selectedConsumerPath, serverFixture];

    const nativeBudget = Math.min(
      nativeTimeoutMs,
      remainingBudget(workDeadline, "native gRPC consumer"),
    );
    const nativeDeadline = Date.now() + nativeBudget;

    child = Bun.spawn(command, {
      cwd: packageRoot,
      env: { ...process.env },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    stdout = new OutputCapture(child.stdout as ReadableStream<Uint8Array>);
    stderr = new OutputCapture(child.stderr as ReadableStream<Uint8Array>);

    readyRecord = await awaitRecord(
      stdout,
      child,
      "server-ready",
      Math.min(startupTimeoutMs, remainingBudget(nativeDeadline, "server readiness")),
    );

    requireRecordField(readyRecord, "nodeVersion", nodeVersion, "server-ready");
    await requireRuntimeExecutable(readyRecord, selectedNodeExecutable, "server-ready");

    const baseUrl = new URL(String(readyRecord.baseUrl));

    expect(baseUrl.protocol).toBe("http:");
    expect(baseUrl.hostname).toBe("127.0.0.1");
    expect(Number(baseUrl.port)).toBeGreaterThan(0);

    const remainingMs = remainingBudget(nativeDeadline, "completion receipt");

    const completedPromise = awaitRecord(stdout, child, "completed", remainingMs);
    const [completed, childExitCode] = await withTimeout(
      Promise.all([completedPromise, child.exited]),
      remainingMs,
      "Node consumer did not complete native gRPC scenarios and cleanup",
    );
    completedRecord = completed;
    exitCode = childExitCode;

    expect(childExitCode, `Node consumer exited nonzero\n${stderr.text()}`).toBe(0);
    requireRecordField(completed, "nodeVersion", nodeVersion, "completed");
    await requireRuntimeExecutable(completed, selectedNodeExecutable, "completed");
    requireRecordField(completed, "clientSessionState", "closed", "completed");
    requireRecordField(completed, "serverCleanup", "complete", "completed");
    moduleResolutions = requireResolutionRecord(completed.moduleResolutions);

    validatedPackageModulePaths = {
      root: await requireCanonicalFileUrl(
        moduleResolutions.hesperiaGrpc,
        publicIndexPath,
        "@hesperia/grpc",
      ),
      native: await requireCanonicalFileUrl(
        moduleResolutions.hesperiaGrpcNative,
        publicNativePath,
        "@hesperia/grpc/native",
      ),
    };

    const checks = completed.checks;

    if (!Array.isArray(checks)) throw new Error("completed.checks must list the native assertions");

    for (const name of requiredChecks) {
      expect(checks, `missing native scenario ${name}`).toContain(name);
    }

    await withTimeout(
      Promise.all([stdout.done, stderr.done]),
      cleanupTimeoutMs,
      "Node consumer exited but its output pipes did not close",
    );

    expect(stdout.truncated, "Node consumer stdout exceeded retained evidence limit").toBe(false);
    expect(stderr.truncated, "Node consumer stderr exceeded retained evidence limit").toBe(false);
    expect(stdout.readErrors).toEqual([]);
    expect(stderr.readErrors).toEqual([]);

    const serverReadyRecords = stdout.records.filter((record) => record.event === "server-ready");
    const completedRecords = stdout.records.filter((record) => record.event === "completed");

    expect(serverReadyRecords).toHaveLength(1);
    expect(completedRecords).toHaveLength(1);
  } catch (error) {
    primaryError = error;
    nativeTimedOut =
      child !== undefined &&
      /timed out|exceeded its work budget|Node consumer did not complete native gRPC scenarios and cleanup/u.test(
        errorText(error),
      );
  } finally {
    if (child !== undefined) {
      try {
        cleanupError = await stopChild(child);
      } catch (error) {
        cleanupError = `could not terminate Node consumer: ${errorText(error)}`;
      }

      exitCode = child.exitCode;
    }

    if (stdout !== undefined && stderr !== undefined) {
      try {
        await withTimeout(
          Promise.all([stdout.done, stderr.done]),
          cleanupTimeoutMs,
          "child output readers remained open after cleanup",
        );
      } catch (error) {
        cleanupError = [cleanupError, errorText(error)].filter(Boolean).join("; ");
      }
    }

    let evidenceWriteError: string | undefined;
    try {
      await Promise.all([
        writeFile(compileStdoutPath, compilerRun?.stdout.text() ?? "", "utf8"),
        writeFile(compileStderrPath, compilerRun?.stderr.text() ?? "", "utf8"),
        writeFile(probeStdoutPath, nodeProbeRun?.stdout.text() ?? "", "utf8"),
        writeFile(probeStderrPath, nodeProbeRun?.stderr.text() ?? "", "utf8"),
        writeFile(stdoutPath, stdout?.text() ?? "", "utf8"),
        writeFile(stderrPath, stderr?.text() ?? "", "utf8"),
      ]);
    } catch (error) {
      evidenceWriteError = `could not persist phase logs: ${errorText(error)}`;
    }

    const receipt = {
      runRoot,
      emittedRoot,
      configPath,
      evidenceDirectory,
      receiptPath,
      compilerPath,
      nodeTypesPath,
      expectedPackageDistPaths: expectedPackageDistPaths ?? null,
      compiler: compilerRun === undefined ? null : processReceipt(compilerRun),
      nodeSelection: {
        selectedCommand: nodeCommand ?? null,
        probe: nodeProbeRun === undefined ? null : processReceipt(nodeProbeRun),
        identity: nodeProbeRecord ?? null,
        actualExecutable: nodeExecutable ?? null,
      },
      consumer: {
        mode: consumerMode,
        freshEmittedPath: freshConsumerPath,
        selectedPath: selectedConsumerPath,
        command,
        pid: child?.pid ?? null,
        exitCode,
        timedOut: nativeTimedOut,
        cleanupStatus:
          child === undefined ? "not-started" : cleanupError === undefined ? "complete" : "failed",
        cleanupError: cleanupError ?? null,
        readyRecord: readyRecord ?? null,
        completedRecord: completedRecord ?? null,
        moduleResolutions: moduleResolutions ?? null,
        validatedPackageModulePaths: validatedPackageModulePaths ?? null,
        stdout: stdout === undefined ? null : processCaptureReceipt(stdout),
        stderr: stderr === undefined ? null : processCaptureReceipt(stderr),
      },
      logPaths: {
        compilerStdout: compileStdoutPath,
        compilerStderr: compileStderrPath,
        nodeProbeStdout: probeStdoutPath,
        nodeProbeStderr: probeStderrPath,
        consumerStdout: stdoutPath,
        consumerStderr: stderrPath,
      },
      primaryError: primaryError === undefined ? null : errorText(primaryError),
      evidenceWriteError: evidenceWriteError ?? null,
    };

    try {
      await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    } catch (error) {
      evidenceWriteError = [evidenceWriteError, `could not persist receipt: ${errorText(error)}`]
        .filter(Boolean)
        .join("; ");
    }

    if (evidenceWriteError !== undefined) {
      cleanupError = [cleanupError, evidenceWriteError].filter(Boolean).join("; ");
    }
  }

  console.info(`Native gRPC evidence: ${evidenceDirectory}`);

  if (primaryError !== undefined || cleanupError !== undefined) {
    const details = [
      `Run directory: ${runRoot}`,
      `Evidence directory: ${evidenceDirectory}`,
      `Receipt: ${receiptPath}`,
      `Compiler: ${compilerRun?.command.map((part) => JSON.stringify(part)).join(" ") ?? "not started"}`,
      `Node probe: ${nodeProbeRun?.command.map((part) => JSON.stringify(part)).join(" ") ?? "not started"}`,
      `Native gRPC proof command: ${command.map((part) => JSON.stringify(part)).join(" ")}`,
      primaryError === undefined ? undefined : `Test failure: ${errorText(primaryError)}`,
      cleanupError === undefined ? undefined : `Cleanup failure: ${cleanupError}`,
      `Exit code: ${String(exitCode)}`,
      compilerRun === undefined ? undefined : `compiler stdout:\n${compilerRun.stdout.text()}`,
      compilerRun === undefined ? undefined : `compiler stderr:\n${compilerRun.stderr.text()}`,
      nodeProbeRun === undefined ? undefined : `Node probe stdout:\n${nodeProbeRun.stdout.text()}`,
      nodeProbeRun === undefined ? undefined : `Node probe stderr:\n${nodeProbeRun.stderr.text()}`,
      stdout === undefined ? undefined : `stdout:\n${stdout.text()}`,
      stderr === undefined ? undefined : `stderr:\n${stderr.text()}`,
      stdout?.truncated || stderr?.truncated ? "Captured output was truncated." : undefined,
    ].filter(Boolean);

    throw new Error(details.join("\n\n"));
  }
}, 45_000);
