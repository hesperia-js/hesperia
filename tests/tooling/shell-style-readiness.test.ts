import { expect, test } from "bun:test";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { prepareBuild } from "../../packages/tooling/src/project.ts";
import { createHost } from "../../packages/hosting/src/index.ts";
import { linkFrameworkPackages, unlinkFrameworkPackages } from "./fixture-dependencies.ts";

test("generated shell startup waits for installed-head CSS and releases failed startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-shell-style-"));
  let server: ReturnType<typeof Bun.serve> | undefined;

  try {
    await cp(join(import.meta.dir, "fixtures/applications/shell-style-readiness"), root, {
      recursive: true,
    });

    await linkFrameworkPackages(root);

    const built = await prepareBuild(root, true);
    const host = await createHost({
      hosting: built.hosting,
      files: new Map(
        built.hosting.assets.map((asset) => [asset.path, built.files.get(asset.path)!]),
      ),
    });
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => host.handle(request) ?? new Response(null, { status: 404 }),
    });
    const child = Bun.spawn(
      [
        "node",
        join(import.meta.dir, "fixtures/drivers/shell-style-readiness-browser.mjs"),
        pathToFileURL(resolve(import.meta.dir, "../../node_modules/playwright/index.mjs")).href,
        server.url.href,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [status, output, errors] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    if (status !== 0) throw new Error(`Generated shell CSS failed\n${output}\n${errors}`);

    expect(output.trim().split(/\r?\n/u)).toEqual([
      "chromium shell CSS verified (delay, reject, ready)",
      "firefox shell CSS verified (ready)",
      "webkit shell CSS verified (ready)",
    ]);
  } finally {
    await server?.stop(true);

    await unlinkFrameworkPackages(root);

    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
