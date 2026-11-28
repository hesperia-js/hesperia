import { browserLaunchOptions } from "../support/browser-launch.mjs";
import { afterEach, expect, test } from "bun:test";
import {
  chromium,
  firefox,
  webkit,
  type Browser,
  type Page,
  type Response as BrowserResponse,
} from "playwright";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  readTargetedBuild,
  type InProcessTargetedDeploymentCapturedBuildV4,
} from "../../packages/hosting/src/index.ts";
import { prepareBuild, writeBuild } from "../../packages/tooling/src/project.ts";
import { previewProject, type ProjectServer } from "../../packages/tooling/src/server.ts";
import { linkFrameworkPackages, unlinkFrameworkPackages } from "./fixture-dependencies.ts";
import {
  createGeneratedAssetProviderFixture,
  type GeneratedAssetProviderEvent,
  type GeneratedAssetScenario,
  type GeneratedAssetScenarioInput,
} from "./fixtures/generated-assets-browser.ts";

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

test("one production build serves root and nested hosts without changing its assets", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-hosting-production-"));

  roots.push(root);

  await linkFrameworkPackages(root);

  await mkdir(join(root, "src", "routes", "early"), { recursive: true });

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
      join(import.meta.dir, "fixtures/applications/production-host/src/routes/early/+page.tsx"),
      "utf8",
    ),
  );

  await writeFile(
    join(root, "src/routes/early/early.css"),
    await readFile(
      join(import.meta.dir, "fixtures/applications/production-host/src/routes/early/early.css"),
      "utf8",
    ),
  );

  const build = await prepareBuild(root).catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "diagnostics" in error)
      throw new Error(
        `Mounted production fixture diagnostics: ${JSON.stringify(error.diagnostics)}`,
        { cause: error },
      );

    throw error;
  });

  expect(build.diagnostics).toStrictEqual([]);

  expect(build.hosting.standaloneMountURL).toBe("/dashboard");

  await writeBuild(root, build);

  const record = JSON.parse(
    await readFile(join(root, ".hesperia", "build", "hesperia-build.json"), "utf8"),
  ) as {
    readonly routeGuards: Readonly<Record<string, string>>;
    readonly routeTable: string;
    readonly hosting: typeof build.hosting;
  };

  expect(record.hosting).toStrictEqual(build.hosting);

  const stylesheetAssets = build.hosting.assets.filter((asset) =>
    asset.contentType.startsWith("text/css"),
  );

  expect(stylesheetAssets.length).toBeGreaterThanOrEqual(2);

  const guardPath = record.routeGuards["src/routes/+route.ts"];

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

  let rootServer: ProjectServer | undefined;

  let dashboardServer: ProjectServer | undefined;

  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

  try {
    rootServer = await previewProject(root, 0, { mountURL: "/" });

    dashboardServer = await previewProject(root, 0, { mountURL: "/dashboard" });

    const mounts = [
      { name: "root", server: rootServer, mount: "", path: "/early" },
      {
        name: "dashboard",
        server: dashboardServer,
        mount: "/dashboard",
        path: "/dashboard/early",
      },
    ];

    for (const fixture of mounts) {
      const assetBase = fixture.mount + "/_hesperia";

      const document = await fetch(new URL(fixture.path, fixture.server.url), {
        headers: { accept: "text/html" },
      });

      expect(document.status).toBe(200);

      expect(await document.text()).toContain(
        '<script type="module" crossorigin="anonymous" src="' + assetBase + '/startup.js">',
      );

      const wrapper = await fetch(new URL(assetBase + "/startup.js", fixture.server.url));

      const expectedGeneratedAssets = JSON.stringify({
        root: { kind: "path", pathname: `${assetBase}/` },
        moduleCredentials: "anonymous",
        credentials: "same-origin",
      });

      expect(await wrapper.text()).toContain(
        `await start(${JSON.stringify(fixture.mount || "/")}, ${expectedGeneratedAssets},`,
      );

      for (const asset of build.hosting.assets) {
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

      expect(
        (await fetch(new URL(assetBase + "/assets/missing.js", fixture.server.url))).status,
      ).toBe(404);

      for (const path of ["/hesperia-build.json", "/src/routes/+route.ts", "/package.json"]) {
        const response = await fetch(new URL(path, fixture.server.url), {
          headers: { accept: "application/json" },
        });

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

    const guardPath = record.routeGuards["src/routes/+route.ts"]!;

    const guardAsset = build.hosting.assets.find((asset) => asset.path === guardPath)!;

    expect(guardAsset).toBeDefined();

    for (const fixture of mounts) {
      const response = await fetch(
        new URL(fixture.mount + "/_hesperia" + guardPath, fixture.server.url),
      );

      expect(response.status).toBe(200);

      expect(await response.text()).not.toContain("SERVER_ROUTE_MARKER");
    }

    const earlyStyle = stylesheetAssets.find((asset) => asset.path.includes("early"));

    expect(earlyStyle).toBeDefined();

    browser = await chromium.launch(browserLaunchOptions("chromium"));

    for (const fixture of mounts) {
      const page = await browser.newPage();

      const errors: string[] = [];

      const consoleErrors: {
        text: string;
        location: ReturnType<import("playwright").ConsoleMessage["location"]>;
      }[] = [];

      const requests: string[] = [];

      const responses: { path: string; status: number }[] = [];

      const failedRequests: { path: string; failure: string | undefined }[] = [];

      page.on("pageerror", (error) => errors.push(error.message));

      page.on("console", (message) => {
        if (message.type() === "error") {
          errors.push(`console: ${message.text()}`);
          consoleErrors.push({ text: message.text(), location: message.location() });
        }
      });

      page.on("request", (request) => requests.push(new URL(request.url()).pathname));

      page.on("requestfailed", (request) =>
        failedRequests.push({
          path: new URL(request.url()).pathname,
          failure: request.failure()?.errorText,
        }),
      );

      page.on("response", (response) =>
        responses.push({ path: new URL(response.url()).pathname, status: response.status() }),
      );

      await page.addInitScript(() => {
        const observed = window as unknown as {
          __r13FirstRender?: { color: string; sheets: { href: string; ready: boolean }[] };
        };

        const observer = new MutationObserver(() => {
          if (observed.__r13FirstRender || !document.querySelector(".early-proof")) return;

          const sheets = [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')];

          observed.__r13FirstRender = {
            color: getComputedStyle(document.querySelector(".early-proof")!).color,
            sheets: sheets.map((link) => ({ href: link.href, ready: Boolean(link.sheet) })),
          };
        });

        observer.observe(document, { childList: true, subtree: true });
      });

      await page
        .goto(new URL(fixture.path, fixture.server.url).href, {
          waitUntil: "domcontentloaded",
          timeout: 5_000,
        })
        .catch(async (error: unknown) => {
          throw new Error(
            `Document did not load at ${fixture.path}; page URL: ${page.url()}; page errors: ${JSON.stringify(errors)}; failed requests: ${JSON.stringify(failedRequests)}; responses: ${JSON.stringify(responses)}; body: ${await page.locator("body").innerText().catch(String)}`,
            { cause: error },
          );
        });

      await page
        .waitForFunction(
          () => document.querySelector(".early-proof")?.textContent === "R13 early route",
          null,
          { timeout: 10_000 },
        )
        .catch(async (error: unknown) => {
          throw new Error(
            `Mounted route did not render at ${fixture.path}; page URL: ${page.url()}; page errors: ${JSON.stringify(errors)}; failed requests: ${JSON.stringify(failedRequests)}; responses: ${JSON.stringify(responses)}; body: ${await page.locator("body").innerText().catch(String)}`,
            { cause: error },
          );
        });

      expect(new URL(page.url()).pathname).toBe(fixture.path);

      expect(
        await page.locator(".early-proof").evaluate((node) => getComputedStyle(node).color),
      ).toBe("rgb(17, 34, 51)");

      const firstRender = await page.evaluate(
        () =>
          (
            window as unknown as {
              __r13FirstRender?: { color: string; sheets: { href: string; ready: boolean }[] };
            }
          ).__r13FirstRender,
      );

      expect(firstRender?.color).toBe("rgb(17, 34, 51)");

      expect(
        firstRender?.sheets.some(
          (sheet) => sheet.href.includes(earlyStyle!.path.slice(1)) && sheet.ready,
        ),
      ).toBe(true);

      expect(
        requests.some(
          (path) => path.includes("/_hesperia/assets/routes/guard-") && path.endsWith(".js"),
        ),
      ).toBe(true);

      expect(
        requests.some((path) => path.includes("/_hesperia/assets/") && path.endsWith(".css")),
      ).toBe(true);

      if (errors.length > 0) {
        console.error(
          "Production hosting browser errors: " +
            JSON.stringify({
              fixture: fixture.name,
              pageURL: page.url(),
              browserVersion: browser.version(),
              consoleErrors,
              responses: responses.filter((response) => response.status >= 400),
              failedRequests,
            }),
        );
      }

      expect(errors).toStrictEqual([]);

      await page.close();
    }
  } finally {
    await browser?.close();

    await dashboardServer?.close();

    await rootServer?.close();
  }
}, 45_000);

interface GeneratedAssetBrowserEvent {
  readonly kind:
    | "request"
    | "response"
    | "requestfailed"
    | "pageerror"
    | "console"
    | "observererror";
  readonly url?: string;
  readonly path?: string;
  readonly origin?: string;
  readonly method?: string;
  readonly resourceType?: string;
  readonly navigation?: boolean;
  readonly status?: number;
  readonly contentType?: string | null;
  readonly expectedContentType?: string | null;
  readonly allowOrigin?: string | null;
  readonly allowCredentials?: string | null;
  readonly vary?: string | null;
  readonly cacheControl?: string | null;
  readonly contentLength?: string | null;
  readonly bodyLength?: number | null;
  readonly contentSecurityPolicy?: string | null;
  readonly bodySha256?: string | null;
  readonly expectedSha256?: string | null;
  readonly bodyReadError?: string | null;
  readonly headersReadError?: string | null;
  readonly failure?: string | null;
  readonly message?: string;
}

interface GeneratedAssetPolicyViolation {
  readonly blockedURI: string;
  readonly effectiveDirective: string;
  readonly violatedDirective: string;
  readonly disposition: string;
}

interface GeneratedAssetModuleEvaluation {
  readonly kind: "static" | "dynamic";
  readonly url: string;
}

interface GeneratedAssetAuditState {
  readonly staticEvaluations: number;
  readonly dynamicEvaluations: number;
  readonly committedEffects: number;
}

interface GeneratedAssetStartupScriptError {
  readonly url: string;
  readonly crossOrigin: string | null;
}

interface GeneratedAssetBrowserAudit {
  readonly policyViolations: GeneratedAssetPolicyViolation[];
  readonly moduleEvaluations: GeneratedAssetModuleEvaluation[];
  readonly startupScriptErrors: GeneratedAssetStartupScriptError[];
}

interface GeneratedAssetDiagnosticRecorder {
  readonly events: GeneratedAssetBrowserEvent[];
  readonly overflow: () => boolean;
  originalDocument(): Promise<{
    readonly url: string;
    readonly status: number;
    readonly body: Uint8Array;
  }>;
  flush(): Promise<void>;
}

async function recordGeneratedAssetBrowserEvents(
  page: Page,
  scenario: GeneratedAssetScenario,
  capture: InProcessTargetedDeploymentCapturedBuildV4,
): Promise<GeneratedAssetDiagnosticRecorder> {
  const events: GeneratedAssetBrowserEvent[] = [];
  const responseTasks: Promise<void>[] = [];
  const responseTaskLimit = 512;
  const responseBodyLimit = 4 * 1024 * 1024;
  const assetPins = new Map<string, { readonly sha256: string; readonly contentType: string }>();
  const publicPins = new Map<string, { readonly sha256: string; readonly contentType: string }>();
  let bytes = 0;
  let didOverflow = false;
  let originalDocumentTask: Promise<void> | undefined;
  let originalDocument:
    | { readonly url: string; readonly status: number; readonly body: Uint8Array }
    | undefined;

  for (const asset of capture.inventory.hosting.assets)
    assetPins.set(new URL(asset.path.slice(1), scenario.assetRoot).href, {
      sha256: asset.sha256,
      contentType: asset.contentType,
    });

  if ("publicFiles" in capture.inventory.hosting)
    for (const file of capture.inventory.hosting.publicFiles)
      publicPins.set(new URL(file.urlPath, scenario.appOrigin).href, {
        sha256: file.sha256,
        contentType: file.contentType,
      });

  const append = (event: GeneratedAssetBrowserEvent): void => {
    const serialized = JSON.stringify(event);

    if (serialized === undefined) {
      didOverflow = true;

      return;
    }

    const size = new TextEncoder().encode(serialized).byteLength;

    if (events.length >= 512 || bytes + size > 512 * 1024) {
      didOverflow = true;

      return;
    }

    events.push(event);
    bytes += size;
  };

  page.on("request", (request) => {
    const url = new URL(request.url());

    append({
      kind: "request",
      url: url.href,
      path: url.pathname,
      origin: url.origin,
      method: request.method(),
      resourceType: request.resourceType(),
      navigation: request.isNavigationRequest(),
    });
  });

  page.on("response", (response: BrowserResponse) => {
    if (responseTasks.length >= responseTaskLimit) {
      didOverflow = true;
      append({
        kind: "observererror",
        message: "Generated-asset response observer reached its bounded task limit",
      });

      return;
    }

    const isOriginalDocument =
      originalDocumentTask === undefined &&
      response.url() === new URL("/", scenario.appOrigin).href &&
      response.request().isNavigationRequest() &&
      response.request().frame() === page.mainFrame();

    responseTasks.push(
      (async () => {
        try {
          const url = new URL(response.url());
          let headers: Record<string, string> = {};
          let headersReadError: string | null = null;

          try {
            headers = await response.allHeaders();
          } catch (error) {
            headersReadError = error instanceof Error ? error.message.slice(0, 500) : String(error);
          }

          const expected = assetPins.get(url.href) ?? publicPins.get(url.href);
          let bodySha256: string | null = null;
          let bodyLength: number | null = null;
          let bodyReadError: string | null = null;
          const declaredLength = Number(headers["content-length"]);

          if (Number.isFinite(declaredLength) && declaredLength > responseBodyLimit) {
            bodyReadError = `Response exceeds ${responseBodyLimit} byte diagnostic body limit`;
          } else {
            try {
              const body = new Uint8Array(await response.body());

              bodyLength = body.byteLength;
              bodySha256 = body.byteLength <= responseBodyLimit ? sha256(body) : null;

              if (isOriginalDocument && body.byteLength <= responseBodyLimit)
                originalDocument = { url: url.href, status: response.status(), body };

              if (body.byteLength > responseBodyLimit)
                bodyReadError = `Response exceeds ${responseBodyLimit} byte diagnostic body limit`;
            } catch (error) {
              bodyReadError = error instanceof Error ? error.message.slice(0, 500) : String(error);
            }
          }

          append({
            kind: "response",
            url: url.href,
            path: url.pathname,
            origin: url.origin,
            resourceType: response.request().resourceType(),
            status: response.status(),
            contentType: headers["content-type"] ?? null,
            expectedContentType: expected?.contentType ?? null,
            allowOrigin: headers["access-control-allow-origin"] ?? null,
            allowCredentials: headers["access-control-allow-credentials"] ?? null,
            vary: headers.vary ?? null,
            cacheControl: headers["cache-control"] ?? null,
            contentLength: headers["content-length"] ?? null,
            bodyLength,
            contentSecurityPolicy: headers["content-security-policy"] ?? null,
            bodySha256,
            expectedSha256: expected?.sha256 ?? null,
            headersReadError,
            bodyReadError,
          });
        } catch (error) {
          append({
            kind: "observererror",
            message: error instanceof Error ? error.message.slice(0, 1000) : String(error),
          });
        }
      })(),
    );

    if (isOriginalDocument) originalDocumentTask = responseTasks[responseTasks.length - 1];
  });

  page.on("requestfailed", (request) => {
    const url = new URL(request.url());

    append({
      kind: "requestfailed",
      url: url.href,
      path: url.pathname,
      origin: url.origin,
      method: request.method(),
      resourceType: request.resourceType(),
      failure: request.failure()?.errorText ?? null,
    });
  });

  page.on("pageerror", (error) => {
    append({ kind: "pageerror", message: error.message.slice(0, 1000) });
  });

  page.on("console", (message) => {
    if (message.type() === "error")
      append({ kind: "console", message: message.text().slice(0, 1000) });
  });

  return {
    events,
    overflow: () => didOverflow,
    async originalDocument() {
      if (!originalDocumentTask)
        throw new Error("Original application document response was not observed");

      let timeout: ReturnType<typeof setTimeout> | undefined;

      try {
        await Promise.race([
          originalDocumentTask,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error("Original application document observation timed out")),
              5_000,
            );
          }),
        ]);
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }

      if (!originalDocument)
        throw new Error("Original application document response body was unavailable");

      return originalDocument;
    },
    async flush() {
      await Promise.all(responseTasks);
    },
  };
}

