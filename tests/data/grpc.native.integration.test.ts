import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

const packageRoot = resolve(import.meta.dir, "../..");
const serverFixture = resolve(import.meta.dir, "fixtures/grpc-server.fixture.mjs");
const nodeVersion = "22.23.2";
const startupTimeoutMs = 12_000;
const childTimeoutMs = 25_000;
const cleanupTimeoutMs = 1_500;
const retainedOutputBytes = 128 * 1024;
const retainedLineCharacters = 32 * 1024;
const retainedRecordCount = 32;

type JsonRecord = Record<string, unknown>;

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

function requiredAbsolutePath(name: string): string {
  const value = process.env[name]?.trim();

  if (value === undefined || value.length === 0) {
    throw new Error(`${name} must name an absolute path for the native gRPC proof`);
  }

  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path, received ${value}`);

  return value;
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

  child.kill();

  try {
    await withTimeout(child.exited, cleanupTimeoutMs, "Node consumer did not exit after termination");

    return undefined;
  } catch (firstError) {
    child.kill("SIGKILL");

    try {
      await withTimeout(child.exited, cleanupTimeoutMs, "Node consumer survived forced termination");

      return `Node consumer required forced termination after ${errorText(firstError)}`;
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

function requireResolutionRecord(value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("completed.moduleResolutions must be an object of resolved module URLs");
  }

  const resolutions = value as Record<string, unknown>;
  const required = [
    "hesperiaGrpc",
    "hesperiaGrpcNative",
    "connectNode",
    "protobuf",
    "aeolia",
  ];

  for (const name of required) {
    expect(typeof resolutions[name], `missing resolved module URL ${name}`).toBe("string");
    expect(String(resolutions[name]), `${name} must resolve to a URL`).toMatch(/^(file|node):/u);
  }
}

async function createEvidenceDirectory(): Promise<string> {
  const root = resolve(requiredAbsolutePath("HESPERIA_GRPC_EVIDENCE_ROOT"));

  await mkdir(root, { recursive: true });

  return mkdtemp(join(root, "grpc-native-"));
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
  const evidenceDirectory = await createEvidenceDirectory();
  const stdoutPath = join(evidenceDirectory, "stdout.log");
  const stderrPath = join(evidenceDirectory, "stderr.log");
  const receiptPath = join(evidenceDirectory, "receipt.json");
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let stdout: OutputCapture | undefined;
  let stderr: OutputCapture | undefined;
  let primaryError: unknown;
  let cleanupError: string | undefined;
  let readyRecord: JsonRecord | undefined;
  let completedRecord: JsonRecord | undefined;
  let nodePath: string | undefined;
  let consumerPath: string | undefined;
  let command: string[] = [];
  let beganAt: number | undefined;
  let exitCode: number | null = null;

  try {
    nodePath = requiredAbsolutePath("HESPERIA_GRPC_NODE");
    consumerPath = requiredAbsolutePath("HESPERIA_GRPC_CONSUMER");
    command = [nodePath, consumerPath, serverFixture];
    beganAt = Date.now();
    child = Bun.spawn(command, {
      cwd: packageRoot,
      env: { ...process.env },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    stdout = new OutputCapture(child.stdout as ReadableStream<Uint8Array>);
    stderr = new OutputCapture(child.stderr as ReadableStream<Uint8Array>);

    readyRecord = await awaitRecord(stdout, child, "server-ready", startupTimeoutMs);

    requireRecordField(readyRecord, "nodeVersion", nodeVersion, "server-ready");

    const baseUrl = new URL(String(readyRecord.baseUrl));

    expect(baseUrl.protocol).toBe("http:");
    expect(baseUrl.hostname).toBe("127.0.0.1");
    expect(Number(baseUrl.port)).toBeGreaterThan(0);

    if (beganAt === undefined) throw new Error("Node consumer start time was not recorded");

    const remainingMs = childTimeoutMs - (Date.now() - beganAt);

    if (remainingMs <= 0) throw new Error("Node consumer exceeded its total runtime bound");

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
    requireRecordField(completed, "clientSessionState", "closed", "completed");
    requireRecordField(completed, "serverCleanup", "complete", "completed");
    requireResolutionRecord(completed.moduleResolutions);

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

    const receipt = {
      command,
      pid: child?.pid ?? null,
      nodePath: nodePath ?? null,
      consumerPath: consumerPath ?? null,
      serverFixture,
      startedAt: beganAt === undefined ? null : new Date(beganAt).toISOString(),
      readyRecord: readyRecord ?? null,
      completedRecord: completedRecord ?? null,
      exitCode,
      cleanupStatus:
        child === undefined ? "not-started" : cleanupError === undefined ? "complete" : "failed",
      cleanupError: cleanupError ?? null,
      stdoutPath,
      stderrPath,
      receiptPath,
      stdout: stdout === undefined ? null : {
        byteCount: stdout.totalBytes,
        recordCount: stdout.totalRecords,
        truncated: stdout.truncated,
        readErrors: stdout.readErrors,
      },
      stderr: stderr === undefined ? null : {
        byteCount: stderr.totalBytes,
        recordCount: stderr.totalRecords,
        truncated: stderr.truncated,
        readErrors: stderr.readErrors,
      },
    };

    try {
      await Promise.all([
        writeFile(stdoutPath, stdout?.text() ?? "", "utf8"),
        writeFile(stderrPath, stderr?.text() ?? "", "utf8"),
        writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8"),
      ]);
    } catch (error) {
      cleanupError = [cleanupError, `could not persist evidence: ${errorText(error)}`]
        .filter(Boolean)
        .join("; ");
    }
  }

  console.info(`Native gRPC evidence: ${evidenceDirectory}`);

  if (primaryError !== undefined || cleanupError !== undefined) {
    const details = [
      `Evidence directory: ${evidenceDirectory}`,
      `Receipt: ${receiptPath}`,
      `Native gRPC proof command: ${command.map((part) => JSON.stringify(part)).join(" ")}`,
      primaryError === undefined ? undefined : `Test failure: ${errorText(primaryError)}`,
      cleanupError === undefined ? undefined : `Cleanup failure: ${cleanupError}`,
      `Exit code: ${String(exitCode)}`,
      stdout === undefined ? undefined : `stdout:\n${stdout.text()}`,
      stderr === undefined ? undefined : `stderr:\n${stderr.text()}`,
      stdout?.truncated || stderr?.truncated ? "Captured output was truncated." : undefined,
    ].filter(Boolean);

    throw new Error(details.join("\n\n"));
  }
}, 45_000);
