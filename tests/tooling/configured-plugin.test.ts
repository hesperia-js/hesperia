import { afterEach, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { linkFrameworkPackages, unlinkFrameworkPackages } from "./fixture-dependencies.ts";

const roots: string[] = [];

const applicationFixture = join(import.meta.dir, "fixtures/applications/configured-plugin");

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await unlinkFrameworkPackages(root);

    await rm(root, { recursive: true, force: true });
  }
});

test("installed command checks and emits a configured custom import from one project-root process", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-configured-plugin-"));

  roots.push(root);

  await linkFrameworkPackages(root);

  await mkdir(join(root, "src"));

  await copyFile(join(applicationFixture, "palette.dat"), join(root, "palette.dat"));

  await copyFile(join(applicationFixture, "src/detail.ts"), join(root, "src", "detail.ts"));

  await copyFile(join(applicationFixture, "app.tsx"), join(root, "app.tsx"));

  const configurationSource = await readFile(
    join(applicationFixture, "hesperia.config.ts"),
    "utf8",
  );

  await copyFile(join(applicationFixture, "hesperia.config.ts"), join(root, "hesperia.config.ts"));

  const executable = resolve(import.meta.dir, "../../packages/tooling/dist/cli.js");

  const captureAdapter = process.env.HESPERIA_CONFIGURED_PLUGIN_BUILD_ADAPTER;

  const run = async (command: string) => {
    if (captureAdapter && command === "build") {
      const { runConfiguredPluginBuildCli } = (await import(
        pathToFileURL(captureAdapter).href
      )) as {
        runConfiguredPluginBuildCli(input: {
          readonly cwd: string;
          readonly execPath: string;
          readonly entryPath: string;
          readonly args: readonly string[];
        }): Promise<{
          readonly status: number;
          readonly stdout: string;
          readonly stderr: string;
        }>;
      };

      const result = await runConfiguredPluginBuildCli({
        cwd: root,
        execPath: process.execPath,
        entryPath: executable,
        args: [command],
      });

      return { code: result.status, stdout: result.stdout, stderr: result.stderr };
    }

    const child = Bun.spawn([process.execPath, executable, command], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    return { code, stdout, stderr };
  };

  const checked = await run("check");

  expect(checked.code, checked.stderr).toBe(0);

  expect(checked.stdout).toContain("checking passed");

  const built = await run("build");

  expect(built.code, built.stderr).toBe(0);

  const record = JSON.parse(
    await readFile(join(root, ".hesperia", "build", "hesperia-build.json"), "utf8"),
  ) as {
    readonly assetDirectory: string;
    readonly hosting: {
      readonly assets: readonly { readonly path: string; readonly contentType: string }[];
    };
  };

  const js = (
    await Promise.all(
      record.hosting.assets
        .filter((asset) => asset.contentType.startsWith("text/javascript"))
        .map((asset) =>
          readFile(
            join(
              root,
              ".hesperia",
              "build",
              ...record.assetDirectory.split("/"),
              asset.path.slice("/assets/".length),
            ),
            "utf8",
          ),
        ),
    )
  ).join("\n");

  expect(js).toContain("red,blue:app");

  expect(js).toContain("red,blue:detail");

  expect(js).toContain("Infinity");

  expect(js).toContain("visible");

  const declarations = await readFile(join(root, "hesperia.d.ts"), "utf8");

  expect(declarations).toContain('declare module "hesperia/config/public"');

  expect(declarations).toContain('readonly "flags": readonly [true, undefined, number]');

  await copyFile(join(applicationFixture, "public-consumer.ts"), join(root, "public-consumer.ts"));

  await copyFile(
    join(applicationFixture, "tsconfig.public.json"),
    join(root, "tsconfig.public.json"),
  );

  const tsc = Bun.spawn(
    [
      process.execPath,
      resolve(import.meta.dir, "../../node_modules/typescript/bin/tsc"),
      "-p",
      join(root, "tsconfig.public.json"),
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );

  const [typeExit, typeOutput] = await Promise.all([tsc.exited, new Response(tsc.stdout).text()]);

  expect(typeExit, typeOutput).toBe(0);

  await writeFile(
    join(root, "hesperia.config.ts"),
    configurationSource.replace(
      '"export default " + JSON.stringify(contents + ":" + label) + ";"',
      '"export default process.env.SECRET;"',
    ),
  );

  const rejected = await run("build");

  expect(rejected.code).toBe(1);

  expect(rejected.stderr).toContain("HES-CAPABILITY");
});