async function installGeneratedAssetBrowserAudit(page: Page, startupURL: string): Promise<void> {
  await page.addInitScript((expectedStartupURL: string) => {
    const audited = window as typeof window & {
      __generatedAssetAudit?: GeneratedAssetAuditState;
      __generatedAssetBrowserAudit?: GeneratedAssetBrowserAudit;
    };

    audited.__generatedAssetAudit = {
      staticEvaluations: 0,
      dynamicEvaluations: 0,
      committedEffects: 0,
    };
    audited.__generatedAssetBrowserAudit = {
      policyViolations: [],
      moduleEvaluations: [],
      startupScriptErrors: [],
    };

    window.addEventListener(
      "error",
      (event) => {
        const target = event.target;

        if (
          event.isTrusted &&
          target instanceof HTMLScriptElement &&
          target.type === "module" &&
          target.src === expectedStartupURL
        )
          audited.__generatedAssetBrowserAudit?.startupScriptErrors.push({
            url: target.src,
            crossOrigin: target.getAttribute("crossorigin"),
          });
      },
      true,
    );

    window.addEventListener("securitypolicyviolation", (event) => {
      audited.__generatedAssetBrowserAudit?.policyViolations.push({
        blockedURI: event.blockedURI,
        effectiveDirective: event.effectiveDirective,
        violatedDirective: event.violatedDirective,
        disposition: event.disposition,
      });
    });

    window.addEventListener("hesperia:generated-asset-module", (event) => {
      const detail = (event as CustomEvent<GeneratedAssetModuleEvaluation>).detail;

      audited.__generatedAssetBrowserAudit?.moduleEvaluations.push({
        kind: detail.kind,
        url: detail.url,
      });
    });
  }, startupURL);
}

