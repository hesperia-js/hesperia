import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { installDocumentNavigationDiagnostics } from "./document-navigation-diagnostics.mjs";

const [playwrightModuleURL, directory] = process.argv.slice(2);
const { chromium, firefox, webkit } = /** @type {typeof import("playwright")} */ (
  await import(playwrightModuleURL)
);
const bodyPrefix =
  '<!doctype html><html><head></head><body><p id="partial">Partial body' + " ".repeat(4096);
const bodySuffix = "</p></body></html>";
const parserDocument =
  '<!doctype html><html><head><script src="/held.js"></script></head><body><script>history.replaceState(null,"","/early/")</script>Parser control</body></html>';
/** @type {import("node:http").ServerResponse | undefined} */
let bodyResponse;
/** @type {import("node:http").ServerResponse | undefined} */
let parserResponse;
const server = createServer((request, response) => {
  if (request.url === "/body/") {
    response.writeHead(200, {
      "Content-Type": "text/html",
      "Content-Length": Buffer.byteLength(bodyPrefix + bodySuffix),
    });

    response.write(bodyPrefix);

    bodyResponse = response;
  } else if (request.url === "/parser/") {
    response.writeHead(200, {
      "Content-Type": "text/html",
      "Content-Length": Buffer.byteLength(parserDocument),
    });

    response.end(parserDocument);
  } else if (request.url === "/held.js") {
    parserResponse = response;

    server.emit("parser-response-held");
  } else {
    response.end("<!doctype html><p>Unrelated document</p>");
  }
});

await mkdir(directory, { recursive: true });

await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));

const address = server.address();

assert.ok(address && typeof address === "object");

const origin = `http://127.0.0.1:${address.port}`;
const failures = [];

