import { writeFileSync } from "node:fs";
import { dlopen } from "bun:ffi";

const library = dlopen("kernel32.dll", {
  SetConsoleCtrlHandler: { args: ["ptr", "i32"], returns: "i32" },
});
let restoreFailed = false;
let restoreError;

try {
  if (!library.symbols.SetConsoleCtrlHandler(null, 0)) {
    throw new Error("Could not restore witness Ctrl+C processing.");
  }
} catch (error) {
  restoreFailed = true;
  restoreError = error;
}

try {
  library.close();
} catch (error) {
  if (restoreFailed) {
    throw new AggregateError(
      [restoreError, error],
      "Witness Ctrl+C restoration and cleanup failed.",
    );
  }

  throw error;
}

if (restoreFailed) throw restoreError;

writeFileSync(process.argv[2], "ready\n", { flag: "wx" });
setInterval(() => {}, 1000);
