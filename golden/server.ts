import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { createHost, type ApplicationHost, type CapturedBrowserBuild } from "@hesperia/hosting";
import { prepareBuild } from "@hesperia/tooling/project-service";
import { verifyAeoliaInputs } from "./verify-aeolia-inputs";
import { verifyWorkspacePackages } from "./verify-packages";

await verifyWorkspacePackages();

const { compile } = await import("@hesperia/compiler");

const port = Number(process.env.HESPERIA_GOLDEN_PORT ?? "4189");

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("HESPERIA_GOLDEN_PORT must be an integer between 1 and 65535");
}

const componentCssBuild = await prepareBuild(resolve(import.meta.dir, "fixtures/component-css"));
const checklistBuild = await prepareBuild(resolve(import.meta.dir, "fixtures/checklist"));
const publicValuesBuild = await prepareBuild(resolve(import.meta.dir, "fixtures/public-values"));
const optionalStylingRoot = resolve(import.meta.dir, "fixtures/optional-styling");
const optionalStylingDevelopmentBuild = await prepareBuild(optionalStylingRoot, true);
const optionalStylingProductionBuild = await prepareBuild(optionalStylingRoot, false);
const optionalStylingDevelopmentHost = await createHost(
  captureHostingBuild(optionalStylingDevelopmentBuild),
  { mountURL: "/optional-styling/development" },
);
const optionalStylingProductionHost = await createHost(
  captureHostingBuild(optionalStylingProductionBuild),
  { mountURL: "/optional-styling/production" },
);
const fixtureHosts: readonly {
  readonly appId: string;
  readonly basePath: string;
  readonly host: ApplicationHost;
}[] = [
  {
    appId: "component-css",
    basePath: "/component-css",
    host: await createHost(captureHostingBuild(componentCssBuild)),
  },
  {
    appId: "checklist",
    basePath: "/checklist",
    host: await createHost(captureHostingBuild(checklistBuild)),
  },
  {
    appId: "public-values",
    basePath: "/public-values",
    host: await createHost(captureHostingBuild(publicValuesBuild)),
  },
];
const componentCssFrame =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Component CSS mount document</title></head><body><section id="first-target"></section><section id="second-target"></section><section id="control-target"></section></body></html>';
const assetContentTypes: Readonly<Record<string, string>> = {
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
};

function captureHostingBuild(
  build: Awaited<ReturnType<typeof prepareBuild>>,
): CapturedBrowserBuild {
  const files = new Map<string, Blob>();

  for (const asset of build.hosting.assets) {
    const file = build.files.get(asset.path);

    if (!file) throw new Error(`Golden browser build omitted ${asset.path}`);

    files.set(asset.path, file);
  }

  return { hosting: build.hosting, files };
}

const browserAssets = new Map<string, Blob>();

for (const build of [componentCssBuild, checklistBuild, publicValuesBuild]) {
  for (const [pathname, asset] of build.files) {
    if (!pathname.startsWith("/assets/")) continue;

    const previous = browserAssets.get(pathname);

    if (previous) {
      const [priorBytes, nextBytes] = await Promise.all([
        previous.arrayBuffer(),
        asset.arrayBuffer(),
      ]);

      if (!Buffer.from(priorBytes).equals(Buffer.from(nextBytes))) {
        throw new Error(`Golden projects emitted different content at ${pathname}`);
      }
    } else {
      browserAssets.set(pathname, asset);
    }
  }
}

function browserAsset(pathname: string): Response | undefined {
  const asset = browserAssets.get(pathname);

  if (!asset) return undefined;

  const extension = pathname.split(".").at(-1) ?? "";
  return new Response(asset, {
    headers: {
      "cache-control": "no-store",
      "content-type": asset.type || assetContentTypes[extension] || "application/octet-stream",
    },
  });
}

function fixtureHostForPath(pathname: string) {
  return fixtureHosts.find(
    ({ basePath }) => pathname === basePath || pathname.startsWith(`${basePath}/`),
  );
}