async function readGeneratedAssetBrowserState(page: Page): Promise<{
  readonly hasApplication: boolean;
  readonly visibleApplication: boolean;
  readonly staticEvaluations: number;
  readonly dynamicEvaluations: number;
  readonly committedEffects: number;
  readonly generatedStylesheets: readonly {
    readonly href: string;
    readonly hasSheet: boolean;
    readonly crossOrigin: string | null;
  }[];
  readonly color: string | null;
  readonly importedCssValue: string | null;
  readonly backgroundImage: string | null;
  readonly authoredStylesheet: {
    readonly href: string | null;
    readonly crossOrigin: string | null;
    readonly integrity: string | null;
    readonly decorationColor: string | null;
  } | null;
  readonly policyViolations: readonly GeneratedAssetPolicyViolation[];
  readonly moduleEvaluations: readonly GeneratedAssetModuleEvaluation[];
  readonly startupScriptErrors: readonly GeneratedAssetStartupScriptError[];
}> {
  return page.evaluate(() => {
    const audited = window as typeof window & {
      __generatedAssetAudit?: GeneratedAssetAuditState;
      __generatedAssetBrowserAudit?: GeneratedAssetBrowserAudit;
    };
    const application = document.querySelector<HTMLElement>("#asset-proof");
    const stylesheet = document.querySelector<HTMLLinkElement>(
      'link[rel="stylesheet"][href="/asset-controls.css"]',
    );
    const generatedStylesheets = [
      ...document.querySelectorAll<HTMLLinkElement>("link[data-hesperia-style-id]"),
    ].map((link) => ({
      href: link.href,
      hasSheet: link.sheet !== null,
      crossOrigin: link.getAttribute("crossorigin"),
    }));

    return {
      hasApplication: application !== null,
      visibleApplication: application !== null && application.getClientRects().length > 0,
      staticEvaluations: audited.__generatedAssetAudit?.staticEvaluations ?? 0,
      dynamicEvaluations: audited.__generatedAssetAudit?.dynamicEvaluations ?? 0,
      committedEffects: audited.__generatedAssetAudit?.committedEffects ?? 0,
      generatedStylesheets,
      color: application ? getComputedStyle(application).color : null,
      importedCssValue: application
        ? getComputedStyle(application).getPropertyValue("--generated-assets-import").trim()
        : null,
      backgroundImage: document.querySelector<HTMLElement>("#asset-image")
        ? getComputedStyle(document.querySelector<HTMLElement>("#asset-image")!).backgroundImage
        : null,
      authoredStylesheet: stylesheet
        ? {
            href: stylesheet.getAttribute("href"),
            crossOrigin: stylesheet.getAttribute("crossorigin"),
            integrity: stylesheet.integrity,
            decorationColor: application
              ? getComputedStyle(document.querySelector<HTMLElement>("#static-proof")!)
                  .textDecorationColor
              : null,
          }
        : null,
      policyViolations: audited.__generatedAssetBrowserAudit?.policyViolations ?? [],
      moduleEvaluations: audited.__generatedAssetBrowserAudit?.moduleEvaluations ?? [],
      startupScriptErrors: audited.__generatedAssetBrowserAudit?.startupScriptErrors ?? [],
    };
  });
}

interface NativeCredentialReferenceStage {
  readonly stage: "script" | "preload";
  readonly entryURL: string;
  readonly requests: GeneratedAssetProviderEvent[];
  readonly responses: Array<{
    readonly url: string;
    readonly status: number;
    readonly contentType: string | null;
    readonly allowOrigin: string | null;
    readonly allowCredentials: string | null;
    readonly vary: string | null;
    readonly cacheControl: string | null;
    readonly contentLength: string | null;
    readonly bodyLength: number;
    readonly bodySha256: string;
  }>;
  seed?: {
    readonly noPriorCookie: boolean;
    readonly responseMatches: boolean;
    readonly cookiePresent: boolean;
  };
  overflow?: boolean;
  state?: {
    readonly entry: boolean;
    readonly static: boolean;
    readonly dynamic: boolean;
    readonly complete: boolean;
    readonly scripts: Array<{ readonly src: string; readonly crossOrigin: string | null }>;
    readonly preloads: Array<{ readonly href: string; readonly crossOrigin: string | null }>;
  };
}

