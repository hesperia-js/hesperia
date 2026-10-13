import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, watch, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devProject, type ProjectServer } from "../../packages/tooling/src/server.ts";
import type { BrowserBuild } from "../../packages/tooling/src/project.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function asset(path: string, source: string, contentType: string) {
  return {
    record: {
      path,
      sha256: new Bun.CryptoHasher("sha256").update(source).digest("hex"),
      contentType,
    },
    blob: new Blob([source], { type: contentType }),
  };
}

function hostingBuild(
  assets: readonly ReturnType<typeof asset>[],
  sources: readonly string[],
  styleRevision?: BrowserBuild["styleRevision"],
): BrowserBuild {
  const hosting = {
    version: 1 as const,
    mode: "development" as const,
    standaloneMountURL: "/",
    startupAsset: "/assets/main.js",
    assets: assets.map((item) => item.record),
  };
  return {
    hosting,
    files: new Map(assets.map((item) => [item.record.path, item.blob])),
    sources,
    diagnostics: [],
    ...(styleRevision ? { styleRevision } : {}),
  };
}

test("development observes a missing plugin watch directory after its creation", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-dev-missing-watch-"));
  const directory = join(root, "plugin", "generated");

  await mkdir(join(root, "src"));

  let count = 0;
  const reports: string[] = [];
  let server: ProjectServer | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  const nextReload = async () => {
    let message = "";

    while (!message.includes('data: "reload"')) {
      const chunk = await reader!.read();

      if (chunk.done) throw new Error("Development stream ended before reload");

      message += new TextDecoder().decode(chunk.value);
    }
  };

  try {
    server = await devProject(
      root,
      { port: 0, report: (message) => reports.push(message) },
      async () => ({
        ...hostingBuild(
          [
            asset(
              "/assets/main.js",
              `export async function start() {} // ${++count}`,
              "text/javascript",
            ),
          ],
          [],
        ),
        watch: [{ kind: "directory", dir: directory }],
      }),
    );
    reader = (await fetch(new URL("/_hesperia/events", server.url))).body!.getReader();

    await reader.read();

    const preparationsAfterSource = count;
    const observer = watch(root)[Symbol.asyncIterator]();
    const generatedDirectoryEvent = observer.next();

    await mkdir(join(root, ".hesperia"));

    await generatedDirectoryEvent;

    await observer.return?.();

    await fetch(new URL("/_hesperia/assets/main.js", server.url));

    expect(count).toBe(preparationsAfterSource);

    expect(
      reports.filter((message) => message.includes("watch directory is missing")),
    ).toHaveLength(1);

    await writeFile(join(root, "src", "edit.ts"), "source edit");

    await nextReload();

    await mkdir(directory, { recursive: true });

    await nextReload();

    await writeFile(join(directory, "style.css"), "plugin output");

    await nextReload();

    expect(count).toBeGreaterThanOrEqual(4);
  } finally {
    await reader?.cancel().catch(() => undefined);

    await server?.close();

    await rm(root, { recursive: true, force: true });
  }
}, 20_000);

