import { expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

test("document navigation diagnostics retain held-body and held-parser evidence", async () => {
  const parent = resolve(import.meta.dir, "../../.hesperia/browser-diagnostics");

  await mkdir(parent, { recursive: true });

  const directory = await mkdtemp(join(parent, "document-timing-controls-"));
  const child = Bun.spawn(
    [
      "node",
      join(import.meta.dir, "fixtures/drivers/document-navigation-controls.mjs"),
      pathToFileURL(resolve(import.meta.dir, "../../node_modules/playwright/index.mjs")).href,
      directory,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );

  try {
    const [status, output, errors] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    if (status !== 0)
      throw new Error(
        `Document timing controls failed; evidence=${directory}\n${output}\n${errors}`,
      );

    expect(output.trim().split(/\r?\n/u)).toStrictEqual([
      "chromium document timing controls verified",
      "firefox document timing controls verified",
      "webkit document timing controls verified",
    ]);
  } finally {
    if (child.exitCode === null) child.kill();
  }
}, 60_000);
