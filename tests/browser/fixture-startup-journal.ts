import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";

type StartupRole = "preload-bootstrap" | "fixture-server";
type StartupPhase =
  | "bootstrap-body-enter"
  | "authored-preload-import-begin"
  | "authored-preload-import-end"
  | "fixture-body-enter"
  | "initial-build-begin"
  | "initial-build-end"
  | "markup-prepare-begin"
  | "markup-prepare-end"
  | "host-create-begin"
  | "host-create-end"
  | "serve-begin"
  | "serve-return"
  | "first-health-request";
type Detail = Readonly<Record<string, string | number | boolean | undefined>>;
type ChannelError = { channel: "file" | "stderr"; message: string };

const entryLimit = 32;
const byteLimit = 32 * 1024;
const lineLimit = 1024;
const reservedEntries = 4;
const prefix = "[browser-css-startup] ";

/** Records only fixture startup; diagnostic failures never change the caller's result. */
export function createBrowserCssStartupJournal(role: StartupRole): {
  mark(phase: StartupPhase, detail?: Detail): void;
  finish(): void;
} {
  const runId = process.env.HESPERIA_BROWSER_COVERAGE_RUN_ID;
  const inactive = { mark() {}, finish() {} };

  if (!runId || !/^[a-f0-9-]{36}$/u.test(runId)) return inactive;

  if (role !== "preload-bootstrap" && role !== "fixture-server") return inactive;

  const started = performance.now();
  let descriptor: number | undefined;
  let stderrAvailable = true;
  let finished = false;
  let truncated = false;
  let entries = 0;
  let bytes = 0;
  let lastPhase: StartupPhase | undefined;
  const reportedErrors = new Set<ChannelError["channel"]>();
  let setupError: ChannelError | undefined;

  function message(error: unknown): string {
    try {
      return (error instanceof Error ? error.message : String(error)).slice(0, 256);
    } catch {
      return "Diagnostic operation failed";
    }
  }

  function closeFile(): void {
    const current = descriptor;
    descriptor = undefined;

    if (current !== undefined) {
      try {
        closeSync(current);
      } catch (error) {
        reportErrors([{ channel: "file", message: message(error) }]);
      }
    }
  }

  function emit(phase: string, detail?: Detail): ChannelError[] {
    if (entries >= entryLimit) return [];

    const failures: ChannelError[] = [];
    const now = performance.now();
    const record = {
      format: "hesperia-browser-css-startup",
      version: 1,
      runId,
      role,
      pid: process.pid,
      parentPid: process.ppid,
      sequence: entries + 1,
      monotonicMs: now,
      timeOriginMs: performance.timeOrigin,
      elapsedMs: now - started,
      phase,
      detail:
        detail &&
        Object.fromEntries(
          Object.entries(detail)
            .slice(0, 8)
            .map(([key, value]) => [
              key.slice(0, 40),
              typeof value === "string" ? value.slice(0, 256) : value,
            ]),
        ),
    };
    let line = JSON.stringify(record) + "\n";

    if (Buffer.byteLength(prefix + line) > lineLimit) {
      record.detail = { truncated: true, reason: "record-byte-limit" };
      line = JSON.stringify(record) + "\n";
    }

    const size = Buffer.byteLength(prefix + line);

    if (bytes + size > byteLimit) return [];

    entries++;
    bytes += size;

    if (descriptor !== undefined) {
      try {
        const value = Buffer.from(line);

        if (writeSync(descriptor, value) !== value.length) throw new Error("Partial journal write");
      } catch (error) {
        failures.push({ channel: "file", message: message(error) });
        const current = descriptor;
        descriptor = undefined;

        if (current !== undefined) {
          try {
            closeSync(current);
          } catch {}
        }
      }
    }

    if (stderrAvailable) {
      try {
        const value = Buffer.from(prefix + line);

        if (writeSync(2, value) !== value.length) throw new Error("Partial stderr journal write");
      } catch (error) {
        stderrAvailable = false;
        failures.push({ channel: "stderr", message: message(error) });
      }
    }

    return failures;
  }

  function reportErrors(failures: readonly ChannelError[]): void {
    const pending = [...failures];

    // Each sink can fail once; reporting through the remaining sink cannot recurse.
    for (let index = 0; index < pending.length && index < 2; index++) {
      const failure = pending[index]!;

      if (reportedErrors.has(failure.channel)) continue;

      reportedErrors.add(failure.channel);
      pending.push(...emit("journal-channel-error", failure));
    }
  }

  function mark(phase: StartupPhase, detail?: Detail): void {
    if (finished) return;

    lastPhase = phase;

    if (truncated) return;

    try {
      if (
        entries >= entryLimit - reservedEntries ||
        bytes >= byteLimit - reservedEntries * lineLimit
      ) {
        truncated = true;
        reportErrors(emit("journal-truncated", { entryLimit, byteLimit, entries, bytes }));
      } else {
        reportErrors(emit(phase, detail));
      }
    } catch (error) {
      truncated = true;

      try {
        reportErrors(emit("journal-capture-error", { message: message(error) }));
      } catch {}
    }
  }

  function finish(): void {
    if (finished) return;

    finished = true;

    process.off("exit", onExit);

    try {
      reportErrors(emit("journal-end", { lastPhase, truncated, entries, bytes }));
      closeFile();
    } catch {}
  }

  function onExit(): void {
    finish();
  }

  try {
    const directory = resolve(
      import.meta.dir,
      "../../.hesperia/browser-diagnostics/browser-css-startup",
      runId,
    );

    mkdirSync(directory, { recursive: true });

    descriptor = openSync(join(directory, `${role}-${process.pid}.jsonl`), "wx");
  } catch (error) {
    setupError = { channel: "file", message: message(error) };
  }

  try {
    process.once("exit", onExit);

    reportErrors([
      ...(setupError ? [setupError] : []),
      ...emit("journal-ready", {
        file: descriptor === undefined ? "unavailable" : "open",
        entryLimit,
        byteLimit,
        lineLimit,
      }),
    ]);
  } catch {
    closeFile();
  }

  return { mark, finish };
}
