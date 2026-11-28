import { isAbsolute } from "node:path";
import { writeFileSync } from "node:fs";
import { dlopen } from "bun:ffi";

const startedPath = process.env.HESPERIA_PROTOTYPE_INSTALLER_STARTED;
const exitedPath = process.env.HESPERIA_PROTOTYPE_INSTALLER_EXITED;
const killPath = process.env.HESPERIA_PROTOTYPE_INSTALLER_KILL;
const nonce = process.env.HESPERIA_PROTOTYPE_NONCE;

if (
  ![startedPath, exitedPath, killPath].every((path) => path && isAbsolute(path)) ||
  new Set([startedPath, exitedPath, killPath]).size !== 3 ||
  !nonce
) {
  throw new Error("Distinct absolute installer observation paths and a nonce are required.");
}

if (process.platform !== "win32" || process.arch !== "x64")
  throw new Error("Windows x64 is required.");

const originalSpawn = Bun.spawn;
let observed = false;

Bun.spawn = (...args) => {
  const command = args[0];

  if (
    observed ||
    !Array.isArray(command) ||
    command.length !== 2 ||
    command[0] !== process.execPath ||
    command[1] !== "install"
  ) {
    return Reflect.apply(originalSpawn, Bun, args);
  }

  observed = true;
  const library = dlopen("kernel32.dll", {
    SetConsoleCtrlHandler: { args: ["ptr", "i32"], returns: "i32" },
  });
  const api = library.symbols;
  let child;
  let armed = false;
  let spawnFailed = false;
  let spawnError;
  const cleanupErrors = [];

  try {
    if (!api.SetConsoleCtrlHandler(null, 1))
      throw new Error("Could not arm installer inheritance.");

    armed = true;
    child = Reflect.apply(originalSpawn, Bun, args);
  } catch (error) {
    spawnFailed = true;
    spawnError = error;
  } finally {
    if (armed) {
      try {
        if (!api.SetConsoleCtrlHandler(null, 0)) {
          cleanupErrors.push(new Error("Could not restore CLI Ctrl+C processing."));
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    try {
      library.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  if (spawnFailed && cleanupErrors.length > 0) {
    throw new AggregateError([spawnError, ...cleanupErrors], "Installer spawn and cleanup failed.");
  }

  if (spawnFailed) throw spawnError;

  if (cleanupErrors.length > 0)
    throw new AggregateError(cleanupErrors, "Installer spawn cleanup failed.");

  const identity = { nonce, cliPid: process.pid, installerPid: child.pid };
  const originalKill = child.kill;

  if (typeof originalKill !== "function") throw new Error("Installer kill method is unavailable.");
  const appendKill = (value) => {
    try {
      writeFileSync(killPath, JSON.stringify({ ...identity, ...value }) + "\n", { flag: "a" });
    } catch (error) {
      console.error("Installer kill observation failed:", error);
    }
  };
  const observedKill = function (...killArgs) {
    const sameReceiver = this === child;

    appendKill({ event: "kill-invoked", args: killArgs, sameReceiver });

    try {
      const value = Reflect.apply(originalKill, this, killArgs);

      appendKill({ event: "kill-returned", args: killArgs, sameReceiver });
      return value;
    } catch (error) {
      appendKill({ event: "kill-threw", args: killArgs, sameReceiver, message: String(error) });
      throw error;
    }
  };

  Object.defineProperty(child, "kill", { configurable: true, writable: true, value: observedKill });
  if (child.kill !== observedKill) throw new Error("Installer kill observation did not attach.");
  writeFileSync(startedPath, JSON.stringify({ ...identity, event: "spawned" }), { flag: "wx" });
  void child.exited.then(
    (exitCode) => {
      try {
        writeFileSync(
          exitedPath,
          JSON.stringify({ ...identity, event: "exited", exitCode, signalCode: child.signalCode }),
          { flag: "wx" },
        );
      } catch (error) {
        console.error("Installer exit observation failed:", error);
      }
    },
    (error) => console.error("Installer exit promise rejected:", error),
  );
  return child;
};
