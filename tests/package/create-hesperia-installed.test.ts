import { expect, test } from "bun:test";
import { readPinnedAeoliaVersion, writePackageManifest } from "./package-manifest.ts";
import { suppliedReleaseArchive } from "./release-candidate.ts";
import { chromium } from "playwright";
import { createRequire } from "node:module";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const packageRoot = resolve(import.meta.dir, "../..");

const creatorFixtures = join(import.meta.dir, "fixtures", "applications", "creator");

const ansiEscapeSequence = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "gu");

async function run(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  if (exitCode !== 0) {
    throw new Error(`${args.join(" ")} failed (${exitCode})\n${stdout}\n${stderr}`);
  }

  return stdout;
}

function normalizeTerminalOutput(output: string): string {
  return output.replace(ansiEscapeSequence, "").replace(/\r\n?/gu, "\n");
}

async function runInteractiveCreator(
  cwd: string,
  destination: string,
  answer: string,
): Promise<string> {
  const command = [process.execPath, "x", "create-hesperia", destination, "--no-install"];

  const decoder = new TextDecoder();

  let output = "";

  let answered = false;

  let finishOutput!: () => void;

  const outputClosed = new Promise<void>((resolve) => {
    finishOutput = resolve;
  });

  const child = Bun.spawn(command, {
    cwd,
    terminal: {
      cols: 100,
      rows: 30,

      data(terminal, data) {
        output += decoder.decode(data, { stream: true });

        const visibleOutput = normalizeTerminalOutput(output);

        if (!answered && visibleOutput.includes("Host [1]: ")) {
          answered = true;

          terminal.write(answer);
        }
      },

      exit() {
        output += decoder.decode();

        finishOutput();
      },
    },
  });

  let timeout: ReturnType<typeof setTimeout> | undefined;

  const timedOut = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      child.kill();

      reject(new Error(`Interactive creator timed out\n${normalizeTerminalOutput(output)}`));
    }, 30_000);
  });

  try {
    const exitCode = await Promise.race([
      Promise.all([child.exited, outputClosed]).then(([code]) => code),
      timedOut,
    ]);

    const visibleOutput = normalizeTerminalOutput(output);

    if (!answered)
      throw new Error(`Interactive creator did not show its host prompt\n${visibleOutput}`);

    if (exitCode !== 0)
      throw new Error(`${command.join(" ")} failed (${exitCode})\n${visibleOutput}`);

    return visibleOutput;
  } finally {
    if (timeout) clearTimeout(timeout);

    if (child.exitCode === null) {
      child.kill();

      await child.exited;
    }

    if (child.terminal && !child.terminal.closed) child.terminal.close();
  }
}

async function pack(
  workspace: string,
  packageDirectory: string,
  builtFile: string,
): Promise<string> {
  const supplied = await suppliedReleaseArchive(packageDirectory);

  if (supplied) return supplied;

  await stat(join(packageDirectory, builtFile));

  const before = new Set(await readdir(workspace));

  await run(
    packageDirectory,
    "pm",
    "pack",
    "--destination",
    workspace,
    "--ignore-scripts",
    "--quiet",
  );

  const [filename] = (await readdir(workspace)).filter(
    (entry) => entry.endsWith(".tgz") && !before.has(entry),
  );

  if (!filename) throw new Error(`Packing ${packageDirectory} produced no tarball`);

  return join(workspace, filename).replaceAll("\\", "/");
}

interface IntegratedServer {
  readonly child: ReturnType<typeof Bun.spawn>;
  readonly url: URL;
}

