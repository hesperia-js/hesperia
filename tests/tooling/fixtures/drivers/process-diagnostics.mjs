import { closeSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const entryLimit = 2000;
const byteLimit = 1_000_000;
const lineLimit = 8192;
const tickIntervalMs = 100;
const sampleIntervalMs = 1000;
const gapThresholdMs = 250;

/** @param {unknown} detail */
function snapshot(detail) {
  const seen = new WeakSet();
  let remaining = 80;

  /** @param {unknown} value @param {number} depth @returns {unknown} */
  function visit(value, depth) {
    if (--remaining < 0 || depth > 4) return "[detail truncated]";
    if (typeof value === "string") return value.slice(0, 1000);
    if (typeof value === "bigint") return String(value);
    if (typeof value !== "object" || value === null) return value;
    if (seen.has(value)) return "[circular]";

    seen.add(value);

    if (value instanceof Error) {
      return visit({ name: value.name, message: value.message, stack: value.stack }, depth + 1);
    }

    if (Array.isArray(value)) {
      const saved = value.slice(0, 20).map((item) => visit(item, depth + 1));

      if (value.length > 20) saved.push("[items truncated]");

      return saved;
    }

    /** @type {Record<string, unknown>} */
    const saved = {};
    let count = 0;

    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;

      if (count++ === 20) {
        saved.diagnosticsTruncated = true;

        break;
      }

      Object.defineProperty(saved, key, {
        enumerable: true,
        writable: true,
        value: visit(/** @type {Record<string, unknown>} */ (value)[key], depth + 1),
      });
    }

    return saved;
  }

  try {
    return visit(detail, 0);
  } catch {
    return "[detail unavailable]";
  }
}

/**
 * Records only this process. Synchronous appends retain completed records if a
 * later browser or event-loop operation stalls; filesystem failures are ignored.
 * The caller owns disposal and should keep the observer alive through browser close.
 *
 * @param {{directory: string, label: string}} options
 * @returns {{mark(kind: string, detail?: unknown): void, dispose(): void}}
 */
export function startProcessDiagnostics({ directory, label }) {
  const started = performance.now();
  const runtime = process.versions.bun ? "bun" : "node";
  const safeLabel = label.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 100) || "process";
  /** @type {number | undefined} */
  let descriptor;
  /** @type {ReturnType<typeof setInterval> | undefined} */
  let timer;
  let disposed = false;
  let truncated = false;
  let bytes = 0;
  let entries = 0;
  let previousTick = started;
  let previousSample = started;
  let previousCpu = { user: 0, system: 0 };
  let largestGapMs = 0;
  /** @type {{kind: string, elapsedMs: number} | undefined} */
  let lastMark;

  try {
    previousCpu = process.cpuUsage();

    mkdirSync(directory, { recursive: true });

    descriptor = openSync(join(directory, `${safeLabel}-${process.pid}.jsonl`), "wx");
  } catch {
    return { mark() {}, dispose() {} };
  }

  function close() {
    if (descriptor === undefined) return;

    try {
      closeSync(descriptor);
    } catch {
      // Diagnostics must never replace the test's failure.
    }

    descriptor = undefined;
  }

  /** @param {string} kind @param {unknown} [detail] @param {boolean} [final] */
  function record(kind, detail, final = false) {
    if (descriptor === undefined || (truncated && !final)) return;

    try {
      const monotonicMs = performance.now();
      const event = {
        at: new Date().toISOString(),
        monotonicMs,
        elapsedMs: monotonicMs - started,
        pid: process.pid,
        runtime,
        kind: kind.slice(0, 200),
        detail: snapshot(detail),
      };
      let line = JSON.stringify(event) + "\n";

      if (Buffer.byteLength(line) > lineLimit) {
        event.detail = { truncated: true, reason: "record-byte-limit", lineLimit };
        line = JSON.stringify(event) + "\n";
      }

      // Reserve a truncation sentinel and a final lifecycle record within both limits.
      if (
        !final &&
        (entries >= entryLimit - 2 || bytes + Buffer.byteLength(line) > byteLimit - 2 * lineLimit)
      ) {
        truncated = true;

        clearInterval(timer);

        event.kind = "journal-truncated";
        event.detail = { entryLimit, byteLimit, entries, bytes };
        line = JSON.stringify(event) + "\n";
      }

      writeFileSync(descriptor, line);
      bytes += Buffer.byteLength(line);
      entries++;
    } catch {
      clearInterval(timer);

      close();
    }
  }

  function sample() {
    const now = performance.now();
    const cpu = process.cpuUsage();
    const intervalMs = now - previousSample;
    const userMicros = cpu.user - previousCpu.user;
    const systemMicros = cpu.system - previousCpu.system;
    previousCpu = cpu;
    previousSample = now;

    return {
      intervalMs,
      cpu: {
        total: cpu,
        userMicros,
        systemMicros,
        percent: ((userMicros + systemMicros) / (intervalMs * 1000)) * 100,
      },
      memory: process.memoryUsage(),
    };
  }

  /** @param {string} kind @param {unknown} [detail] */
  function mark(kind, detail) {
    if (disposed) return;

    lastMark = { kind: kind.slice(0, 200), elapsedMs: performance.now() - started };

    record(kind, detail);
  }

  /** @param {number} [exitCode] */
  function finish(exitCode) {
    if (disposed) return;

    disposed = true;

    clearInterval(timer);

    process.off("exit", onExit);

    record(
      exitCode === undefined ? "observer-dispose" : "process-exit",
      { exitCode, largestGapMs, lastMark, truncated, entries, bytes },
      true,
    );

    close();
  }

  /** @param {number} exitCode */
  function onExit(exitCode) {
    finish(exitCode);
  }

  record("observer-start", {
    label,
    parentPid: process.ppid,
    version: process.version,
    runtimeVersion: process.versions.bun ?? process.version,
    platform: process.platform,
    arch: process.arch,
    timeOriginMs: performance.timeOrigin,
    tickIntervalMs,
    sampleIntervalMs,
    gapThresholdMs,
    entryLimit,
    byteLimit,
    lineLimit,
    detailLimits: { depth: 4, values: 80, entries: 20, stringCharacters: 1000 },
  });

  if (descriptor === undefined) return { mark() {}, dispose() {} };

  timer = setInterval(() => {
    try {
      const now = performance.now();
      const gapMs = now - previousTick;
      previousTick = now;
      largestGapMs = Math.max(largestGapMs, gapMs);

      if (gapMs > gapThresholdMs) {
        record("event-loop-gap", { gapMs, lateMs: gapMs - tickIntervalMs, lastMark });
      }

      if (now - previousSample >= sampleIntervalMs) {
        record("heartbeat", { ...sample(), lastMark });
      }
    } catch {
      clearInterval(timer);

      close();
    }
  }, tickIntervalMs);

  timer.unref();

  process.once("exit", onExit);

  return { mark, dispose: () => finish() };
}
