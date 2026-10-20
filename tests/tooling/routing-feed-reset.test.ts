import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { prepareBuild, writeBuild } from "../../packages/tooling/src/project.ts";
import { previewProject } from "../../packages/tooling/src/server.ts";

const applicationFixture = join(import.meta.dir, "fixtures/applications/routing-feed-reset");

async function verifyFeedReset(group: "continuation" | "terminal"): Promise<void> {
  const parent = resolve(import.meta.dir, "../../.hesperia");

  await mkdir(parent, { recursive: true });

  const root = await mkdtemp(join(parent, "routing-feed-reset-"));
  let server: Awaited<ReturnType<typeof previewProject>> | undefined;

  try {
    for (const filename of [
      "app.tsx",
      "api.ts",
      "src/routes/+page.tsx",
      "src/routes/other/+page.tsx",
      "src/routes/terminal/+page.tsx",
    ]) {
      const target = join(root, filename);

      await mkdir(resolve(target, ".."), { recursive: true });

      await copyFile(join(applicationFixture, filename), target);
    }

    await writeBuild(root, await prepareBuild(root));

    server = await previewProject(root, 0);

    const child = Bun.spawn(
      [
        "node",
        join(import.meta.dir, "fixtures/drivers/routing-feed-reset-browser.mjs"),
        pathToFileURL(resolve(import.meta.dir, "../../node_modules/playwright/index.mjs")).href,
        server.url.href,
        group,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [status, output, errors] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    if (status !== 0) throw new Error(`Feed reset application failed\n${output}\n${errors}`);

    expect(output.trim().split(/\r?\n/u)).toStrictEqual([
      `chromium ${group} verified`,
      `firefox ${group} verified`,
      `webkit ${group} verified`,
    ]);
  } finally {
    await server?.close();

    await rm(root, { recursive: true, force: true });
  }
}

test(
  "cached feed projections preserve continuation and discard pre-reset values",
  () => verifyFeedReset("continuation"),
  90_000,
);

test(
  "terminal feed projections clear errors on reset and retain their lifecycle",
  () => verifyFeedReset("terminal"),
  90_000,
);