async function startIntegratedServer(
  application: string,
  serverLabel: "Elysia" | "preview" = "Elysia",
  ...args: string[]
): Promise<IntegratedServer> {
  const child = Bun.spawn([process.execPath, "run", "preview", ...args], {
    cwd: application,
    env: { ...process.env, PORT: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });

  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();

  let output = "";

  try {
    while (true) {
      const chunk = await reader.read();

      if (chunk.done) {
        const [exitCode, stderr] = await Promise.all([
          child.exited,
          new Response(child.stderr as ReadableStream<Uint8Array>).text(),
        ]);

        throw new Error(
          `Integrated server exited before listening (${exitCode})\n${output}\n${stderr}`,
        );
      }

      output += new TextDecoder().decode(chunk.value);

      const match =
        serverLabel === "Elysia"
          ? output.match(/Hesperia Elysia: (https?:\/\/[^\s]+)/u)
          : output.match(/Hesperia preview: (https?:\/\/[^\s]+)/u);

      if (match) return { child, url: new URL(match[1]!) };
    }
  } catch (error) {
    if (child.exitCode === null) await terminateIntegratedServerProcess(child);

    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function terminateIntegratedServerProcess(
  child: ReturnType<typeof Bun.spawn>,
): Promise<void> {
  if (child.exitCode !== null) {
    await child.exited;

    return;
  }

  if (process.platform === "win32") {
    const termination = Bun.spawn(["taskkill.exe", "/PID", String(child.pid), "/T", "/F"], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const [exitCode, stdout, stderr] = await Promise.all([
      termination.exited,
      new Response(termination.stdout).text(),
      new Response(termination.stderr).text(),
    ]);

    if (exitCode !== 0) {
      throw new Error(
        `Could not terminate integrated server process tree ${child.pid} (taskkill ${exitCode}, launcher ${String(child.exitCode)})\n${stdout}\n${stderr}`,
      );
    }
  } else {
    child.kill();
  }

  await child.exited;
}

async function stopIntegratedServer(server: IntegratedServer): Promise<void> {
  await terminateIntegratedServerProcess(server.child);
}

async function runExpectingFailure(
  cwd: string,
  env: Record<string, string | undefined> = process.env,
  ...args: string[]
): Promise<{ readonly exitCode: number | null; readonly output: string }> {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  return { exitCode, output: stdout + stderr };
}

test("packed creator defaults to Elysia and builds a selectable no-host application", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "hesperia-create-installed-"));

  const driver = join(workspace, "command driver");

  const application = join(workspace, "Generated Frontend");

  const interactiveApplication = join(workspace, "Interactive Default Frontend");

  const noHostApplication = join(workspace, "Frontend Without Host");

  let passed = false;

  let server: IntegratedServer | undefined;

  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

  try {
    await mkdir(driver);

    const tarballs = {
      hesperia: await pack(workspace, resolve(packageRoot, "packages/hesperia"), "dist/index.js"),
      compiler: await pack(workspace, resolve(packageRoot, "packages/compiler"), "dist/index.js"),
      elysia: await pack(workspace, resolve(packageRoot, "packages/elysia"), "dist/index.js"),
      hosting: await pack(workspace, resolve(packageRoot, "packages/hosting"), "dist/index.js"),
      tooling: await pack(
        workspace,
        resolve(packageRoot, "packages/tooling"),
        "dist/project-service.js",
      ),
      languageServer: await pack(
        workspace,
        resolve(packageRoot, "packages/language-server"),
        "dist/cli.js",
      ),
      creator: await pack(
        workspace,
        resolve(packageRoot, "packages/create-hesperia"),
        "dist/cli.js",
      ),
    };

    const overrides = {
      aeolia: await readPinnedAeoliaVersion(packageRoot),
      hesperia: tarballs.hesperia,
      "@hesperia/compiler": tarballs.compiler,
      "@hesperia/elysia": tarballs.elysia,
      "@hesperia/hosting": tarballs.hosting,
      "@hesperia/tooling": tarballs.tooling,
      "@hesperia/language-server": tarballs.languageServer,
    };

    await writeFile(
      join(driver, "package.json"),
      JSON.stringify(
        {
          name: "hesperia-create-command-driver",
          private: true,
          type: "module",
          dependencies: { "create-hesperia": tarballs.creator },
        },
        null,
        2,
      ),
    );

    await run(driver, "install", "--ignore-scripts");

    await run(driver, "x", "create-hesperia", application, "--no-install");

    const interactiveOutput = await runInteractiveCreator(driver, interactiveApplication, "\r");

    expect(interactiveOutput).toContain("Choose a host integration:");

    expect(interactiveOutput).toContain("Created interactive-default-frontend");

    const interactiveManifest = JSON.parse(
      await readFile(join(interactiveApplication, "package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };

    expect(interactiveManifest.dependencies["@hesperia/hosting"]).toBe("1.0.0-alpha.1");

    expect(interactiveManifest.dependencies["@elysia/eden"]).toBe("1.4.10");

    expect(interactiveManifest.dependencies.elysia).toBe("1.4.30");

    const interactiveSourceFiles = await readdir(join(interactiveApplication, "src"));

    expect(interactiveSourceFiles).toContain("server.ts");

    expect(interactiveSourceFiles).toContain("server-internals.ts");

    expect(interactiveSourceFiles).toContain("server-entry.ts");

    const noHostOutput = await runInteractiveCreator(driver, noHostApplication, "2\r");

    expect(noHostOutput).toContain("Choose a host integration:");

    expect(noHostOutput).toContain("Created frontend-without-host");

    const noHostManifestPath = join(noHostApplication, "package.json");

    const noHostManifest = JSON.parse(await readFile(noHostManifestPath, "utf8")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
      overrides?: Record<string, string>;
    };

    expect(noHostManifest.dependencies).not.toHaveProperty("@hesperia/hosting");

    expect(noHostManifest.dependencies).not.toHaveProperty("@hesperia/elysia");

    expect(noHostManifest.dependencies).not.toHaveProperty("@elysia/eden");

    expect(noHostManifest.dependencies).not.toHaveProperty("elysia");

    const noHostSourceFiles = await readdir(join(noHostApplication, "src"));

    expect(noHostSourceFiles).not.toContain("server.ts");

    expect(noHostSourceFiles).not.toContain("server-internals.ts");

    expect(noHostSourceFiles).not.toContain("server-entry.ts");

    const appManifestPath = join(application, "package.json");

    const appManifest = JSON.parse(await readFile(appManifestPath, "utf8")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
      overrides?: Record<string, string>;
    };

    const languageServerWorkspaceManifest = JSON.parse(
      await readFile(resolve(packageRoot, "packages/language-server/package.json"), "utf8"),
    ) as { version: string };

    expect(appManifest.devDependencies["@hesperia/language-server"]).toBe(
      languageServerWorkspaceManifest.version,
    );

    expect(appManifest.dependencies["@hesperia/hosting"]).toBe("1.0.0-alpha.1");

    expect(appManifest.dependencies["@hesperia/elysia"]).toBe("1.0.0-alpha.1");

    expect(appManifest.dependencies.elysia).toBe("1.4.30");

    expect(appManifest.dependencies["@elysia/eden"]).toBe("1.4.10");

    appManifest.dependencies.aeolia = await readPinnedAeoliaVersion(packageRoot);

    appManifest.dependencies.hesperia = tarballs.hesperia;

    appManifest.devDependencies["@hesperia/tooling"] = tarballs.tooling;

    appManifest.devDependencies["@hesperia/language-server"] = tarballs.languageServer;

    appManifest.overrides = overrides;

    await writePackageManifest(appManifestPath, appManifest);

    noHostManifest.dependencies.aeolia = await readPinnedAeoliaVersion(packageRoot);

    noHostManifest.dependencies.hesperia = tarballs.hesperia;

    noHostManifest.devDependencies["@hesperia/tooling"] = tarballs.tooling;

    noHostManifest.devDependencies["@hesperia/language-server"] = tarballs.languageServer;

    noHostManifest.overrides = overrides;

    await writePackageManifest(noHostManifestPath, noHostManifest);

    const awayRoute = join(application, "src/routes/away");

    await mkdir(awayRoute, { recursive: true });

    await copyFile(join(creatorFixtures, "away/+page.tsx"), join(awayRoute, "+page.tsx"));

    const notesRoute = join(application, "src/routes/notes");

    await mkdir(notesRoute, { recursive: true });

    await copyFile(join(creatorFixtures, "notes/+page.tsx"), join(notesRoute, "+page.tsx"));

    await run(application, "install", "--ignore-scripts");

    const requireFromApplication = createRequire(appManifestPath);

    await run(
      application,
      resolve(requireFromApplication.resolve("oxfmt/package.json"), "../bin/oxfmt"),
      "src/routes/notes/+page.tsx",
    );

    expect(requireFromApplication.resolve("@hesperia/hosting")).toBe(
      resolve(application, "node_modules/@hesperia/hosting/dist/index.js"),
    );

    expect(requireFromApplication.resolve("@hesperia/elysia")).toBe(
      resolve(application, "node_modules/@hesperia/elysia/dist/index.js"),
    );

    expect(requireFromApplication.resolve("@hesperia/elysia/client")).toBe(
      resolve(application, "node_modules/@hesperia/elysia/dist/client.js"),
    );

    expect(requireFromApplication.resolve("@hesperia/language-server/bin")).toBe(
      resolve(application, "node_modules/@hesperia/language-server/dist/cli.js"),
    );

    const elysiaManifest = JSON.parse(
      await readFile(join(application, "node_modules/elysia/package.json"), "utf8"),
    ) as { version: string };

    const edenManifest = JSON.parse(
      await readFile(join(application, "node_modules/@elysia/eden/package.json"), "utf8"),
    ) as { version: string };

    expect(elysiaManifest.version).toBe("1.4.30");

    expect(edenManifest.version).toBe("1.4.10");

    const toolingManifest = JSON.parse(
      await readFile(join(application, "node_modules/@hesperia/tooling/package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };

    expect(toolingManifest.dependencies ?? {}).not.toHaveProperty("@hesperia/language-server");

    const languageServerManifest = JSON.parse(
      await readFile(
        join(application, "node_modules/@hesperia/language-server/package.json"),
        "utf8",
      ),
    ) as { bin: Record<string, string> };

    expect(languageServerManifest.bin).toStrictEqual({
      "hesperia-language-server": "./dist/cli.js",
    });

    expect(await run(application, "run", "check")).toContain("Hesperia checking passed");

    expect(await run(application, "run", "build")).toContain("Built browser application");

    await run(noHostApplication, "install", "--ignore-scripts");

    const requireFromNoHostApplication = createRequire(noHostManifestPath);

    expect(() => requireFromNoHostApplication.resolve("@hesperia/elysia")).toThrow();

    expect(() => requireFromNoHostApplication.resolve("elysia")).toThrow();

    expect(() => requireFromNoHostApplication.resolve("@elysia/eden")).toThrow();

    expect(await run(noHostApplication, "run", "check")).toContain("Hesperia checking passed");

    expect(await run(noHostApplication, "run", "build")).toContain("Built browser application");

    const buildRecordPath = join(application, ".hesperia/build/hesperia-build.json");

    const originalRecord = await readFile(buildRecordPath, "utf8");

    const buildRecord = JSON.parse(originalRecord) as {
      assetDirectory?: string;
      hosting: {
        mode: string;
        startupAsset: string;
        assets: { path: string; sha256: string; contentType: string }[];
      };
    };

    const rejectEditedRecord = async (
      edit: (record: {
        assetDirectory?: string;
        hosting: {
          mode: string;
          startupAsset: string;
          assets: { path: string; sha256: string; contentType: string }[];
        };
      }) => void,
      expectedFailure: string | RegExp,
    ): Promise<void> => {
      const record = JSON.parse(originalRecord) as {
        assetDirectory?: string;
        hosting: {
          mode: string;
          startupAsset: string;
          assets: { path: string; sha256: string; contentType: string }[];
        };
      };

      edit(record);

      await writeFile(buildRecordPath, JSON.stringify(record, null, 2));

      try {
        const result = await runExpectingFailure(application, process.env, "run", "start");

        expect(result.exitCode).not.toBe(0);

        if (typeof expectedFailure === "string") expect(result.output).toContain(expectedFailure);
        else expect(result.output).toMatch(expectedFailure);
      } finally {
        await writeFile(buildRecordPath, originalRecord);
      }
    };

    await rejectEditedRecord((record) => {
      record.hosting.mode = "development";
    }, "Cannot serve a development build as production");

    await rejectEditedRecord((record) => {
      record.hosting.assets[0]!.path = "/assets/../package.json";
    }, "asset path is not a safe canonical path");

    const startupAssetPath = buildRecord.hosting.startupAsset;

    if (!startupAssetPath.startsWith("/assets/"))
      throw new Error("Production build has no canonical startup asset");

    const startupFile = join(
      application,
      ".hesperia",
      "build",
      ...(buildRecord.assetDirectory ?? "assets").split("/"),
      ...startupAssetPath.slice("/assets/".length).split("/"),
    );

    const startupBytes = await readFile(startupFile);

    await writeFile(startupFile, Buffer.concat([startupBytes, Buffer.from([0])]));

    try {
      const result = await runExpectingFailure(application, process.env, "run", "start");

      expect(result.exitCode).not.toBe(0);

      expect(result.output).toContain("asset digest mismatch");
    } finally {
      await writeFile(startupFile, startupBytes);
    }

    browser = await chromium.launch();

    const page = await browser.newPage();

    const pageErrors: string[] = [];

    page.on("pageerror", (error) => pageErrors.push(error.message));

    server = await startIntegratedServer(application);

    const initialNotes = await fetch(new URL("/api/notes", server.url), {
      headers: { accept: "application/json" },
    });

    expect(initialNotes.status).toBe(200);

    expect(await initialNotes.json()).toStrictEqual([]);

    const createdNote = await fetch(new URL("/api/notes", server.url), {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ text: "created through the installed Elysia route" }),
    });

    expect(createdNote.status).toBe(200);

    expect(await createdNote.json()).toMatchObject({
      id: 1,
      text: "created through the installed Elysia route",
    });

    const notesAfterMutation = await fetch(new URL("/api/notes", server.url), {
      headers: { accept: "application/json" },
    });

    expect(await notesAfterMutation.json()).toStrictEqual([
      { id: 1, text: "created through the installed Elysia route" },
    ]);

    const rootAsset = await fetch(new URL("/_hesperia/startup.js", server.url));

    expect(rootAsset.status).toBe(200);

    expect(rootAsset.headers.get("content-type")).toContain("text/javascript");

    const servedStartupAsset = await fetch(
      new URL(`/_hesperia/assets/${startupAssetPath.slice("/assets/".length)}`, server.url),
    );

    expect(servedStartupAsset.status).toBe(200);

    expect(servedStartupAsset.headers.get("content-type")).toContain("javascript");

    expect(Buffer.from(await servedStartupAsset.arrayBuffer()).equals(startupBytes)).toBe(true);

    const missingManagedAsset = await fetch(new URL("/_hesperia/assets/missing.js", server.url), {
      headers: { accept: "application/javascript" },
    });

    expect(missingManagedAsset.status).toBe(404);

    expect(await missingManagedAsset.text()).toBe("");

    const headDocument = await fetch(new URL("/away", server.url), {
      method: "HEAD",
      headers: { accept: "text/html" },
    });

    expect(headDocument.status).toBe(200);

    expect(await headDocument.text()).toBe("");

    await page.goto(new URL("/away", server.url).href);

    await page.getByRole("heading", { name: "Test route", exact: true }).waitFor();

    expect(await page.locator("header a").getAttribute("href")).toBe("/");

    const rootURL = new URL("/", server.url).href;

    await page.locator("header a").click();

    await page.waitForURL(rootURL);

    await page.getByRole("heading", { name: "Welcome to Hesperia", exact: true }).waitFor();

    expect(page.url()).toBe(rootURL);

    expect(
      await page.locator("html").evaluate((node) => getComputedStyle(node).backgroundColor),
    ).toBe("rgb(16, 24, 39)");

    expect(await page.getByRole("button").textContent()).toContain("Count: 0");

    await page.getByRole("button").click();

    await page.waitForFunction(() =>
      document.querySelector("button")?.textContent?.includes("Count: 1"),
    );

    await page.goto(new URL("/notes", server.url).href);

    await page.waitForFunction(
      () =>
        document.querySelector("#notes")?.textContent ===
        "1:created through the installed Elysia route",
    );

    expect(await page.locator("#notes").textContent()).toContain(
      "created through the installed Elysia route",
    );

    await page.locator("#create-note").click();

    await page.waitForFunction(
      () =>
        document.querySelector("#created-note")?.textContent ===
        "2:created through installed browser adapter",
    );

    expect(await page.locator("#created-note").textContent()).toBe(
      "2:created through installed browser adapter",
    );

    await page.waitForFunction(
      () =>
        document.querySelector("#notes")?.textContent ===
        "1:created through the installed Elysia route|2:created through installed browser adapter",
    );

    await stopIntegratedServer(server);

    server = undefined;

    await copyFile(
      join(creatorFixtures, "hesperia.config.ts"),
      join(application, "hesperia.config.ts"),
    );

    expect(await run(application, "run", "check")).toContain("Hesperia checking passed");

    server = await startIntegratedServer(application);

    const nestedWrapper = await fetch(new URL("/dashboard/_hesperia/startup.js", server.url));

    expect(nestedWrapper.status).toBe(200);

    const nestedStartupAsset = await fetch(
      new URL(
        `/dashboard/_hesperia/assets/${startupAssetPath.slice("/assets/".length)}`,
        server.url,
      ),
    );

    expect(nestedStartupAsset.status).toBe(200);

    expect(Buffer.from(await nestedStartupAsset.arrayBuffer()).equals(startupBytes)).toBe(true);

    await page.goto(new URL("/dashboard/away", server.url).href);

    await page.getByRole("heading", { name: "Test route", exact: true }).waitFor();

    expect(await page.locator("header a").getAttribute("href")).toBe("/dashboard/");

    const nestedURL = new URL("/dashboard/", server.url).href;

    await page.locator("header a").click();

    await page.waitForURL(nestedURL);

    await page.getByRole("heading", { name: "Welcome to Hesperia", exact: true }).waitFor();

    expect(page.url()).toBe(nestedURL);

    expect(pageErrors).toStrictEqual([]);

    await stopIntegratedServer(server);

    server = undefined;

    server = await startIntegratedServer(noHostApplication, "preview", "--port", "0");

    const noHostDocument = await fetch(server.url, {
      headers: { accept: "text/html" },
    });

    expect(noHostDocument.status).toBe(200);

    expect(noHostDocument.headers.get("content-type")).toContain("text/html");

    expect((await noHostDocument.text()).toLowerCase()).toContain("<html");

    const noHostStartup = await fetch(new URL("/_hesperia/startup.js", server.url));

    expect(noHostStartup.status).toBe(200);

    expect(noHostStartup.headers.get("content-type")).toContain("javascript");

    const noHostPage = await browser.newPage();

    const noHostPageErrors: string[] = [];

    noHostPage.on("pageerror", (error) => noHostPageErrors.push(error.message));

    await noHostPage.goto(server.url.href);

    await noHostPage.getByRole("heading", { name: "Welcome to Hesperia", exact: true }).waitFor();

    const noHostCounter = noHostPage.getByRole("button");

    expect(await noHostCounter.textContent()).toContain("Count: 0");

    await noHostCounter.click();

    await noHostPage.waitForFunction(() =>
      document.querySelector("button")?.textContent?.includes("Count: 1"),
    );

    expect(noHostPageErrors).toStrictEqual([]);

    await stopIntegratedServer(server);

    server = undefined;

    passed = true;
  } finally {
    if (server) await stopIntegratedServer(server);

    await browser?.close();

    if (passed || process.env.HESPERIA_PACKAGE_TEST_KEEP_TEMP_ON_FAILURE !== "1") {
      await rm(workspace, { recursive: true, force: true });
    } else {
      console.error(`Retained failed creator fixture at ${workspace}`);
    }
  }
}, 240_000);
