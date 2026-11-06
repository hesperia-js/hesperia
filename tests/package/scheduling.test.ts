import { expect, test } from "bun:test";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const workspaceRoot = resolve(import.meta.dir, "../..");
const packageRoot = resolve(workspaceRoot, "packages/hesperia");
const probe = resolve(workspaceRoot, "tests/package/fixtures/scheduling-probe.mjs");

const qualifiedNodeProfiles = [
  { version: "24.22.0", pathVariable: "HESPERIA_SCHEDULING_NODE_24_22_0_EXE" },
  { version: "26.10.0", pathVariable: "HESPERIA_SCHEDULING_NODE_26_10_0_EXE" },
  { version: "26.12.0", pathVariable: "HESPERIA_SCHEDULING_NODE_26_12_0_EXE" },
] as const;

const fallbackNodeProfile = {
  version: "22.23.2",
  pathVariable: "HESPERIA_SCHEDULING_NODE_22_23_2_EXE",
} as const;

type NodeProfile = { readonly version: string; readonly pathVariable: string };

interface ChildResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

class ChildSpawnError extends Error {
  constructor(cause: unknown) {
    super("Could not start the scheduling child process", { cause });
    this.name = "ChildSpawnError";
  }
}

class ChildPipeError extends Error {
  constructor(cause: unknown) {
    super("Scheduling child output could not be collected", { cause });
    this.name = "ChildPipeError";
  }
}

class ChildWatchdogError extends Error {
  constructor() {
    const record = {
      kind: "scheduling-child-watchdog",
      status: "timed_out",
      measurement: "unmeasured",
      timeoutMs: 20_000,
    };

    super(JSON.stringify(record));
    this.name = "ChildWatchdogError";
  }
}

async function runChild(executable: string, args: readonly string[]): Promise<ChildResult> {
  let child: Bun.Subprocess<"ignore", "pipe", "pipe">;

  try {
    child = Bun.spawn([executable, ...args], {
      cwd: workspaceRoot,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    throw new ChildSpawnError(error);
  }

  let exited = false;
  const childExited = child.exited.then(
    (code) => {
      exited = true;
      return code;
    },
    (error: unknown) => {
      exited = true;
      throw error;
    },
  );
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const watchdog = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => reject(new ChildWatchdogError()), 20_000);
  });

  try {
    const [code, stdout, stderr] = await Promise.race([
      Promise.all([
        childExited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]),
      watchdog,
    ]);

    return { code, stdout, stderr };
  } catch (error) {
    if (error instanceof ChildWatchdogError) throw error;

    throw new ChildPipeError(error);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);

    if (!exited) {
      try {
        child.kill();
      } catch {}

      await childExited.catch(() => undefined);
    }
  }
}

function prerequisiteFailure(profile: NodeProfile, reason: string, cause?: unknown): Error {
  const record = {
    kind: "scheduling-runtime-prerequisite",
    status: "unsupported",
    measurement: "unmeasured",
    requiredVersion: profile.version,
    pathVariable: profile.pathVariable,
    reason,
  };

  const message = `Node scheduling profile prerequisite missing: ${JSON.stringify(record)}`;

  return cause === undefined ? new Error(message) : new Error(message, { cause });
}

async function runQualifiedChild(
  profile: NodeProfile,
  executable: string,
  args: readonly string[],
): Promise<ChildResult> {
  try {
    return await runChild(executable, args);
  } catch (error) {
    if (!(error instanceof ChildSpawnError)) throw error;

    throw prerequisiteFailure(profile, "The configured executable could not be started", error);
  }
}

async function verifyNaturalLiveness(profile: NodeProfile, executable: string): Promise<void> {
  const livenessActions = [
    ["debounce:unref-before", ["armed"]],
    ["debounce:unref-after", ["armed"]],
    ["debounce:ref-after", ["armed", "fired"]],
    ["throttle:unref-before", ["first", "armed"]],
    ["throttle:unref-after", ["first", "armed"]],
    ["throttle:ref-after", ["first", "armed", "second"]],
  ] as const;

  for (const [action, expectedEvents] of livenessActions) {
    const liveness = await runQualifiedChild(profile, executable, [
      probe,
      "liveness",
      profile.version,
      action,
    ]);

    expect(liveness.code, liveness.stderr || liveness.stdout).toBe(0);

    const records = liveness.stdout
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line) as { readonly runtime?: string; readonly event?: string });

    expect(records[0]).toEqual({ runtime: profile.version });
    expect(records.slice(1).map((record) => record.event)).toEqual([...expectedEvents]);
  }
}

