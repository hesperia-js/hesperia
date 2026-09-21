import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { writeProjectTypes } from "../../src/tooling/page-types.ts";

const roots: string[] = [];
async function project(): Promise<string> {
  const parent = resolve(".hesperia");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "page-types-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("route declarations follow the current snapshot without rewriting unchanged output", async () => {
  const root = await project();
  const page = (route: string) => join(root, "src/routes", route, "+page.tsx");
  const filename = await writeProjectTypes(root, new Map([[page("users/[uid]"), ""]]));
  expect(filename).toBe(join(root, "hesperia.d.ts"));
  const first = await readFile(filename, "utf8");
  expect(first).toContain('readonly "uid": string');
  const timestamp = (await stat(filename)).mtimeMs;
  await writeProjectTypes(root, new Map([[page("users/[uid]"), "changed source"]]));
  expect((await stat(filename)).mtimeMs).toBe(timestamp);
  await writeProjectTypes(root, new Map([[page("users/[userId]"), ""]]));
  const renamed = await readFile(filename, "utf8");
  expect(renamed).toContain('readonly "userId": string');
  expect(renamed).not.toContain('"uid"');
  await expect(
    writeProjectTypes(
      root,
      new Map([
        [page("users/[userId]"), ""],
        [page("users/[otherId]"), ""],
      ]),
    ),
  ).rejects.toThrow();
  expect(await readFile(filename, "utf8")).toBe(renamed);
  expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toStrictEqual([]);
});

test("generated declarations never replace an authored root declaration", async () => {
  const root = await project();
  const filename = join(root, "hesperia.d.ts");
  const authored = 'declare const applicationName: "keep me";\n';
  await writeFile(filename, authored);
  await expect(writeProjectTypes(root, new Map())).rejects.toThrow("will not overwrite");
  expect(await readFile(filename, "utf8")).toBe(authored);
});

test("the emitted check command updates route types and rejects stale parameter access after a route rename", async () => {
  const root = await project();
  const oldDirectory = join(root, "src/routes/users/[uid]");
  const newDirectory = join(root, "src/routes/users/[userId]");
  await mkdir(oldDirectory, { recursive: true });
  const source =
    'import type { Page } from "hesperia";\nexport default function User(props: Page.Props<{ queryParams: { tab?: string } }>) { return <span>{props.params.uid}:{props.queryParams().get("tab")}</span>; }';
  await writeFile(join(oldDirectory, "+page.tsx"), source);
  await writeFile(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: "ESNext",
        module: "ESNext",
        moduleResolution: "Bundler",
        lib: ["ESNext", "DOM"],
        skipLibCheck: true,
        types: [],
      },
      include: ["src", "hesperia.d.ts"],
    }),
  );
  const invoke = async () => {
    const child = Bun.spawn([process.execPath, resolve("dist/tooling/cli.js"), "check"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, output: stdout + stderr };
  };
  expect(await invoke()).toMatchObject({ code: 0 });
  expect(await readFile(join(root, "hesperia.d.ts"), "utf8")).toContain('"uid": string');
  await rename(oldDirectory, newDirectory);
  const failed = await invoke();
  expect(failed.code).toBe(1);
  expect(failed.output).toContain("uid");
  expect(failed.output).toContain("TS2339");
  expect(await readFile(join(root, "hesperia.d.ts"), "utf8")).toContain('"userId": string');
  await writeFile(join(newDirectory, "+page.tsx"), source.replace("params.uid", "params.userId"));
  expect(await invoke()).toMatchObject({ code: 0 });
}, 30_000);
