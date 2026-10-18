import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareBuild, writeBuild } from "../../packages/tooling/src/project.ts";
import { previewProject, type ProjectServer } from "../../packages/tooling/src/server.ts";
import { linkFrameworkPackages, unlinkFrameworkPackages } from "./fixture-dependencies.ts";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await unlinkFrameworkPackages(root);

    await rm(root, { recursive: true, force: true });
  }
});

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

test("one production capture serves exact assets at root and a nested mount", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-hosting-http-"));

  roots.push(root);

  await linkFrameworkPackages(root);

  await mkdir(join(root, "src/routes/early"), { recursive: true });

  await writeFile(join(root, "hesperia.config.json"), JSON.stringify({ mountURL: "/dashboard" }));

  await writeFile(
    join(root, "app.tsx"),
    await readFile(join(import.meta.dir, "fixtures/applications/production-host/app.tsx"), "utf8"),
  );

  await writeFile(
    join(root, "app.css"),
    await readFile(join(import.meta.dir, "fixtures/applications/production-host/app.css"), "utf8"),
  );

  await writeFile(
    join(root, "src/routes/+route.ts"),
    await readFile(
      join(import.meta.dir, "fixtures/applications/production-host/src/routes/+route.ts"),
      "utf8",
    ),
  );

  await writeFile(
    join(root, "src/routes/+page.tsx"),
    await readFile(
      join(import.meta.dir, "fixtures/applications/production-host/src/routes/+page.tsx"),
      "utf8",
    ),
  );

  await writeFile(
    join(root, "src/routes/home.css"),
    await readFile(
      join(import.meta.dir, "fixtures/applications/production-host/src/routes/home.css"),
      "utf8",
    ),
  );

  await writeFile(
    join(root, "src/routes/early/+page.tsx"),
    await readFile(
      join(import.meta.dir, "fixtures/applications/production-host/src/routes/early/http-page.tsx"),
      "utf8",
    ),
  );

  await writeFile(
    join(root, "src/routes/early/early.css"),
    await readFile(
      join(
        import.meta.dir,
        "fixtures/applications/production-host/src/routes/early/http-early.css",
      ),
      "utf8",
    ),
  );

  const build = await prepareBuild(root);

  expect(build.diagnostics).toStrictEqual([]);

  expect(build.hosting.standaloneMountURL).toBe("/dashboard");

  const record = JSON.parse(await build.files.get("/hesperia-build.json")!.text()) as {
    readonly routeGuards: Readonly<Record<string, string>>;
    readonly routeTable: string;
  };

  const guardPath = record.routeGuards["src/routes/+route.ts"]!;

  expect(guardPath).toMatch(/^\/assets\/routes\/guard-.*\.js$/u);

  const routeTable = await build.files.get(record.routeTable)!.text();

  expect(routeTable).toContain('import("./routes/guard-');

  expect(routeTable).not.toContain('import("/assets/routes/guard-');

  const emittedJavaScript = (
    await Promise.all(
      [...build.files].filter(([path]) => path.endsWith(".js")).map(([, file]) => file.text()),
    )
  ).join("\n");

  expect(emittedJavaScript).not.toContain("SERVER_ROUTE_MARKER");

  await writeBuild(root, build);

  let rootServer: ProjectServer | undefined;

  let dashboardServer: ProjectServer | undefined;

  try {
    rootServer = await previewProject(root, 0, { mountURL: "/" });

    dashboardServer = await previewProject(root, 0, { mountURL: "/dashboard" });

    const mounts = [
      { server: rootServer, mount: "", path: "/early" },
      { server: dashboardServer, mount: "/dashboard", path: "/dashboard/early" },
    ];

    for (const fixture of mounts) {
      const assetBase = fixture.mount + "/_hesperia";

      const document = await fetch(new URL(fixture.path, fixture.server.url), {
        headers: { accept: "text/html" },
      });

      expect(document.status).toBe(200);

      expect(await document.text()).toContain(
        `<script type="module" src="${assetBase}/startup.js">`,
      );

      const wrapper = await fetch(new URL(assetBase + "/startup.js", fixture.server.url));

      expect(wrapper.status).toBe(200);

      expect(await wrapper.text()).toContain(`await start("${fixture.mount || "/"}")`);

      for (const asset of build.hosting.assets) {
        expect(build.files.get(asset.path)).toBeInstanceOf(Blob);

        const response = await fetch(new URL(assetBase + asset.path, fixture.server.url));

        expect(response.status).toBe(200);

        expect(response.headers.get("content-type")).toBe(asset.contentType);

        expect(sha256(new Uint8Array(await response.arrayBuffer()))).toBe(asset.sha256);
      }

      for (const asset of build.hosting.assets.filter((item) =>
        item.contentType.startsWith("text/javascript"),
      )) {
        const source = await build.files.get(asset.path)!.text();

        const moduleUrl = new URL(assetBase + asset.path, fixture.server.url);

        const specifiers = [
          ...source.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["'](\.{1,2}\/[^"']+)["']/gu),
        ].map((match) => match[1]!);

        for (const specifier of specifiers) {
          const importedUrl = new URL(specifier, moduleUrl);

          expect(importedUrl.pathname.startsWith(assetBase + "/assets/")).toBe(true);

          expect(importedUrl.pathname).not.toContain("/assets/assets/");

          expect((await fetch(importedUrl)).status).toBe(200);
        }
      }

      const guard = await fetch(new URL(assetBase + guardPath, fixture.server.url));

      expect(guard.status).toBe(200);

      expect(await guard.text()).not.toContain("SERVER_ROUTE_MARKER");

      expect(
        (await fetch(new URL(assetBase + "/assets/missing.js", fixture.server.url))).status,
      ).toBe(404);

      for (const path of [
        "/hesperia-build.json",
        "/src/routes/+route.ts",
        "/package.json",
        "/.hesperia/build/hesperia-build.json",
      ]) {
        const response = await fetch(new URL(path, fixture.server.url));

        expect(response.status).toBe(404);
      }

      if (fixture.mount) {
        for (const path of [
          "/hesperia-build.json",
          "/src/routes/+route.ts",
          "/package.json",
          "/.hesperia/build/hesperia-build.json",
        ]) {
          const response = await fetch(new URL(fixture.mount + path, fixture.server.url), {
            headers: { accept: "application/json" },
          });

          expect(response.status).toBe(404);
        }
      }
    }
  } finally {
    await dashboardServer?.close();

    await rootServer?.close();
  }
}, 45_000);
