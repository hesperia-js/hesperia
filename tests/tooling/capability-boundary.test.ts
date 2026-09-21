import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { prepareBuild, ProjectError } from "../../src/tooling/project.ts";

test("prepareBuild rejects a browser page that reaches node:fs through an imported API", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-capability-"));
  try {
    await mkdir(join(root, "src/routes"), { recursive: true });
    await writeFile(
      join(root, "app.tsx"),
      "export default function App() { return <html><head></head><body></body></html>; }",
    );
    await writeFile(
      join(root, "api.ts"),
      '// @ts-ignore host capability is the subject of this checking probe\nimport fs from "node:fs"; export const api = () => fs.existsSync(".");',
    );
    await writeFile(
      join(root, "src/routes/+page.tsx"),
      'import { api } from "../../api.ts"; export default function Page() { return <main>{String(api())}</main>; }',
    );
    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          lib: ["ESNext", "DOM"],
          module: "ESNext",
          moduleResolution: "Bundler",
          skipLibCheck: true,
          strict: true,
          target: "ESNext",
          types: [],
        },
      }),
    );

    let failure: unknown;
    try {
      await prepareBuild(root);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ProjectError);
    expect((failure as ProjectError).diagnostics).toContainEqual(
      expect.objectContaining({
        code: "HES-CAPABILITY",
        filename: resolve(root, "api.ts"),
        message: expect.stringContaining("node:fs"),
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prepareBuild rejects an authored app configuration dependency with a host capability", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-generated-capability-"));
  try {
    await mkdir(join(root, "src/routes"), { recursive: true });
    await writeFile(
      join(root, "app.tsx"),
      "export default function App() { return <html><head></head><body></body></html>; }",
    );
    await writeFile(
      join(root, "app.config.ts"),
      'import { pageCacheSize } from "./config-backend.ts"; export default { pageCacheSize };',
    );
    await writeFile(
      join(root, "config-backend.ts"),
      "// @ts-ignore host capability is the subject of this checking probe\nexport const pageCacheSize = Number(process.env.HESPERIA_CACHE_SIZE);",
    );
    await writeFile(
      join(root, "src/routes/+page.tsx"),
      "export default function Page() { return <main>Ready</main>; }",
    );
    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          lib: ["ESNext", "DOM"],
          module: "ESNext",
          moduleResolution: "Bundler",
          skipLibCheck: true,
          strict: true,
          target: "ESNext",
          types: [],
        },
      }),
    );

    let failure: unknown;
    try {
      await prepareBuild(root);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ProjectError);
    expect((failure as ProjectError).message).toBe("Hesperia checking failed");
    expect((failure as ProjectError).diagnostics).toContainEqual(
      expect.objectContaining({
        code: "HES-CAPABILITY",
        filename: resolve(root, "config-backend.ts"),
        message: expect.stringContaining("process"),
      }),
    );
    expect(await readdir(root)).not.toContain(".hesperia");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