test("development does not publish a build superseded during host validation", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-dev-revision-"));

  await mkdir(join(root, "src"));

  const app = join(root, "app.tsx");

  await writeFile(app, "initial");

  const fingerprintStarted = deferred();
  const releaseFingerprint = deferred();
  const obsoleteAborted = deferred();
  const replacementStarted = deferred();
  const releaseReplacement = deferred();
  let preparations = 0;
  let server: ProjectServer | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  class HeldBlob extends Blob {
    override async arrayBuffer(): Promise<ArrayBuffer> {
      fingerprintStarted.resolve();

      await releaseFingerprint.promise;
      return super.arrayBuffer();
    }
  }

  const build = (value: string, blob?: Blob): BrowserBuild =>
    hostingBuild(
      [
        asset(
          "/assets/main.js",
          "export async function start() {}",
          "text/javascript; charset=utf-8",
        ),
        {
          record: {
            path: "/assets/asset.js",
            sha256: new Bun.CryptoHasher("sha256").update(value).digest("hex"),
            contentType: "text/javascript; charset=utf-8",
          },
          blob: blob ?? new Blob([value], { type: "text/javascript; charset=utf-8" }),
        },
      ],
      [app],
    );

  try {
    server = await devProject(root, { port: 0 }, async (_root, signal) => {
      preparations++;

      if (preparations === 1) return build("initial");

      if (preparations === 2) {
        signal?.addEventListener("abort", obsoleteAborted.resolve, { once: true });

        return build(
          "obsolete",
          new HeldBlob(["obsolete"], { type: "text/javascript; charset=utf-8" }),
        );
      }

      replacementStarted.resolve();

      await releaseReplacement.promise;
      return build("current");
    });
    const events = await fetch(new URL("/_hesperia/events", server.url));
    reader = events.body!.getReader();

    expect(new TextDecoder().decode((await reader.read()).value)).toContain(": connected");

    await writeFile(app, "first");

    await fingerprintStarted.promise;

    await writeFile(join(root, "src", "revision.ts"), "second");

    await obsoleteAborted.promise;

    releaseFingerprint.resolve();

    await replacementStarted.promise;

    expect(await (await fetch(new URL("/_hesperia/assets/asset.js", server.url))).text()).toBe(
      "initial",
    );

    releaseReplacement.resolve();

    let message = "";

    while (!message.includes('data: "reload"')) {
      const chunk = await reader.read();

      if (chunk.done) throw new Error("Development event stream closed before reload");

      message += new TextDecoder().decode(chunk.value);
    }

    expect(await (await fetch(new URL("/_hesperia/assets/asset.js", server.url))).text()).toBe(
      "current",
    );
  } finally {
    releaseFingerprint.resolve();

    releaseReplacement.resolve();

    await reader?.cancel().catch(() => undefined);

    await server?.close();

    await rm(root, { recursive: true, force: true });
  }
}, 20_000);

test("CSS-only publication keeps previous hashed sheets available", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-dev-css-"));

  await mkdir(join(root, "src"));

  const app = join(root, "app.tsx");

  await writeFile(app, "initial");

  const build = (revision: string): BrowserBuild =>
    hostingBuild(
      [
        asset(
          "/assets/main.js",
          "export async function start() {}",
          "text/javascript; charset=utf-8",
        ),
        asset(
          `/assets/card-${revision}.css`,
          `.card{color:${revision}}`,
          "text/css; charset=utf-8",
        ),
        asset(
          `/assets/lazy-${revision}.js`,
          `export const color = "${revision}";`,
          "text/javascript; charset=utf-8",
        ),
      ],
      [app],
      {
        semanticKey: "same-executable-snapshot",
        plan: {
          assets: [{ id: "css:src/card.css", revision, path: `./card-${revision}.css` }],
          owners: [{ ownerId: "src/Card.tsx#7", styles: ["css:src/card.css"] }],
          entries: [{ entryId: "src/Card.tsx", closure: ["css:src/card.css"] }],
          compositions: [],
        },
      },
    );

  let count = 0;
  let server: ProjectServer | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  try {
    server = await devProject(root, { port: 0 }, async () => build(++count === 1 ? "red" : "blue"));
    const events = await fetch(new URL("/_hesperia/events", server.url));
    reader = events.body!.getReader();

    await reader.read();

    await writeFile(join(root, "src", "revision.ts"), "edit");

    let payload = "";

    while (!payload.includes('"type":"style-revision"')) {
      const chunk = await reader.read();

      if (chunk.done) throw new Error("Development event stream closed before style revision");

      payload += new TextDecoder().decode(chunk.value);
    }

    expect(payload).toContain('"path":"./card-blue.css"');

    expect(payload).not.toContain('"reload"');

    expect((await fetch(new URL("/_hesperia/assets/card-red.css", server.url))).status).toBe(200);

    expect((await fetch(new URL("/_hesperia/assets/card-blue.css", server.url))).status).toBe(200);

    expect((await fetch(new URL("/_hesperia/assets/lazy-red.js", server.url))).status).toBe(200);

    expect((await fetch(new URL("/_hesperia/assets/lazy-blue.js", server.url))).status).toBe(200);
  } finally {
    await reader?.cancel().catch(() => undefined);

    await server?.close();

    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
