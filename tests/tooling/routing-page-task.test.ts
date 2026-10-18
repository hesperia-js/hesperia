import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { prepareBuild, writeBuild } from "../../packages/tooling/src/project.ts";
import { previewProject } from "../../packages/tooling/src/server.ts";

const applicationFixture = join(import.meta.dir, "fixtures/applications/routing-page-task");

test("a parked page task updates active shared data and eviction cancels it", async () => {
  const parent = resolve(import.meta.dir, "../../.hesperia");

  await mkdir(parent, { recursive: true });

  const root = await mkdtemp(join(parent, "routing-page-task-"));

  let server: Awaited<ReturnType<typeof previewProject>> | undefined;

  try {
    const sourceFiles = [
      "app.config.ts",
      "app.tsx",
      "api.ts",
      "src/routes/+page.tsx",
      "src/routes/other/+page.tsx",
      "src/routes/evict/+page.tsx",
    ];

    for (const filename of sourceFiles) {
      const target = join(root, filename);

      await mkdir(resolve(target, ".."), { recursive: true });

      await copyFile(join(applicationFixture, filename), target);
    }

    await writeBuild(root, await prepareBuild(root));

    server = await previewProject(root, 0);

    const child = Bun.spawn(
      [
        "node",
        join(import.meta.dir, "fixtures/drivers/routing-page-task-browser.mjs"),
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

    if (status !== 0) throw new Error(`Parked page task failed\n${output}\n${errors}`);

    expect(output.trim().split(/\r?\n/u)).toStrictEqual([
      "chromium parked task and eviction verified",
      "firefox parked task and eviction verified",
      "webkit parked task and eviction verified",
    ]);
  } finally {
    await server?.close();

    await rm(root, { recursive: true, force: true });
  }
}, 90_000);
