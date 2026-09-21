import { resolve } from "node:path";
import { compile } from "hesperia/compiler";

const built = await Bun.build({
  entrypoints: [
    resolve(import.meta.dir, "fixtures/entry.fixture.mts"),
    resolve(import.meta.dir, "fixtures/raw.fixture.mts"),
    resolve(import.meta.dir, "fixtures/structure.fixture.mts"),
    resolve(import.meta.dir, "fixtures/async.fixture.mts"),
    resolve(import.meta.dir, "fixtures/native.fixture.mts"),
    resolve(import.meta.dir, "fixtures/props.fixture.mts"),
    resolve(import.meta.dir, "fixtures/functions.fixture.mts"),
    resolve(import.meta.dir, "fixtures/document.fixture.mts"),
    resolve(import.meta.dir, "fixtures/route-host.fixture.mts"),
    resolve(import.meta.dir, "fixtures/error-boundary.fixture.mts"),
    resolve(import.meta.dir, "fixtures/stream.fixture.mts"),
  ],
  target: "browser",
  format: "esm",
  sourcemap: "inline",
  plugins: [
    {
      name: "hesperia-browser-fixtures",
      setup(builder) {
        builder.onLoad({ filter: /\.tsx$/u }, async ({ path }) => {
          const result = compile(await Bun.file(path).text(), {
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
const errorBoundaryOutput = built.outputs.find(
  (artifact) =>
    artifact.kind === "entry-point" && artifact.path.endsWith("error-boundary.fixture.js"),
);
const streamOutput = built.outputs.find(
  (artifact) => artifact.kind === "entry-point" && artifact.path.endsWith("stream.fixture.js"),
);
if (
  !output ||
  !rawOutput ||
  !structureOutput ||
  !asyncOutput ||
  !nativeOutput ||
  !propsOutput ||
  !functionsOutput ||
  !documentOutput ||
  !routeHostOutput ||
  !errorBoundaryOutput ||
  !streamOutput
)
  throw new Error("The browser fixture build produced no entry point");

Bun.serve({
  hostname: "127.0.0.1",
  port: 4178,
  fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/health") return new Response("ready");
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
