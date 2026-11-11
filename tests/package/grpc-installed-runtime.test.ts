import { expect, test } from "bun:test";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { archiveIntegrity } from "../../scripts/ci/release-candidate.ts";
import { suppliedReleaseArchive } from "./release-candidate.ts";

const root = resolve(import.meta.dir, "../..");
const grpcRoot = join(root, "packages/grpc");

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

async function run(command: string[], cwd: string, timeoutMs: number): Promise<string> {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  let timedOut = false;
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
    forceTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
  }, timeoutMs);
  try {
    const [status, out, err] = await Promise.all([child.exited, stdout, stderr]);
    if (timedOut || status !== 0)
      throw new Error(
        `${command.join(" ")} ${timedOut ? "timed out" : `exited ${status}`}\n${out}\n${err}`,
      );
    return out;
  } finally {
    clearTimeout(timer);
    if (forceTimer) clearTimeout(forceTimer);
  }
}

test("installed gRPC archive serves the native HTTP/2 consumer", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "hesperia-grpc-installed-"));
  const workspaceReal = await realpath(workspace);
  const tempReal = await realpath(tmpdir());
  const checkoutReal = await realpath(root);
  if (
    !inside(tempReal, workspaceReal) ||
    inside(checkoutReal, workspaceReal) ||
    inside(workspaceReal, checkoutReal)
  )
    throw new Error(`Installed consumer is not in an independent temp directory: ${workspaceReal}`);
  const app = join(workspace, "consumer");
  let passed = false;
  try {
    await mkdir(app);
    let archive = await suppliedReleaseArchive(grpcRoot);
    if (!archive) {
      await run(
        [process.execPath, "pm", "pack", "--destination", workspace, "--ignore-scripts", "--quiet"],
        grpcRoot,
        20_000,
      );
      const archives = (await readdir(workspace)).filter((name) => name.endsWith(".tgz"));
      if (archives.length !== 1) throw new Error(`Expected one archive, found ${archives.length}`);
      archive = join(workspace, archives[0]!);
    }

    const rootManifest = await Bun.file(join(root, "package.json")).json();
    const versions = rootManifest.devDependencies as Record<string, string>;
    const names = [
      "@bufbuild/protobuf",
      "@connectrpc/connect",
      "@connectrpc/connect-node",
      "@types/node",
      "aeolia",
    ];
    const dependencies: Record<string, string> = { "@hesperia/grpc": archive };
    for (const name of names) {
      const version = versions[name];
      if (!version || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/u.test(version))
        throw new Error(`Expected exact ${name} version`);
      dependencies[name] = version;
    }
    await writeFile(
      join(app, "package.json"),
      `${JSON.stringify({ name: "grpc-installed-consumer", private: true, type: "module", dependencies }, null, 2)}\n`,
    );
    await run(
      [process.execPath, "install", "--ignore-scripts", "--backend", "copyfile"],
      app,
      90_000,
    );

    const consumer = join(app, "tests/package/fixtures");
    const fixture = join(app, "tests/data/fixtures");
    await mkdir(consumer, { recursive: true });
    await mkdir(join(fixture, "grpc"), { recursive: true });
    await copyFile(
      join(root, "tests/package/fixtures/grpc-native.mts"),
      join(consumer, "grpc-native.mts"),
    );
    await copyFile(
      join(root, "tests/data/fixtures/grpc/service-all_pb.ts"),
      join(fixture, "grpc/service-all_pb.ts"),
    );
    await copyFile(
      join(root, "tests/data/fixtures/grpc-server.fixture.mjs"),
      join(fixture, "grpc-server.fixture.mjs"),
    );
    const config = join(app, "tsconfig.json");
    await writeFile(
      config,
      `${JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmitOnError: true, skipLibCheck: false, types: ["node"], rootDir: "tests", outDir: "emitted" }, files: ["tests/package/fixtures/grpc-native.mts", "tests/data/fixtures/grpc/service-all_pb.ts"] }, null, 2)}\n`,
    );
    await run(
      [process.execPath, join(root, "node_modules/typescript/bin/tsc"), "--project", config],
      app,
      35_000,
    );

    const override = process.env.HESPERIA_GRPC_NODE;
    if (override && !isAbsolute(override))
      throw new Error("HESPERIA_GRPC_NODE must be an absolute path");
    const node = override ?? "node";
    const output = await run(
      [
        node,
        join(app, "emitted/package/fixtures/grpc-native.mjs"),
        join(fixture, "grpc-server.fixture.mjs"),
      ],
      app,
      35_000,
    );
    const records = output
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line));
    const ready = records.filter((record) => record.event === "server-ready");
    const completed = records.filter((record) => record.event === "completed");
    expect(ready).toHaveLength(1);
    expect(completed).toHaveLength(1);
    const result = completed[0];
    expect(result.nodeVersion).toBe("22.23.2");
    if (override) expect(await realpath(result.nodeExecutable)).toBe(await realpath(override));
    expect(result.clientSessionState).toBe("closed");
    expect(result.serverCleanup).toBe("complete");
    for (const check of [
      "query-mutation-effects",
      "error-details",
      "deadline",
      "unary-cancel",
      "stream",
      "late-error",
      "early-return",
    ])
      expect(result.checks).toContain(check);
    const installed = await realpath(join(app, "node_modules/@hesperia/grpc"));
    expect(inside(await realpath(app), installed)).toBe(true);
    expect(await realpath(fileURLToPath(result.moduleResolutions.hesperiaGrpc))).toBe(
      await realpath(join(installed, "dist/index.js")),
    );
    expect(await realpath(fileURLToPath(result.moduleResolutions.hesperiaGrpcNative))).toBe(
      await realpath(join(installed, "dist/native.js")),
    );
    const receipt = {
      archiveIntegrity: archiveIntegrity(await readFile(archive)),
      consumerLockIntegrity: archiveIntegrity(await readFile(join(app, "bun.lock"))),
      nodeExecutable: result.nodeExecutable,
      nodeVersion: result.nodeVersion,
      moduleResolutions: result.moduleResolutions,
      checks: result.checks,
      clientSessionState: result.clientSessionState,
      serverCleanup: result.serverCleanup,
    };
    const evidenceRoot = process.env.HESPERIA_GRPC_PACKAGE_EVIDENCE_DIR;
    if (evidenceRoot) {
      if (!isAbsolute(evidenceRoot))
        throw new Error("HESPERIA_GRPC_PACKAGE_EVIDENCE_DIR must be absolute");
      const evidenceRootReal = await realpath(evidenceRoot);
      if (evidenceRootReal === workspaceReal || inside(workspaceReal, evidenceRootReal))
        throw new Error("Installed evidence directory must be outside the consumer workspace");
      const evidence = await mkdtemp(join(evidenceRootReal, "grpc-installed-"));
      await copyFile(archive, join(evidence, "hesperia-grpc.tgz"));
      await copyFile(join(app, "package.json"), join(evidence, "package.json"));
      await copyFile(join(app, "bun.lock"), join(evidence, "bun.lock"));
      await writeFile(
        join(evidence, "receipt.json"),
        `${JSON.stringify({ ...receipt, records }, null, 2)}\n`,
      );
      console.info(`Installed gRPC evidence: ${evidence}`);
    }
    console.info(`Installed gRPC receipt: ${JSON.stringify(receipt)}`);
    passed = true;
  } finally {
    if (passed) await rm(workspaceReal, { recursive: true, force: true });
    else console.error(`Retained failed installed gRPC consumer: ${workspace}`);
  }
}, 180_000);
