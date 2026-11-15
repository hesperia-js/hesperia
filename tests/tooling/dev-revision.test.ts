import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, watch, writeFile } from "node:fs/promises";
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
  const canonicalRoot = await realpath(root);
  const directory = join(canonicalRoot, "plugin", "generated");

  await mkdir(join(root, "src"));

  let count = 0;
  const reports: string[] = [];
  const parent = join(canonicalRoot, "plugin");
  const missingChild = `Development watch directory is missing: ${directory}; watching for its creation`;
  const missingParent = `Development watch directory is missing: ${parent}; watching for its creation`;
  let watchParent = false;
  let server: ProjectServer | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  const decoder = new TextDecoder();
  let pendingEvents = "";

  const nextReload = async (expected: string) => {
    for (;;) {
      const boundary = pendingEvents.indexOf("\n\n");

      if (boundary >= 0) {
        const event = pendingEvents.slice(0, boundary);
        pendingEvents = pendingEvents.slice(boundary + 2);

        if (event.includes('data: "reload"')) {
          const response = await fetch(new URL("/_hesperia/assets/main.js", server!.url));

          if ((await response.text()).includes(expected)) return;
        }

        continue;
      }

      const chunk = await reader!.read();

      if (chunk.done) throw new Error("Development stream ended before reload");

      pendingEvents += decoder.decode(chunk.value, { stream: true });
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
              `export async function start() {} // ${++count}:${watchParent ? "parent" : "child"}:${existsSync(directory) ? "present" : "missing"}:${existsSync(join(directory, "style.css")) ? "present" : "missing"}`,
              "text/javascript",
            ),
          ],
          [],
        ),
        watch: [
          { kind: "directory", dir: directory },
          ...(watchParent ? [{ kind: "directory" as const, dir: parent }] : []),
        ],
      }),
    );
    reader = (await fetch(new URL("/_hesperia/events", server.url))).body!.getReader();

    const initialChunk = await reader.read();

    if (initialChunk.done) throw new Error("Development stream closed before connection");

    pendingEvents += decoder.decode(initialChunk.value, { stream: true });

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

    expect(reports.filter((message) => message === missingChild)).toHaveLength(1);

    expect(reports.filter((message) => message === missingParent)).toHaveLength(0);

    watchParent = true;

    await writeFile(join(root, "src", "edit.ts"), "source edit");

    await nextReload("parent:missing:missing");

    expect(reports.filter((message) => message === missingChild)).toHaveLength(1);

    expect(reports.filter((message) => message === missingParent)).toHaveLength(1);

    await mkdir(directory, { recursive: true });

    await nextReload("parent:present:missing");

    await writeFile(join(directory, "style.css"), "plugin output");

    await nextReload("parent:present:present");

    expect(reports.filter((message) => message === missingChild)).toHaveLength(1);

    expect(reports.filter((message) => message === missingParent)).toHaveLength(1);

    await rm(directory, { recursive: true, force: true });

    await nextReload("parent:missing:missing");

    expect(reports.filter((message) => message === missingChild)).toHaveLength(2);

    expect(reports.filter((message) => message === missingParent)).toHaveLength(1);

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

  await writeFile(app, "red");

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
  const initialRevalidation = deferred();
  const releaseRevalidation = deferred();
  let server: ProjectServer | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  try {
    server = await devProject(root, { port: 0 }, async () => {
      const revision = await readFile(app, "utf8");

      if (++count === 2) {
        initialRevalidation.resolve();

        await releaseRevalidation.promise;
      }

      return build(revision);
    });
    const events = await fetch(new URL("/_hesperia/events", server.url));
    reader = events.body!.getReader();

    await reader.read();

    await initialRevalidation.promise;

    const initial = await fetch(new URL("/_hesperia/assets/card-red.css", server.url));

    expect(initial.status).toBe(200);

    expect(await initial.text()).toBe(".card{color:red}");

    releaseRevalidation.resolve();

    const nextRevision = join(root, "next-revision");

    await writeFile(nextRevision, "blue");

    await rename(nextRevision, app);

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
    releaseRevalidation.resolve();

    await reader?.cancel().catch(() => undefined);

    await server?.close();

    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
