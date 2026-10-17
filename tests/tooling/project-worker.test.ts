import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildInProjectProcess,
  editorInProjectProcess,
} from "../../packages/tooling/src/project-worker-client.ts";
import { checkProject, prepareBuild } from "../../packages/tooling/src/project.ts";
import { linkFrameworkPackages, unlinkFrameworkPackages } from "./fixture-dependencies.ts";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await unlinkFrameworkPackages(root);

    await rm(root, { recursive: true, force: true });
  }
});

test("project-root worker reloads changed config and ignores plugin logging", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-worker-"));

  roots.push(root);

  await linkFrameworkPackages(root);

  await mkdir(join(root, "src"));

  const source =
    'import { LABEL } from "hesperia/config/public"; export default function App() { return <html><head></head><body>{LABEL}</body></html>; }';

  await writeFile(join(root, "app.tsx"), source);

  const config = (label: string) => `
import { defineConfig } from "@hesperia/tooling";
console.log("config log ${label}");
export default defineConfig({
  mountURL: "/worker",
  public: { LABEL: "${label}", SPECIAL: { values: [undefined, Infinity, -Infinity, NaN, -0] } },
  plugins: [{ name: "logging", transformSource(input) {
    console.log("plugin log ${label}");
    return { code: input.current };
  } }],
});`;

  await writeFile(join(root, "hesperia.config.ts"), config("first"));

  const first = await editorInProjectProcess(root, new Map([[join(root, "app.tsx"), source]]));

  expect(first.configuration.public?.LABEL).toBe("first");

  expect(first.configuration.mountURL).toBe("/worker");

  expect(first.modules.some((item) => item.filename.endsWith("app.tsx"))).toBe(true);

  await writeFile(join(root, "hesperia.config.ts"), config("second"));

  const second = await editorInProjectProcess(root, new Map([[join(root, "app.tsx"), source]]));

  expect(second.configuration.public?.LABEL).toBe("second");

  const special = second.configuration.public?.SPECIAL as { values: number[] };

  expect(special.values[0]).toBeUndefined();

  expect(special.values[1]).toBe(Infinity);

  expect(special.values[2]).toBe(-Infinity);

  expect(Number.isNaN(special.values[3])).toBe(true);

  expect(Object.is(special.values[4], -0)).toBe(true);

  expect((await checkProject(root)).some((item) => item.severity === "error")).toBe(false);

  const build = await buildInProjectProcess(root, false);

  expect(build.hosting.standaloneMountURL).toBe("/worker");

  expect(build.hosting.assets.map((asset) => asset.path)).toStrictEqual(
    [...build.files.keys()].filter((path) => path.startsWith("/assets/")).sort(),
  );

  const scripts = (
    await Promise.all(
      [...build.files]
        .filter(([name]) => name.endsWith(".js"))
        .map(async ([, blob]) => blob.text()),
    )
  ).join("\n");

  expect(scripts.includes("second")).toBe(true);

  expect((await prepareBuild(root)).files.size).toBeGreaterThan(0);

  await writeFile(
    join(root, "hesperia.config.ts"),
    `setInterval(() => {}, 3_600_000);\n${config("third")}`,
  );

  expect(
    (await editorInProjectProcess(root, new Map([[join(root, "app.tsx"), source]]))).configuration
      .public?.LABEL,
  ).toBe("third");

  await writeFile(
    join(root, "hesperia.config.ts"),
    "setInterval(() => {}, 3_600_000); export default { unsupported: true };",
  );

  await expect(
    editorInProjectProcess(root, new Map([[join(root, "app.tsx"), source]])),
  ).rejects.toThrow("Unknown Hesperia configuration option");

  await writeFile(
    join(root, "hesperia.config.ts"),
    "setInterval(() => {}, 3_600_000); await new Promise(() => {});",
  );

  const controller = new AbortController();
  const pending = editorInProjectProcess(
    root,
    new Map([[join(root, "app.tsx"), source]]),
    controller.signal,
  );

  setTimeout(() => controller.abort(), 100);

  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
}, 60_000);
