import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

test.skipIf(process.platform !== "win32" && process.platform !== "linux")(
  "local editor admission follows the extension baseline while explicit versions and prefixes remain strict",
  async () => {
    const root = resolve(import.meta.dir, "../..");
    const manifest = JSON.parse(
      await readFile(resolve(root, "editors/vscode/package.json"), "utf8"),
    ) as { engines: { vscode: string } };
    const range = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(manifest.engines.vscode);

    if (!range)
      throw new Error(
        "The owning fixture requires the extension's declared caret compatibility range",
      );

    const major = Number(range[1]);
    const minor = Number(range[2]);
    const patch = Number(range[3]);
    const baseline = `${major}.${minor}.${patch}`;
    const future = `${major}.${minor + 7}.0`;
    const directory = await mkdtemp(resolve(tmpdir(), "hesperia-editor-version-"));

    try {
      const codePath =
        process.platform === "win32"
          ? resolve(directory, "Programs/Microsoft VS Code/Code.exe")
          : resolve(directory, "vscode/bin/code");

      await mkdir(resolve(codePath, ".."), { recursive: true });

      await writeFile(codePath, "unused metadata fixture");

      if (process.platform === "linux")
        await writeFile(resolve(directory, "vscode/code"), "unused executable fixture");

      const marker = resolve(directory, "capture-not-started");
      const preload = resolve(directory, "metadata.ts");

      await writeFile(
        preload,
        `
        import { mock } from 'bun:test';
        import * as fs from 'node:fs';
        import * as childProcess from 'node:child_process';
        const mkdirSync = fs.mkdirSync;
        mock.module('node:fs', () => ({ ...fs, mkdirSync(path, ...args) {
          if (String(path).includes('.hesperia') && String(path).includes('ec')) {
            fs.writeFileSync(${JSON.stringify(marker)}, 'version admitted; no capture started');
            throw new Error('Stopped before editor capture');
          }
          return mkdirSync(path, ...args);
        } }));
        mock.module('node:child_process', () => ({ ...childProcess, spawnSync(command) {
          if (command === 'which') return { status: 0, stdout: ${JSON.stringify(codePath)} };
          if (command === 'powershell' || command === ${JSON.stringify(codePath)}) {
            return { status: 0, stdout: process.env.HESPERIA_TEST_EDITOR_VERSION + '\\n', stderr: '' };
          }
          throw new Error('Unexpected metadata subprocess: ' + command);
        } }));
      `,
      );

      async function run(version: string, args: readonly string[] = []) {
        await rm(marker, { force: true });

        const child = Bun.spawn(
          [
            process.execPath,
            "--preload",
            preload,
            resolve(root, "scripts/ci/run-editor-coverage.ts"),
            ...args,
          ],
          {
            cwd: root,
            env: { ...process.env, LOCALAPPDATA: directory, HESPERIA_TEST_EDITOR_VERSION: version },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const [status, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);

        expect(status).not.toBe(0);

        return { output: stdout + stderr, admitted: existsSync(marker) };
      }

      for (const version of [baseline, future]) {
        const result = await run(version);

        expect(result.admitted, result.output).toBe(true);

        expect(result.output).toContain("Stopped before editor capture");
      }

      for (const version of [`${major}.${minor - 1}.99`, `${major + 1}.0.0`]) {
        const result = await run(version);

        expect(result.admitted).toBe(false);

        expect(result.output).toContain(
          `does not satisfy extension compatibility ${manifest.engines.vscode}`,
        );
      }

      const explicitMismatch = await run(future, [codePath, `${major}.${minor}`]);

      expect(explicitMismatch.admitted).toBe(false);

      expect(explicitMismatch.output).toContain(`does not match required ${major}.${minor}`);

      const oldVersion = `${major}.${minor - 1}.99`;
      const incompatibleIdentity = await run(oldVersion, [codePath, oldVersion]);

      expect(incompatibleIdentity.admitted).toBe(false);

      expect(incompatibleIdentity.output).toContain(
        `does not satisfy extension compatibility ${manifest.engines.vscode}`,
      );

      const patchVersion = `${major}.${minor}.${patch + 1}`;
      const exactMismatch = await run(patchVersion, [codePath, baseline]);

      expect(exactMismatch.admitted).toBe(false);

      expect(exactMismatch.output).toContain(`does not match required ${baseline}`);

      const prefixMatch = await run(patchVersion, [
        codePath,
        `${major}.${minor}`,
        "--verify=artifacts-and-native",
      ]);

      expect(prefixMatch.admitted).toBe(true);

      const privateDefault = await run(future, [codePath, "--verify=artifacts-and-native"]);

      expect(privateDefault.admitted).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);
