import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { devProject } from "../../packages/tooling/src/server.ts";
import { linkFrameworkPackages, unlinkFrameworkPackages } from "./fixture-dependencies.ts";

const applicationFixture = join(import.meta.dir, "fixtures/applications/development-deletion");

const browserDriver = join(import.meta.dir, "fixtures/drivers/development-deletion-browser.mjs");

test.each(["chromium", "firefox", "webkit"] as const)(
  "%s development dependency deletion reloads affected active and cached pages while preserving an unrelated page",
  async (engineName) => {
    const root = await mkdtemp(join(tmpdir(), "hesperia-dev-deletion-"));

    let server: Awaited<ReturnType<typeof devProject>> | undefined;

    try {
      await linkFrameworkPackages(root);

      await mkdir(join(root, "src", "routes", "a"), { recursive: true });

      await mkdir(join(root, "src", "routes", "b"), { recursive: true });

      await copyFile(join(applicationFixture, "app.tsx"), join(root, "app.tsx"));

      await copyFile(
        join(applicationFixture, "src/routes/+loading.tsx"),
        join(root, "src", "routes", "+loading.tsx"),
      );

      for (const name of ["a", "b"]) {
        await writeFile(
          join(root, "src", "routes", name, "+page.tsx"),
          `import * as client from "hesperia/client"; import { beforeLeave, navigation } from "hesperia/navigation"; import "./page.css";
export default function Page() { const count = client.state(0); const veto = client.state(false); client.effect(() => { const navigate = () => { const result = navigation.navigate("/a"); void result.committed.catch(() => {}); void result.finished.then(() => window.dispatchEvent(new CustomEvent("fixture-api-result", { detail: "committed" })), error => window.dispatchEvent(new CustomEvent("fixture-api-result", { detail: error.name }))); }; window.addEventListener("fixture-api-navigate", navigate); return () => window.removeEventListener("fixture-api-navigate", navigate); }); beforeLeave(() => { window.dispatchEvent(new CustomEvent("fixture-departure", { detail: veto() })); return !veto(); }); return <main><button id="veto" on:click={() => veto.update(value => !value)}>Toggle veto</button><button id="reload" on:click={() => { const result = navigation.reload(); void result.committed.catch(() => {}); void result.finished.catch(() => {}); }}>Reload</button><button id="count" on:click={() => count.update(value => value + 1)}>{count()}</button><p id="${name}" class="${name}">${name}</p><a id="to-other" href="/${name === "a" ? "b" : "a"}">Other</a></main>; }`,
        );

        await writeFile(
          join(root, "src", "routes", name, "page.css"),
          name === "a" ? '@import "./removed.css";' : ".b { color: rgb(1, 2, 3); }",
        );
      }

      const css = join(root, "src", "routes", "a", "page.css");

      const removed = join(root, "src", "routes", "a", "removed.css");

      await writeFile(removed, ".a { color: rgb(20, 30, 40); }");

      const reports: string[] = [];

      server = await devProject(root, { port: 0, report: (message) => reports.push(message) });

      const child = Bun.spawn(
        [
          "node",
          browserDriver,
          pathToFileURL(resolve(import.meta.dir, "../../node_modules/playwright/index.mjs")).href,
          engineName,
          new URL("a", server.url).href,
          css,
          removed,
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
          `Deletion browser failed\n${output}\n${errors}\nReports: ${JSON.stringify(reports)}`,
        );

      expect(output.trim().endsWith("Active and cached deletion behavior verified")).toBe(true);
    } finally {
      await server?.close();

      await unlinkFrameworkPackages(root);

      await rm(root, { recursive: true, force: true });
    }
  },
  process.platform === "win32" ? 120_000 : 90_000,
);
