import assert from "node:assert/strict";
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
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { expect, test } from "bun:test";
import { archiveIntegrity } from "../../scripts/ci/release-candidate.ts";
import { readPinnedAeoliaVersion, writePackageManifest } from "./package-manifest.ts";
import { suppliedReleaseArchive } from "./release-candidate.ts";

const packageRoot = resolve(import.meta.dir, "../..");
const graphqlPackageRoot = resolve(packageRoot, "packages/graphql");

type PackageManifest = {
  readonly name?: string;
  readonly version?: string;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
};

type FixtureReady = {
  readonly type: "ready";
  readonly host: string;
  readonly port: number;
  readonly instanceId: string;
  readonly graphqlUrl: string;
  readonly controlUrl: string;
};

type CommandFailure = Error & {
  readonly command: readonly string[];
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number;
  readonly timedOut: boolean;
};

function isCommandFailure(error: unknown): error is CommandFailure {
  return (
    error instanceof Error &&
    "command" in error &&
    Array.isArray(error.command) &&
    "stdout" in error &&
    typeof error.stdout === "string" &&
    "stderr" in error &&
    typeof error.stderr === "string" &&
    "status" in error &&
    typeof error.status === "number" &&
    "timedOut" in error &&
    typeof error.timedOut === "boolean"
  );
}

type FixtureState = {
  readonly instanceId: string;
  readonly revision: number;
  readonly writes: readonly string[];
  readonly resolverCalls: { readonly state: number };
};

type FixtureProcess = {
  readonly child: ReturnType<typeof Bun.spawn>;
  readonly graphqlUrl: string;
  readonly controlUrl: string;
  readonly instanceId: string;
  readonly readyLine: string;
  readonly stderr: Promise<string>;
};

function isInside(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child));

  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function exactVersion(manifest: PackageManifest, name: string): string {
  const version = manifest.devDependencies?.[name] ?? manifest.dependencies?.[name];

  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version))
    throw new Error(`Expected an exact root dependency version for ${name}`);

  return version;
}

