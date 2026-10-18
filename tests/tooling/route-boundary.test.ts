import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { prepareBuild } from "../../packages/tooling/src/project.ts";
import { captureRejection } from "./capture-rejection.ts";

async function project(main: string): Promise<string> {
  const parent = resolve(import.meta.dir, "../../.hesperia");

  await mkdir(parent, { recursive: true });

  const root = await mkdtemp(join(parent, "route-boundary-"));

  await mkdir(join(root, "src/routes"), { recursive: true });

  await writeFile(
    join(root, "src/routes/+route.ts"),
    `
    import { route } from "hesperia/routing";
    console.log("server-route-side-effect");
    const guard = () => true;
    export default route({ guard, load: () => "server-loader-marker" });
  `,
  );

  await writeFile(
    join(root, "app.tsx"),
    `${main}
export default function App() { return <html><head></head><body></body></html>; }`,
  );

  return root;
}

test("browser builds reject value imports of server-only route declarations", async () => {
  const root = await project('import route from "./src/routes/+route.ts"; console.log(route);');

  try {
    expect(await captureRejection(prepareBuild(root))).toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "HES-ROUTE-SERVER",
          filename: join(root, "src/routes/+route.ts"),
        }),
      ]),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("type-only route references do not include server code in browser artifacts", async () => {
  const root = await project(`
    import type definition from "./src/routes/+route.ts";
    type Configuration = typeof definition;
    const field: keyof Configuration = "guard";
    document.body.setAttribute("data-field", field);
  `);

  try {
    const result = await prepareBuild(root);

    expect(result.diagnostics).toStrictEqual([]);

    const scripts = await Promise.all(
      [...result.files]
        .filter(([filename]) => filename.endsWith(".js"))
        .map(([, blob]) => blob.text()),
    );

    expect(scripts).not.toHaveLength(0);

    expect(scripts.join("\n")).not.toContain("server-loader-marker");

    expect(scripts.join("\n")).not.toContain("server-route-side-effect");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prepareBuild publishes isolated route guards and authored maps", async () => {
  const root = await project("document.body.setAttribute('data-app', 'app');");

  try {
    await writeFile(
      join(root, "src/routes/+route.ts"),
      `import { redirect, route } from "hesperia/routing";
const serverMarker = "SERVER_ROUTE_LOAD";
const guard = () => redirect("/login");
export default route({ guard, load: () => serverMarker });
`,
    );

    const built = await prepareBuild(root);

    expect(built.diagnostics).toStrictEqual([]);

    const record = JSON.parse(await built.files.get("/hesperia-build.json")!.text());
    const outputUrl = record.routeGuards["src/routes/+route.ts"] as string;

    expect(outputUrl).toMatch(/^\/assets\/routes\/guard-.*\.js$/);

    const guardCode = await built.files.get(outputUrl)!.text();
    const guardMap = JSON.parse(await built.files.get(`${outputUrl}.map`)!.text());

    expect(guardCode).toContain(`//# sourceMappingURL=${outputUrl.split("/").at(-1)}.map`);

    expect(guardCode).not.toContain("SERVER_ROUTE_LOAD");

    expect(JSON.stringify(guardMap)).not.toContain("SERVER_ROUTE_LOAD");

    expect(guardMap.sourcesContent).toBeUndefined();

    const browserCode = (
      await Promise.all(
        [...built.files].filter(([path]) => path.endsWith(".js")).map(([, blob]) => blob.text()),
      )
    ).join("\n");

    expect(browserCode).toContain('import("./routes/guard-');

    expect(browserCode).not.toContain('import("/assets/routes/guard-');

    const encoded = Buffer.from(guardCode).toString("base64");
    const module = await import(`data:text/javascript;base64,${encoded}`);

    expect(module.default()).toStrictEqual({ redirect: "/login" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the emitted check command rejects an unreachable route guard before browser emission", async () => {
  const root = await project('document.body.setAttribute("data-app", "app");');

  try {
    await writeFile(
      join(root, "src/routes/+route.ts"),
      'import { route } from "hesperia/routing"; export default route({ guard: () => true });',
    );

    const child = Bun.spawn(
      [process.execPath, resolve(import.meta.dir, "../../packages/tooling/dist/cli.js"), "check"],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(code).toBe(1);

    expect(stdout + stderr).toContain("HES-ROUTE-GUARD");

    expect(stdout + stderr).toContain("+route.ts");

    expect(await captureRejection(prepareBuild(root))).toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "HES-ROUTE-GUARD",
          filename: join(root, "src/routes/+route.ts"),
        }),
      ]),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