async function readNativeCredentialReference(
  browser: Browser,
  scenario: GeneratedAssetScenario,
  stages: NativeCredentialReferenceStage[],
): Promise<boolean> {
  const referenceSources = {
    "entry.mjs":
      'import "./static.mjs"; globalThis.__hesperiaNativeReferenceEntry = true; await import("./dynamic.mjs"); globalThis.__hesperiaNativeReferenceComplete = true;\n',
    "static.mjs": "globalThis.__hesperiaNativeReferenceStatic = true;\n",
    "dynamic.mjs": "globalThis.__hesperiaNativeReferenceDynamic = true;\n",
  } as const;

  for (const stage of ["script", "preload"] as const) {
    const entryURL = new URL(`__hesperia-native-reference/${stage}/entry.mjs`, scenario.assetRoot)
      .href;
    const record: NativeCredentialReferenceStage = { stage, entryURL, requests: [], responses: [] };
    const context = await browser.newContext();
    const requestStart = scenario.nativeReferenceEvents.length;
    let requestsCaptured = false;
    const failures: unknown[] = [];

    stages.push(record);

    try {
      const page = await context.newPage();
      const existingCookies = (await context.cookies(scenario.assetRoot)).filter(
        (cookie) => cookie.name === "hesperia-generated-assets",
      );

      const seed = await page.goto(scenario.cookieSeedURL, { waitUntil: "load", timeout: 20_000 });
      const seedHeaders = (await seed?.headersArray())?.filter(
        (header) => header.name.toLowerCase() === "set-cookie",
      );
      const expectedSeed = `hesperia-generated-assets=present; Path=${scenario.assetRootPath}; SameSite=Lax; HttpOnly`;

      const cookiePresent = (await context.cookies(scenario.assetRoot)).some(
        (cookie) =>
          cookie.name === "hesperia-generated-assets" &&
          cookie.value === "present" &&
          cookie.path === scenario.assetRootPath,
      );

      record.seed = {
        noPriorCookie: existingCookies.length === 0,
        responseMatches:
          seed?.status() === 200 &&
          seed.url() === scenario.cookieSeedURL &&
          seedHeaders?.length === 1 &&
          seedHeaders[0]?.value === expectedSeed,
        cookiePresent,
      };
      expect(record.seed).toStrictEqual({
        noPriorCookie: true,
        responseMatches: true,
        cookiePresent: true,
      });

      const responses: Array<Promise<void>> = [];
      let responseOverflow = false;
      const expectedURLs = new Map(
        Object.entries(referenceSources).map(
          ([name, source]) =>
            [new URL(name, entryURL).href, sha256(new TextEncoder().encode(source))] as const,
        ),
      );

      page.on("response", (response) => {
        if (!expectedURLs.has(response.url())) return;

        if (responses.length >= 16) {
          responseOverflow = true;

          return;
        }

        responses.push(
          (async () => {
            const headers = await response.allHeaders();
            const body = new Uint8Array(await response.body());

            record.responses.push({
              url: response.url(),
              status: response.status(),
              contentType: headers["content-type"] ?? null,
              allowOrigin: headers["access-control-allow-origin"] ?? null,
              allowCredentials: headers["access-control-allow-credentials"] ?? null,
              vary: headers.vary ?? null,
              cacheControl: headers["cache-control"] ?? null,
              contentLength: headers["content-length"] ?? null,
              bodyLength: body.byteLength,
              bodySha256: sha256(body),
            });
          })(),
        );
      });

      const entryResponse = page.waitForResponse((response) => response.url() === entryURL, {
        timeout: 20_000,
      });

      void entryResponse.catch(() => undefined);

      const documentResponse = await page.goto(scenario.nativeReferenceURL(stage), {
        waitUntil: "load",
        timeout: 30_000,
      });

      expect(documentResponse?.status()).toBe(200);
      expect((await entryResponse).status()).toBe(200);
      await page.waitForLoadState("networkidle", { timeout: 15_000 });

      record.state = await page.evaluate(() => ({
        entry: Reflect.get(globalThis, "__hesperiaNativeReferenceEntry") === true,
        static: Reflect.get(globalThis, "__hesperiaNativeReferenceStatic") === true,
        dynamic: Reflect.get(globalThis, "__hesperiaNativeReferenceDynamic") === true,
        complete: Reflect.get(globalThis, "__hesperiaNativeReferenceComplete") === true,
        scripts: [...document.querySelectorAll<HTMLScriptElement>('script[type="module"]')].map(
          (element) => ({ src: element.src, crossOrigin: element.crossOrigin }),
        ),
        preloads: [...document.querySelectorAll<HTMLLinkElement>('link[rel="modulepreload"]')].map(
          (element) => ({ href: element.href, crossOrigin: element.crossOrigin }),
        ),
      }));

      if (stage === "script") {
        expect(record.state).toMatchObject({
          entry: true,
          static: true,
          dynamic: true,
          complete: true,
        });
        expect(record.state.scripts).toStrictEqual([
          { src: entryURL, crossOrigin: scenario.credentials },
        ]);
        expect(record.state.preloads).toStrictEqual([]);
      } else {
        expect(record.state).toMatchObject({
          entry: false,
          static: false,
          dynamic: false,
          complete: false,
        });
        expect(record.state.scripts).toStrictEqual([]);
        expect(record.state.preloads).toStrictEqual([
          { href: entryURL, crossOrigin: scenario.credentials },
        ]);
      }

      let drainTimer: ReturnType<typeof setTimeout> | undefined;

      try {
        await Promise.race([
          Promise.all(responses),
          new Promise<never>((_, reject) => {
            drainTimer = setTimeout(
              () => reject(new Error("Native reference response drain timed out")),
              5_000,
            );
          }),
        ]);
      } finally {
        if (drainTimer !== undefined) clearTimeout(drainTimer);
      }

      record.requests.push(...scenario.nativeReferenceEvents.slice(requestStart));
      requestsCaptured = true;
      record.overflow = responseOverflow;
      expect(responseOverflow).toBe(false);
      expect(
        record.requests.every((event) =>
          expectedURLs.has(new URL(event.path, scenario.assetOrigin).href),
        ),
      ).toBe(true);

      const required = stage === "script" ? [...expectedURLs.keys()] : [entryURL];

      for (const url of expectedURLs.keys()) {
        const pathname = new URL(url).pathname;
        const requests = record.requests.filter((event) => event.path === pathname);
        const observed = record.responses.filter((response) => response.url === url);

        if (!required.includes(url) && requests.length === 0) {
          expect(observed).toHaveLength(0);

          continue;
        }

        expect(requests.length).toBeGreaterThan(0);
        expect(observed.length).toBeGreaterThan(0);
        expect(
          requests.every(
            (event) =>
              event.responseStatus === 200 &&
              event.origin === scenario.appOrigin &&
              event.allowOrigin === scenario.appOrigin &&
              event.allowCredentials === "true" &&
              (event.contentType ?? "").includes("javascript"),
          ),
        ).toBe(true);
        expect(
          observed.every(
            (response) =>
              response.status === 200 &&
              response.bodySha256 === expectedURLs.get(url) &&
              requests.every((event) => event.contentType === response.contentType) &&
              response.allowOrigin === scenario.appOrigin &&
              response.allowCredentials === "true" &&
              response.vary === "Origin" &&
              response.cacheControl === null &&
              response.contentLength === String(response.bodyLength),
          ),
        ).toBe(true);
      }
    } catch (error) {
      failures.push(error);
    } finally {
      if (!requestsCaptured)
        record.requests.push(...scenario.nativeReferenceEvents.slice(requestStart));

      try {
        await context.close();
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
    }

    if (failures.length === 1) throw failures[0];

    if (failures.length > 1)
      throw new AggregateError(failures, "Native reference and cleanup failed");
  }

  const requests = stages.flatMap((stage) => stage.requests);
  const cookie = requests[0]?.syntheticCookiePresent;

  if (cookie === undefined || !requests.every((event) => event.syntheticCookiePresent === cookie))
    throw new Error(
      "Native script and preload credentials are inconsistent; request attribution is unresolved",
    );

  return cookie;
}

test("one captured browser graph serves native generated resources at same-origin and external bases", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-generated-assets-browser-"));

  roots.push(root);

  const fixtureRoot = join(import.meta.dir, "fixtures/applications/generated-assets");

  await cp(fixtureRoot, root, { recursive: true });
  await linkFrameworkPackages(root);

  const prepared = await prepareBuild(root);
  const output = await writeBuild(root, prepared);
  const loaded = await readTargetedBuild(output);

  if (
    !("deployment" in loaded) ||
    loaded.version !== 4 ||
    loaded.control.kind !== "browser" ||
    "serverFiles" in loaded.inventory
  )
    throw new Error("The generated-assets fixture must publish a targeted V4 browser capture");

  const capture = loaded;
  const publicFiles =
    "publicFiles" in capture.inventory.hosting ? capture.inventory.hosting.publicFiles : [];
  const capturedAssetPins = [
    ...capture.inventory.hosting.assets.map((asset) => ({
      kind: "managed" as const,
      path: asset.path,
      sha256: asset.sha256,
      contentType: asset.contentType,
    })),
    ...publicFiles.map((file) => ({
      kind: "public" as const,
      path: file.urlPath,
      sha256: file.sha256,
      contentType: file.contentType,
    })),
  ];
  const svgSourceSha256 = sha256(
    new Uint8Array(await readFile(join(fixtureRoot, "assets/proof.svg"))),
  );
  const fontSourceBytes = new Uint8Array(await readFile(join(fixtureRoot, "assets/proof.ttf")));
  const fontSourceSha256 = sha256(fontSourceBytes);
  const svgAssetPins = capture.inventory.hosting.assets.filter(
    (asset) => asset.sha256 === svgSourceSha256 && asset.contentType.startsWith("image/svg+xml"),
  );
  const fontAssetPins = capture.inventory.hosting.assets.filter(
    (asset) => asset.sha256 === fontSourceSha256 && asset.contentType.startsWith("font/"),
  );

  expect(svgAssetPins).toHaveLength(1);
  expect(fontAssetPins).toHaveLength(1);

  const svgAssetPin = svgAssetPins[0]!;
  const fontAssetPin = fontAssetPins[0]!;
  const authoredStylesheetPin = publicFiles.find((file) => file.urlPath === "/asset-controls.css");

  expect(capture.control.hosting.mode).toBe("production");
  expect(authoredStylesheetPin).toBeDefined();

  const provider = await createGeneratedAssetProviderFixture(capture);

  try {
    const runId = randomUUID();
    const diagnosticsDirectory = resolve(
      import.meta.dir,
      "../../.hesperia/browser-diagnostics/generated-assets-browser",
    );
    const positiveInputs: readonly GeneratedAssetScenarioInput[] = [
      { id: "same-origin-default-anonymous", base: "same-origin", credentials: "anonymous" },
      { id: "same-origin-use-credentials", base: "same-origin", credentials: "use-credentials" },
      {
        id: "external-a-default-anonymous",
        base: "external-a",
        credentials: "anonymous",
        holdStylesheet: true,
      },
      { id: "external-a-use-credentials", base: "external-a", credentials: "use-credentials" },
      { id: "external-b-default-anonymous", base: "external-b", credentials: "anonymous" },
      { id: "external-b-use-credentials", base: "external-b", credentials: "use-credentials" },
    ];
    const validCorsSamples = new Map<string, GeneratedAssetProviderEvent>();

    await mkdir(diagnosticsDirectory, { recursive: true });

    expect(provider.externalAOrigin).not.toBe(provider.appOrigin);
    expect(provider.externalBOrigin).not.toBe(provider.appOrigin);
    expect(provider.externalAOrigin).not.toBe(provider.externalBOrigin);

    async function runBrowserScenario(
      engineName: string,
      browserVersion: string,
      browser: Browser,
      input: GeneratedAssetScenarioInput,
      mode: "positive" | "cors-denial" | "csp-denial",
      validCorsSample?: GeneratedAssetProviderEvent,
    ): Promise<readonly GeneratedAssetProviderEvent[]> {
      const scenario = await provider.configure(input);
      const context = await browser.newContext();
      let pageForDiagnostics: Page | undefined;
      let navigation: Promise<BrowserResponse | null> | undefined;
      let recorder: GeneratedAssetDiagnosticRecorder | undefined;
      let failure: string | null = null;
      let primaryError: unknown;
      let hasPrimaryError = false;
      let observations: Record<string, unknown> = {};
      let mainDocumentStatus: number | null = null;
      let mainDocumentPolicy: string | null = null;
      let generatedStylesheetURLs: readonly string[] = [];
      let generatedInitialPreloads: readonly {
        readonly href: string;
        readonly credentials: string | null;
      }[] = [];
      const cleanupErrors: string[] = [];
      const flushErrors: string[] = [];
      const finalizationCauses: unknown[] = [];

      try {
        const page = await context.newPage();

        pageForDiagnostics = page;
        const startupURL = new URL("startup.js", scenario.assetRoot).href;

        await installGeneratedAssetBrowserAudit(page, startupURL);

        const cookieSeed = await page.goto(scenario.cookieSeedURL, {
          waitUntil: "load",
          timeout: 20_000,
        });

        expect(cookieSeed?.status()).toBe(200);

        const seededCookie = (await context.cookies(scenario.assetRoot)).find(
          (cookie) =>
            cookie.name === "hesperia-generated-assets" &&
            cookie.value === "present" &&
            cookie.path === scenario.assetRootPath,
        );

        expect(seededCookie).toBeDefined();

        recorder = await recordGeneratedAssetBrowserEvents(page, scenario, capture);
        const svgURL = new URL(svgAssetPin.path.slice(1), scenario.assetRoot).href;
        const svgResponse =
          mode === "positive"
            ? page.waitForResponse((response) => response.url() === svgURL, { timeout: 0 })
            : undefined;

        void svgResponse?.catch(() => undefined);
        const applicationUrl = new URL("/", scenario.appOrigin).href;

        if (mode === "positive" && input.holdStylesheet) {
          navigation = page.goto(applicationUrl, { waitUntil: "load", timeout: 30_000 });
          void navigation.catch(() => undefined);
          await scenario.waitForStylesheetRequest();

          const held = await readGeneratedAssetBrowserState(page);
          const heldApplicationVisible = await page.locator("#asset-proof").isVisible();

          observations = { ...observations, heldStylesheetState: held, heldApplicationVisible };
          expect(heldApplicationVisible).toBe(false);
          expect(held.committedEffects).toBe(0);
          scenario.releaseStylesheet();
          const response = await navigation;

          mainDocumentStatus = response?.status() ?? null;
        } else {
          const response = await page.goto(applicationUrl, { waitUntil: "load", timeout: 30_000 });

          mainDocumentStatus = response?.status() ?? null;

          const headers = await response?.allHeaders();

          mainDocumentPolicy = headers?.["content-security-policy"] ?? null;
        }

        if (mode === "positive") {
          await page.locator("#asset-proof").waitFor({ state: "visible", timeout: 20_000 });

          const originalDocument = await recorder.originalDocument();
          const originalHTML = new TextDecoder("utf-8", { fatal: true }).decode(
            originalDocument.body,
          );
          const originalElements = await page.evaluate(
            ({ html, documentURL }) => {
              const document = new DOMParser().parseFromString(html, "text/html");

              return {
                modules: [
                  ...document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]'),
                ].map((script) => ({
                  src: new URL(script.getAttribute("src")!, documentURL).href,
                  credentials: script.getAttribute("crossorigin"),
                })),
                preloads: [
                  ...document.querySelectorAll<HTMLLinkElement>('link[rel="modulepreload"][href]'),
                ].map((preload) => ({
                  href: new URL(preload.getAttribute("href")!, documentURL).href,
                  credentials: preload.getAttribute("crossorigin"),
                })),
              };
            },
            { html: originalHTML, documentURL: originalDocument.url },
          );
          const initialModules = originalElements.modules;
          const initialPreloads = await page
            .locator('link[rel="modulepreload"]')
            .evaluateAll((elements) =>
              elements.map((element) => {
                const preload = element as HTMLLinkElement;

                return { href: preload.href, credentials: preload.crossOrigin };
              }),
            );

          observations = {
            ...observations,
            initialModules,
            initialPreloads,
            originalDocument: {
              url: originalDocument.url,
              status: originalDocument.status,
              byteLength: originalDocument.body.byteLength,
              sha256: sha256(originalDocument.body),
              preloads: originalElements.preloads,
            },
          };
          generatedInitialPreloads = initialPreloads;
          expect(originalDocument.url).toBe(applicationUrl);
          expect(originalDocument.status).toBe(200);
          expect(initialModules).toStrictEqual([
            { src: startupURL, credentials: input.credentials },
          ]);

          for (const preload of [...originalElements.preloads, ...initialPreloads]) {
            expect(preload.href.startsWith(scenario.assetRoot + "assets/")).toBe(true);
            expect(preload.credentials).toBe(input.credentials);
          }

          const beforeDynamic = await readGeneratedAssetBrowserState(page);

          generatedStylesheetURLs = beforeDynamic.generatedStylesheets.map((link) => link.href);

          expect(beforeDynamic.staticEvaluations).toBe(1);
          expect(beforeDynamic.dynamicEvaluations).toBe(0);
          expect(beforeDynamic.committedEffects).toBeGreaterThan(0);
          expect(beforeDynamic.startupScriptErrors).toStrictEqual([]);
          expect(beforeDynamic.color).toBe("rgb(17, 34, 51)");
          expect(beforeDynamic.importedCssValue).toBe("loaded");
          expect(beforeDynamic.generatedStylesheets.length).toBeGreaterThan(0);
          expect(beforeDynamic.generatedStylesheets.every((link) => link.hasSheet)).toBe(true);
          const nativeMediaStyles = capture.inventory.hosting.assets.filter(
            (asset) =>
              asset.path.startsWith("/assets/native-css/") &&
              asset.path.endsWith("/native-media.css"),
          );

          expect(nativeMediaStyles).toHaveLength(1);
          const nativeMediaUrl = new URL(nativeMediaStyles[0]!.path.slice(1), scenario.assetRoot)
            .href;

          expect(
            beforeDynamic.generatedStylesheets.some((link) => link.href === nativeMediaUrl),
          ).toBe(true);
          expect(
            beforeDynamic.generatedStylesheets.every(
              (link) => link.crossOrigin === (link.href === nativeMediaUrl ? "anonymous" : null),
            ),
          ).toBe(true);
          expect(beforeDynamic.authoredStylesheet).toMatchObject({
            href: "/asset-controls.css",
            crossOrigin: "anonymous",
            integrity: "sha256-+8chqzQauzujwYKmYR0FNA5nwYVFTQ2VriPj6QW5qJ4=",
            decorationColor: "rgb(91, 37, 119)",
          });

          const initialRequests = recorder.events.filter((event) => event.kind === "request");
          const staticModule = beforeDynamic.moduleEvaluations.find(
            (module) => module.kind === "static",
          );

          expect(staticModule).toBeDefined();
          expect(new URL(staticModule!.url).origin).toBe(scenario.assetOrigin);
          expect(initialRequests.some((event) => event.url === staticModule!.url)).toBe(true);
          expect(
            recorder.events.some((event) => event.kind === "request" && event.url === startupURL),
          ).toBe(true);

          const activationEventStart = recorder.events.length;

          await page.locator("#load-dynamic").click();
          await page.waitForFunction(
            () =>
              document.querySelector("#dynamic-proof")?.textContent ===
              "DYNAMIC_MODULE_READY:STATIC_MODULE_READY:1",
            undefined,
            { timeout: 20_000 },
          );
          if (!svgResponse) throw new Error("The SVG response observer was not installed");

          let svgWaitTimedOut = false;
          let svgWaitTimer: ReturnType<typeof setTimeout> | undefined;

          try {
            const response = await Promise.race([
              svgResponse,
              new Promise<never>((_, reject) => {
                svgWaitTimer = setTimeout(() => {
                  svgWaitTimedOut = true;
                  reject(new Error(`Timed out after 20000ms waiting for SVG response: ${svgURL}`));
                }, 20_000);
              }),
            ]);

            expect(response.status()).toBe(200);
          } catch (waitError) {
            if (svgWaitTimedOut) {
              let timer: ReturnType<typeof setTimeout> | undefined;

              try {
                const resourceTiming = await Promise.race([
                  page.evaluate(
                    ({ expectedURL, origins }) => {
                      const resources = performance.getEntriesByType("resource").filter((entry) => {
                        try {
                          return origins.includes(new URL(entry.name).origin);
                        } catch {
                          return false;
                        }
                      });
                      const matches = resources.filter((entry) => entry.name === expectedURL);
                      const sample = resources.slice(-80).map((entry) => {
                        const resource = entry as PerformanceResourceTiming;

                        return {
                          name: resource.name,
                          initiatorType: resource.initiatorType,
                          startTime: resource.startTime,
                          duration: resource.duration,
                          responseEnd: resource.responseEnd,
                          transferSize: resource.transferSize,
                        };
                      });

                      return {
                        expectedURL,
                        documentURL: location.href,
                        isTopLevel: window.top === window,
                        timeOrigin: performance.timeOrigin,
                        fixtureOriginResourceCount: resources.length,
                        expectedNameMatchCount: matches.length,
                        expectedNameMatches: matches.slice(-80).map((entry) => entry.name),
                        sample,
                        truncated: resources.length > sample.length,
                      };
                    },
                    { expectedURL: svgURL, origins: [scenario.appOrigin, scenario.assetOrigin] },
                  ),
                  new Promise<never>((_, reject) => {
                    timer = setTimeout(
                      () => reject(new Error("Resource timing diagnostic timed out")),
                      3_000,
                    );
                  }),
                ]);

                observations = { ...observations, resourceTiming };
              } catch (error) {
                observations = { ...observations, resourceTiming: { error: String(error) } };
              } finally {
                if (timer !== undefined) clearTimeout(timer);
              }
            }

            throw waitError;
          } finally {
            if (svgWaitTimer !== undefined) clearTimeout(svgWaitTimer);
          }

          const finalState = await readGeneratedAssetBrowserState(page);
          const dynamicModule = finalState.moduleEvaluations.find(
            (module) => module.kind === "dynamic",
          );
          const activationRequests = recorder.events.slice(activationEventStart);

          expect(dynamicModule).toBeDefined();
          expect(new URL(dynamicModule!.url).origin).toBe(scenario.assetOrigin);
          expect(finalState.backgroundImage).toContain(svgURL);
          expect(
            activationRequests.some(
              (event) => event.kind === "request" && event.url === dynamicModule!.url,
            ),
          ).toBe(true);

          const fontState = await page.evaluate(async () => {
            const faces = await document.fonts.load('100px "HesperiaProof"', "\uE000");
            const canvas = document.createElement("canvas");
            const context = canvas.getContext("2d");

            if (!context) throw new Error("Canvas 2D text metrics are unavailable");

            context.font = '100px "HesperiaProof"';

            return {
              faceStatuses: faces.map((face) => face.status),
              check: document.fonts.check('100px "HesperiaProof"', "\uE000"),
              width: context.measureText("\uE000").width,
            };
          });
          const completedState = await readGeneratedAssetBrowserState(page);

          observations = { ...observations, fontState };

          let fontControlDeadline: ReturnType<typeof setTimeout> | undefined;

          try {
            const fontControlTimeout = new Promise<never>((_, reject) => {
              fontControlDeadline = setTimeout(
                () => reject(new Error("Independent font observation timed out")),
                5_000,
              );
            });
            const fontControlWork = page.evaluate(
              async ({ bytes, id, sourceSha256 }) => {
                const canvas = document.createElement("canvas");
                const context = canvas.getContext("2d");

                if (!context) throw new Error("Canvas 2D text metrics are unavailable");

                const missingFamily = `HesperiaMissing-${id}`;
                const controlFamily = `HesperiaControl-${id}`;

                context.font = `100px "${missingFamily}"`;
                const fallbackFont = context.font;
                const fallbackWidth = context.measureText("\uE000").width;

                context.font = "100px sans-serif";
                const genericWidth = context.measureText("\uE000").width;
                const result = {
                  sourceSha256,
                  fallbackFont,
                  fallbackWidth,
                  genericWidth,
                  controlStatus: null as string | null,
                  controlFont: null as string | null,
                  controlWidth: null as number | null,
                  error: null as string | null,
                  removed: null as boolean | null,
                };
                let control: FontFace | undefined;
                let timer: number | undefined;

                try {
                  if (
                    sourceSha256 !==
                    "82c7efe1d8d9f598644b92e8c03489a4240ce60586631f60eb9bfe844e8a9f7f"
                  )
                    throw new Error("Independent font source does not match the pinned fixture");

                  control = new FontFace(controlFamily, new Uint8Array(bytes).buffer, {
                    style: "normal",
                    weight: "400",
                  });
                  const loaded = await Promise.race([
                    control.load(),
                    new Promise<never>((_, reject) => {
                      timer = window.setTimeout(
                        () => reject(new Error("Independent font control timed out")),
                        3_000,
                      );
                    }),
                  ]);

                  document.fonts.add(loaded);
                  result.controlStatus = loaded.status;
                  context.font = `100px "${controlFamily}"`;
                  result.controlFont = context.font;
                  result.controlWidth = context.measureText("\uE000").width;
                } catch (error) {
                  result.error = String(error);
                } finally {
                  if (timer !== undefined) window.clearTimeout(timer);

                  if (control) {
                    try {
                      result.removed = document.fonts.delete(control);
                    } catch (error) {
                      result.error = [result.error, `Control cleanup: ${String(error)}`]
                        .filter(Boolean)
                        .join("; ");
                    }
                  }
                }

                return result;
              },
              { bytes: Array.from(fontSourceBytes), id: runId, sourceSha256: fontSourceSha256 },
            );
            const fontControl = await Promise.race([fontControlWork, fontControlTimeout]);

            observations = {
              ...observations,
              fontControl: {
                ...fontControl,
                generatedDifference:
                  fontControl.controlWidth === null
                    ? null
                    : fontState.width - fontControl.controlWidth,
                fallbackDifference:
                  fontControl.controlWidth === null
                    ? null
                    : fontControl.controlWidth - fontControl.fallbackWidth,
              },
            };
            expect(fontControl.error).toBeNull();
            expect(fontControl.controlStatus).toBe("loaded");
            expect(fontControl.removed).toBe(true);

            if (fontControl.controlWidth === null)
              throw new Error("The independent font control did not produce a width");

            expect(Math.abs(fontState.width - fontControl.controlWidth)).toBeLessThan(0.05);
            expect(Math.abs(fontControl.controlWidth - fontControl.fallbackWidth)).toBeGreaterThan(
              0.05,
            );
          } catch (error) {
            observations = { ...observations, fontControlFailure: String(error) };

            throw error;
          } finally {
            if (fontControlDeadline !== undefined) clearTimeout(fontControlDeadline);
          }

          expect(fontState.faceStatuses).toContain("loaded");
          expect(fontState.check).toBe(true);
          expect(completedState.dynamicEvaluations).toBe(1);

          const nextRouteLink = page.locator("#next-route-link");
          const authoredLiteralHref = await nextRouteLink.getAttribute("href");
          const preservedLiteralURL = await page.locator("#literal-url-proof").getAttribute("href");

          expect(authoredLiteralHref).toBe("/next");
          expect(preservedLiteralURL).toBe("https://literal.invalid/preserved?x=1");

          const earlierPreloads = await page
            .locator('link[rel="modulepreload"]')
            .evaluateAll((links) => links.map((link) => (link as HTMLLinkElement).href));

          await nextRouteLink.click();
          await page.locator("#next-proof").waitFor({ state: "visible", timeout: 20_000 });

          const routePreloads = (
            await page.locator('link[rel="modulepreload"]').evaluateAll((links) =>
              links.map((link) => {
                const preload = link as HTMLLinkElement;

                return { href: preload.href, credentials: preload.crossOrigin };
              }),
            )
          ).filter((preload) => !earlierPreloads.includes(preload.href));
          const nextRouteModules = await Promise.all(
            [...capture.inventory.files]
              .filter(([path]) => /\.m?js$/u.test(path))
              .map(async ([path, blob]) =>
                (await blob.text()).includes("GENERATED_ASSET_NEXT_ROUTE_READY")
                  ? new URL(path.slice(1), scenario.assetRoot).href
                  : undefined,
              ),
          );
          const nextRouteModule = nextRouteModules.find((path) => path !== undefined);

          expect(nextRouteModules.filter((path) => path !== undefined)).toHaveLength(1);
          if (!nextRouteModule) throw new Error("The next route module was not emitted");

          expect(earlierPreloads).not.toContain(nextRouteModule);
          expect(routePreloads).toContainEqual({
            href: nextRouteModule,
            credentials: input.credentials,
          });

          for (const preload of routePreloads) {
            expect(preload.href.startsWith(scenario.assetRoot + "assets/")).toBe(true);
            expect(preload.credentials).toBe(input.credentials);
          }

          const nextRouteURL = new URL(page.url());

          expect(nextRouteURL.origin).toBe(scenario.appOrigin);
          expect(nextRouteURL.pathname).toBe("/next");
          expect(await page.locator("#next-proof").textContent()).toBe(
            "GENERATED_ASSET_NEXT_ROUTE_READY",
          );

          observations = {
            ...observations,
            beforeDynamic,
            finalState: completedState,
            fontState,
            routeNavigation: {
              authoredLiteralHref,
              preservedLiteralURL,
              destinationOrigin: nextRouteURL.origin,
              destinationPath: nextRouteURL.pathname,
              destinationText: "GENERATED_ASSET_NEXT_ROUTE_READY",
            },
          };
        } else {
          const deniedState = await readGeneratedAssetBrowserState(page);

          observations = { ...observations, deniedState };
          expect(deniedState.hasApplication).toBe(false);
          expect(deniedState.staticEvaluations).toBe(0);
          expect(deniedState.dynamicEvaluations).toBe(0);
          expect(deniedState.committedEffects).toBe(0);
          expect(
            recorder.events.some(
              (event) =>
                event.kind === "request" &&
                event.origin === scenario.appOrigin &&
                event.path?.startsWith("/_hesperia/"),
            ),
          ).toBe(false);

          if (mode === "cors-denial") {
            const moduleResponses = scenario.providerEvents.filter(
              (event) => event.kind === "asset" && (event.contentType ?? "").includes("javascript"),
            );
            const failures = recorder.events.filter(
              (event) => event.kind === "requestfailed" && event.origin === scenario.assetOrigin,
            );

            observations = { ...observations, corsRequestFailures: failures };
            expect(moduleResponses.length).toBeGreaterThan(0);
            expect(
              moduleResponses.some(
                (event) =>
                  event.path === new URL(startupURL).pathname &&
                  event.origin === scenario.appOrigin &&
                  event.responseStatus === 200,
              ),
            ).toBe(true);
            expect(
              recorder.events.some(
                (event) =>
                  event.kind === "request" &&
                  event.url === startupURL &&
                  event.resourceType === "script",
              ),
            ).toBe(true);
            expect(deniedState.startupScriptErrors).toContainEqual({
              url: startupURL,
              crossOrigin: input.credentials,
            });

            if (input.corsPolicy === "wrong-origin")
              expect(
                moduleResponses.every(
                  (event) => event.allowOrigin === "https://wrong-origin.invalid",
                ),
              ).toBe(true);
            else {
              expect(
                moduleResponses.every((event) => event.allowOrigin === scenario.appOrigin),
              ).toBe(true);
              expect(moduleResponses.every((event) => event.allowCredentials === null)).toBe(true);
              expect(moduleResponses.every((event) => event.syntheticCookiePresent)).toBe(true);
            }

            expect(
              scenario.applicationEvents.some(
                (event) => event.kind === "unclaimed" && event.path.includes("_hesperia/assets"),
              ),
            ).toBe(false);
          } else {
            expect(mainDocumentPolicy).toContain("script-src 'self'");
            expect(scenario.providerEvents.some((event) => event.kind === "asset")).toBe(false);
            expect(deniedState.policyViolations.length).toBeGreaterThan(0);
            expect(
              deniedState.policyViolations.some((event) => {
                try {
                  return (
                    new URL(event.blockedURI, scenario.appOrigin).origin === scenario.assetOrigin &&
                    (event.effectiveDirective === "script-src-elem" ||
                      event.violatedDirective.startsWith("script-src"))
                  );
                } catch {
                  return false;
                }
              }),
            ).toBe(true);

            expect(validCorsSample).toMatchObject({
              origin: scenario.appOrigin,
              allowOrigin: scenario.appOrigin,
              allowCredentials: "true",
            });
          }
        }

        await recorder.flush();

        const responseRows = recorder.events.filter((event) => event.kind === "response");
        const bodyMismatches = responseRows.filter(
          (event) => event.expectedSha256 !== null && event.bodySha256 !== event.expectedSha256,
        );
        const responseReadErrors = responseRows.filter((event) => event.bodyReadError !== null);
        const headerReadErrors = responseRows.filter((event) => event.headersReadError !== null);

        if (mode === "positive") {
          const moduleEvents = scenario.providerEvents.filter(
            (event) =>
              event.kind === "asset" &&
              (event.contentType ?? "").includes("javascript") &&
              event.responseStatus === 200,
          );
          const nativeResources = scenario.providerEvents.filter(
            (event) =>
              event.kind === "asset" &&
              ((event.contentType ?? "").startsWith("text/css") ||
                (event.contentType ?? "").startsWith("font/") ||
                (event.contentType ?? "").startsWith("image/")),
          );
          const selectedRootRequests = recorder.events.filter(
            (event) => event.kind === "request" && event.origin === scenario.assetOrigin,
          );
          const pinnedManagedResponses = responseRows.filter(
            (event) => event.expectedSha256 !== null && event.origin === scenario.assetOrigin,
          );
          const javascriptResponses = pinnedManagedResponses.filter((event) =>
            event.expectedContentType?.includes("javascript"),
          );
          const stylesheetResponses = pinnedManagedResponses.filter((event) =>
            event.expectedContentType?.startsWith("text/css"),
          );
          const svgURL = new URL(svgAssetPin.path.slice(1), scenario.assetRoot).href;
          const fontURL = new URL(fontAssetPin.path.slice(1), scenario.assetRoot).href;
          const authoredStylesheetURL = new URL("/asset-controls.css", scenario.appOrigin).href;
          const svgResponses = pinnedManagedResponses.filter((event) => event.url === svgURL);
          const fontResponses = pinnedManagedResponses.filter((event) => event.url === fontURL);
          const authoredStylesheetResponses = responseRows.filter(
            (event) => event.url === authoredStylesheetURL,
          );

          expect(moduleEvents.length).toBeGreaterThan(0);

          if (scenario.sameOrigin || input.credentials === "use-credentials") {
            expect(moduleEvents.every((event) => event.syntheticCookiePresent)).toBe(true);
          } else {
            const nativeReference: NativeCredentialReferenceStage[] = [];

            observations = { ...observations, nativeCredentialReference: nativeReference };

            const expectedCookie = await readNativeCredentialReference(
              browser,
              scenario,
              nativeReference,
            );
            const startupResponses = responseRows.filter((event) => event.url === startupURL);
            const generatedPreloadResponses = responseRows.filter((event) =>
              generatedInitialPreloads.some((preload) => preload.href === event.url),
            );
            const scriptReference = nativeReference.find((stage) => stage.stage === "script");
            const preloadReference = nativeReference.find((stage) => stage.stage === "preload");
            const scriptEntries =
              scriptReference?.responses.filter(
                (response) => response.url === scriptReference.entryURL,
              ) ?? [];
            const preloadEntries =
              preloadReference?.responses.filter(
                (response) => response.url === preloadReference.entryURL,
              ) ?? [];

            expect(startupResponses.length).toBeGreaterThan(0);
            expect(generatedPreloadResponses.length).toBeGreaterThan(0);
            expect(scriptEntries.length).toBeGreaterThan(0);
            expect(preloadEntries.length).toBeGreaterThan(0);
            expect(
              startupResponses.every(
                (response) =>
                  response.status === 200 &&
                  response.contentLength === String(response.bodyLength) &&
                  scriptEntries.every(
                    (reference) =>
                      response.contentType === reference.contentType &&
                      response.allowOrigin === reference.allowOrigin &&
                      response.allowCredentials === reference.allowCredentials &&
                      response.vary === reference.vary &&
                      response.cacheControl === reference.cacheControl,
                  ),
              ),
            ).toBe(true);
            expect(
              generatedPreloadResponses.every(
                (response) =>
                  response.status === 200 &&
                  response.contentLength === String(response.bodyLength) &&
                  preloadEntries.every(
                    (reference) =>
                      response.contentType === reference.contentType &&
                      response.allowOrigin === reference.allowOrigin &&
                      response.allowCredentials === reference.allowCredentials &&
                      response.vary === reference.vary &&
                      response.cacheControl === reference.cacheControl,
                  ),
              ),
            ).toBe(true);
            expect(
              moduleEvents.every((event) => event.syntheticCookiePresent === expectedCookie),
            ).toBe(true);
          }

          expect(
            nativeResources.some((event) => (event.contentType ?? "").startsWith("text/css")),
          ).toBe(true);
          expect(
            nativeResources.some((event) => (event.contentType ?? "").startsWith("font/")),
          ).toBe(true);
          expect(
            nativeResources.some((event) => (event.contentType ?? "").startsWith("image/")),
          ).toBe(true);
          expect(javascriptResponses.length).toBeGreaterThan(0);
          expect(stylesheetResponses.length).toBeGreaterThan(0);
          expect(generatedStylesheetURLs.length).toBeGreaterThan(0);
          expect(svgResponses.length).toBeGreaterThan(0);
          expect(fontResponses.length).toBeGreaterThan(0);
          expect(selectedRootRequests.some((event) => event.url === svgURL)).toBe(true);
          expect(selectedRootRequests.some((event) => event.url === fontURL)).toBe(true);
          expect(
            recorder.events.some(
              (event) => event.kind === "request" && event.url === authoredStylesheetURL,
            ),
          ).toBe(true);
          expect(authoredStylesheetResponses.length).toBeGreaterThan(0);
          expect(
            authoredStylesheetResponses.every(
              (event) =>
                event.expectedSha256 === authoredStylesheetPin?.sha256 &&
                event.bodySha256 === authoredStylesheetPin?.sha256,
            ),
          ).toBe(true);
          expect(
            svgResponses.every(
              (event) =>
                event.status === 200 &&
                event.contentType === svgAssetPin.contentType &&
                event.expectedContentType === svgAssetPin.contentType &&
                event.bodySha256 === svgSourceSha256,
            ),
          ).toBe(true);
          expect(fontResponses.every((event) => event.bodySha256 === fontSourceSha256)).toBe(true);

          for (const stylesheetURL of generatedStylesheetURLs) {
            expect(new URL(stylesheetURL).origin).toBe(scenario.assetOrigin);
            expect(selectedRootRequests.some((event) => event.url === stylesheetURL)).toBe(true);
            expect(stylesheetResponses.some((event) => event.url === stylesheetURL)).toBe(true);
          }

          expect(
            pinnedManagedResponses.every(
              (event) => event.bodySha256 !== null && event.bodySha256 === event.expectedSha256,
            ),
          ).toBe(true);

          if (!scenario.sameOrigin) {
            expect(
              moduleEvents.every(
                (event) =>
                  event.origin === scenario.appOrigin &&
                  event.allowOrigin === scenario.appOrigin &&
                  event.allowCredentials === "true",
              ),
            ).toBe(true);
          }

          expect(bodyMismatches).toStrictEqual([]);
          expect(responseReadErrors).toStrictEqual([]);
          expect(headerReadErrors).toStrictEqual([]);
          expect(recorder.events.filter((event) => event.kind === "observererror")).toStrictEqual(
            [],
          );
          expect(
            scenario.providerEvents
              .filter((event) => event.kind === "asset")
              .every((event) => event.responseStatus === 200),
          ).toBe(true);
        }

        expect(mainDocumentStatus).toBe(200);
        expect(recorder.overflow()).toBe(false);
        expect(scenario.eventOverflow()).toBe(false);
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
        primaryError = error;
        hasPrimaryError = true;
      } finally {
        let finalState: Awaited<ReturnType<typeof readGeneratedAssetBrowserState>> | null = null;

        try {
          scenario.releaseStylesheet();
        } catch (error) {
          cleanupErrors.push(error instanceof Error ? error.message : String(error));
          finalizationCauses.push(error);
        }

        if (navigation) {
          const navigationResult = await Promise.allSettled([navigation]);

          if (navigationResult[0]?.status === "rejected") {
            const error = navigationResult[0].reason;

            cleanupErrors.push(error instanceof Error ? error.message : String(error));
            finalizationCauses.push(error);
          }
        }

        if (pageForDiagnostics) {
          try {
            finalState = await readGeneratedAssetBrowserState(pageForDiagnostics);
          } catch (error) {
            cleanupErrors.push(error instanceof Error ? error.message : String(error));
            finalizationCauses.push(error);
          }
        }

        try {
          await context.close();
        } catch (error) {
          cleanupErrors.push(error instanceof Error ? error.message : String(error));
          finalizationCauses.push(error);
        } finally {
          if (recorder) {
            try {
              await recorder.flush();
            } catch (error) {
              flushErrors.push(error instanceof Error ? error.message : String(error));
              finalizationCauses.push(error);
            }
          }

          const diagnostic = {
            kind: "generated-assets-browser-observation",
            version: 1,
            runId,
            scenario: {
              id: input.id,
              mode,
              base: input.base,
              resolvedModuleCredentials: input.credentials,
              corsPolicy: scenario.corsPolicy,
              appOrigin: scenario.appOrigin,
              assetOrigin: scenario.assetOrigin,
              assetRoot: scenario.assetRoot,
              sameOrigin: scenario.sameOrigin,
              cookiePath: scenario.assetRootPath,
            },
            browser: { engine: engineName, version: browserVersion },
            build: {
              completedRecordVersion: 4,
              captureMode: capture.inventory.hosting.mode,
              assetPins: capturedAssetPins,
            },
            observations: { ...observations, finalState },
            provider: {
              applicationEvents: scenario.applicationEvents,
              assetEvents: scenario.providerEvents,
              nativeReferenceEvents: scenario.nativeReferenceEvents,
              overflow: scenario.eventOverflow(),
            },
            browserEvents: recorder?.events ?? [],
            browserEventsOverflow: recorder?.overflow() ?? false,
            validCorsSample: validCorsSample ?? null,
            cleanupErrors,
            flushErrors,
            failure,
          };
          const safeName = `${runId}-${engineName}-${input.id.replace(/[^a-z0-9-]/giu, "-")}.json`;

          try {
            await writeFile(
              join(diagnosticsDirectory, safeName),
              JSON.stringify(diagnostic, null, 2) + "\n",
            );
          } catch (error) {
            cleanupErrors.push(error instanceof Error ? error.message : String(error));
            finalizationCauses.push(error);
          }
        }
      }

      if (hasPrimaryError) {
        if (finalizationCauses.length)
          throw new AggregateError(
            [primaryError, ...finalizationCauses],
            "Generated-asset browser scenario and evidence cleanup failed",
          );

        throw primaryError;
      }

      if (finalizationCauses.length)
        throw new AggregateError(
          finalizationCauses,
          "Generated-asset browser evidence cleanup failed",
        );

      return [...scenario.providerEvents];
    }

    for (const [engineName, engine] of [
      ["chromium", chromium],
      ["firefox", firefox],
      ["webkit", webkit],
    ] as const) {
      const browser = await engine.launch(browserLaunchOptions(engineName));

      try {
        const browserVersion = browser.version();

        for (const input of positiveInputs) {
          const events = await runBrowserScenario(
            engineName,
            browserVersion,
            browser,
            input,
            "positive",
          );

          if (input.id === "external-a-default-anonymous") {
            const sample = events.find(
              (event) =>
                event.kind === "asset" &&
                (event.contentType ?? "").includes("javascript") &&
                event.allowOrigin === provider.appOrigin &&
                event.allowCredentials === "true",
            );

            expect(sample).toBeDefined();

            if (sample) validCorsSamples.set(engineName, sample);
          }
        }

        await runBrowserScenario(
          engineName,
          browserVersion,
          browser,
          {
            id: "deny-wrong-cors-origin",
            base: "external-a",
            credentials: "anonymous",
            corsPolicy: "wrong-origin",
          },
          "cors-denial",
        );
        await runBrowserScenario(
          engineName,
          browserVersion,
          browser,
          {
            id: "deny-missing-allow-credentials",
            base: "external-a",
            credentials: "use-credentials",
            corsPolicy: "missing-credentials",
          },
          "cors-denial",
        );
        await runBrowserScenario(
          engineName,
          browserVersion,
          browser,
          {
            id: "deny-csp-script-source",
            base: "external-a",
            credentials: "anonymous",
            corsPolicy: "allow",
            denyAssetScripts: true,
          },
          "csp-denial",
          validCorsSamples.get(engineName),
        );
      } finally {
        await browser.close();
      }
    }
  } finally {
    await provider.close();
  }
}, 120_000);
