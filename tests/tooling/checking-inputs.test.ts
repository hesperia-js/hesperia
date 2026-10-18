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

async function servedAsset(server: ProjectServer, assetPath: string): Promise<string> {
  const response = await fetch(new URL(`/_hesperia${assetPath}`, server.url));

  if (!response.ok) throw new Error(`Development asset returned ${response.status}: ${assetPath}`);

  return response.text();
}

async function nextEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  expected: string,
): Promise<string> {
  let received = "";

  while (!received.includes(expected)) {
    const chunk = await reader.read();

    if (chunk.done) throw new Error(`Development events ended before ${expected}`);

    received += new TextDecoder().decode(chunk.value);
  }

  return received;
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
    let latestCapture: { build: BrowserBuild; record: BuildRecord } | undefined;
    let initialAssetHashes: ReadonlyMap<string, string> | undefined;
    server = await devProject(
      root,
      { port: 0, report: (message) => reports.push(message) },
      async (projectRoot) => {
        const build = await prepareBuild(projectRoot, true);
        const record = await recordFromBuild(build);
        latestCapture = { build, record };
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
          repaired.resolve(latestCapture);

        return build;
      },
    );
    const initialCapture = latestCapture;

    if (!initialCapture) throw new Error("Development server did not prepare an initial build");

    const initialRecord = initialCapture.record;
    const initialInput = initialRecord.checkingInputs.find(
      (input) => input.filename === "node_modules/declaration-package/types/api.d.ts",
    );

    expect(initialInput?.digest).toBe(sourceDigest(initialDeclaration));

    expect(inputPaths(root, initialRecord)).toEqual(
      inputPaths(root, initialRecord).sort((a, b) => a.localeCompare(b)),
    );

    const initialStartup = await servedAsset(server, initialCapture.build.hosting.startupAsset);

    const events = await fetch(new URL("/_hesperia/events", server.url), {
      signal: AbortSignal.timeout(15_000),
    });
    reader = events.body!.getReader();
    const connected = await reader.read();

    expect(new TextDecoder().decode(connected.value)).toContain(": connected");

    await writeFile(declaration, "export declare const label: number;");

    const diagnostic = await nextEvent(reader, "Hesperia checking failed");

    expect(diagnostic).toContain('data: "ProjectError: Hesperia checking failed"');

    expect(reports).toContain("ProjectError: Hesperia checking failed");

    expect(latestCapture).toBe(initialCapture);

    expect(await servedAsset(server, initialCapture.build.hosting.startupAsset)).toBe(
      initialStartup,
    );

    await writeFile(browserModule, 'export const label = "updated";');

    await writeFile(declaration, repairedDeclaration);

    const [repairedCapture] = await Promise.all([
      repaired.promise,
      nextEvent(reader, 'data: "reload"'),
    ]);

    expect(latestCapture).toBe(repairedCapture);

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

    expect(await servedAsset(server, changedAsset.path)).toBe(await expectedAsset.text());
  } finally {
    await reader?.cancel().catch(() => undefined);

    await server?.close();

    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
