import { expect, test } from "bun:test";
import { readPinnedAeoliaVersion } from "./package-manifest.ts";
import { suppliedReleaseArchive } from "./release-candidate.ts";
import { chromium } from "playwright";
import { createRequire } from "node:module";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const packageRoot = resolve(
  process.env.HESPERIA_PACKAGE_TEST_ROOT ?? resolve(import.meta.dir, "../.."),
);

const hostingFixtures = join(import.meta.dir, "fixtures", "applications", "hosting");

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

  if (status !== 0)
    throw new Error(args.join(" ") + " failed (" + status + ")\n" + stdout + "\n" + stderr);

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

  if (!name) throw new Error("Packing " + root + " produced no new tarball");

  return join(workspace, name).replaceAll("\\", "/");
}

async function waitForOutput(
  child: ReturnType<typeof Bun.spawn>,
  pattern: RegExp,
): Promise<{ readonly match: RegExpMatchArray; readonly output: string }> {
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

        throw new Error(
          "Consumer process exited before ready (" + status + ")\n" + output + "\n" + errors,
        );
      }

      output += new TextDecoder().decode(chunk.value);

      const match = output.match(pattern);

      if (match) return { match, output };
    }
  } finally {
    reader.releaseLock();
  }
}

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

test("packed tooling and hosting serve one built route at root and a nested mount", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "hesperia-hosting-installed-"));

  const application = join(workspace, "external hosted app");

  let consumer: ReturnType<typeof Bun.spawn> | undefined;

  let preview: ReturnType<typeof Bun.spawn> | undefined;

  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

  try {
    const tarballs = {
      hesperia: await pack(workspace, resolve(packageRoot, "packages/hesperia")),
      compiler: await pack(workspace, resolve(packageRoot, "packages/compiler")),
      hosting: await pack(workspace, resolve(packageRoot, "packages/hosting")),
      tooling: await pack(workspace, resolve(packageRoot, "packages/tooling")),
    };

    await mkdir(application, { recursive: true });

    const manifest = {
      name: "hesperia-hosting-installed-smoke",
      private: true,
      type: "module",
      dependencies: {
        aeolia: await readPinnedAeoliaVersion(packageRoot),
        hesperia: tarballs.hesperia,
        "@hesperia/hosting": tarballs.hosting,
        "@hesperia/tooling": tarballs.tooling,
        "@hesperia/compiler": tarballs.compiler,
      },
      overrides: {
        aeolia: await readPinnedAeoliaVersion(packageRoot),
        hesperia: tarballs.hesperia,
        "@hesperia/hosting": tarballs.hosting,
        "@hesperia/tooling": tarballs.tooling,
        "@hesperia/compiler": tarballs.compiler,
      },
    };

    await writeFile(join(application, "package.json"), JSON.stringify(manifest, null, 2));

    await writeFile(
      join(application, "hesperia.config.json"),
      JSON.stringify({ mountURL: "/dashboard" }),
    );

    await mkdir(join(application, "src", "routes", "early"), { recursive: true });

    for (const path of [
      "app.tsx",
      "app.css",
      "src/routes/+route.ts",
      "src/routes/+page.tsx",
      "src/routes/early/+page.tsx",
      "src/routes/home.css",
      "src/routes/early/early.css",
    ]) {
      await copyFile(join(hostingFixtures, path), join(application, path));
    }

    await writeFile(
      join(application, "serve-build.ts"),
      await readFile(join(import.meta.dir, "fixtures", "hosting-consumer-server.ts"), "utf8"),
    );

    await run(application, "install", "--ignore-scripts");

    const require = createRequire(join(application, "package.json"));

    expect(require.resolve("@hesperia/hosting")).toContain(
      join("node_modules", "@hesperia", "hosting"),
    );

    expect(require.resolve("@hesperia/tooling")).toContain(
      join("node_modules", "@hesperia", "tooling"),
    );

    for (const packageName of ["@hesperia/hosting", "@hesperia/tooling"]) {
      const packagePath = join(application, "node_modules", packageName, "package.json");

      const packed = JSON.parse(await readFile(packagePath, "utf8")) as {
        readonly exports: Readonly<
          Record<string, string | { readonly types?: string; readonly import?: string }>
        >;
      };

      const packageDirectory = dirname(packagePath);

      for (const target of Object.values(packed.exports)) {
        if (typeof target === "string") {
          await stat(join(packageDirectory, target));

          continue;
        }

        for (const path of [target.types, target.import])
          if (path) await stat(join(packageDirectory, path));
      }
    }

    await copyFile(
      join(hostingFixtures, "consumer-types.ts"),
      join(application, "consumer-types.ts"),
    );

    await writeFile(
      join(application, "tsconfig.consumer.json"),
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
      application,
      join(application, "node_modules", "typescript", "bin", "tsc"),
      "--project",
      "tsconfig.consumer.json",
    );

    consumer = Bun.spawn([process.execPath, join(application, "serve-build.ts")], {
      cwd: application,
      stdout: "pipe",
      stderr: "pipe",
    });

    const ready = await waitForOutput(
      consumer,
      /\{"rootURL":"http:\/\/127\.0\.0\.1:\d+\/","dashboardURL":"http:\/\/127\.0\.0\.1:\d+\/"/u,
    );

    const [jsonLine] = ready.output.trim().split(/\r?\n/u);

    const serving = JSON.parse(jsonLine!) as {
      readonly rootURL: string;
      readonly dashboardURL: string;
      readonly hosting: {
        readonly standaloneMountURL: string;
        readonly assets: readonly {
          readonly path: string;
          readonly sha256: string;
          readonly contentType: string;
        }[];
      };
    };

    expect(serving.hosting.standaloneMountURL).toBe("/dashboard");

    const mounts = [
      { name: "root", url: serving.rootURL, mount: "", path: "/early" },
      {
        name: "dashboard",
        url: serving.dashboardURL,
        mount: "/dashboard",
        path: "/dashboard/early",
      },
    ];

    for (const fixture of mounts) {
      const assetBase = fixture.mount + "/_hesperia";

      const document = await fetch(new URL(fixture.path, fixture.url), {
        headers: { accept: "text/html" },
      });

      expect(document.status).toBe(200);

      expect(await document.text()).toContain(
        '<script type="module" src="' + assetBase + '/startup.js">',
      );

      const wrapper = await fetch(new URL(assetBase + "/startup.js", fixture.url));

      expect(await wrapper.text()).toContain('await start("' + (fixture.mount || "/") + '")');

      for (const asset of serving.hosting.assets) {
        const response = await fetch(new URL(assetBase + asset.path, fixture.url));

        expect(response.status).toBe(200);

        expect(response.headers.get("content-type")).toBe(asset.contentType);

        expect(sha256(new Uint8Array(await response.arrayBuffer()))).toBe(asset.sha256);
      }

      expect((await fetch(new URL(assetBase + "/assets/missing.js", fixture.url))).status).toBe(
        404,
      );

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

    browser = await chromium.launch();

    for (const fixture of mounts) {
      const page = await browser.newPage();

      const errors: string[] = [];

      const requests: string[] = [];

      page.on("pageerror", (error) => errors.push(error.message));

      page.on("request", (request) => requests.push(new URL(request.url()).pathname));

      await page.addInitScript(() => {
        const observed = window as unknown as {
          __installedFirstRender?: { color: string; sheets: { href: string; ready: boolean }[] };
        };

        const observer = new MutationObserver(() => {
          if (observed.__installedFirstRender || !document.querySelector(".early-proof")) return;

          const sheets = [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')];

          observed.__installedFirstRender = {
            color: getComputedStyle(document.querySelector(".early-proof")!).color,
            sheets: sheets.map((link) => ({ href: link.href, ready: Boolean(link.sheet) })),
          };
        });

        observer.observe(document, { childList: true, subtree: true });
      });

      await page.goto(new URL(fixture.path, fixture.url).href);

      await page.waitForFunction(
        () => document.querySelector(".early-proof")?.textContent === "Installed early route",
      );

      expect(new URL(page.url()).pathname).toBe(fixture.path);

      expect(
        await page.locator(".early-proof").evaluate((node) => getComputedStyle(node).color),
      ).toBe("rgb(17, 34, 51)");

      const firstRender = await page.evaluate(
        () =>
          (
            window as unknown as {
              __installedFirstRender?: {
                color: string;
                sheets: { href: string; ready: boolean }[];
              };
            }
          ).__installedFirstRender,
      );

      expect(firstRender?.color).toBe("rgb(17, 34, 51)");

      expect(
        firstRender?.sheets.some((sheet) => sheet.href.includes("early-") && sheet.ready),
      ).toBe(true);

      expect(
        requests.some(
          (path) => path.includes("/_hesperia/assets/routes/guard-") && path.endsWith(".js"),
        ),
      ).toBe(true);

      expect(
        requests.some((path) => path.includes("/_hesperia/assets/") && path.endsWith(".css")),
      ).toBe(true);

      expect(errors).toStrictEqual([]);

      await page.close();
    }

    preview = Bun.spawn(
      [
        process.execPath,
        join(application, "node_modules", "@hesperia", "tooling", "dist", "cli.js"),
        "preview",
        "--port",
        "0",
      ],
      { cwd: application, stdout: "pipe", stderr: "pipe" },
    );

    const previewReady = await waitForOutput(
      preview,
      /Hesperia preview: http:\/\/127\.0\.0\.1:\d+\//u,
    );

    const previewURL = previewReady.match[0]!.replace("Hesperia preview: ", "");

    const previewDocument = await fetch(new URL("/dashboard/early", previewURL), {
      headers: { accept: "text/html" },
    });

    expect(previewDocument.status).toBe(200);

    expect(await previewDocument.text()).toContain(
      '<script type="module" src="/dashboard/_hesperia/startup.js">',
    );

    for (const path of ["/hesperia-build.json", "/src/routes/+route.ts", "/package.json"]) {
      expect(
        (
          await fetch(new URL(path, previewURL), {
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
          await fetch(new URL(path, previewURL), {
            headers: { accept: "application/json" },
          })
        ).status,
      ).toBe(404);
    }
  } finally {
    await browser?.close();

    if (preview) {
      preview.kill();

      await preview.exited;
    }

    if (consumer) {
      consumer.kill();

      await consumer.exited;
    }

    await rm(workspace, { recursive: true, force: true });
  }
}, 120_000);
