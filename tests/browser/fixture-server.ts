import { resolve } from "node:path";
import { compile } from "@hesperia/compiler";
import { createHost } from "../../packages/hosting/src/index.ts";
import { prepareBuild } from "../../packages/tooling/src/project.ts";
import {
  browserCssCoverageEnabled,
  captureBrowserCssPageRequest,
  createBrowserCssCoverageBuildPlugin,
  withBrowserCssCoverageFixtureBuild,
} from "../../scripts/ci/browser-css-coverage-preload.ts";

const browserCoverageBuildPlugin = createBrowserCssCoverageBuildPlugin();

const built = await Bun.build({
  entrypoints: [
    resolve(import.meta.dir, "fixtures/entry.fixture.mts"),
    resolve(import.meta.dir, "fixtures/raw.fixture.mts"),
    resolve(import.meta.dir, "fixtures/structure.fixture.mts"),
    resolve(import.meta.dir, "fixtures/async.fixture.mts"),
    resolve(import.meta.dir, "fixtures/native.fixture.mts"),
    resolve(import.meta.dir, "fixtures/event-options-cache.fixture.mts"),
    resolve(import.meta.dir, "fixtures/props.fixture.mts"),
    resolve(import.meta.dir, "fixtures/functions.fixture.mts"),
    resolve(import.meta.dir, "fixtures/document.fixture.mts"),
    resolve(import.meta.dir, "fixtures/route-host.fixture.mts"),
    resolve(import.meta.dir, "fixtures/blob-attributes.fixture.mts"),
    resolve(import.meta.dir, "fixtures/css-runtime.fixture.mts"),
    resolve(import.meta.dir, "fixtures/error-boundary.fixture.mts"),
    resolve(import.meta.dir, "fixtures/stream.fixture.mts"),
    resolve(import.meta.dir, "fixtures/embed.fixture.mts"),
  ],
  target: "browser",
  format: "esm",
  sourcemap: "inline",
  plugins: [
    {
      name: "hesperia-browser-fixtures",

      setup(builder) {
        builder.onLoad({ filter: /\.tsx$/u }, async ({ path }) => {
          const result = await compile(await Bun.file(path).text(), {
            filename: path,
            allowUnsafeHTML: path.endsWith("Structure.tsx"),
            documentShell: path.endsWith("AppShell.tsx"),
          });

          if (result.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
            throw new Error(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
          }

          return { contents: result.code, loader: "js" };
        });
      },
    },
    ...(browserCoverageBuildPlugin ? [browserCoverageBuildPlugin] : []),
  ],
});

if (!built.success) throw new AggregateError(built.logs, "Browser fixture compilation failed");

const output = built.outputs.find(
  (artifact) => artifact.kind === "entry-point" && artifact.path.endsWith("entry.fixture.js"),
);
const rawOutput = built.outputs.find(
  (artifact) => artifact.kind === "entry-point" && artifact.path.endsWith("raw.fixture.js"),
);
const structureOutput = built.outputs.find(
  (artifact) => artifact.kind === "entry-point" && artifact.path.endsWith("structure.fixture.js"),
);
const asyncOutput = built.outputs.find(
  (artifact) => artifact.kind === "entry-point" && artifact.path.endsWith("async.fixture.js"),
);
const nativeOutput = built.outputs.find(
  (artifact) => artifact.kind === "entry-point" && artifact.path.endsWith("native.fixture.js"),
);
const eventOptionsCacheOutput = built.outputs.find(
  (artifact) =>
    artifact.kind === "entry-point" && artifact.path.endsWith("event-options-cache.fixture.js"),
);
const propsOutput = built.outputs.find(
  (artifact) => artifact.kind === "entry-point" && artifact.path.endsWith("props.fixture.js"),
);
const functionsOutput = built.outputs.find(
  (artifact) => artifact.kind === "entry-point" && artifact.path.endsWith("functions.fixture.js"),
);
const documentOutput = built.outputs.find(
  (artifact) => artifact.kind === "entry-point" && artifact.path.endsWith("document.fixture.js"),
);
const routeHostOutput = built.outputs.find(
  (artifact) => artifact.kind === "entry-point" && artifact.path.endsWith("route-host.fixture.js"),
);
const blobAttributesOutput = built.outputs.find(
  (artifact) =>
    artifact.kind === "entry-point" && artifact.path.endsWith("blob-attributes.fixture.js"),
);
const cssRuntimeOutput = built.outputs.find(
  (artifact) => artifact.kind === "entry-point" && artifact.path.endsWith("css-runtime.fixture.js"),
);
const errorBoundaryOutput = built.outputs.find(
  (artifact) =>
    artifact.kind === "entry-point" && artifact.path.endsWith("error-boundary.fixture.js"),
);
const streamOutput = built.outputs.find(
  (artifact) => artifact.kind === "entry-point" && artifact.path.endsWith("stream.fixture.js"),
);
const embedOutput = built.outputs.find(
  (artifact) => artifact.kind === "entry-point" && artifact.path.endsWith("embed.fixture.js"),
);

if (
  !output ||
  !rawOutput ||
  !structureOutput ||
  !asyncOutput ||
  !nativeOutput ||
  !eventOptionsCacheOutput ||
  !propsOutput ||
  !functionsOutput ||
  !documentOutput ||
  !routeHostOutput ||
  !blobAttributesOutput ||
  !cssRuntimeOutput ||
  !errorBoundaryOutput ||
  !streamOutput ||
  !embedOutput
)
  throw new Error("The browser fixture build produced no entry point");

const importedMarkupRoot = resolve(import.meta.dir, "fixtures/imported-markup");
const importedMarkupBuild = await withBrowserCssCoverageFixtureBuild(importedMarkupRoot, () =>
  prepareBuild(importedMarkupRoot),
);
const importedMarkupFiles = new Map(
  importedMarkupBuild.hosting.assets.map((asset) => {
    const file = importedMarkupBuild.files.get(asset.path);

    if (!file) throw new Error(`Missing imported markup browser asset ${asset.path}`);

    return [asset.path, file] as const;
  }),
);
const importedMarkupHost = await createHost({
  hosting: importedMarkupBuild.hosting,
  files: importedMarkupFiles,
});

const browserPort = Number.parseInt(process.env.HESPERIA_BROWSER_PORT ?? "4178", 10);

if (!Number.isInteger(browserPort) || browserPort < 1 || browserPort > 65535)
  throw new Error("HESPERIA_BROWSER_PORT must be a valid TCP port");

Bun.serve({
  hostname: "127.0.0.1",
  port: browserPort,

  fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/health") return new Response("ready");

    if (path === "/__coverage/browser-css-page") {
      if (!browserCssCoverageEnabled) return new Response("Not found", { status: 404 });

      return captureBrowserCssPageRequest(request);
    }

    if (path === "/" && url.searchParams.has("importedMarkup")) {
      return importedMarkupHost.handle(request) ?? new Response(null, { status: 404 });
    }

    if (path.startsWith("/_hesperia/"))
      return importedMarkupHost.handle(request) ?? new Response(null, { status: 404 });

    const importedMarkupFile = importedMarkupBuild.files.get(path);

    if (importedMarkupFile) {
      const hostedAsset = importedMarkupBuild.hosting.assets.find((asset) => asset.path === path);
      const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
      const contentType =
        hostedAsset?.contentType ||
        importedMarkupFile.type ||
        new Map([
          [".js", "text/javascript"],
          [".css", "text/css"],
          [".json", "application/json"],
          [".png", "image/png"],
          [".svg", "image/svg+xml"],
          [".jpg", "image/jpeg"],
          [".jpeg", "image/jpeg"],
          [".gif", "image/gif"],
          [".webp", "image/webp"],
          [".woff2", "font/woff2"],
        ]).get(extension) ||
        "application/octet-stream";
      return new Response(importedMarkupFile, { headers: { "content-type": contentType } });
    }

    if (path === "/css/imported-markup.css")
      return new Response(".markup-panel { color: rgb(70, 80, 90); }", {
        headers: { "content-type": "text/css" },
      });

    if (path === "/css/imported-markup-print.css")
      return new Response(".markup-panel { border-top: 7px solid rgb(2, 3, 4); }", {
        headers: { "content-type": "text/css" },
      });

    if (path === "/css/imported-markup-disabled.css")
      return new Response(".markup-panel { border-bottom: 9px solid rgb(2, 3, 4); }", {
        headers: { "content-type": "text/css" },
      });

    if (path === "/css/imported-markup-alternate.css")
      return new Response(".markup-panel { letter-spacing: 13px; }", {
        headers: { "content-type": "text/css" },
      });

    if (path === "/css/imported-native-sri-failure.css")
      return new Response(
        ".markup-panel { text-indent: 23px; } .managed-bad-sri-target { color: rgb(255, 1, 2); }",
        { headers: { "content-type": "text/css" } },
      );

    if (path === "/embed-browser.js")
      return new Response(embedOutput, { headers: { "content-type": "text/javascript" } });

    if (path === "/embed-browser")
      return new Response(
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Embed browser proof</title></head><body><div id="app"></div><script type="module" src="/embed-browser.js"></script></body></html>',
        { headers: { "content-type": "text/html" } },
      );

    if (path === "/css-runtime.js")
      return new Response(cssRuntimeOutput, { headers: { "content-type": "text/javascript" } });

    if (path === "/css/red.css")
      return new Response(
        ".css-red-node { color: rgb(220, 0, 0); } .order-node { color: rgb(220, 0, 0); }",
        {
          headers: { "content-type": "text/css" },
        },
      );

    if (path === "/css/blue.css")
      return new Response(
        ".css-blue-node { color: rgb(0, 0, 220); } .order-node { color: rgb(0, 0, 220); }",
        {
          headers: { "content-type": "text/css" },
        },
      );

    if (path === "/css/red-next.css")
      return new Response(".css-red-node { color: rgb(0, 180, 0); }", {
        headers: { "content-type": "text/css" },
      });

    if (path === "/css/document.css")
      return new Response(".css-document-node { color: rgb(80, 0, 160); }", {
        headers: { "content-type": "text/css" },
      });

    if (path === "/css-runtime")
      return new Response(
        '<!doctype html><html><head><title>CSS runtime</title></head><body><div id="first-target"><i id="existing-element">existing</i>existing text</div><div id="second-target"></div><div id="blue-target"></div><div id="nested-target"></div><div id="conditional-target"></div><div id="ordered-target"></div><script type="module" src="/css-runtime.js"></script></body></html>',
        { headers: { "content-type": "text/html" } },
      );

    if (path === "/blob-attributes-browser.js")
      return new Response(blobAttributesOutput, { headers: { "content-type": "text/javascript" } });

    if (path === "/blob-attributes-cache")
      return new Response(
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Blob route cache</title></head><body><div id="app"></div><script type="module" src="/blob-attributes-browser.js"></script></body></html>',
        { headers: { "content-type": "text/html" } },
      );

    if (path === "/stream.js")
      return new Response(streamOutput, { headers: { "content-type": "text/javascript" } });

    if (path === "/stream")
      return new Response(
        '<!doctype html><html><head><title>Shared streams</title></head><body><div id="app"></div><script type="module" src="/stream.js"></script></body></html>',
        { headers: { "content-type": "text/html" } },
      );

    if (path === "/error-boundary.js")
      return new Response(errorBoundaryOutput, { headers: { "content-type": "text/javascript" } });

    if (path === "/error-boundary")
      return new Response(
        '<!doctype html><html><head><title>Error boundaries</title></head><body><div id="app"></div><script type="module" src="/error-boundary.js"></script></body></html>',
        { headers: { "content-type": "text/html" } },
      );

    if (path === "/route-host.js")
      return new Response(routeHostOutput, { headers: { "content-type": "text/javascript" } });

    if (path === "/route-host")
      return new Response(
        '<!doctype html><html><head><title>Persistent route layouts</title></head><body><div id="app"></div><script type="module" src="/route-host.js"></script></body></html>',
        { headers: { "content-type": "text/html" } },
      );

    if (path === "/document.js")
      return new Response(documentOutput, { headers: { "content-type": "text/javascript" } });

    if (path === "/document")
      return new Response(
        '<!doctype html><html><head><title>Bootstrap shell</title></head><body><script type="module" src="/document.js"></script></body></html>',
        { headers: { "content-type": "text/html" } },
      );

    if (path === "/functions.js")
      return new Response(functionsOutput, { headers: { "content-type": "text/javascript" } });

    if (path === "/functions")
      return new Response(
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Function components</title></head><body><div id="app"></div><script type="module" src="/functions.js"></script></body></html>',
        { headers: { "content-type": "text/html" } },
      );

    if (path === "/props.js")
      return new Response(propsOutput, { headers: { "content-type": "text/javascript" } });

    if (path === "/props")
      return new Response(
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Component prop fixture</title></head><body><div id="app"></div><script type="module" src="/props.js"></script></body></html>',
        { headers: { "content-type": "text/html" } },
      );

    if (path === "/app.js")
      return new Response(output, { headers: { "content-type": "text/javascript" } });

    if (path === "/raw.js")
      return new Response(rawOutput, { headers: { "content-type": "text/javascript" } });

    if (path === "/structure.js")
      return new Response(structureOutput, { headers: { "content-type": "text/javascript" } });

    if (path === "/async.js")
      return new Response(asyncOutput, { headers: { "content-type": "text/javascript" } });

    if (path === "/native.js")
      return new Response(nativeOutput, { headers: { "content-type": "text/javascript" } });

    if (path === "/native")
      return new Response(
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Native binding fixture</title></head><body><div id="app"></div><script type="module" src="/native.js"></script></body></html>',
        { headers: { "content-type": "text/html" } },
      );

    if (path === "/event-options-cache.js")
      return new Response(eventOptionsCacheOutput, {
        headers: { "content-type": "text/javascript" },
      });

    if (path === "/event-options-cache")
      return new Response(
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Cached event options</title></head><body><div id="app"></div><script type="module" src="/event-options-cache.js"></script></body></html>',
        { headers: { "content-type": "text/html" } },
      );

    if (path === "/raw")
      return new Response(
        '<!doctype html><html><head><meta charset="utf-8"><title>Raw HTML runtime fixture</title></head><body><div id="app"></div><script type="module" src="/raw.js"></script></body></html>',
        {
          headers: {
            "content-type": "text/html",
            ...(url.searchParams.has("trusted")
              ? {
                  "content-security-policy":
                    "require-trusted-types-for 'script'; trusted-types hesperia-test",
                }
              : {}),
          },
        },
      );

    if (path === "/structure")
      return new Response(
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Compiled structure fixture</title></head><body><div id="app"></div><button id="remove">Remove application</button><script type="module" src="/structure.js"></script></body></html>',
        { headers: { "content-type": "text/html" } },
      );

    if (path === "/async")
      return new Response(
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Compiled async fixture</title></head><body><div id="async-app"></div><div id="independent-app"></div><script type="module" src="/async.js"></script></body></html>',
        { headers: { "content-type": "text/html" } },
      );

    return new Response(
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Compiled Hesperia fixture</title></head><body><div id="app"></div><button id="remove">Remove application</button><script type="module" src="/app.js"></script></body></html>',
      {
        headers: { "content-type": "text/html" },
      },
    );
  },
});
