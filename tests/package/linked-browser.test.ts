import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, firefox, webkit } from "playwright";

const packageRoot = resolve(import.meta.dir, "../..");

const aeoliaRoot = resolve(packageRoot, "node_modules/aeolia");

const linkedFixtureRoot = join(import.meta.dir, "fixtures/applications/linked");

test("linked packages share state and revalidate live invalidated queries", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "hesperia-linked-browser-"));

  const application = join(workspace, "application");

  let preview: ReturnType<typeof Bun.spawn> | undefined;

  async function run(cwd: string, ...args: string[]): Promise<string> {
    const process_ = Bun.spawn([process.execPath, ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [status, stdout, stderr] = await Promise.all([
      process_.exited,
      new Response(process_.stdout).text(),
      new Response(process_.stderr).text(),
    ]);

    if (status !== 0) throw new Error(`${args.join(" ")} failed (${status})\n${stdout}\n${stderr}`);

    return stdout;
  }

  try {
    await run(
      packageRoot,
      resolve(packageRoot, "packages/create-hesperia/dist/cli.js"),
      application,
      "--no-install",
      "--host",
      "none",
    );

    await mkdir(join(application, "node_modules/@hesperia"), { recursive: true });

    await symlink(
      resolve(packageRoot, "packages/hesperia"),
      join(application, "node_modules/hesperia"),
      "junction",
    );

    await symlink(
      resolve(packageRoot, "packages/compiler"),
      join(application, "node_modules/@hesperia/compiler"),
      "junction",
    );

    await symlink(
      resolve(packageRoot, "packages/tooling"),
      join(application, "node_modules/@hesperia/tooling"),
      "junction",
    );

    await symlink(aeoliaRoot, join(application, "node_modules/aeolia"), "junction");

    const require = createRequire(join(application, "package.json"));

    const clientEntry = await realpath(require.resolve("hesperia/client"));

    const adapterEntry = await realpath(require.resolve("hesperia/aeolia"));

    const aeoliaEntry = await realpath(require.resolve("aeolia"));

    expect(clientEntry.startsWith(resolve(packageRoot, "packages/hesperia"))).toBe(true);

    expect(adapterEntry.startsWith(resolve(packageRoot, "packages/hesperia"))).toBe(true);

    expect(await realpath(createRequire(adapterEntry).resolve("aeolia"))).toBe(aeoliaEntry);

    await writeFile(
      join(application, "api.ts"),
      await readFile(join(linkedFixtureRoot, "api.ts"), "utf8"),
    );

    await writeFile(
      join(application, "src/routes/+page.tsx"),
      await readFile(join(linkedFixtureRoot, "src/routes/+page.tsx"), "utf8"),
    );

    await mkdir(join(application, "src/routes/todos/[id]"), { recursive: true });

    await writeFile(
      join(application, "src/routes/todos/[id]/+page.tsx"),
      await readFile(join(linkedFixtureRoot, "src/routes/todos/[id]/+page.tsx"), "utf8"),
    );

    await run(
      application,
      join(application, "node_modules/@hesperia/tooling/dist/cli.js"),
      "build",
    );

    preview = Bun.spawn(
      [
        process.execPath,
        join(application, "node_modules/@hesperia/tooling/dist/cli.js"),
        "preview",
        "--port",
        "0",
      ],
      { cwd: application, stdout: "pipe", stderr: "pipe" },
    );

    const reader = (preview.stdout as ReadableStream<Uint8Array>).getReader();

    let output = "";

    let url: string | undefined;

    try {
      while (!url) {
        const chunk = await reader.read();

        if (chunk.done) throw new Error(`Preview exited before listening: ${output}`);

        output += new TextDecoder().decode(chunk.value);

        url = output.match(/http:\/\/127\.0\.0\.1:\d+\//u)?.[0];
      }
    } finally {
      reader.releaseLock();
    }

    for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) {
      const browser = await engine.launch();

      try {
        const page = await browser.newPage();

        const errors: string[] = [];

        page.on("pageerror", (error) => errors.push(error.message));

        await page.goto(url);

        await page.waitForFunction(
          () => document.querySelector("#adapted")?.textContent === "Hello Hesperia",
        );

        await page.waitForFunction(
          () => document.querySelector("#raw")?.textContent === "Hello Hesperia",
        );

        const localCount = page.locator("#local-count");

        const localNode = await localCount.elementHandle();

        expect(await localCount.textContent()).toBe("Local: 0");

        await localCount.click();

        await localCount.click();

        expect(await localCount.textContent()).toBe("Local: 2");

        expect(
          await localNode?.evaluate(
            (node) => node.isConnected && document.querySelector("#local-count") === node,
          ),
        ).toBe(true);

        await localNode?.dispose();

        await page.waitForFunction(
          () => document.querySelector("#todo-empty")?.textContent === "No todos found.",
        );

        await page.locator("#rename").click();

        await page.waitForFunction(
          () => document.querySelector("#adapted")?.textContent === "Hello Aeolia",
        );

        await page.waitForFunction(
          () => document.querySelector("#raw")?.textContent === "Hello Aeolia",
        );

        await page.locator("#todo-form input").fill("Linked todo");

        await page.locator("#todo-submit").click();

        await page.waitForFunction(
          () => document.querySelector("#todo-list li")?.textContent === "Linked todo - Pending",
        );

        const listMain = await page.locator("main").elementHandle();

        await page.locator("#todo-link").click();

        await page.waitForFunction(
          () => document.querySelector("#detail-status")?.textContent === "Pending",
        );

        await page.locator("#detail-toggle").click();

        await page.waitForFunction(
          () => document.querySelector("#detail-status")?.textContent === "Completed",
        );

        await page.goBack();

        expect(listMain).not.toBeNull();

        expect(
          await page.locator("main").evaluate((node, original) => node === original, listMain),
        ).toBe(true);

        await page.waitForFunction(
          () => document.querySelector("#todo-link")?.textContent === "Linked todo - Completed",
          undefined,
          { timeout: 5_000 },
        );

        await page.goForward();

        await page.waitForFunction(
          () => document.querySelector("#detail-status")?.textContent === "Completed",
        );

        await page.locator("#detail-toggle").click();

        await page.waitForFunction(
          () => document.querySelector("#detail-status")?.textContent === "Pending",
        );

        await page.goBack();

        expect(
          await page.locator("main").evaluate((node, original) => node === original, listMain),
        ).toBe(true);

        await page.waitForFunction(
          () => document.querySelector("#todo-link")?.textContent === "Linked todo - Pending",
          undefined,
          { timeout: 5_000 },
        );

        expect(errors, `${name}: ${await page.content()}`).toStrictEqual([]);
      } finally {
        await browser.close();
      }
    }
  } finally {
    if (preview) {
      preview.kill();

      await preview.exited;
    }

    await rm(workspace, { recursive: true, force: true });
  }
}, 120_000);
