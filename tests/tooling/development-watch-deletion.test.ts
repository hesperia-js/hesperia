import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devProject } from "../../packages/tooling/src/server.ts";
import { linkFrameworkPackages, unlinkFrameworkPackages } from "./fixture-dependencies.ts";

test.each(["source", "project"] as const)(
  "%s hook watched-file deletion retains declared ownership",
  async (scope) => {
    const root = await mkdtemp(join(tmpdir(), "hesperia-dev-watch-deletion-"));

    let server: Awaited<ReturnType<typeof devProject>> | undefined;

    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

    try {
      await linkFrameworkPackages(root);

      for (const name of ["a", "b"]) {
        await mkdir(join(root, "src", "routes", name), { recursive: true });

        await writeFile(
          join(root, "src", "routes", name, "+page.tsx"),
          `export default function Page() { return <p>${name}</p>; }`,
        );
      }

      await writeFile(
        join(root, "app.tsx"),
        await readFile(
          new URL("./fixtures/applications/development-watch-deletion/app.tsx", import.meta.url),
          "utf8",
        ),
      );

      const watched = join(root, "input.txt");

      await writeFile(watched, "plugin input");

      const hook =
        scope === "source"
          ? 'transformSource(input) { if (input.filename.replaceAll("\\\\", "/").endsWith("/a/+page.tsx")) return { code: input.current, watch: [{ kind: "file", file: watched }] }; }'
          : 'analyzeProject() { return { watch: [{ kind: "file", file: watched }] }; }';

      await writeFile(
        join(root, "hesperia.config.ts"),
        `import { defineConfig } from "@hesperia/tooling"; const watched = ${JSON.stringify(watched)}; export default defineConfig({ plugins: [{ name: "watch-fixture", ${hook} }] });`,
      );

      server = await devProject(root, { port: 0 });

      reader = (await fetch(new URL("/_hesperia/events", server.url))).body!.getReader();

      await reader.read();

      await rm(watched);

      let buffer = "";

      let removal: { type: string; reloadAll: boolean; routeIds: string[] } | undefined;

      while (!removal) {
        const chunk = await reader.read();

        if (chunk.done) throw new Error("Development stream ended before removal publication");

        buffer += new TextDecoder().decode(chunk.value);

        for (const line of buffer.split("\n")) {
          if (!line.startsWith("data: ")) continue;

          const message = JSON.parse(line.slice(6));

          if (message?.type === "source-removal") removal = message;
        }
      }

      expect(removal.reloadAll).toBe(scope === "project");

      if (scope === "source") {
        expect(removal.routeIds).toHaveLength(1);

        expect(removal.routeIds[0]).toContain("a");
      }
    } finally {
      await reader?.cancel().catch(() => undefined);

      await server?.close();

      await unlinkFrameworkPackages(root);

      await rm(root, { recursive: true, force: true });
    }
  },
  25_000,
);
