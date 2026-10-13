import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const entry = pathToFileURL(resolve(import.meta.dir, "../../packages/hesperia/dist/env.js")).href;

const textKey = "HESPERIA_ENV_SPEC_TEXT";

const numberKey = "HESPERIA_ENV_SPEC_NUMBER";

const booleanKey = "HESPERIA_ENV_SPEC_BOOLEAN";

test("the public env namespace preserves supplied parsing and defaults in isolated processes", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-env-"));

  try {
    await writeFile(
      join(root, "probe.mjs"),
      await readFile(new URL("./fixtures/env-probe.mjs", import.meta.url), "utf8"),
    );

    async function run(action: string, values: Record<string, string> = {}) {
      const environment = { ...process.env };

      delete environment[textKey];

      delete environment[numberKey];

      delete environment[booleanKey];

      Object.assign(environment, values);

      const child = Bun.spawn(
        [process.execPath, join(root, "probe.mjs"), action, entry, textKey, numberKey, booleanKey],
        {
          cwd: root,
          env: environment,
          stdout: "pipe",
          stderr: "pipe",
        },
      );

      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);

      expect(code, stderr).toBe(0);

      return JSON.parse(stdout.trim()) as { value?: string; type?: string; error?: string };
    }

    expect(await run("string", { [textKey]: "" })).toStrictEqual({
      value: "fallback",
      type: "string",
    });

    expect(await run("required")).toStrictEqual({
      error: `${textKey} env variable must be defined`,
    });

    expect(await run("optional")).toStrictEqual({ value: "<undefined>", type: "undefined" });

    expect(await run("optional", { [textKey]: "" })).toStrictEqual({
      value: "",
      type: "string",
    });

    expect(await run("number", { [numberKey]: "0x10" })).toStrictEqual({
      value: "16",
      type: "number",
    });

    expect(await run("number")).toStrictEqual({ value: "3000", type: "number" });

    expect(await run("number", { [numberKey]: "" })).toStrictEqual({
      value: "3000",
      type: "number",
    });

    expect(await run("number", { [numberKey]: "Infinity" })).toStrictEqual({
      value: "Infinity",
      type: "number",
    });

    expect(await run("number", { [numberKey]: "not-a-number" })).toStrictEqual({
      error: `${numberKey} env variable must be a number got not-a-number`,
    });

    expect(await run("optional-number")).toStrictEqual({
      value: "<undefined>",
      type: "undefined",
    });

    expect(await run("boolean")).toStrictEqual({ value: "false", type: "boolean" });

    expect(await run("boolean", { [booleanKey]: "TrUe" })).toStrictEqual({
      value: "true",
      type: "boolean",
    });

    expect(await run("boolean", { [booleanKey]: "FaLsE" })).toStrictEqual({
      value: "false",
      type: "boolean",
    });

    expect(await run("boolean-default", { [booleanKey]: "" })).toStrictEqual({
      value: "true",
      type: "boolean",
    });

    expect(await run("boolean", { [booleanKey]: "yes" })).toStrictEqual({
      error: `${booleanKey} env variable must be 'true' or 'false' got yes`,
    });

    await writeFile(join(root, ".env"), `${textKey}=from-project-file\n`);

    expect(await run("required")).toStrictEqual({ value: "from-project-file", type: "string" });

    expect(await run("required", { [textKey]: "from-process" })).toStrictEqual({
      value: "from-process",
      type: "string",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