function fixtureHostForRequest(request: Request) {
  const appCookie = request.headers
    .get("cookie")
    ?.split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith("hesperia-golden-host="));
  const appId = appCookie?.slice("hesperia-golden-host=".length);
  return fixtureHosts.find((fixture) => fixture.appId === appId);
}

function withFixtureHostCookie(response: Response, appId: string): Response {
  const headers = new Headers(response.headers);

  headers.set("cache-control", "no-store");

  headers.set("set-cookie", `hesperia-golden-host=${appId}; Path=/; SameSite=Lax`);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

const entrypoints = new Map([
  [
    "blob-attributes",
    resolve(import.meta.dir, "fixtures/blob-attributes/blob-attributes.fixture.ts"),
  ],
  ["identity", resolve(import.meta.dir, "fixtures/native-identity/identity.fixture.ts")],
  ["native-events", resolve(import.meta.dir, "fixtures/native-events/native-events.fixture.ts")],
  [
    "task-cancellation",
    resolve(import.meta.dir, "fixtures/task-cancellation/task-cancellation.fixture.ts"),
  ],
  ["embed-security", resolve(import.meta.dir, "fixtures/embed-security/embed-security.fixture.ts")],
  ["lifecycle", resolve(import.meta.dir, "fixtures/lifecycle/lifecycle.fixture.ts")],
]);

const built = await Bun.build({
  entrypoints: [...entrypoints.values()],
  target: "browser",
  format: "esm",
  metafile: true,
  sourcemap: "inline",
  plugins: [
    {
      name: "hesperia-golden-tsx",

      setup(builder) {
        builder.onLoad({ filter: /\.tsx$/u }, async ({ path }) => {
          const result = await compile(await Bun.file(path).text(), {
            filename: path,
            allowUnsafeEmbed: path.toLowerCase().endsWith("embedsecurity.tsx"),
          });
          const errors = result.diagnostics.filter(({ severity }) => severity === "error");

          if (errors.length > 0) {
            throw new Error(errors.map(({ message }) => `${path}: ${message}`).join("\n"));
          }

          return { contents: result.code, loader: "js" };
        });
      },
    },
  ],
});

if (!built.success) {
  throw new AggregateError(built.logs, "Golden application compilation failed");
}

if (!built.metafile) throw new Error("Bun did not return golden build metadata");

const scripts = new Map<string, string>();
const expectedEntryPoints = new Map(
  await Promise.all(
    [...entrypoints].map(async ([name, path]) => [await realpath(path), name] as const),
  ),
);
const mappedEntryPoints = new Set<string>();

for (const artifact of built.outputs) {
  if (artifact.kind !== "entry-point") continue;

  const outputMetadata =
    built.metafile.outputs[artifact.path] ??
    Object.entries(built.metafile.outputs).find(
      ([path]) => resolve(import.meta.dir, path) === resolve(import.meta.dir, artifact.path),
    )?.[1];

  if (!outputMetadata?.entryPoint) {
    throw new Error(`Bun emitted ${artifact.path} without entrypoint metadata`);
  }

  const emittedEntryPoint = await realpath(resolve(import.meta.dir, outputMetadata.entryPoint));
  const name = expectedEntryPoints.get(emittedEntryPoint);

  if (!name) throw new Error(`Bun emitted an unrecognized golden entrypoint: ${emittedEntryPoint}`);

  if (mappedEntryPoints.has(name))
    throw new Error(`Bun emitted golden entry ${name} more than once`);

  mappedEntryPoints.add(name);

  scripts.set(`/${name}.js`, await artifact.text());
}

for (const name of entrypoints.keys()) {
  if (!mappedEntryPoints.has(name))
    throw new Error(`Golden application entry ${name} produced no browser bundle`);
}

const aeoliaRoot = await realpath(resolve(import.meta.dir, "..", "node_modules", "aeolia"));

await verifyAeoliaInputs(
  Object.keys(built.metafile.inputs).map((path) => resolve(import.meta.dir, path)),
  aeoliaRoot,
);

console.log(
  `[hesperia-golden] entrypoint output mapping verified: ${[...mappedEntryPoints].join(", ")}`,
);

console.log(`[hesperia-golden] Aeolia inputs share one emitted package root: ${aeoliaRoot}`);

const embedChild =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Controlled embed child</title></head><body><script>const caseId = new URLSearchParams(location.search).get("case") ?? "missing"; document.documentElement.dataset.embedScriptRan = "true"; let parentAccess = "denied"; try { parent.document.documentElement.dataset.embedChildAccess = caseId; parentAccess = "allowed"; } catch {} parent.postMessage({ type: "hesperia-embed-child", caseId, childOrigin: location.origin, parentAccess }, "*");</script></body></html>';

const pages = new Map([
  ["/", await Bun.file(resolve(import.meta.dir, "index.html")).text()],
  [
    "/blob-attributes",
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Blob attributes</title></head><body><div id="app"></div><script type="module" src="/blob-attributes.js"></script></body></html>`,
  ],
  [
    "/identity",
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Native identity</title></head><body><div id="app"></div><script type="module" src="/identity.js"></script></body></html>`,
  ],
  [
    "/native-events",
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Native events</title></head><body><div id="app"></div><script type="module" src="/native-events.js"></script></body></html>`,
  ],
  [
    "/task-cancellation",
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Task cancellation</title></head><body><div id="app"></div><script type="module" src="/task-cancellation.js"></script></body></html>`,
  ],
  [
    "/embed-security",
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Embed security</title></head><body><div id="app"></div><script type="module" src="/embed-security.js"></script></body></html>',
  ],
  [
    "/lifecycle",
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Lifecycle</title></head><body><div id="app"></div><script type="module" src="/lifecycle.js"></script></body></html>',
  ],
]);

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,

  fetch(request) {
    const { pathname } = new URL(request.url);

    if (pathname === "/health") return new Response("hesperia-golden-ready");

    const optionalStylingResponse =
      optionalStylingDevelopmentHost.handle(request) ??
      optionalStylingProductionHost.handle(request);

    if (optionalStylingResponse) return optionalStylingResponse;

    // Root-mounted hosts share this URL, but each wrapper imports a different startup asset.
    if (pathname === "/_hesperia/startup.js") {
      const fixture = fixtureHostForRequest(request);
      return fixture?.host.handle(request) ?? new Response(null, { status: 404 });
    }

    if (pathname.startsWith("/_hesperia/assets/")) {
      const logicalPath = `/assets/${pathname.slice("/_hesperia/assets/".length)}`;
      return browserAsset(logicalPath) ?? new Response(null, { status: 404 });
    }

    if (pathname === "/_hesperia" || pathname.startsWith("/_hesperia/"))
      return new Response(null, { status: 404 });

    const fixture = fixtureHostForPath(pathname);

    if (fixture) {
      const response = fixture.host.handle(request);

      if (response) return withFixtureHostCookie(response, fixture.appId);
    }

    if (pathname === "/component-css-frame") {
      return new Response(componentCssFrame, {
        headers: { "cache-control": "no-store", "content-type": "text/html; charset=utf-8" },
      });
    }

    const assetResponse = browserAsset(pathname);

    if (assetResponse) return assetResponse;

    if (pathname === "/embed-child") {
      return new Response(embedChild, {
        headers: {
          "cache-control": "no-store",
          "content-type": "text/html; charset=utf-8",
          "x-content-type-options": "nosniff",
        },
      });
    }

    const script = scripts.get(pathname);

    if (script !== undefined) {
      return new Response(script, {
        headers: { "content-type": "text/javascript; charset=utf-8" },
      });
    }

    const page = pages.get(pathname);

    if (page !== undefined) {
      return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`[hesperia-golden] Browse fixtures at ${server.url}`);
