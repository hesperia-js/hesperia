import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const diagnosticsRoot = resolve(import.meta.dir, "../../.hesperia/browser-diagnostics");
const journalRoot = join(diagnosticsRoot, "browser-css-startup");
const helper = pathToFileURL(
  resolve(import.meta.dir, "../browser/fixture-startup-journal.ts"),
).href;

for (const mode of ["file-unavailable", "stderr-unwritable", "both-unavailable", "cap"] as const) {
  test(`browser CSS startup journal preserves the original outcome with ${mode}`, async () => {
    const runId = randomUUID();
    const directory = join(journalRoot, runId);
    const evidence = join(diagnosticsRoot, "browser-css-startup-controls", runId);
    const fileUnavailable = mode === "file-unavailable" || mode === "both-unavailable";
    const stderrUnavailable = mode === "stderr-unwritable" || mode === "both-unavailable";
    const stderrTarget = join(evidence, "read-only-stderr.txt");
    let stderrDescriptor: number | undefined;

    await mkdir(journalRoot, { recursive: true });
    await mkdir(evidence, { recursive: true });

    if (fileUnavailable) await writeFile(directory, "occupied");

    if (stderrUnavailable) await writeFile(stderrTarget, "unwritable stderr");

    try {
      if (stderrUnavailable) stderrDescriptor = openSync(stderrTarget, "r");

      const child = spawnSync(
        process.execPath,
        [
          "--eval",
          `import { writeSync } from "node:fs";
import { createBrowserCssStartupJournal } from ${JSON.stringify(helper)};
${
  stderrUnavailable
    ? `let rawWrite;
try { writeSync(2, Buffer.from("must not be written")); rawWrite = { writeSucceeded: true }; }
catch (error) { rawWrite = { writeSucceeded: false, code: error.code }; }
process.stdout.write(JSON.stringify(rawWrite) + "\\n");`
    : ""
}
const journal = createBrowserCssStartupJournal("fixture-server");
for (let index = 0; index < ${mode === "cap" ? 1000 : 1}; index++) {
  journal.mark("fixture-body-enter", {
    first: "x".repeat(2000), second: "x".repeat(2000), third: "x".repeat(2000),
    fourth: "x".repeat(2000), fifth: "x".repeat(2000), sixth: "x".repeat(2000),
    seventh: "x".repeat(2000), eighth: "x".repeat(2000),
  });
}
journal.finish();
journal.finish();
process.stdout.write("original startup outcome\\n");
process.exitCode = 17;`,
        ],
        {
          encoding: "utf8",
          timeout: 15_000,
          maxBuffer: 128 * 1024,
          env: { ...process.env, HESPERIA_BROWSER_COVERAGE_RUN_ID: runId },
          stdio: ["ignore", "pipe", stderrDescriptor ?? "pipe"],
        },
      );
      const stdout = child.stdout ?? "";
      const stderr = child.stderr ?? "";
      const paths = fileUnavailable ? [] : await readdir(directory);
      const journal = paths.length ? await readFile(join(directory, paths[0]!), "utf8") : "";

      await writeFile(join(evidence, "stdout.log"), stdout);
      await writeFile(join(evidence, "stderr.log"), stderr);
      await writeFile(join(evidence, "journal.jsonl"), journal);
      await writeFile(
        join(evidence, "control.json"),
        JSON.stringify({
          mode,
          runId,
          status: child.status,
          signal: child.signal,
          error: child.error?.message,
        }),
      );

      expect(child.error).toBeUndefined();
      expect(child.status).toBe(17);
      if (stderrUnavailable) {
        const [probe, outcome] = stdout.trimEnd().split(/\r?\n/u);

        expect(JSON.parse(probe!).writeSucceeded).toBe(false);
        expect(typeof JSON.parse(probe!).code).toBe("string");
        expect(outcome).toBe("original startup outcome");
        expect(await readFile(stderrTarget, "utf8")).toBe("unwritable stderr");
      } else {
        expect(stdout).toBe("original startup outcome\n");
      }

      const errors = stderr
        .split(/\r?\n/u)
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line.slice("[browser-css-startup] ".length)) as {
              phase: string;
              detail?: { channel?: string; reason?: string };
            },
        );
      const records = journal
        .split(/\r?\n/u)
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as { phase: string; detail?: { channel?: string; reason?: string } },
        );

      if (fileUnavailable) {
        expect(await readFile(directory, "utf8")).toBe("occupied");

        if (!stderrUnavailable) {
          expect(
            errors.some(
              (record) =>
                record.phase === "journal-channel-error" && record.detail?.channel === "file",
            ),
          ).toBe(true);
        }
      } else {
        expect(paths).toHaveLength(1);
        expect(records.filter((record) => record.phase === "journal-end")).toHaveLength(1);
      }

      if (mode === "stderr-unwritable") {
        expect(
          records.some(
            (record) =>
              record.phase === "journal-channel-error" && record.detail?.channel === "stderr",
          ),
        ).toBe(true);
      }

      if (mode === "cap") {
        expect(records.filter((record) => record.phase === "journal-truncated")).toHaveLength(1);
        expect(records.length).toBeLessThanOrEqual(32);
        expect(Buffer.byteLength(journal)).toBeLessThanOrEqual(32 * 1024);
        expect(Buffer.byteLength(stderr)).toBeLessThanOrEqual(32 * 1024);
        for (const line of [...journal.split(/(?<=\n)/u), ...stderr.split(/(?<=\n)/u)]) {
          expect(Buffer.byteLength(line)).toBeLessThanOrEqual(1024);
        }
        expect(records.some((record) => record.detail?.reason === "record-byte-limit")).toBe(true);
        expect(records.some((record) => record.phase === "fixture-body-enter")).toBe(true);
      }
    } finally {
      if (stderrDescriptor !== undefined) closeSync(stderrDescriptor);

      await rm(directory, { recursive: true, force: true });
    }
  });
}
