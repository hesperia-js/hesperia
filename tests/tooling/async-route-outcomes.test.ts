import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { prepareBuild, ProjectError, writeBuild } from "../../packages/tooling/src/project.ts";
import { previewProject } from "../../packages/tooling/src/server.ts";

const applicationFixture = join(import.meta.dir, "fixtures/applications/async-route-outcomes");

test("compiled async routes surface rejection, bubble fallback faults, and cancel stale work", async () => {
  const parent = resolve(import.meta.dir, "../../.hesperia");

  await mkdir(parent, { recursive: true });

  const root = await mkdtemp(join(parent, "async-route-outcomes-"));

  let server: Awaited<ReturnType<typeof previewProject>> | undefined;

  try {
    const sourceFiles = [
      "app.tsx",
      "api.ts",
      "src/routes/+layout.tsx",
      "src/routes/+loading.tsx",
      "src/routes/+error.tsx",
      "src/routes/+page.tsx",
      "src/routes/reject/+page.tsx",
      "src/routes/broken/+error.tsx",
      "src/routes/broken/+page.tsx",
      "src/routes/slow/+page.tsx",
      "src/routes/fast/+page.tsx",
    ];

    for (const filename of sourceFiles) {
      const target = join(root, filename);

      await mkdir(resolve(target, ".."), { recursive: true });

      await copyFile(join(applicationFixture, filename), target);
    }

    try {
      await writeBuild(root, await prepareBuild(root));
    } catch (error) {
      if (error instanceof ProjectError)
        throw new Error(JSON.stringify(error.diagnostics, null, 2), { cause: error });

      throw error;
    }

    server = await previewProject(root, 0);

    const child = Bun.spawn(
      [
        "node",
        join(import.meta.dir, "fixtures/drivers/async-route-outcomes-browser.mjs"),
        pathToFileURL(resolve(import.meta.dir, "../../node_modules/playwright/index.mjs")).href,
        server.url.href,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    const [status, output, errors] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    if (status !== 0) throw new Error(`Generated async outcomes failed\n${output}\n${errors}`);

    expect(output.trim().split(/\r?\n/u)).toStrictEqual([
      "chromium async outcomes verified",
      "firefox async outcomes verified",
      "webkit async outcomes verified",
    ]);
  } finally {
    await server?.close();

    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
