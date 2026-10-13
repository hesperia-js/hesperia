import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { prepareBuild, ProjectError } from "../../packages/tooling/src/project.ts";
import { linkFrameworkPackages, unlinkFrameworkPackages } from "./fixture-dependencies.ts";
import { captureRejection } from "./capture-rejection.ts";

test("type-only env usage emits no host code, while a value alias blocks browser preparation", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-env-boundary-"));

  try {
    await linkFrameworkPackages(root);

    await mkdir(join(root, "src/routes"), { recursive: true });

    await writeFile(
      join(root, "app.tsx"),
      "export default function App() { return <html><head></head><body></body></html>; }",
    );

    const page = join(root, "src/routes/+page.tsx");

    await writeFile(
      page,
      'import type { env } from "hesperia/env"; type Reader = typeof env; export default function Page() { return <main>Ready</main>; }',
    );

    const safe = await prepareBuild(root);
    const browserCode = (
      await Promise.all(
        [...safe.files].filter(([path]) => path.endsWith(".js")).map(([, file]) => file.text()),
      )
    ).join("\n");

    expect(browserCode.includes("hesperia/env")).toBe(false);

    expect(browserCode.includes("env variable must be defined")).toBe(false);

    await writeFile(join(root, "barrel.ts"), 'export { env as reader } from "hesperia/env";');

    await writeFile(
      page,
      'import { reader } from "../../barrel.ts"; export default function Page() { return <main>{reader("TOKEN")}</main>; }',
    );

    const failure = await captureRejection(prepareBuild(root));

    expect(failure).toBeInstanceOf(ProjectError);

    expect((failure as ProjectError).diagnostics).toContainEqual(
      expect.objectContaining({
        code: "HES-CAPABILITY",
        filename: resolve(root, "barrel.ts"),
        message: expect.stringContaining("hesperia/env"),
      }),
    );
  } finally {
    await unlinkFrameworkPackages(root);

    await rm(root, { recursive: true, force: true });
  }
});

test("prepareBuild rejects a browser page that reaches node:fs through an imported API", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-capability-"));

  try {
    await linkFrameworkPackages(root);

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
    await unlinkFrameworkPackages(root);

    await rm(root, { recursive: true, force: true });
  }
});

test("prepareBuild rejects an authored app configuration dependency with a host capability", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-generated-capability-"));

  try {
    await linkFrameworkPackages(root);

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
    await unlinkFrameworkPackages(root);

    await rm(root, { recursive: true, force: true });
  }
});
