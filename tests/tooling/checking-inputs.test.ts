import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { prepareBuild, type BrowserBuild } from "../../packages/tooling/src/project.ts";
import { devProject, type ProjectServer } from "../../packages/tooling/src/server.ts";

interface BuildRecord {
  readonly checkingInputs: readonly { filename: string; digest: string }[];
}

function sourceDigest(source: string): string {
  return `sha256-${new Bun.CryptoHasher("sha256").update(source).digest("hex")}`;
}

function inputPaths(root: string, record: BuildRecord): string[] {
  return record.checkingInputs.map((input) => resolve(root, input.filename).replaceAll("\\", "/"));
}

async function recordFromBuild(build: BrowserBuild): Promise<BuildRecord> {
  const record = build.files.get("/hesperia-build.json");

  if (!record) throw new Error("Prepared development build has no record");

  return JSON.parse(await record.text()) as BuildRecord;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

async function servedAsset(server: ProjectServer, assetPath: string): Promise<Uint8Array> {
  const response = await fetch(new URL(`/_hesperia${assetPath}`, server.url));

  if (!response.ok) throw new Error(`Development asset returned ${response.status}: ${assetPath}`);

  return new Uint8Array(await response.arrayBuffer());
}

function developmentEvents(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const decoder = new TextDecoder();
  let pending = "";

  return async (expected: string): Promise<string> => {
    for (;;) {
      const boundary = pending.indexOf("\n\n");

      if (boundary >= 0) {
        const event = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);

        if (event.includes(expected)) return event;

        continue;
      }

      const chunk = await reader.read();

      if (chunk.done) throw new Error(`Development events ended before ${expected}`);

      pending += decoder.decode(chunk.value, { stream: true });
    }
  };
}

async function waitForServedAsset(
  server: ProjectServer,
  assetPath: string,
  expected: Uint8Array,
  nextEvent: (expected: string) => Promise<string>,
): Promise<void> {
  for (;;) {
    const response = await fetch(new URL(`/_hesperia${assetPath}`, server.url));

    if (response.ok) {
      const actual = new Uint8Array(await response.arrayBuffer());

      if (
        actual.length === expected.length &&
        actual.every((byte, index) => byte === expected[index])
      )
        return;
    }

    await nextEvent('data: "reload"');
  }
}

