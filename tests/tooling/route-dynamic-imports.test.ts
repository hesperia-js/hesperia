import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildRouteGuards } from "../../src/tooling/route-build.ts";

test("emitted guards lazily evaluate finite TypeScript imports and retain native module caching", async () => {
  const parent = resolve(import.meta.dir, "../../.hesperia");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "route-lazy-imports-"));
  try {
    const modules = Object.entries({
      "+route.ts": `import { route } from "hesperia/routing";
const guard = async (first: boolean) => {
  const target = first ? "./first.ts" : "./second.ts";
  return (await import(target)).allow();
};
export default route({ guard });`,
      "first.ts": `import "./effect.ts";
Object.assign(globalThis, { firstLoaded: true });
export const allow = () => true;`,
      "second.ts": `import "./effect.ts";
Object.assign(globalThis, { secondLoaded: true });
export const allow = () => false;`,
      "effect.ts": `Object.assign(globalThis, { sharedLoads: (globalThis.sharedLoads ?? 0) + 1 });`,
    }).map(([filename, source]) => ({ filename: join(root, filename), source }));
    for (const module of modules) await writeFile(module.filename, module.source);
    const result = await buildRouteGuards(
      { modules, routeFiles: [join(root, "+route.ts")] },
      { root },
    );
    expect(result.diagnostics).toStrictEqual([]);
    expect(result.guards).toHaveLength(1);
    const artifact = join(root, "guard.mjs");
    await writeFile(artifact, result.guards[0]!.code);
    const script = `import assert from "node:assert/strict";
const { default: guard } = await import(${JSON.stringify(pathToFileURL(artifact).href)});
assert.equal(globalThis.firstLoaded, undefined);
assert.equal(globalThis.secondLoaded, undefined);
assert.equal(globalThis.sharedLoads, undefined);
assert.equal(await guard(true), true);
assert.equal(globalThis.firstLoaded, true);
assert.equal(globalThis.secondLoaded, undefined);
assert.equal(globalThis.sharedLoads, 1);
assert.equal(await guard(true), true);
assert.equal(await guard(false), false);
assert.equal(globalThis.secondLoaded, true);
assert.equal(globalThis.sharedLoads, 1);
console.log("lazy guard imports verified");`;
    const child = Bun.spawn(["node", "--input-type=module", "--eval", script], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [status, output, errors] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (status !== 0) throw new Error(`Emitted guard failed\n${output}\n${errors}`);
    expect(output.trim()).toBe("lazy guard imports verified");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
