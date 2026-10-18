import { closeSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { startProcessDiagnostics } from "./fixtures/drivers/process-diagnostics.mjs";

type Mark = ReturnType<typeof startProcessDiagnostics>["mark"];

/** Record handler arrival, return, and Promise settlement; these are not network completion events. */
export function observeFetch<This, Args extends unknown[], Result>(
  handler: (this: This, ...args: Args) => Result,
  mark: Mark,
): (this: This, ...args: Args) => Result {
  let requestId = 0;

  function record(kind: string, detail?: unknown): void {
    try {
      mark(kind, detail);
    } catch {}
  }

  return function (this: This, ...args: Args): Result {
    const id = ++requestId;
    const started = performance.now();
    let path: string | undefined;

    try {
      if (args[0] instanceof Request) {
        path = new URL(args[0].url).pathname;

        record("server-fetch-ingress", { id, path, method: args[0].method });
      }
    } catch {}

    function returned(kind: string, result?: unknown, error?: unknown): void {
      try {
        record(kind, {
          id,
          path,
          durationMs: performance.now() - started,
          status: result instanceof Response ? result.status : undefined,
          error: error === undefined ? undefined : String(error),
        });
      } catch {}
    }

    let result: Result;

    try {
      result = Reflect.apply(handler, this, args);
    } catch (error) {
      returned("server-handler-throw", undefined, error);

      throw error;
    }

    if (result instanceof Promise) {
      record("server-handler-return", {
        id,
        path,
        shape: "promise",
        durationMs: performance.now() - started,
      });

      try {
        void Promise.prototype.then.call(
          result,
          (response: unknown) => returned("server-handler-resolve", response),
          (error: unknown) => returned("server-handler-reject", undefined, error),
        );
      } catch {}
    } else {
      returned("server-handler-return-sync", result);
    }

    return result;
  };
}

/** Observe one sequential preview startup. Other server creation must not overlap this scope. */
export async function observePreviewServer<T>(create: () => Promise<T>, mark: Mark): Promise<T> {
  const originalServe = Bun.serve;

  function record(kind: string): void {
    try {
      mark(kind);
    } catch {}
  }

  const observedServe = function (this: unknown, options: Parameters<typeof Bun.serve>[0]) {
    // The real handler stays observed; the global hook exists only until server creation.
    Bun.serve = originalServe;

    if (typeof options.fetch !== "function") return Reflect.apply(originalServe, this, [options]);

    return Reflect.apply(originalServe, this, [
      { ...options, fetch: observeFetch(options.fetch, mark) },
    ]);
  } as typeof Bun.serve;

  record("preview-create-start");

  try {
    Bun.serve = observedServe;

    const server = await create();

    record("preview-create-complete");

    return server;
  } catch (error) {
    record("preview-create-error");

    throw error;
  } finally {
    if (Bun.serve === observedServe) Bun.serve = originalServe;
  }
}

/** Keep bounded raw stderr on disk while returning the complete original decoded stderr. */
export async function captureDriverStderr(
  stream: ReadableStream<Uint8Array>,
  directory: string,
  mark: Mark,
): Promise<string> {
  const limit = 8 * 1024 * 1024;
  const sentinel = Buffer.from("\n[driver stderr diagnostic file truncated at 8 MiB]\n");
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let descriptor: number | undefined;
  let bytes = 0;
  let truncated = false;

  function record(kind: string, detail?: unknown): void {
    try {
      mark(kind, detail);
    } catch {}
  }

  function close(): void {
    if (descriptor === undefined) return;

    try {
      closeSync(descriptor);
    } catch {}

    descriptor = undefined;
  }

  function append(chunk: Uint8Array): void {
    if (descriptor === undefined || truncated) return;

    try {
      const remaining = limit - sentinel.length - bytes;
      const retained = chunk.subarray(0, Math.max(0, remaining));
      let offset = 0;

      while (offset < retained.length) {
        const written = writeSync(descriptor, retained, offset, retained.length - offset);

        if (written <= 0) throw new Error("Driver stderr diagnostic write made no progress");

        offset += written;
      }

      bytes += retained.length;

      if (retained.length < chunk.length) {
        let offset = 0;

        while (offset < sentinel.length) {
          const written = writeSync(descriptor, sentinel, offset, sentinel.length - offset);

          if (written <= 0) throw new Error("Driver stderr truncation write made no progress");

          offset += written;
        }

        truncated = true;

        record("driver-stderr-truncated", { retainedBytes: bytes, limitBytes: limit });
      }
    } catch (error) {
      record("driver-stderr-write-error", { error: String(error) });

      close();
    }
  }

  try {
    descriptor = openSync(join(directory, "driver-stderr.log"), "wx");
  } catch (error) {
    record("driver-stderr-open-error", { error: String(error) });
  }

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  try {
    reader = stream.getReader();

    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      append(value);

      parts.push(decoder.decode(value, { stream: true }));
    }

    parts.push(decoder.decode());

    record("driver-stderr-eof", { retainedBytes: bytes, truncated });

    return parts.join("");
  } catch (error) {
    record("driver-stderr-read-error", { error: String(error) });

    throw error;
  } finally {
    try {
      reader?.releaseLock();
    } finally {
      close();
    }
  }
}