test("development captures declaration revisions and serves only successful rebuilds", async () => {
  const parent = resolve(import.meta.dir, "../../.hesperia");

  await mkdir(parent, { recursive: true });

  const root = await mkdtemp(join(parent, "checking-inputs-"));
  let server: ProjectServer | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  try {
    const library = join(root, "node_modules/declaration-package");

    await mkdir(join(library, "types"), { recursive: true });

    await mkdir(join(root, "src/routes"), { recursive: true });

    await writeFile(
      join(library, "package.json"),
      JSON.stringify({
        name: "declaration-package",
        type: "module",
        exports: {
          ".": {
            types: "./types/api.d.ts",
            browser: "./browser.js",
            default: "./browser.js",
          },
        },
      }),
    );

    const initialDeclaration = "export declare const label: string;";
    const invalidDeclaration = "export declare const label: number;";
    const repairedDeclaration = 'export declare const label: "updated";';
    const declaration = join(library, "types/api.d.ts");
    const browserModule = join(library, "browser.js");

    await writeFile(declaration, initialDeclaration);

    await writeFile(browserModule, 'export const label = "initial";');

    await writeFile(
      join(root, "hesperia.config.json"),
      JSON.stringify({
        resolutionOverrides: { browser: { "chosen-library": "declaration-package" } },
      }),
    );

    await writeFile(
      join(root, "app.tsx"),
      'import { label } from "chosen-library"; export default function App() { return <html><head><title>{label.toUpperCase()}</title></head><body>{label}</body></html>; }',
    );

    const reports: string[] = [];
    const repaired = deferred<{ build: BrowserBuild; record: BuildRecord }>();
    const successfulCaptures: { build: BrowserBuild; record: BuildRecord }[] = [];
    const declarationDigests = () =>
      successfulCaptures.map(
        ({ record }) =>
          record.checkingInputs.find(
            (input) => input.filename === "node_modules/declaration-package/types/api.d.ts",
          )?.digest,
      );
    let initialAssetHashes: ReadonlyMap<string, string> | undefined;
    server = await devProject(
      root,
      { port: 0, report: (message) => reports.push(message) },
      async (projectRoot) => {
        const build = await prepareBuild(projectRoot, true);
        const record = await recordFromBuild(build);
        const capture = { build, record };
        successfulCaptures.push(capture);
        initialAssetHashes ??= new Map(
          build.hosting.assets.map((asset) => [asset.path, asset.sha256]),
        );
        const hasChangedAsset = build.hosting.assets.some(
          (asset) => initialAssetHashes?.get(asset.path) !== asset.sha256,
        );

        if (
          hasChangedAsset &&
          record.checkingInputs.some(
            (input) =>
              input.filename === "node_modules/declaration-package/types/api.d.ts" &&
              input.digest === sourceDigest(repairedDeclaration),
          )
        )
          repaired.resolve(capture);

        return build;
      },
    );
    const initialCapture = successfulCaptures[0];

    if (!initialCapture) throw new Error("Development server did not prepare an initial build");

    const initialRecord = initialCapture.record;
    const initialInput = initialRecord.checkingInputs.find(
      (input) => input.filename === "node_modules/declaration-package/types/api.d.ts",
    );

    expect(initialInput?.digest).toBe(sourceDigest(initialDeclaration));

    expect(inputPaths(root, initialRecord)).toEqual(
      inputPaths(root, initialRecord).sort((a, b) => a.localeCompare(b)),
    );

    const initialServedAssets = await Promise.all(
      initialCapture.build.hosting.assets.map(async ({ path }) => {
        const captured = initialCapture.build.files.get(path);

        if (!captured) throw new Error(`Initial build omitted ${path}`);

        const bytes = await servedAsset(server!, path);

        expect(bytes).toEqual(new Uint8Array(await captured.arrayBuffer()));

        return { path, bytes };
      }),
    );

    const initialEntrypoint = await fetch(new URL("/_hesperia/startup.js", server.url));

    if (!initialEntrypoint.ok)
      throw new Error(`Development entry returned ${initialEntrypoint.status}`);

    const initialEntrypointBytes = new Uint8Array(await initialEntrypoint.arrayBuffer());
    const events = await fetch(new URL("/_hesperia/events", server.url), {
      signal: AbortSignal.timeout(15_000),
    });
    reader = events.body!.getReader();
    const nextEvent = developmentEvents(reader);

    expect(await nextEvent(": connected")).toContain(": connected");

    await writeFile(declaration, invalidDeclaration);

    const diagnostic = await nextEvent("Hesperia checking failed");

    expect(diagnostic).toContain('data: "ProjectError: Hesperia checking failed"');

    expect(reports).toContain("ProjectError: Hesperia checking failed");

    expect(declarationDigests()).not.toContain(undefined);
    expect(declarationDigests()).not.toContain(sourceDigest(invalidDeclaration));

    for (const asset of initialServedAssets)
      expect(await servedAsset(server, asset.path)).toEqual(asset.bytes);

    const retainedEntrypoint = await fetch(new URL("/_hesperia/startup.js", server.url));

    expect(retainedEntrypoint.status).toBe(200);

    expect(new Uint8Array(await retainedEntrypoint.arrayBuffer())).toEqual(initialEntrypointBytes);

    await writeFile(browserModule, 'export const label = "updated";');

    await writeFile(declaration, repairedDeclaration);

    const [repairedCapture] = await Promise.all([repaired.promise, nextEvent('data: "reload"')]);

    const repairedRecord = repairedCapture.record;
    const repairedInput = repairedRecord.checkingInputs.find(
      (input) => input.filename === "node_modules/declaration-package/types/api.d.ts",
    );

    expect(repairedInput?.digest).toBe(sourceDigest(repairedDeclaration));

    expect(repairedInput?.digest).not.toBe(initialInput?.digest);

    expect(inputPaths(root, repairedRecord)).toEqual(
      inputPaths(root, repairedRecord).sort((a, b) => a.localeCompare(b)),
    );

    expect(repairedRecord).not.toStrictEqual(initialRecord);

    const originalAssetHashes = new Map(
      initialCapture.build.hosting.assets.map((asset) => [asset.path, asset.sha256]),
    );
    const changedAsset = repairedCapture.build.hosting.assets.find(
      (asset) => originalAssetHashes.get(asset.path) !== asset.sha256,
    );

    if (!changedAsset) throw new Error("Repaired build did not change any hosted asset");

    const expectedAsset = repairedCapture.build.files.get(changedAsset.path);

    if (!expectedAsset) throw new Error(`Repaired build omitted ${changedAsset.path}`);

    await waitForServedAsset(
      server,
      changedAsset.path,
      new Uint8Array(await expectedAsset.arrayBuffer()),
      nextEvent,
    );

    expect(declarationDigests()).not.toContain(undefined);
    expect(declarationDigests()).not.toContain(sourceDigest(invalidDeclaration));
  } finally {
    await reader?.cancel().catch(() => undefined);

    await server?.close();

    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
