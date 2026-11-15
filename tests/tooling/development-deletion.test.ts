import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { devProject } from "../../packages/tooling/src/server.ts";
import { linkFrameworkPackages, unlinkFrameworkPackages } from "./fixture-dependencies.ts";

const applicationFixture = join(import.meta.dir, "fixtures/applications/development-deletion");

const browserDriver = join(import.meta.dir, "fixtures/drivers/development-deletion-browser.mjs");

function reconnectDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

async function reconnectCleanup<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(label + " cleanup timed out")), 4_000);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function reconnectFrames(reader: ReadableStreamDefaultReader<Uint8Array>) {
  let pending = new Uint8Array();
  let id = "";
  return async () => {
    while (true) {
      for (let index = 0; index + 1 < pending.length; index++) {
        if (pending[index] !== 10 || pending[index + 1] !== 10) continue;
        if (index + 2 > 65_536) throw new Error("Development SSE frame exceeded test limit");
        const bytes = pending.slice(0, index + 2);
        pending = pending.slice(index + 2);
        const lines = new TextDecoder("utf-8", { fatal: true }).decode(bytes).split("\n");
        const idLine = lines.find((line) => line.startsWith("id: "));
        const dataLine = lines.find((line) => line.startsWith("data: "));
        if (idLine) id = idLine.slice(4);
        return { bytes, id, message: dataLine ? JSON.parse(dataLine.slice(6)) : undefined };
      }
      if (pending.length > 65_536) throw new Error("Development SSE frame exceeded test limit");
      const chunk = await reader.read();
      if (chunk.done) throw new Error("Development SSE ended before the expected frame");
      const joined = new Uint8Array(pending.length + chunk.value.length);
      joined.set(pending);
      joined.set(chunk.value, pending.length);
      pending = joined;
    }
  };
}

