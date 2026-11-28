import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareBuild } from "../../packages/tooling/src/project.ts";
import { linkFrameworkPackages, unlinkFrameworkPackages } from "./fixture-dependencies.ts";

test("Tooling emits client callback diagnostics only in development browser bundles", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-client-guards-"));

  try {
    await linkFrameworkPackages(root);

    await mkdir(join(root, "src"));

    await writeFile(
      join(root, "app.tsx"),
      `import * as client from "hesperia/client";

export default function App() {
  const count = client.state(1);
  const doubled = client.derived(() => count() * 2);
  client.effect(() => {
    document.title = "client-guards-title:" + doubled();
  });
  return <html><head></head><body>{doubled()}</body></html>;
}
`,
    );

    for (const development of [true, false]) {
      const build = await prepareBuild(root, development);
      const modules = await Promise.all(
        [...build.files].filter(([path]) => path.endsWith(".js")).map(([, file]) => file.text()),
      );
      const browserCode = modules.join("\n");

      expect(browserCode).toContain("client-guards-title:");

      for (const diagnostic of ["HES-DEV-CLIENT-DERIVED", "HES-DEV-CLIENT-EFFECT"]) {
        expect(browserCode.includes(diagnostic)).toBe(development);
      }
    }
  } finally {
    await unlinkFrameworkPackages(root);

    await rm(root, { recursive: true, force: true });
  }
});
