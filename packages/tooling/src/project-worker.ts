import { readConfiguration } from "./configuration.ts";
import {
  checkProjectLocal,
  prepareBuildLocal,
  preparePluginEditorWire,
  type BrowserBuild,
} from "./project.ts";

type Request =
  | { readonly kind: "check" }
  | { readonly kind: "build"; readonly development: boolean }
  | { readonly kind: "editor"; readonly sources: readonly (readonly [string, string])[] };

const PREFIX = "\nHESPERIA_PROJECT_WORKER:";
let response: unknown;
let status = 0;

type BlobEntry = readonly [string, Blob];
type EncodedBlobEntry = readonly [string, string, string];

function assertPublicMapMatchesInventory(
  records: readonly { readonly urlPath: string; readonly contentType: string }[],
  entries: readonly BlobEntry[],
): void {
  const inventory = new Map<string, string>();

  for (const record of records) {
    if (inventory.has(record.urlPath))
      throw new TypeError(`hosting.publicFiles contains duplicate URL ${record.urlPath}`);

    inventory.set(record.urlPath, record.contentType);
  }

  if (inventory.size !== entries.length)
    throw new TypeError("hosting.publicFiles inventory does not match the publicFiles map");

  for (const [urlPath, blob] of entries)
    if (inventory.get(urlPath) !== blob.type)
      throw new TypeError(
        `publicFiles map metadata does not match hosting.publicFiles for ${urlPath}`,
      );
}

async function encodeBlobEntries(
  entries: readonly BlobEntry[],
): Promise<readonly EncodedBlobEntry[]> {
  return Promise.all(
    entries.map(
      async ([path, blob]) =>
        [path, blob.type, Buffer.from(await blob.arrayBuffer()).toString("base64")] as const,
    ),
  );
}

function snapshotMetadata(build: BrowserBuild) {
  return {
    sources: structuredClone(build.sources),
    diagnostics: structuredClone(build.diagnostics),
    styles: structuredClone(build.styles),
    styleRevision: structuredClone(build.styleRevision),
    developmentDependencies: structuredClone(build.developmentDependencies),
    watch: structuredClone(build.watch),
  };
}

function workerBuildValue(
  hosting: BrowserBuild["hosting"],
  files: readonly EncodedBlobEntry[],
  metadata: ReturnType<typeof snapshotMetadata>,
  publicFiles?: readonly EncodedBlobEntry[],
) {
  const value = {
    files,
    hosting,
    sources: metadata.sources,
    diagnostics: metadata.diagnostics,
    styles: metadata.styles,
    ...(metadata.styleRevision ? { styleRevision: metadata.styleRevision } : {}),
    ...(metadata.developmentDependencies
      ? { developmentDependencies: metadata.developmentDependencies }
      : {}),
    watch: metadata.watch,
  };

  return publicFiles === undefined ? value : { ...value, publicFiles };
}

try {
  const request = JSON.parse(await Bun.stdin.text()) as Request;
  const root = process.cwd();

  if (request.kind === "check") {
    const diagnostics = await checkProjectLocal(root);
    response = { ok: true, value: diagnostics };
  } else if (request.kind === "build") {
    const build = await prepareBuildLocal(root, request.development);

    if ("publicFiles" in build) {
      const hosting = structuredClone(build.hosting);
      const files = [...build.files];
      const publicEntries = [...build.publicFiles];

      if (hosting.version !== 2) throw new TypeError("A V2 build requires hosting version 2");

      if (!Array.isArray(hosting.publicFiles))
        throw new TypeError("A V2 build requires hosting.publicFiles");

      assertPublicMapMatchesInventory(hosting.publicFiles, publicEntries);

      const metadata = snapshotMetadata(build);
      const [encodedFiles, encodedPublicFiles] = await Promise.all([
        encodeBlobEntries(files),
        encodeBlobEntries(publicEntries),
      ]);

      response = {
        ok: true,
        value: workerBuildValue(hosting, encodedFiles, metadata, encodedPublicFiles),
      };
    } else {
      const hosting = structuredClone(build.hosting);
      const files = [...build.files];

      if (hosting.version !== 1) throw new TypeError("A V1 build requires hosting version 1");

      const metadata = snapshotMetadata(build);
      const encodedFiles = await encodeBlobEntries(files);

      response = { ok: true, value: workerBuildValue(hosting, encodedFiles, metadata) };
    }
  } else if (request.kind === "editor") {
    const configuration = await readConfiguration(root);
    const sources = new Map(request.sources);
    const wire = await preparePluginEditorWire(sources, root, configuration);
    response = { ok: true, value: wire };
  } else throw new TypeError("Unknown project worker request");
} catch (error) {
  const value = error instanceof Error ? error : new Error(String(error));
  const details = value as Error & { diagnostics?: unknown; watch?: unknown };
  const diagnostics = details.diagnostics;
  const watch = value.name === "ProjectError" ? details.watch : undefined;

  response = {
    ok: false,
    error: {
      name: value.name,
      message: value.message,
      ...(Array.isArray(diagnostics) ? { diagnostics } : {}),
      ...(watch !== undefined ? { watch: structuredClone(watch) } : {}),
    },
  };
  status = 1;
}

await new Promise<void>((done, fail) => {
  process.stdout.once("error", fail);

  process.stdout.end(`${PREFIX}${JSON.stringify(response)}\n`, done);
});

process.exit(status);