try {
  for (const engine of [chromium, firefox, webkit]) {
    const browser = await engine.launch();
    let completed = 0;

    try {
      for (const mode of ["body", "parser"]) {
        const page = await browser.newPage();
        const targetURL = `${origin}/${mode}/`;
        /** @type {{kind: string, detail: any}[]} */
        const records = [];
        /** @type {(() => void) | undefined} */
        let loaded;
        const loadRecord = new Promise((resolve) => {
          loaded = () => resolve(undefined);
        });
        const stop = await installDocumentNavigationDiagnostics(
          page,
          {
            mark(kind, detail) {
              records.push({ kind, detail });

              if (
                kind === "document-navigation-timing" &&
                /** @type {any} */ (detail).browser.phase === "load"
              )
                loaded?.();
            },
          },
          targetURL,
        );
        const parserReceiptAbort = new AbortController();

        try {
          const parserHeld =
            mode === "parser"
              ? once(server, "parser-response-held", {
                  signal: AbortSignal.any([parserReceiptAbort.signal, AbortSignal.timeout(5000)]),
                })
              : undefined;

          void parserHeld?.catch(() => {});

          const documentFinished = page.waitForEvent("requestfinished", {
            predicate: (request) => request.isNavigationRequest() && request.url() === targetURL,
            timeout: 5000,
          });
          let finished = false;

          void documentFinished.then(
            () => {
              finished = true;

              records.push({
                kind: "document-requestfinished",
                detail: { receivedAtEpochMs: Date.now() },
              });
            },
            () => {},
          );

          void documentFinished.catch(() => {});
          const scriptRequest =
            mode === "parser"
              ? page.waitForRequest(`${origin}/held.js`, { timeout: 5000 })
              : undefined;

          void scriptRequest?.catch(() => {});

          await page.goto(targetURL, { waitUntil: "commit", timeout: 5000 });

          if (mode === "body") {
            await page.locator("#partial").waitFor({ timeout: 5000 });

            const beforeRelease = await page.evaluate(() => {
              const navigation = /** @type {PerformanceNavigationTiming | undefined} */ (
                performance.getEntriesByType("navigation")[0]
              );

              return {
                now: performance.now(),
                responseEnd: navigation?.responseEnd ?? null,
                bytes: navigation?.decodedBodySize ?? null,
              };
            });

            records.push({ kind: "body-release-control", detail: { ...beforeRelease, finished } });

            assert.equal(finished, false);

            assert.ok(
              beforeRelease.bytes === null ||
                beforeRelease.bytes < Buffer.byteLength(bodyPrefix + bodySuffix),
            );

            assert.ok(bodyResponse);

            await page.waitForFunction((now) => performance.now() > now, beforeRelease.now, {
              timeout: 5000,
            });

            bodyResponse.end(bodySuffix);
          } else {
            await scriptRequest;

            const documentRequest = await documentFinished;
            const documentResponse = await documentRequest.response();

            assert.ok(documentResponse);

            const documentBody = await documentResponse.body();

            assert.equal(documentBody.toString(), parserDocument);

            const beforeRelease = await page.evaluate(() => {
              const navigation = /** @type {PerformanceNavigationTiming} */ (
                performance.getEntriesByType("navigation")[0]
              );

              return {
                now: performance.now(),
                responseEnd: navigation.responseEnd,
                bytes: navigation.decodedBodySize,
                dcl: navigation.domContentLoadedEventStart,
              };
            });

            records.push({
              kind: "parser-release-control",
              detail: { ...beforeRelease, finished, responseBodyBytes: documentBody.length },
            });

            assert.equal(beforeRelease.dcl, 0);

            await parserHeld;

            assert.ok(parserResponse);

            await page.waitForFunction((now) => performance.now() > now, beforeRelease.now, {
              timeout: 5000,
            });

            parserResponse.end("// Release the parser-blocking script.");
          }

          await documentFinished;

          /** @type {ReturnType<typeof setTimeout> | undefined} */
          let timer;

          try {
            await Promise.race([
              loadRecord,
              new Promise((_, reject) => {
                timer = setTimeout(
                  () => reject(new Error("Native load record was not received")),
                  5000,
                );
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }

          const nativeRecords = records.filter(
            (item) => item.kind === "document-navigation-timing",
          );
          const initial = nativeRecords.find((item) => item.detail.browser.phase === "init");
          const dcl = nativeRecords.find(
            (item) => item.detail.browser.phase === "domcontentloaded",
          );
          const load = nativeRecords.find((item) => item.detail.browser.phase === "load");

          assert.ok(initial && dcl && load);

          assert.equal(load.detail.browser.navigation.name, targetURL);

          assert.equal(
            load.detail.browser.navigation.decodedBodySize,
            Buffer.byteLength(mode === "body" ? bodyPrefix + bodySuffix : parserDocument),
          );

          assert.ok(load.detail.browser.navigation.responseEnd > 0);

          const release = records.find((item) => item.kind === `${mode}-release-control`);

          assert.ok(dcl.detail.browser.navigation.domContentLoadedEventStart > release?.detail.now);

          if (mode === "parser") {
            assert.ok(dcl.detail.browser.navigation.responseEnd <= release?.detail.now);

            assert.equal(load.detail.browser.documentURL, `${origin}/early/`);
          }

          const count = records.length;

          await page.goto(`${origin}/unrelated/`, { timeout: 5000 });

          assert.equal(records.length, count);

          await writeFile(
            join(directory, `${engine.name()}-${mode}.json`),
            JSON.stringify({ engine: engine.name(), mode, targetURL, records }, null, 2),
          );

          completed++;
        } catch (error) {
          await writeFile(
            join(directory, `${engine.name()}-${mode}-failure.json`),
            JSON.stringify({ records, error: String(error) }, null, 2),
          );

          failures.push(
            `${engine.name()} ${mode}: ${error instanceof Error ? error.stack : error}`,
          );
        } finally {
          parserReceiptAbort.abort();

          if (bodyResponse && !bodyResponse.writableEnded) bodyResponse.end();

          if (parserResponse && !parserResponse.writableEnded) parserResponse.end();

          bodyResponse = undefined;
          parserResponse = undefined;

          stop();

          await page.close();
        }
      }

      if (completed === 2) console.log(`${engine.name()} document timing controls verified`);
    } finally {
      await browser.close();
    }
  }
} finally {
  server.closeAllConnections();

  await new Promise((resolve) => server.close(() => resolve(undefined)));
}

assert.deepEqual(failures, []);
