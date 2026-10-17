import { afterAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { verifyAeoliaInputs } from "../../golden/verify-aeolia-inputs";

const root = await mkdtemp(resolve(tmpdir(), "hesperia-golden-aeolia-"));

async function packageFile(directory: string, name: string, relative: string): Promise<string> {
  const packageRoot = resolve(root, directory);
  const file = resolve(packageRoot, relative);

  await mkdir(resolve(file, ".."), { recursive: true });

  await writeFile(resolve(packageRoot, "package.json"), JSON.stringify({ name }));

  await writeFile(file, "export {};\n");

  return file;
}

afterAll(async () => {
  const physical = await realpath(root);
  const prefix = `${await realpath(resolve(tmpdir()))}${sep}`;

  if (!physical.startsWith(prefix) || !physical.includes(`${sep}hesperia-golden-aeolia-`)) {
    throw new Error(`Refusing to remove unexpected test directory: ${physical}`);
  }

  await rm(physical, { recursive: true, force: true });
});

test("accepts Hesperia's Aeolia adapter and the expected package dist", async () => {
  const adapter = await packageFile("hesperia", "hesperia", "dist/aeolia/index.js");
  const expectedInput = await packageFile("aeolia-current", "aeolia", "dist/index.js");
  const matched = await verifyAeoliaInputs(
    [adapter, expectedInput],
    resolve(root, "aeolia-current"),
  );

  expect(matched).toEqual([await realpath(expectedInput)]);
});

test("rejects a second Aeolia package under an aliased directory", async () => {
  const expectedInput = await packageFile("aeolia-current", "aeolia", "dist/index.js");
  const aliasedInput = await packageFile("engine-alias", "aeolia", "dist/index.js");

  await expect(
    verifyAeoliaInputs([expectedInput, aliasedInput], resolve(root, "aeolia-current")),
  ).rejects.toThrow("Golden bundle loaded Aeolia outside its emitted dist");
});
