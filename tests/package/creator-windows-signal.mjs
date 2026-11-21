import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dlopen } from "bun:ffi";
import { admitCreatorWindowsConsole } from "./creator-windows-console.mjs";

// This process owns only the installed-Creator cancellation fixture.
const [driver, entry, destination, registryUrl, proofUrl, cache, outputRoot] =
  process.argv.slice(2);
if (!outputRoot || process.platform !== "win32" || process.arch !== "x64")
  throw new Error("Invalid Creator Windows fixture.");
mkdirSync(outputRoot);
const startedPath = join(outputRoot, "installer-started.json");
const exitedPath = join(outputRoot, "installer-exited.json");
const killPath = join(outputRoot, "installer-kill.jsonl");
const witnessReady = join(outputRoot, "witness-ready");
const nonce = crypto.randomUUID();
const support = dirname(fileURLToPath(import.meta.url));
const observer = join(support, "creator-windows-observer.mjs");
const witnessSource = join(support, "creator-windows-witness.mjs");
const requireValue = (value, message) => {
  if (!value) throw new Error(message);
};
const wait = (ms) => Bun.sleep(ms);
let admission;
let apiLibrary;
let controller;
let witness;
let cli;
let installer;
let witnessChild;
let cliChild;
let witnessExit;
let cliExit;
let masked = false;
let clean = false;
let closeAttempted = false;
let consoleDetached = false;
let primaryFailed = false;
let primaryError;
const cleanupErrors = [];
const retained = [];
try {
  admission = admitCreatorWindowsConsole(() => {
    throw new Error("Controller received Ctrl+C.");
  });
  controller = admission.openVerifiedLiveMember(process.pid);
  retained.push(controller);
  witnessChild = Bun.spawn(
    [process.execPath, "--no-env-file", "--no-install", witnessSource, witnessReady],
    {
      cwd: driver,
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  witnessExit = witnessChild.exited;
  void witnessExit.catch(() => {});
  const witnessDeadline = Date.now() + 10000;
  while (!existsSync(witnessReady) && Date.now() < witnessDeadline) await wait(20);
  requireValue(existsSync(witnessReady), "Witness did not start.");
  witness = admission.openVerifiedLiveMember(witnessChild.pid);
  retained.push(witness);
  const witnessParent = admission.verifyParent(witness, controller);
  const witnessStart = Date.now();
  while (Date.now() - witnessStart < 2500) {
    admission.recheckMember(witness);
    await wait(50);
  }
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toLowerCase().includes("registry")),
  );
  const env = {
    ...inherited,
    BUN_CONFIG_REGISTRY: registryUrl,
    npm_config_registry: registryUrl,
    BUN_INSTALL_CACHE_DIR: cache,
    HESPERIA_PROTOTYPE_INSTALLER_STARTED: startedPath,
    HESPERIA_PROTOTYPE_INSTALLER_EXITED: exitedPath,
    HESPERIA_PROTOTYPE_INSTALLER_KILL: killPath,
    HESPERIA_PROTOTYPE_NONCE: nonce,
  };
  const keys = Object.keys(env).map((key) => key.toLowerCase());
  requireValue(new Set(keys).size === keys.length, "Duplicate Windows environment keys.");
  const registry = new URL(registryUrl);
  requireValue(
    registry.protocol === "http:" && registry.hostname === "127.0.0.1",
    "Registry is not loopback.",
  );
  cliChild = Bun.spawn(
    [process.execPath, "--preload", observer, entry, destination, "--json", "--host", "none"],
    {
      cwd: driver,
      env,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const deadline = Date.now() + 30000;
  cliExit = cliChild.exited;
  void cliExit.catch(() => {});
  let stdout = new Response(cliChild.stdout).text();
  void stdout.catch(() => {});
  let stderr = new Response(cliChild.stderr).text();
  void stderr.catch(() => {});
  let started;
  let held;
  while (Date.now() < deadline) {
    if (existsSync(startedPath)) started = JSON.parse(readFileSync(startedPath, "utf8"));
    const response = await fetch(proofUrl, { signal: AbortSignal.timeout(1000) });
    held = await response.json();
    if (started && held.live && held.ageMs < 9000) break;
    await wait(20);
  }
  requireValue(
    started?.event === "spawned" &&
      started.nonce === nonce &&
      started.cliPid === cliChild.pid &&
      held?.live &&
      held.ageMs < 9000,
    "Real installer or held registry request was not observed.",
  );
  cli = admission.openVerifiedLiveMember(cliChild.pid);
  installer = admission.openVerifiedLiveMember(started.installerPid);
  retained.push(cli, installer);
  const cliParent = admission.verifyParent(cli, controller);
  const installerParent = admission.verifyParent(installer, cli);
  const holdStart = Date.now();
  while (Date.now() - holdStart < 2000) {
    requireValue(
      Date.now() - holdStart <= 2500 && Date.now() < deadline,
      "Installer hold exceeded its bound.",
    );
    for (const member of retained) admission.recheckMember(member);
    const response = await fetch(proofUrl, { signal: AbortSignal.timeout(1000) });
    held = await response.json();
    requireValue(held.live && held.ageMs < 9000, "Registry request ended during installer hold.");
    await wait(50);
  }
  requireValue(Date.now() - holdStart <= 2500, "Installer hold exceeded its ceiling.");
  const expected = new Set(retained.map((member) => member.pid));
  const census = () => {
    const ids = admission.census();
    requireValue(
      ids.length === 4 && new Set(ids).size === 4 && ids.every((pid) => expected.has(pid)),
      "Console membership differs.",
    );
    for (const member of retained) admission.recheckMember(member);
    return ids;
  };
  const first = census();
  const second = census();
  apiLibrary = dlopen("kernel32.dll", {
    SetConsoleCtrlHandler: { args: ["ptr", "i32"], returns: "i32" },
    GenerateConsoleCtrlEvent: { args: ["u32", "u32"], returns: "i32" },
  });
  requireValue(
    apiLibrary.symbols.SetConsoleCtrlHandler(null, 1) !== 0,
    "Could not protect controller.",
  );
  masked = true;
  const final = census();
  const finalProof = await (await fetch(proofUrl, { signal: AbortSignal.timeout(1000) })).json();
  requireValue(finalProof.live && finalProof.ageMs < 9000, "Registry request ended before Ctrl+C.");
  census();
  requireValue(Date.now() < deadline, "Creator cancellation deadline expired before Ctrl+C.");
  requireValue(apiLibrary.symbols.GenerateConsoleCtrlEvent(0, 0) !== 0, "Ctrl+C was not accepted.");
  const remaining = () => Math.max(0, deadline - Date.now());
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("Creator cancellation timed out.")), remaining());
  });
  const [witnessPromiseExit, exitCode, out, err] = await Promise.race([
    Promise.all([witnessExit, cliExit, stdout, stderr]),
    timeout,
  ]).finally(() => clearTimeout(timer));
  requireValue(/^[^\r\n]+\r?\n$/u.test(out), "Creator stdout was not one JSON record.");
  const witnessNativeExit = admission.verifyExitedMember(witness);
  const cliNativeExit = admission.verifyExitedMember(cli);
  const installerNativeExit = admission.verifyExitedMember(installer);
  requireValue(witnessNativeExit.exitCode >>> 0 === 0xc000013a, "Witness did not receive Ctrl+C.");
  requireValue(exitCode === 130 && cliChild.signalCode === null, "Creator exit differs.");
  requireValue(cliNativeExit.exitCode >>> 0 === 130, "Creator native exit differs.");
  const ended = JSON.parse(readFileSync(exitedPath, "utf8"));
  const kills = readFileSync(killPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  requireValue(
    ended.nonce === nonce &&
      ended.cliPid === cli.pid &&
      ended.installerPid === installer.pid &&
      Number.isInteger(ended.exitCode),
    "Installer promise exit differs.",
  );
  requireValue(
    kills.length >= 2 &&
      kills[0].event === "kill-invoked" &&
      kills[1].event === "kill-returned" &&
      kills
        .slice(0, 2)
        .every(
          (item) =>
            item.nonce === nonce &&
            item.cliPid === cli.pid &&
            item.installerPid === installer.pid &&
            item.sameReceiver &&
            JSON.stringify(item.args) === '["SIGINT"]',
        ),
    "Original Creator installer kill was not observed.",
  );
  const terminalEvidence = {
    exitCode,
    stdout: out,
    stderr: err,
    witnessPromiseExit,
    witnessNativeExit,
    cliNativeExit,
    installerNativeExit,
    installerPromise: ended,
    kills,
    witnessParent,
    cliParent,
    installerParent,
    first,
    second,
    final,
    held: finalProof,
  };
  const receiptFd = openSync(join(outputRoot, "terminal-receipt.json"), "wx");
  let receiptFailed = false;
  let receiptError;
  let receiptCloseFailed = false;
  let receiptCloseError;
  try {
    writeSync(receiptFd, JSON.stringify(terminalEvidence) + "\n");
    fsyncSync(receiptFd);
  } catch (error) {
    receiptFailed = true;
    receiptError = error;
  } finally {
    try {
      closeSync(receiptFd);
    } catch (error) {
      receiptCloseFailed = true;
      receiptCloseError = error;
    }
  }
  if (receiptFailed && receiptCloseFailed) {
    throw new AggregateError(
      [receiptError, receiptCloseError],
      "Terminal receipt write and close failed.",
    );
  }
  if (receiptFailed) throw receiptError;
  if (receiptCloseFailed) throw receiptCloseError;
  for (const member of retained.splice(0)) admission.closeMember(member.handle);
  controller = undefined;
  witness = undefined;
  cli = undefined;
  installer = undefined;
  witnessChild = undefined;
  cliChild = undefined;
  witnessExit = undefined;
  cliExit = undefined;
  stdout = undefined;
  stderr = undefined;
  Bun.gc(true);
  closeAttempted = true;
  const job = await admission.close();
  consoleDetached = true;
  admission = undefined;
  requireValue(
    apiLibrary.symbols.SetConsoleCtrlHandler(null, 0) !== 0,
    "Could not restore Ctrl+C after detaching.",
  );
  masked = false;
  clean = true;
  process.stdout.write(JSON.stringify({ ...terminalEvidence, job }) + "\n");
} catch (error) {
  primaryFailed = true;
  primaryError = error;
  try {
    process.stderr.write(
      `Creator fixture failed; terminal receipt ${existsSync(join(outputRoot, "terminal-receipt.json")) ? "retained" : "unavailable"}: ${outputRoot}\n`,
    );
  } catch (reportError) {
    cleanupErrors.push(reportError);
  }
} finally {
  if (!clean) {
    for (const child of [cliChild, witnessChild]) {
      if (child && child.exitCode === null) {
        try {
          child.kill();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
    }
    for (const member of retained.splice(0)) {
      try {
        admission.closeMember(member.handle);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (admission && !closeAttempted) {
      closeAttempted = true;
      try {
        await admission.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (admission?.isDetached()) consoleDetached = true;
    if (masked && apiLibrary) {
      if (consoleDetached) {
        try {
          if (!apiLibrary.symbols.SetConsoleCtrlHandler(null, 0)) {
            cleanupErrors.push(new Error("Could not restore Ctrl+C after detaching."));
          }
        } catch (error) {
          cleanupErrors.push(error);
        }
      } else {
        cleanupErrors.push(
          new Error("Console detachment was not confirmed before Ctrl+C restoration."),
        );
      }
    }
  }
  if (apiLibrary) {
    try {
      apiLibrary.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
}
if (primaryFailed && cleanupErrors.length > 0) {
  throw new AggregateError([primaryError, ...cleanupErrors], "Creator fixture and cleanup failed.");
}
if (primaryFailed) throw primaryError;
if (cleanupErrors.length > 0)
  throw new AggregateError(cleanupErrors, "Creator fixture cleanup failed.");
