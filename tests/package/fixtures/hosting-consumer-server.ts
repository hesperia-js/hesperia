// The package imports resolve only after this fixture is copied to the installed external app.
// @ts-nocheck
import { createHost, type CapturedBrowserBuild } from "@hesperia/hosting";
import { prepareBuild, writeBuild } from "@hesperia/tooling";

const root = process.cwd();
const build = await prepareBuild(root);

if (build.diagnostics.some((diagnostic) => diagnostic.severity === "error"))
  throw new Error("Installed tooling produced a build with errors");

await writeBuild(root, build);

const files = new Map(
  build.hosting.assets.map((asset) => {
    const blob = build.files.get(asset.path);

    if (!blob) throw new Error("Build omitted captured asset " + asset.path);

    return [asset.path, blob] as const;
  }),
);
const captured: CapturedBrowserBuild = { hosting: build.hosting, files };
const rootHost = await createHost(captured, { mountURL: "/" });
const dashboardHost = await createHost(captured, { mountURL: "/dashboard" });
const rootServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request) => rootHost.handle(request) ?? new Response(null, { status: 404 }),
});
const dashboardServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request) => dashboardHost.handle(request) ?? new Response(null, { status: 404 }),
});

console.log(
  JSON.stringify({
    rootURL: rootServer.url.href,
    dashboardURL: dashboardServer.url.href,
    hosting: build.hosting,
  }),
);
