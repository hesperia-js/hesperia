import { afterEach, expect, test } from "bun:test";
import { readPinnedAeoliaVersion } from "./package-manifest.ts";
import { suppliedReleaseArchive } from "./release-candidate.ts";
import { createRequire } from "node:module";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const packageRoot = resolve(
  process.env.HESPERIA_PACKAGE_TEST_ROOT ?? resolve(import.meta.dir, "../.."),
);

const hostingFixtures = join(import.meta.dir, "fixtures", "applications", "hosting");

const workspaces: string[] = [];

const consumers: ReturnType<typeof Bun.spawn>[] = [];

const previews: ReturnType<typeof Bun.spawn>[] = [];

afterEach(async () => {
  for (const process_ of [...previews.splice(0), ...consumers.splice(0)]) {
    process_.kill();

    await process_.exited;
  }

  for (const workspace of workspaces.splice(0))
    await rm(workspace, { recursive: true, force: true });
});

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

async function pack(workspace: string, root: string): Promise<string> {
  const supplied = await suppliedReleaseArchive(root);

  if (supplied) return supplied;

  const before = new Set(await readdir(workspace));

  await run(root, "pm", "pack", "--destination", workspace, "--ignore-scripts", "--quiet");

  const [name] = (await readdir(workspace)).filter(
    (item) => item.endsWith(".tgz") && !before.has(item),
  );

  if (!name) throw new Error(`Packing ${root} produced no tarball`);

  return join(workspace, name).replaceAll("\\", "/");
}

async function waitForOutput(
  child: ReturnType<typeof Bun.spawn>,
  pattern: RegExp,
): Promise<string> {
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();

  let output = "";

  try {
    while (true) {
      const chunk = await reader.read();

      if (chunk.done) {
        const [status, errors] = await Promise.all([
          child.exited,
          new Response(child.stderr as ReadableStream<Uint8Array>).text(),
        ]);

        throw new Error(`Installed server exited (${status})\n${output}\n${errors}`);
      }

      output += new TextDecoder().decode(chunk.value);

      if (pattern.test(output)) return output;
    }
  } finally {
    reader.releaseLock();
  }
}

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

