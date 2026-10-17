import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const action = Bun.YAML.parse(
  await Bun.file(new URL("../../.github/actions/setup-editor/action.yml", import.meta.url)).text(),
) as { runs: { steps: { id?: string; run?: string }[] } };
const run = action.runs.steps.find((step) => step.id === "metadata")?.run;

assert.ok(run);

const match = /^bun -e '\s*([\s\S]*?)\s*'\s*$/.exec(run);

assert.ok(match?.[1]);

const script = match[1];
const manifest = await Bun.file(
  new URL("../../editors/vscode/package.json", import.meta.url),
).json();
const metadata = {
  productVersion: manifest.devDependencies["@types/vscode"],
  version: "a".repeat(40),
  sha256hash: "b".repeat(64),
  url: "https://vscode.download.prss.microsoft.com/stable/verified.zip",
};

async function resolveEditor(overrides: Record<string, unknown> = {}) {
  const scratch = await mkdtemp(join(tmpdir(), "hesperia-editor-metadata-"));

  try {
    const fixture = join(scratch, "metadata.json");
    const output = join(scratch, "outputs.txt");

    await writeFile(fixture, JSON.stringify({ ...metadata, ...overrides }));

    await writeFile(output, "");

    const result = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        `const fixture = await Bun.file(process.env.HESPERIA_EDITOR_METADATA_FIXTURE).json();
         globalThis.fetch = async () => new Response(JSON.stringify(fixture), { status: fixture.status ?? 200 });
         ${script}`,
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          HESPERIA_EDITOR_METADATA_FIXTURE: fixture,
          GITHUB_OUTPUT: output,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    return { result, output: await readFile(output, "utf8") };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

test("stable editor metadata at the existing baseline supplies verified download identity", async () => {
  const { result, output } = await resolveEditor();

  expect(result.exitCode).toBe(0);

  expect(output).toContain(`version=${metadata.productVersion}\n`);

  expect(output).toContain(`commit=${metadata.version}\n`);

  expect(output).toContain(`sha256=${metadata.sha256hash}\n`);

  expect(output).toContain(`url=${metadata.url}\n`);
});

test("editor setup accepts later stable versions within the existing engine range", async () => {
  for (const productVersion of ["1.141.0", "1.150.2"]) {
    const { result, output } = await resolveEditor({ productVersion });

    expect(result.exitCode).toBe(0);

    expect(output).toContain(`version=${productVersion}\n`);
  }
});

test("editor setup rejects unsupported versions and unverifiable metadata before download", async () => {
  for (const invalid of [
    { productVersion: "1.136.0" },
    { productVersion: "2.0.0" },
    { productVersion: "1.141.0-insider" },
    { version: "not-a-commit" },
    { sha256hash: "not-a-checksum" },
    { url: "http://vscode.download.prss.microsoft.com/editor.zip" },
    { url: "https://example.com/editor.zip" },
    { status: 503 },
  ]) {
    const { result, output } = await resolveEditor(invalid);

    expect(result.exitCode).not.toBe(0);

    expect(output).toBe("");
  }
});

async function downloadEditor(truncatedResponses: number) {
  const run = action.runs.steps.find((step) => step.id === "windows")?.run;

  assert.ok(run);

  const scratch = await mkdtemp(join(tmpdir(), "hesperia-editor-download-"));
  const payload = Buffer.alloc(4096, "editor archive fixture");
  let requests = 0;
  const server = createServer((socket) => {
    socket.once("data", () => {
      requests++;

      const body = requests <= truncatedResponses ? payload.subarray(0, 17) : payload;

      socket.end(
        Buffer.concat([
          Buffer.from(
            `HTTP/1.1 200 OK\r\nContent-Length: ${payload.length}\r\nConnection: close\r\n\r\n`,
          ),
          body,
        ]),
      );
    });
  });

  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const address = server.address();

    assert.ok(address && typeof address !== "string");

    const output = join(scratch, "outputs.txt");
    const script = join(scratch, "setup.ps1");

    await writeFile(output, "");

    await writeFile(script, `$ErrorActionPreference = 'Stop'\n${run}`);

    const child = Bun.spawn(["pwsh", "-NoProfile", "-File", script], {
      env: {
        ...process.env,
        RUNNER_TEMP: scratch,
        GITHUB_OUTPUT: output,
        CODE_VERSION: metadata.productVersion,
        CODE_COMMIT: metadata.version,
        CODE_SHA256: metadata.sha256hash,
        CODE_URL: `http://127.0.0.1:${address.port}/editor.zip`,
      },
      stdout: "ignore",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    const archive = join(scratch, `vscode-${metadata.productVersion}.zip`);

    return {
      exitCode,
      stderr,
      requests,
      output: await readFile(output, "utf8"),
      extracted: existsSync(join(scratch, `vscode-${metadata.productVersion}`)),
      archive: (await Bun.file(archive).exists()) ? await readFile(archive) : undefined,
      payload,
    };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });

    await rm(scratch, { recursive: true, force: true });
  }
}

test.skipIf(process.platform !== "win32")(
  "Windows editor setup retries a truncated archive before enforcing its checksum",
  async () => {
    const result = await downloadEditor(1);

    expect(result.requests).toBe(2);

    expect(result.archive).toEqual(result.payload);

    expect(result.exitCode).not.toBe(0);

    expect(result.stderr).toContain("archive SHA-256 mismatch");

    expect(result.output).toBe("");

    expect(result.extracted).toBe(false);
  },
  20000,
);

test.skipIf(process.platform !== "win32")(
  "Windows editor setup stops after bounded download failures before verifying an archive",
  async () => {
    const result = await downloadEditor(Infinity);

    expect(result.requests).toBe(4);

    expect(result.exitCode).not.toBe(0);

    expect(result.stderr).toContain("VS Code archive download failed");

    expect(result.stderr).not.toContain("archive SHA-256 mismatch");

    expect(result.archive).toBeUndefined();

    expect(result.output).toBe("");

    expect(result.extracted).toBe(false);
  },
  20000,
);

test.skipIf(process.platform !== "win32")(
  "Windows editor setup rejects a complete archive with a mismatched checksum without retrying",
  async () => {
    const result = await downloadEditor(0);

    expect(result.requests).toBe(1);

    expect(result.exitCode).not.toBe(0);

    expect(result.stderr).toContain("archive SHA-256 mismatch");

    expect(result.output).toBe("");

    expect(result.extracted).toBe(false);
  },
);