async function runCommand(
  command: readonly string[],
  cwd: string,
  timeoutMs = 30_000,
  env?: NodeJS.ProcessEnv,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const child = Bun.spawn([...command], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    ...(env ? { env } : {}),
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  clearTimeout(timeout);

  if (timedOut || status !== 0) {
    const failure = new Error(
      `${command.join(" ")} ${timedOut ? `timed out after ${timeoutMs} ms` : `failed (${status})`}\n${stdout}\n${stderr}`,
    ) as CommandFailure;

    Object.assign(failure, { command, stdout, stderr, status, timedOut });

    throw failure;
  }

  return { stdout, stderr };
}

function boundedTimeout(timeoutMs: number, deadlineAt: number): number {
  const remaining = deadlineAt - Date.now();

  if (remaining <= 0)
    throw new Error("GraphQL installed runtime test exceeded its 52-second work deadline");

  return Math.min(timeoutMs, remaining);
}

async function packGraphQL(workspace: string, deadlineAt: number): Promise<string> {
  const supplied = await suppliedReleaseArchive(graphqlPackageRoot);

  if (supplied) return supplied;

  const before = new Set(await readdir(workspace));

  await runCommand(
    [process.execPath, "pm", "pack", "--destination", workspace, "--ignore-scripts", "--quiet"],
    graphqlPackageRoot,
    boundedTimeout(10_000, deadlineAt),
  );

  const [name] = (await readdir(workspace)).filter(
    (item) => item.endsWith(".tgz") && !before.has(item),
  );

  if (!name) throw new Error(`Packing ${graphqlPackageRoot} produced no new tarball`);

  return join(workspace, name).replaceAll("\\", "/");
}

async function readReadyLine(
  child: ReturnType<typeof Bun.spawn>,
  stderr: Promise<string>,
  timeoutMs: number,
): Promise<string> {
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let output = "";
  let cancelled = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      (async () => {
        while (true) {
          const chunk = await reader.read();

          if (chunk.done) {
            if (cancelled) throw new Error("Stopped reading fixture readiness output");

            const [status, errors] = await Promise.all([child.exited, stderr]);

            throw new Error(
              `Yoga fixture exited before readiness (${status})\n${output}\n${errors}`,
            );
          }

          output += decoder.decode(chunk.value, { stream: true });
          const newline = output.indexOf("\n");

          if (newline >= 0) return output.slice(0, newline);
        }
      })(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () =>
            reject(new Error(`Timed out waiting for Yoga fixture readiness after ${timeoutMs} ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);

    cancelled = true;
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function startFixture(nodePath: string, deadlineAt: number): Promise<FixtureProcess> {
  const fixturePath = resolve(packageRoot, "tests/data/fixtures/graphql-server.fixture.mjs");
  const child = Bun.spawn([nodePath, fixturePath], {
    cwd: packageRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = new Response(child.stderr as ReadableStream<Uint8Array>).text();

  try {
    const readyLine = await readReadyLine(child, stderr, boundedTimeout(8_000, deadlineAt));
    let ready: FixtureReady;

    try {
      ready = JSON.parse(readyLine) as FixtureReady;
    } catch (error) {
      throw new Error(`Yoga fixture readiness was not JSON: ${readyLine}`, { cause: error });
    }

    if (
      ready.type !== "ready" ||
      ready.host !== "127.0.0.1" ||
      ready.port < 1 ||
      !ready.instanceId ||
      !ready.graphqlUrl ||
      !ready.controlUrl
    )
      throw new Error(`Yoga fixture returned invalid readiness data: ${JSON.stringify(ready)}`);

    return {
      child,
      graphqlUrl: ready.graphqlUrl,
      controlUrl: ready.controlUrl,
      instanceId: ready.instanceId,
      readyLine,
      stderr,
    };
  } catch (error) {
    child.kill();
    await child.exited;
    const errors = await stderr;
    const reason = error instanceof Error ? error.message : String(error);

    throw new Error(`Unable to start the Node Yoga fixture: ${reason}\n${errors}`, {
      cause: error,
    });
  }
}

async function stopFixture(fixture: FixtureProcess): Promise<string> {
  try {
    const response = await fetch(`${fixture.controlUrl}/shutdown`, {
      method: "POST",
      signal: AbortSignal.timeout(2_000),
    });

    await response.arrayBuffer();
  } catch {
    fixture.child.kill();
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const exited = await Promise.race([
    fixture.child.exited.then(() => true),
    new Promise<false>((resolveTimeout) => {
      timeout = setTimeout(() => resolveTimeout(false), 5_000);
    }),
  ]);

  if (timeout !== undefined) clearTimeout(timeout);

  if (!exited) {
    fixture.child.kill();
    await fixture.child.exited;
  }

  return fixture.stderr;
}

async function checkEvidenceDirectory(
  evidenceDirectory: string,
  checkoutRoot: string,
  workspaceRoot: string,
): Promise<string> {
  if (!isAbsolute(evidenceDirectory))
    throw new Error("HESPERIA_GRAPHQL_PACKAGE_EVIDENCE_DIR must be an absolute path");

  const path = resolve(evidenceDirectory);

  if (
    isInside(checkoutRoot, path) ||
    isInside(path, checkoutRoot) ||
    path === checkoutRoot ||
    isInside(workspaceRoot, path) ||
    path === workspaceRoot
  )
    throw new Error("GraphQL package evidence must be written outside the source checkout");

  await mkdir(path, { recursive: true });

  const evidenceRealPath = await realpath(path);

  if (
    isInside(checkoutRoot, evidenceRealPath) ||
    isInside(evidenceRealPath, checkoutRoot) ||
    evidenceRealPath === checkoutRoot ||
    isInside(workspaceRoot, evidenceRealPath) ||
    evidenceRealPath === workspaceRoot
  )
    throw new Error("GraphQL package evidence resolves inside a protected source or temp path");

  return evidenceRealPath;
}

test("an installed GraphQL archive executes its public Apollo adapter against the Node Yoga fixture", async () => {
  const nodeOverride = process.env.HESPERIA_GRAPHQL_NODE;

  if (nodeOverride !== undefined && !isAbsolute(nodeOverride))
    throw new Error(
      "HESPERIA_GRAPHQL_NODE must be an absolute Node 22.23.2 executable path when supplied",
    );

  const nodePath = nodeOverride ?? Bun.which("node");

  if (!nodePath)
    throw new Error(
      "Node 22.23.2 was not found on PATH; install it or set HESPERIA_GRAPHQL_NODE to its absolute executable path",
    );

  const tempRoot = await realpath(resolve(tmpdir()));
  const checkoutRoot = await realpath(packageRoot);

  if (
    isInside(checkoutRoot, tempRoot) ||
    isInside(tempRoot, checkoutRoot) ||
    tempRoot === checkoutRoot
  )
    throw new Error(`The system temp directory is not external to the checkout: ${tempRoot}`);

  const deadlineAt = Date.now() + 52_000;
  const workspace = await mkdtemp(join(tempRoot, "graphql-installed-runtime-"));
  const application = join(workspace, "consumer app");
  const workspaceRealPath = await realpath(workspace);
  const sourceConsumer = resolve(import.meta.dir, "fixtures/graphql-runtime.mjs");
  let evidenceRoot: string | undefined;
  const evidence: Record<string, unknown> = { phase: "workspace-created" };
  let fixture: FixtureProcess | undefined;
  let passed = false;

  async function saveEvidence(): Promise<void> {
    if (!evidenceRoot) return;

    await writeFile(
      join(evidenceRoot, "graphql-installed-runtime.json"),
      `${JSON.stringify(evidence, null, 2)}\n`,
    );
  }

  try {
    if (
      !isInside(tempRoot, workspaceRealPath) ||
      isInside(checkoutRoot, workspaceRealPath) ||
      isInside(workspaceRealPath, checkoutRoot)
    )
      throw new Error(`GraphQL runtime app escaped its external temp root: ${workspace}`);

    await mkdir(application, { recursive: true });

    const applicationRealPath = await realpath(application);

    if (
      !isInside(workspaceRealPath, applicationRealPath) ||
      isInside(checkoutRoot, applicationRealPath) ||
      isInside(applicationRealPath, checkoutRoot)
    )
      throw new Error(`Installed consumer escaped its owned temp app: ${application}`);

    const evidenceDirectory = process.env.HESPERIA_GRAPHQL_PACKAGE_EVIDENCE_DIR;

    if (evidenceDirectory)
      evidenceRoot = await checkEvidenceDirectory(
        evidenceDirectory,
        checkoutRoot,
        workspaceRealPath,
      );

    const [rootManifestText, graphqlManifestText] = await Promise.all([
      readFile(resolve(packageRoot, "package.json"), "utf8"),
      readFile(resolve(graphqlPackageRoot, "package.json"), "utf8"),
    ]);
    const rootManifest = JSON.parse(rootManifestText) as PackageManifest;
    const graphqlManifest = JSON.parse(graphqlManifestText) as PackageManifest;
    const rootAeolia = await readPinnedAeoliaVersion(packageRoot);
    const packageDependencies = graphqlManifest.dependencies ?? {};
    const packagePeers = graphqlManifest.peerDependencies ?? {};
    const packageName = graphqlManifest.name;
    const packageVersion = graphqlManifest.version;

    assert.ok(packageName, "GraphQL package manifest has no name");
    assert.equal(packageName, "@hesperia/graphql", "Unexpected GraphQL package name");
    assert.ok(packageVersion, "GraphQL package manifest has no version");
    expect(packageVersion).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u);
    assert.ok(packageDependencies["@apollo/client"], "GraphQL package must declare Apollo Client");

    const nativeVersions = Object.fromEntries(
      [...new Set([...Object.keys(packagePeers), ...Object.keys(packageDependencies)])]
        .sort()
        .map((name) => {
          const rootVersion = name === "aeolia" ? rootAeolia : exactVersion(rootManifest, name);

          if (packagePeers[name] !== undefined) expect(packagePeers[name]).toBe(rootVersion);
          if (packageDependencies[name] !== undefined)
            expect(packageDependencies[name]).toBe(rootVersion);

          return [name, rootVersion];
        }),
    );
    const versions = { [packageName]: packageVersion, ...nativeVersions };
    const nativeOverrides = {
      ...nativeVersions,
      "@graphql-typed-document-node/core": "3.2.0",
      "@wry/caches": "1.0.1",
      "@wry/context": "0.7.4",
      "@wry/equality": "0.5.7",
      "@wry/trie": "0.5.0",
      "graphql-tag": "2.12.7",
      optimism: "0.18.1",
      tslib: "2.8.1",
    };

    const cachePreparationRoot = join(workspace, "native-cache-preparation");
    const nativeCacheRoot = join(workspace, "native-install-cache");
    const nativeInstallEnv = { ...process.env, BUN_INSTALL_CACHE_DIR: nativeCacheRoot };

    await mkdir(cachePreparationRoot);
    await mkdir(nativeCacheRoot);

    const cachePreparationManifest = {
      name: "hesperia-graphql-native-cache-preparation",
      private: true,
      dependencies: nativeOverrides,
      overrides: nativeOverrides,
    };

    await writePackageManifest(
      join(cachePreparationRoot, "package.json"),
      cachePreparationManifest,
    );

    evidence.phase = "preparing-native-cache";
    evidence.cachePreparationManifest = cachePreparationManifest;
    await saveEvidence();

    const cachePreparation = await runCommand(
      [process.execPath, "install", "--ignore-scripts"],
      cachePreparationRoot,
      boundedTimeout(25_000, deadlineAt),
      nativeInstallEnv,
    );
    const cachePreparationLock = await readFile(join(cachePreparationRoot, "bun.lock"), "utf8");

    evidence.cachePreparation = cachePreparation;
    evidence.cachePreparationLockIntegrity = archiveIntegrity(
      new TextEncoder().encode(cachePreparationLock),
    );

    if (evidenceRoot) {
      await copyFile(
        join(cachePreparationRoot, "package.json"),
        join(evidenceRoot, "cache-package.json"),
      );
      await writeFile(join(evidenceRoot, "cache-bun.lock"), cachePreparationLock);
    }

    await saveEvidence();

    const archive = await packGraphQL(workspace, deadlineAt);
    const archiveBytes = await readFile(archive);
    const archiveReceipt = {
      path: archive,
      package: packageName,
      version: packageVersion,
      integrity: archiveIntegrity(archiveBytes),
    };
    const appManifestPath = join(application, "package.json");
    const applicationManifest = {
      name: "hesperia-graphql-installed-runtime-consumer",
      private: true,
      type: "module",
      dependencies: {
        ...nativeVersions,
        [packageName]: archive,
      },
      overrides: nativeOverrides,
    };

    evidence.phase = "archive-created";
    evidence.archive = archiveReceipt;
    evidence.applicationManifest = applicationManifest;

    if (evidenceRoot) await copyFile(archive, join(evidenceRoot, basename(archive)));

    await writePackageManifest(appManifestPath, applicationManifest);
    await copyFile(sourceConsumer, join(application, "graphql-runtime.mjs"));
    evidence.phase = "manifest-written";

    if (evidenceRoot) await copyFile(appManifestPath, join(evidenceRoot, "package.json"));

    await saveEvidence();

    const install = await runCommand(
      [process.execPath, "install", "--ignore-scripts", "--offline"],
      application,
      boundedTimeout(25_000, deadlineAt),
      nativeInstallEnv,
    );
    evidence.install = install;

    const generatedLock = await readFile(join(application, "bun.lock"), "utf8");
    const generatedLockIntegrity = archiveIntegrity(new TextEncoder().encode(generatedLock));
    evidence.phase = "installed";
    evidence.generatedLockIntegrity = generatedLockIntegrity;

    if (evidenceRoot) await writeFile(join(evidenceRoot, "bun.lock"), generatedLock);

    await saveEvidence();

    const runningFixture = await startFixture(nodePath, deadlineAt);

    fixture = runningFixture;
    evidence.phase = "fixture-ready";
    evidence.fixtureReadyLine = runningFixture.readyLine;
    await saveEvidence();

    const consumer = await runCommand(
      [
        nodePath,
        join(application, "graphql-runtime.mjs"),
        runningFixture.graphqlUrl,
        runningFixture.controlUrl,
        checkoutRoot,
        runningFixture.instanceId,
        JSON.stringify({
          ...versions,
        }),
      ],
      application,
      boundedTimeout(12_000, deadlineAt),
    );
    evidence.consumerStdout = consumer.stdout;
    evidence.consumerStderr = consumer.stderr;
    evidence.phase = "consumer-complete";
    await saveEvidence();

    const receipt = JSON.parse(consumer.stdout.trim()) as {
      readonly nodeVersion: string;
      readonly fixtureInstanceId: string;
      readonly entrypoints: Record<string, string>;
      readonly installedVersions: Record<string, string>;
      readonly partial: {
        readonly ok: string;
        readonly broken: string | null;
        readonly errorMessage: string;
        readonly errorPath: readonly string[];
        readonly extensionInstanceId: string;
      };
      readonly failure: {
        readonly message: string;
        readonly errorName: string;
        readonly executionMessage: string;
        readonly causeName: string;
        readonly value: string;
        readonly failedField: string | null;
        readonly errorPath: readonly string[];
        readonly extensionInstanceId: string;
      };
      readonly stateBefore: FixtureState;
      readonly stateAfter: FixtureState;
    };

    // Bun's asymmetric matchers can replace fields on the received object.
    evidence.runtime = structuredClone(receipt);
    await saveEvidence();

    expect(receipt.nodeVersion).toBe("22.23.2");
    expect(receipt.fixtureInstanceId).toBe(runningFixture.instanceId);
    expect(receipt.installedVersions).toEqual(versions);
    expect(receipt.partial).toMatchObject({
      ok: "partial-ok",
      broken: null,
      errorMessage: "fixture partial field failure",
      errorPath: ["partial", "broken"],
      extensionInstanceId: receipt.fixtureInstanceId,
    });
    expect(receipt.failure).toMatchObject({
      message: expect.stringContaining("fixture mutation field failure"),
      errorName: "Error",
      executionMessage: "fixture mutation field failure",
      causeName: "CombinedGraphQLErrors",
      value: "installed-failed-write",
      failedField: null,
      errorPath: ["writeThenFail", "failure"],
      extensionInstanceId: receipt.fixtureInstanceId,
    });
    expect(receipt.stateBefore.resolverCalls.state).toBe(1);
    expect(receipt.stateAfter.resolverCalls.state).toBe(1);
    expect(receipt.stateAfter.revision).toBe(1);
    expect(receipt.stateAfter.writes).toEqual(["installed-failed-write"]);

    evidence.fixtureStderr = await stopFixture(runningFixture);
    fixture = undefined;
    evidence.phase = "passed";
    await saveEvidence();
    passed = true;
  } catch (error) {
    evidence.phase = "failed";
    evidence.failure = {
      message: error instanceof Error ? error.message : String(error),
      ...(isCommandFailure(error)
        ? {
            command: error.command,
            stdout: error.stdout,
            stderr: error.stderr,
            status: error.status,
            timedOut: error.timedOut,
          }
        : {}),
    };

    await saveEvidence();
    console.error(`Retained failed GraphQL consumer app at ${application}`);
    throw error;
  } finally {
    if (fixture) {
      evidence.fixtureStderr = await stopFixture(fixture);
      fixture = undefined;
      await saveEvidence();
    }
  }

  if (passed) {
    const workspaceRealPath = await realpath(workspace);

    if (
      !isInside(tempRoot, workspaceRealPath) ||
      isInside(checkoutRoot, workspaceRealPath) ||
      isInside(workspaceRealPath, checkoutRoot)
    )
      throw new Error(`Refusing to remove an unsafe GraphQL runtime app path: ${workspace}`);

    await rm(workspace, { recursive: true, force: true });
  }
}, 60_000);