test("packed tooling and hosting serve captured assets at root and a nested mount", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "hesperia-hosting-installed-http-"));

  workspaces.push(workspace);

  const application = join(workspace, "external hosted app");

  const tarballs = {
    hesperia: await pack(workspace, resolve(packageRoot, "packages/hesperia")),
    compiler: await pack(workspace, resolve(packageRoot, "packages/compiler")),
    hosting: await pack(workspace, resolve(packageRoot, "packages/hosting")),
    tooling: await pack(workspace, resolve(packageRoot, "packages/tooling")),
  };

  await writeFile(
    join(workspace, "package.json"),
    JSON.stringify(
      {
        name: "hesperia-hosting-installed-http-smoke",
        private: true,
        type: "module",
        dependencies: {
          aeolia: await readPinnedAeoliaVersion(packageRoot),
          hesperia: tarballs.hesperia,
          "@hesperia/compiler": tarballs.compiler,
          "@hesperia/hosting": tarballs.hosting,
          "@hesperia/tooling": tarballs.tooling,
        },
        overrides: {
          aeolia: await readPinnedAeoliaVersion(packageRoot),
          hesperia: tarballs.hesperia,
          "@hesperia/compiler": tarballs.compiler,
          "@hesperia/hosting": tarballs.hosting,
          "@hesperia/tooling": tarballs.tooling,
        },
      },
      null,
      2,
    ),
  );

  await run(workspace, "install", "--ignore-scripts");

  const require = createRequire(join(workspace, "package.json"));

  for (const packageName of ["@hesperia/hosting", "@hesperia/tooling"]) {
    expect(require.resolve(packageName)).toContain(join("node_modules", ...packageName.split("/")));
  }

  await stat(join(workspace, "node_modules", "@hesperia", "hosting", "dist", "index.js"));

  await stat(join(workspace, "node_modules", "@hesperia", "tooling", "dist", "project.js"));

  await copyFile(
    join(hostingFixtures, "http-consumer-types.ts"),
    join(workspace, "consumer-types.ts"),
  );

  await writeFile(
    join(workspace, "tsconfig.consumer.json"),
    JSON.stringify({
      compilerOptions: {
        lib: ["ESNext", "DOM"],
        module: "ESNext",
        moduleResolution: "Bundler",
        noEmit: true,
        skipLibCheck: true,
        strict: true,
        types: [],
      },
      files: ["consumer-types.ts"],
    }),
  );

  await run(
    workspace,
    join(workspace, "node_modules", "typescript", "bin", "tsc"),
    "--project",
    "tsconfig.consumer.json",
  );

  await mkdir(join(application, "src", "routes", "early"), { recursive: true });

  await writeFile(
    join(application, "hesperia.config.json"),
    JSON.stringify({ mountURL: "/dashboard" }),
  );

  for (const path of [
    "app.tsx",
    "app.css",
    "src/routes/+route.ts",
    "src/routes/+page.tsx",
    "src/routes/home.css",
    "src/routes/early/early.css",
  ]) {
    await copyFile(join(hostingFixtures, path), join(application, path));
  }

  await copyFile(
    join(hostingFixtures, "src/routes/early/http-page.tsx"),
    join(application, "src/routes/early/+page.tsx"),
  );

  await writeFile(
    join(application, "serve-build.ts"),
    await readFile(join(import.meta.dir, "fixtures", "hosting-consumer-server.ts"), "utf8"),
  );

  consumers.push(
    Bun.spawn([process.execPath, join(application, "serve-build.ts")], {
      cwd: application,
      stdout: "pipe",
      stderr: "pipe",
    }),
  );

  const consumer = consumers.at(-1)!;

  const output = await waitForOutput(consumer, /\{"rootURL":"http:\/\/127\.0\.0\.1:\d+\//u);

  const serving = JSON.parse(output.trim().split(/\r?\n/u)[0]!) as {
    readonly rootURL: string;
    readonly dashboardURL: string;
    readonly hosting: {
      readonly mode: "production";
      readonly standaloneMountURL: string;
      readonly assets: readonly {
        readonly path: string;
        readonly sha256: string;
        readonly contentType: string;
      }[];
    };
  };

  expect(serving.hosting.mode).toBe("production");

  expect(serving.hosting.standaloneMountURL).toBe("/dashboard");

  const mounts = [
    { url: serving.rootURL, mount: "", path: "/early" },
    { url: serving.dashboardURL, mount: "/dashboard", path: "/dashboard/early" },
  ];

  for (const fixture of mounts) {
    const assetBase = fixture.mount + "/_hesperia";

    const document = await fetch(new URL(fixture.path, fixture.url), {
      headers: { accept: "text/html" },
    });

    expect(document.status).toBe(200);

    expect(await document.text()).toContain(`<script type="module" src="${assetBase}/startup.js">`);

    const wrapper = await fetch(new URL(assetBase + "/startup.js", fixture.url));

    expect(wrapper.status).toBe(200);

    expect(await wrapper.text()).toContain(`await start("${fixture.mount || "/"}")`);

    for (const asset of serving.hosting.assets) {
      const response = await fetch(new URL(assetBase + asset.path, fixture.url));

      expect(response.status).toBe(200);

      expect(response.headers.get("content-type")).toBe(asset.contentType);

      const bytes = new Uint8Array(await response.arrayBuffer());

      expect(sha256(bytes)).toBe(asset.sha256);

      if (!asset.contentType.startsWith("text/javascript")) continue;

      const source = new TextDecoder().decode(bytes);

      const moduleUrl = new URL(assetBase + asset.path, fixture.url);

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

    const guard = serving.hosting.assets.find((asset) =>
      asset.path.includes("/assets/routes/guard-"),
    );

    expect(guard).toBeDefined();

    const guardResponse = await fetch(new URL(assetBase + guard!.path, fixture.url));

    expect(guardResponse.status).toBe(200);

    expect(await guardResponse.text()).not.toContain("INSTALLED_SERVER_ROUTE_MARKER");

    expect((await fetch(new URL(assetBase + "/assets/missing.js", fixture.url))).status).toBe(404);

    for (const path of ["/hesperia-build.json", "/src/routes/+route.ts", "/package.json"]) {
      expect(
        (
          await fetch(new URL(path, fixture.url), {
            headers: { accept: "application/json" },
          })
        ).status,
      ).toBe(404);
    }

    if (fixture.mount) {
      for (const path of [
        "/hesperia-build.json",
        "/src/routes/+route.ts",
        "/package.json",
        "/.hesperia/build/hesperia-build.json",
      ]) {
        expect(
          (
            await fetch(new URL(fixture.mount + path, fixture.url), {
              headers: { accept: "application/json" },
            })
          ).status,
        ).toBe(404);
      }
    }
  }

  const preview = Bun.spawn(
    [
      process.execPath,
      join(workspace, "node_modules", "@hesperia", "tooling", "dist", "cli.js"),
      "preview",
      "--port",
      "0",
    ],
    { cwd: application, stdout: "pipe", stderr: "pipe" },
  );

  previews.push(preview);

  const previewOutput = await waitForOutput(
    preview,
    /Hesperia preview: http:\/\/127\.0\.0\.1:\d+\//u,
  );

  const previewURL = previewOutput.match(/Hesperia preview: (http:\/\/127\.0\.0\.1:\d+\/)/u)?.[1];

  expect(previewURL).toBeDefined();

  const previewDocument = await fetch(new URL("/dashboard/early", previewURL!), {
    headers: { accept: "text/html" },
  });

  expect(previewDocument.status).toBe(200);

  expect(await previewDocument.text()).toContain(
    '<script type="module" src="/dashboard/_hesperia/startup.js">',
  );

  for (const path of ["/hesperia-build.json", "/src/routes/+route.ts", "/package.json"]) {
    expect(
      (
        await fetch(new URL(path, previewURL!), {
          headers: { accept: "application/json" },
        })
      ).status,
    ).toBe(404);
  }

  for (const path of [
    "/dashboard/hesperia-build.json",
    "/dashboard/src/routes/+route.ts",
    "/dashboard/package.json",
    "/dashboard/.hesperia/build/hesperia-build.json",
  ]) {
    expect(
      (
        await fetch(new URL(path, previewURL!), {
          headers: { accept: "application/json" },
        })
      ).status,
    ).toBe(404);
  }
}, 120_000);