test(
  "the emitted default scheduling artifact satisfies the public contract by file URL",
  async () => {
    const manifest = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8")) as {
      readonly exports?: Record<string, unknown>;
    };
    const schedulingExport = manifest.exports?.["./scheduling"];

    expect(schedulingExport).toBeDefined();
    expect(typeof schedulingExport).toBe("object");
    expect(schedulingExport).not.toBeNull();

    const targets = schedulingExport as {
      readonly default?: unknown;
      readonly node?: { readonly import?: unknown };
    };

    expect(typeof targets.default).toBe("string");
    expect(typeof targets.node?.import).toBe("string");

    const defaultEntry = pathToFileURL(resolve(packageRoot, targets.default as string)).href;
    const nativeEntry = pathToFileURL(resolve(packageRoot, targets.node?.import as string)).href;
    const result = await runChild(process.execPath, [probe, "default-contract", defaultEntry]);

    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toMatchObject({
      status: "passed",
      runtime: "bun",
      entryUrl: defaultEntry,
    });
    expect(defaultEntry).not.toBe(nativeEntry);
  },
  { timeout: 60_000 },
);

for (const profile of qualifiedNodeProfiles) {
  test(
    `Node ${profile.version} resolves the native public subpath and preserves scheduling behavior`,
    async () => {
      const executable = process.env[profile.pathVariable];

      if (executable === undefined || executable.length === 0)
        throw prerequisiteFailure(
          profile,
          "No explicit executable path was configured; no download attempted",
        );

      if (!isAbsolute(executable))
        throw prerequisiteFailure(profile, "The configured executable path is not absolute");

      const manifest = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8")) as {
        readonly exports?: Record<string, unknown>;
      };
      const schedulingExport = manifest.exports?.["./scheduling"];

      expect(schedulingExport).toBeDefined();
      expect(typeof schedulingExport).toBe("object");
      expect(schedulingExport).not.toBeNull();

      const targets = schedulingExport as {
        readonly default?: unknown;
        readonly node?: { readonly import?: unknown };
      };
      const nativeTarget = targets.node?.import;

      expect(typeof targets.default).toBe("string");
      expect(typeof nativeTarget).toBe("string");

      const defaultEntry = pathToFileURL(resolve(packageRoot, targets.default as string)).href;
      const nativeTargetPath = resolve(packageRoot, nativeTarget as string);
      const nativeEntry = pathToFileURL(nativeTargetPath).href;
      const expectedNativePath = await realpath(nativeTargetPath);
      expect(defaultEntry).not.toBe(nativeEntry);
      const result = await runQualifiedChild(profile, executable, [
        probe,
        "native-contract",
        profile.version,
        nativeEntry,
        defaultEntry,
      ]);

      expect(result.code, result.stderr || result.stdout).toBe(0);
      const nativeResult = JSON.parse(result.stdout.trim()) as {
        readonly nativeDelegations?: {
          readonly debounce?: number;
          readonly throttle?: number;
        };
      };

      expect(nativeResult).toMatchObject({
        status: "passed",
        profile: "native",
        runtime: profile.version,
        nativeReference: "passed",
        portableDefault: "passed",
      });
      expect(nativeResult.nativeDelegations?.debounce).toBeGreaterThan(0);
      expect(nativeResult.nativeDelegations?.throttle).toBeGreaterThan(0);
      expect(
        (JSON.parse(result.stdout.trim()) as { readonly artifactPath?: string }).artifactPath,
      ).toBe(expectedNativePath);

      await verifyNaturalLiveness(profile, executable);
    },
    { timeout: 60_000 },
  );
}

test(
  "Node 22.23.2 fallback behavior and liveness",
  async () => {
    const executable = process.env[fallbackNodeProfile.pathVariable];

    if (executable === undefined || executable.length === 0)
      throw prerequisiteFailure(
        fallbackNodeProfile,
        "No explicit executable path was configured; no download attempted",
      );

    if (!isAbsolute(executable))
      throw prerequisiteFailure(
        fallbackNodeProfile,
        "The configured executable path is not absolute",
      );

    const manifest = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8")) as {
      readonly exports?: Record<string, unknown>;
    };
    const schedulingExport = manifest.exports?.["./scheduling"];

    expect(schedulingExport).toBeDefined();
    expect(typeof schedulingExport).toBe("object");
    expect(schedulingExport).not.toBeNull();

    const targets = schedulingExport as {
      readonly default?: unknown;
      readonly node?: { readonly import?: unknown };
    };

    expect(typeof targets.default).toBe("string");
    expect(typeof targets.node?.import).toBe("string");

    const defaultEntry = pathToFileURL(resolve(packageRoot, targets.default as string)).href;
    const nodeEntryPath = resolve(packageRoot, targets.node?.import as string);
    const nodeEntry = pathToFileURL(nodeEntryPath).href;
    const expectedNodePath = await realpath(nodeEntryPath);
    const result = await runQualifiedChild(fallbackNodeProfile, executable, [
      probe,
      "fallback-contract",
      fallbackNodeProfile.version,
      nodeEntry,
      defaultEntry,
    ]);

    expect(defaultEntry).not.toBe(nodeEntry);
    expect(result.code, result.stderr || result.stdout).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toMatchObject({
      status: "passed",
      profile: "fallback",
      runtime: fallbackNodeProfile.version,
      portableDefault: "passed",
    });
    expect(
      (JSON.parse(result.stdout.trim()) as { readonly artifactPath?: string }).artifactPath,
    ).toBe(expectedNodePath);

    await verifyNaturalLiveness(fallbackNodeProfile, executable);
  },
  { timeout: 60_000 },
);
