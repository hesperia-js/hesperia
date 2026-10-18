import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { devProject, type ProjectServer } from "../../packages/tooling/src/server.ts";

const applicationFixture = join(import.meta.dir, "fixtures/applications/development-browser");
const browserDriver = join(import.meta.dir, "fixtures/drivers/development-browser.mjs");

test("development browsers forward authored unsafe warnings and reload fresh state after an edit", async () => {
  const parent = resolve(import.meta.dir, "../../.hesperia");

  await mkdir(parent, { recursive: true });

  const root = await mkdtemp(join(parent, "development-browser-"));
  const cleanupRelative = relative(parent, resolve(root));

  if (
    isAbsolute(cleanupRelative) ||
    !cleanupRelative.startsWith("development-browser-") ||
    cleanupRelative.includes("/") ||
    cleanupRelative.includes("\\")
  )
    throw new Error("Invalid development fixture cleanup path");

  const reports: string[] = [];
  let server: ProjectServer | undefined;

  const pageSource = (version: string) => `import * as client from "hesperia/client";
export default function Page() {
  const count = client.state(0);
  const input = client.unsafeBind<HTMLInputElement>();
  return <main><span id="version">${version}</span><input bind={input} /><button id="count" on:click={() => count.update(value => value + 1)}>{count()}</button></main>;
}`;

  try {
    const route = join(root, "src/routes/nested/+page.tsx");

    await mkdir(resolve(route, ".."), { recursive: true });

    await copyFile(join(applicationFixture, "app.tsx"), join(root, "app.tsx"));

    await writeFile(route, pageSource("first"));

    await copyFile(
      join(applicationFixture, "src/routes/+loading.tsx"),
      join(root, "src/routes/+loading.tsx"),
    );

    server = await devProject(root, { port: 0, report: (message) => reports.push(message) });

    const child = Bun.spawn(
      [
        "node",
        browserDriver,
        pathToFileURL(resolve(import.meta.dir, "../../node_modules/playwright/index.mjs")).href,
        new URL("/nested", server.url).href,
        route,
        pageSource("second"),
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

    if (status !== 0)
      throw new Error(
        `Development browser flow failed\n${output}\n${errors}\nServer reports: ${JSON.stringify(reports)}`,
      );

    expect(output.trim().split(/\r?\n/u)).toStrictEqual([
      "chromium development warning and reload verified",
      "firefox development warning and reload verified",
      "webkit development warning and reload verified",
    ]);

    expect(
      reports.filter((message) => message.includes("unsafeBind")).length,
    ).toBeGreaterThanOrEqual(3);

    expect(reports.filter((message) => !message.includes("unsafeBind"))).toStrictEqual([]);
  } finally {
    await server?.close();

    await rm(root, { recursive: true, force: true });
  }
}, 90_000);
