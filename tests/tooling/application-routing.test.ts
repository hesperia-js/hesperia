import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { prepareBuild, ProjectError, writeBuild } from "../../packages/tooling/src/project.ts";
import { previewProject } from "../../packages/tooling/src/server.ts";
import { startProcessDiagnostics } from "./fixtures/drivers/process-diagnostics.mjs";
import { captureDriverStderr, observePreviewServer } from "./server-diagnostics.ts";

const applicationFixture = join(import.meta.dir, "fixtures/applications/application-routing");

test("generated async routes wait for public query data and restore the cached native page", async () => {
  const parent = resolve(import.meta.dir, "../../.hesperia");

  await mkdir(parent, { recursive: true });

  const root = await mkdtemp(join(parent, "application-routing-"));

  const diagnosticsParent = join(parent, "browser-diagnostics");

  await mkdir(diagnosticsParent, { recursive: true });

  const diagnosticsDirectory = await mkdtemp(join(diagnosticsParent, "application-routing-"));
  const diagnostics = startProcessDiagnostics({
    directory: diagnosticsDirectory,
    label: "bun-parent",
  });
  let server: Awaited<ReturnType<typeof previewProject>> | undefined;

  try {
    const sourceFiles = [
      "app.tsx",
      "api.ts",
      "src/routes/+layout.tsx",
      "src/routes/+error.tsx",
      "src/routes/+page.tsx",
      "src/routes/+loading.tsx",
      "src/routes/slow/+page.tsx",
      "src/routes/broken/+layout.tsx",
      "src/routes/broken/+error.tsx",
      "src/routes/broken/+page.tsx",
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

    server = await observePreviewServer(() => previewProject(root, 0), diagnostics.mark);

    diagnostics.mark("preview-ready", { url: server.url.href });

    diagnostics.mark("driver-spawn-start");

    const child = Bun.spawn(
      [
        "node",
        join(import.meta.dir, "fixtures/drivers/application-routing-browser.mjs"),
        pathToFileURL(resolve(import.meta.dir, "../../node_modules/playwright/index.mjs")).href,
        server.url.href,
        diagnosticsDirectory,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    diagnostics.mark("driver-spawned", { pid: child.pid });

    const [status, output, errors] = await Promise.all([
      child.exited.then((status) => {
        diagnostics.mark("driver-exited", { pid: child.pid, status });

        return status;
      }),
      new Response(child.stdout).text().then((output) => {
        diagnostics.mark("driver-stdout-eof");

        return output;
      }),
      captureDriverStderr(child.stderr, diagnosticsDirectory, diagnostics.mark),
    ]);

    if (status !== 0)
      throw new Error(
        `Generated route application failed; diagnostics=${diagnosticsDirectory}\n${output}\n${errors}`,
      );

    expect(output.trim().split(/\r?\n/u)).toStrictEqual([
      "chromium async routing verified",
      "firefox async routing verified",
      "webkit async routing verified",
    ]);
  } catch (error) {
    diagnostics.mark("parent-error", { error: String(error) });

    throw error;
  } finally {
    try {
      diagnostics.mark("preview-close-start");

      await server?.close();

      diagnostics.mark("preview-close-complete");
    } finally {
      diagnostics.dispose();
    }

    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