test(
  "development EventSource reconnect recovers a missed terminal after unrelated route deletion",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "hesperia-dev-reconnect-"));
    const ready = reconnectDeferred<void>();
    const removal = reconnectDeferred<string>();
    const forwarded = reconnectDeferred<string>();
    const release = reconnectDeferred<void>();
    const proxyFailure = reconnectDeferred<never>();
    const receipts: unknown[] = [];
    const reports: string[] = [];
    let server: Awaited<ReturnType<typeof devProject>> | undefined;
    let proxy: ReturnType<typeof Bun.serve> | undefined;
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let observer: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const stream = {
      upstream: undefined as ReadableStreamDefaultReader<Uint8Array> | undefined,
      pullCount: 0,
      lastFrame: undefined as { id: string; type?: string } | undefined,
      cutHeld: false,
      cutReleased: false,
      cleanupStarted: false,
    };
    let output: Promise<string> | undefined;
    let errors: Promise<string> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let phase = "setup";
    let proxyRequests = 0;
    let failure: unknown;
    const cleanupFailures: unknown[] = [];
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("Reconnect control deadline")),
        process.platform === "win32" ? 110_000 : 80_000,
      );
    });
    void timeout.catch(() => {});
    try {
      await linkFrameworkPackages(root);
      const routeA = join(root, "src", "routes", "a");
      const routeB = join(root, "src", "routes", "b");
      await mkdir(routeA, { recursive: true });
      await mkdir(routeB, { recursive: true });
      await copyFile(join(applicationFixture, "app.tsx"), join(root, "app.tsx"));
      await copyFile(
        join(applicationFixture, "src/routes/+loading.tsx"),
        join(root, "src", "routes", "+loading.tsx"),
      );
      for (const name of ["a", "b"] as const) {
        const other = name === "a" ? "b" : "a";
        await writeFile(
          join(root, "src", "routes", name, "+page.tsx"),
          'import * as client from "hesperia/client"; import "./page.css";\n' +
            'export default function Page() { const count = client.state(0); return <main><button id="count" on:click={() => count.update(value => value + 1)}>{count()}</button><p id="' +
            name +
            '">' +
            name +
            '</p><a id="to-other" href="/' +
            other +
            '">Other</a></main>; }',
        );
      }
      await writeFile(join(routeA, "page.css"), '@import "./removed.css";');
      await writeFile(join(routeB, "page.css"), ".b { color: rgb(1, 2, 3); }");
      const removed = join(routeA, "removed.css");
      await writeFile(removed, ".a { color: rgb(20, 30, 40); }");
      server = await devProject(root, { port: 0, report: (message) => reports.push(message) });
      const eventUrl = new URL("/_hesperia/events", server.url);
      const response = await Promise.race([fetch(eventUrl), timeout]);
      if (!response.ok || !response.body) throw new Error("Independent SSE subscriber failed");
      observer = response.body.getReader();
      const nextObserver = reconnectFrames(observer);
      expect((await Promise.race([nextObserver(), timeout])).message?.type).toBe("current");

      proxy = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        idleTimeout: 0,
        async fetch(request) {
          if (request.method !== "GET" || new URL(request.url).pathname !== eventUrl.pathname)
            return new Response(null, { status: 404 });
          if (++proxyRequests !== 1) {
            proxyFailure.reject(new Error("Unexpected second request through SSE proxy"));
            return new Response(null, { status: 500 });
          }
          try {
            const response = await fetch(eventUrl);
            if (!response.ok || !response.body) throw new Error("Proxied SSE subscriber failed");
            stream.upstream = response.body.getReader();
            const next = reconnectFrames(stream.upstream);
            return new Response(
              new ReadableStream<Uint8Array>({
                async pull(controller) {
                  try {
                    stream.pullCount++;
                    const frame = await next();
                    stream.lastFrame = {
                      id: frame.id,
                      type: typeof frame.message === "string" ? frame.message : frame.message?.type,
                    };
                    controller.enqueue(frame.bytes);
                    if (frame.message?.type === "source-removal") {
                      stream.cutHeld = true;
                      forwarded.resolve(frame.id);
                      await release.promise;
                      stream.cutReleased = true;
                      controller.close();
                      await stream.upstream?.cancel();
                    }
                  } catch (error) {
                    const errorText = String(error);
                    receipts.push({
                      type: "proxy-pull-error",
                      phase,
                      cleanupStarted: stream.cleanupStarted,
                      pullCount: stream.pullCount,
                      lastFrame: stream.lastFrame,
                      cutHeld: stream.cutHeld,
                      cutReleased: stream.cutReleased,
                      error: errorText.slice(0, 500),
                      errorChars: errorText.length,
                      errorTruncated: errorText.length > 500,
                    });
                    proxyFailure.reject(error);
                    try {
                      controller.error(error);
                    } catch {}
                  }
                },
                async cancel() {
                  await stream.upstream?.cancel();
                },
              }),
              {
                headers: {
                  "content-type": "text/event-stream",
                  "cache-control": "no-cache",
                  "access-control-allow-origin": eventUrl.origin,
                },
              },
            );
          } catch (error) {
            proxyFailure.reject(error);
            return new Response(null, { status: 502 });
          }
        },
      });
      const spawned = Bun.spawn(
        [
          "node",
          browserDriver,
          pathToFileURL(resolve(import.meta.dir, "../../node_modules/playwright/index.mjs")).href,
          "chromium",
          new URL("/a", server.url).href,
          join(routeA, "page.css"),
          removed,
          "default",
          "",
          "reconnect-stream",
          proxy.url.origin,
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
          serialization: "json",
          ipc(message: unknown) {
            if (receipts.length < 16) receipts.push(message);
            if (!message || typeof message !== "object") return;
            const record = message as { type?: string; id?: string };
            if (record.type === "ready") ready.resolve();
            if (record.type === "removal" && typeof record.id === "string")
              removal.resolve(record.id);
            if (record.type === "header-confirmed") phase = "waiting-for-recovery";
          },
        },
      );
      child = spawned;
      output = new Response(spawned.stdout).text();
      errors = new Response(spawned.stderr).text();
      const earlyExit = spawned.exited.then((code) => {
        throw new Error("Browser exited early: " + code);
      });
      const wait = <T>(promise: Promise<T>) =>
        Promise.race([promise, earlyExit, proxyFailure.promise, timeout]);
      phase = "waiting-for-browser";
      await wait(ready.promise);
      phase = "preparing-deletion";
      await writeFile(join(routeA, "page.css"), ".a { color: rgb(50, 60, 70); }");
      const styleRevision = await wait(nextObserver());
      expect(styleRevision.message?.type).toBe("style-revision");
      phase = "deleting";
      await rm(removed);
      const [sentId, seenId] = await wait(Promise.all([forwarded.promise, removal.promise]));
      expect(sentId.length).toBeGreaterThan(0);
      expect(seenId).toBe(sentId);
      const removedEvent = await wait(nextObserver());
      const terminal = await wait(nextObserver());
      expect(removedEvent.message?.type).toBe("source-removal");
      expect(removedEvent.id).toBe(sentId);
      expect(terminal.message === "reload" || terminal.message?.type === "style-revision").toBe(
        true,
      );
      expect(terminal.id).toBe(sentId);
      receipts.push({
        type: "terminal",
        id: terminal.id,
        messageType:
          typeof terminal.message === "string" ? terminal.message : terminal.message?.type,
      });
      phase = "waiting-for-reconnect-evidence";
      release.resolve();
      const status = await Promise.race([spawned.exited, proxyFailure.promise, timeout]);
      const [stdout, stderr] = await Promise.all([output, errors]);
      if (status !== 0) throw new Error("Browser exited " + status + "\n" + stdout + "\n" + stderr);
      expect(stdout.trim()).toBe("Deletion SSE reconnect recovery verified");
      expect(reports).toStrictEqual([]);
    } catch (error) {
      failure = error;
    } finally {
      if (timer) clearTimeout(timer);
      stream.cleanupStarted = true;
      release.resolve();
      try {
        if (child && child.exitCode === null) child.kill();
      } catch (error) {
        cleanupFailures.push(error);
      }
      try {
        const results = await reconnectCleanup(
          Promise.allSettled([
            observer?.cancel(),
            stream.upstream?.cancel(),
            proxy?.stop(true),
            child?.exited,
          ]),
          "streams and browser",
        );
        for (const result of results)
          if (result.status === "rejected") cleanupFailures.push(result.reason);
      } catch (error) {
        cleanupFailures.push(error);
      }
      try {
        await reconnectCleanup(Promise.resolve(server?.close()), "server");
      } catch (error) {
        cleanupFailures.push(error);
      }
      try {
        await reconnectCleanup(
          (async () => {
            await unlinkFrameworkPackages(root);
            await rm(root, { recursive: true, force: true });
          })(),
          "fixture",
        );
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    if (failure || cleanupFailures.length) {
      let stdoutText = "";
      let stderr = "";
      try {
        if (output) stdoutText = await reconnectCleanup(output, "browser stdout");
      } catch (error) {
        cleanupFailures.push(error);
      }
      try {
        if (errors) stderr = await reconnectCleanup(errors, "browser stderr");
      } catch (error) {
        cleanupFailures.push(error);
      }
      const bounded = (value: string, limit: number) => ({
        text: value.slice(0, limit),
        totalChars: value.length,
        truncated: value.length > limit,
      });
      const diagnostic = {
        type: "reconnect-control-failure",
        phase,
        failure: bounded(String(failure), 1000),
        stream: {
          pullCount: stream.pullCount,
          lastFrame: stream.lastFrame,
          cutHeld: stream.cutHeld,
          cutReleased: stream.cutReleased,
          cleanupStarted: stream.cleanupStarted,
        },
        receipts: {
          items: receipts
            .slice(0, 20)
            .map((receipt) => bounded(JSON.stringify(receipt) ?? String(receipt), 400)),
          total: receipts.length,
          included: Math.min(receipts.length, 20),
          truncated: receipts.length > 20,
        },
        stdout: bounded(stdoutText, 1200),
        stderr: bounded(stderr, 2000),
        cleanupFailures: {
          items: cleanupFailures.slice(0, 4).map((error) => bounded(String(error), 400)),
          total: cleanupFailures.length,
          included: Math.min(cleanupFailures.length, 4),
          truncated: cleanupFailures.length > 4,
        },
      };
      console.error("[reconnect-control] " + JSON.stringify(diagnostic));
      throw new AggregateError(
        [failure, ...cleanupFailures].filter((error) => error !== undefined),
        "Reconnect phase " +
          phase +
          "; receipts " +
          JSON.stringify(receipts).slice(0, 5000) +
          "\n" +
          stderr,
      );
    }
  },
  process.platform === "win32" ? 120_000 : 90_000,
);

test.each(
  (["chromium", "firefox", "webkit"] as const).flatMap((engineName) =>
    (["default", "fallback"] as const).map(
      (navigationMode) => [engineName, navigationMode] as const,
    ),
  ),
)(
  "%s (%s navigation) development dependency deletion reloads affected active and cached pages while preserving an unrelated page",
  async (engineName, navigationMode) => {
    const root = await mkdtemp(join(tmpdir(), "hesperia-dev-deletion-"));

    let server: Awaited<ReturnType<typeof devProject>> | undefined;

    try {
      let diagnostics: string | undefined;
      let diagnosticsFailure: string | undefined;

      try {
        const diagnosticsParent = resolve(import.meta.dir, "../../.hesperia/browser-diagnostics");

        await mkdir(diagnosticsParent, { recursive: true });

        diagnostics = await mkdtemp(join(diagnosticsParent, "development-deletion-"));
      } catch (error) {
        diagnosticsFailure = String(error);
        console.error(`Deletion diagnostics unavailable: ${diagnosticsFailure}`);
      }

      await linkFrameworkPackages(root);

      await mkdir(join(root, "src", "routes", "a"), { recursive: true });

      await mkdir(join(root, "src", "routes", "b"), { recursive: true });

      await copyFile(join(applicationFixture, "app.tsx"), join(root, "app.tsx"));

      await copyFile(
        join(applicationFixture, "src/routes/+loading.tsx"),
        join(root, "src", "routes", "+loading.tsx"),
      );

      for (const name of ["a", "b"]) {
        await writeFile(
          join(root, "src", "routes", name, "+page.tsx"),
          `import * as client from "hesperia/client"; import { beforeLeave, navigation } from "hesperia/navigation"; import "./page.css";
export default function Page() { const count = client.state(0); const veto = client.state(false); client.effect(() => { const navigate = () => { const result = navigation.navigate("/a"); void result.committed.catch(() => {}); void result.finished.then(() => window.dispatchEvent(new CustomEvent("fixture-api-result", { detail: "committed" })), error => window.dispatchEvent(new CustomEvent("fixture-api-result", { detail: error.name }))); }; window.addEventListener("fixture-api-navigate", navigate); return () => window.removeEventListener("fixture-api-navigate", navigate); }); beforeLeave(() => { window.dispatchEvent(new CustomEvent("fixture-departure", { detail: veto() })); return !veto(); }); return <main><button id="veto" on:click={() => veto.update(value => !value)}>Toggle veto</button><button id="reload" on:click={() => { const result = navigation.reload(); void result.committed.catch(() => {}); void result.finished.catch(() => {}); }}>Reload</button><button id="count" on:click={() => count.update(value => value + 1)}>{count()}</button><p id="${name}" class="${name}">${name}</p><a id="to-other" href="/${name === "a" ? "b" : "a"}">Other</a></main>; }`,
        );

        await writeFile(
          join(root, "src", "routes", name, "page.css"),
          name === "a" ? '@import "./removed.css";' : ".b { color: rgb(1, 2, 3); }",
        );
      }

      const css = join(root, "src", "routes", "a", "page.css");

      const removed = join(root, "src", "routes", "a", "removed.css");

      await writeFile(removed, ".a { color: rgb(20, 30, 40); }");

      const reports: string[] = [];

      server = await devProject(root, { port: 0, report: (message) => reports.push(message) });

      const child = Bun.spawn(
        [
          "node",
          browserDriver,
          pathToFileURL(resolve(import.meta.dir, "../../node_modules/playwright/index.mjs")).href,
          engineName,
          new URL("a", server.url).href,
          css,
          removed,
          navigationMode,
          diagnostics ?? "",
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
        },
      );

      const [status, output, errors] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);

      if (status !== 0)
        throw new Error(
          `Deletion browser failed; evidence=${diagnostics ?? "unavailable"}${diagnosticsFailure ? `; diagnostics-error=${diagnosticsFailure}` : ""}\n${output}\n${errors}\nReports: ${JSON.stringify(reports)}`,
        );

      expect(output.trim().endsWith("Active and cached deletion behavior verified")).toBe(true);
    } finally {
      await server?.close();

      await unlinkFrameworkPackages(root);

      await rm(root, { recursive: true, force: true });
    }
  },
  process.platform === "win32" ? 120_000 : 90_000,
);
