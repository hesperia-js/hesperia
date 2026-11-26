import { randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type CapturedBuild, type HostSelection } from "@hesperia/hosting";
import {
  createBrowserArtifacts,
  BROWSER_MODULE_PRELOADS_ASSET,
  encodeTargetedControlRecord,
  createHostForDeployment,
  readBrowserStaticRouting,
  readBrowserModulePreloads,
  resolveCapturedDeployment,
  readDevelopmentBuildRecord,
  readManagedBuildRecord,
  readRetainedManagedCapture,
  snapshotHostSelection,
  type ResolvedDeployment,
  snapshotTargetedControl,
  validateTargetedCapturedBuild,
} from "@hesperia/hosting/internal";

const controlPath = "/hesperia-build.json";
const captureIdPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u;

type RetainedManagedBuild = Awaited<ReturnType<typeof readRetainedManagedCapture>>;

interface ObservedPublication {
  readonly source: string;
  readonly assetDirectory: string;
  readonly deployment?: ResolvedDeployment;
  readonly managed?: RetainedManagedBuild;
}

/** The validated prior publication and exclusive ownership of its replacement. @internal */
export interface BuildPublication {
  /** Absolute, real completed-build directory. */
  readonly output: string;
  /** Validated managed inventories from previously published captures. */
  readonly history: readonly RetainedManagedBuild[];
  /** Prior validated asset directory, relative to the completed-build directory. */
  readonly previousDirectory?: string;
  /** Prior validated V4 deployment, inherited unless the caller replaces generated settings. */
  readonly deployment?: ResolvedDeployment;
  /** Capture IDs whose published assets cannot be removed by staging cleanup. */
  readonly retainedCaptureIds: ReadonlySet<string>;
  /**
   * Archive the observed production record, then replace its pointer with owned staging.
   * @param temporary - Absolute owned temporary record path in the completed-build directory.
   * @returns Completion after the pointer has been replaced.
   * @throws Through rejection for changed publication, archival or replacement failure.
   */
  replace(temporary: string): Promise<void>;
}

/**
 * Admit one cooperating build writer before it observes or changes completed output.
 *
 * @param root - Project whose real build directory receives the publication.
 * @param operation - Writer that validates staging and cleans its own failed attempt.
 * @returns The writer's result after its exclusive admission has been released.
 * @throws Through rejection for existing admission, invalid history, publication or release
 * failures. An existing admission is never guessed stale or removed automatically.
 * @internal
 */
export async function withBuildPublication<T>(
  root: string,
  operation: (publication: BuildPublication) => Promise<T>,
): Promise<T> {
  const output = resolve(root, ".hesperia", "build");

  await ensureRealDirectory(dirname(output));

  await ensureRealDirectory(output);

  const lockPath = join(output, ".publication.lock");
  const token = `${randomUUID()}\n`;
  let lock: FileHandle;

  try {
    lock = await open(lockPath, "wx");
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "EEXIST")
      throw new TypeError(
        "Build publication is already admitted or a previous writer left its admission file; resolve that writer before retrying",
        { cause },
      );

    throw cause;
  }

  const failures: unknown[] = [];
  let identity: BigIntStats | undefined;
  let result: T | undefined;

  try {
    identity = await lock.stat({ bigint: true });

    await lock.writeFile(token);

    const previous = await observePublishedRecord(output);
    const history = await readRetainedManagedHistory(output);
    const previousManaged = previous?.managed;

    if (previousManaged && !history.some((item) => item.captureId === previousManaged.captureId))
      history.push(previousManaged);

    const destination = join(output, "hesperia-build.json");
    let replaced = false;

    result = await operation({
      output,
      history,
      ...(previous ? { previousDirectory: previous.assetDirectory } : {}),
      ...(previous?.deployment ? { deployment: previous.deployment } : {}),
      retainedCaptureIds: new Set(history.map((item) => item.captureId)),
      async replace(temporary) {
        if (replaced)
          throw new TypeError("A publication admission can replace its record only once");

        if (
          dirname(temporary) !== output ||
          !/^\.hesperia-build\.[0-9a-f-]{36}\.tmp$/u.test(temporary.slice(output.length + 1))
        )
          throw new TypeError(
            "The replacement record must be owned staging in the completed-build directory",
          );

        await assertRecordDestination(temporary);

        if ((await readOptionalRecordSource(destination)) !== previous?.source)
          throw new TypeError("The published build changed outside its exclusive admission");

        if (previous?.managed)
          await archivePublishedRecord(output, previous.managed.captureId, previous.source);

        if ((await readOptionalRecordSource(destination)) !== previous?.source)
          throw new TypeError("The published build changed before replacement");

        await rename(temporary, destination);
        replaced = true;
      },
    });
  } catch (cause) {
    failures.push(cause);
  }

  try {
    const current = await lstat(lockPath, { bigint: true });

    if (
      !identity ||
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.dev !== identity.dev ||
      current.ino !== identity.ino ||
      (await readFile(lockPath, "utf8")) !== token
    )
      throw new TypeError("Publication admission ownership changed; its path was retained");

    await rm(lockPath);
  } catch (cause) {
    failures.push(cause);
  }

  try {
    await lock.close();
  } catch (cause) {
    failures.push(cause);
  }

  if (failures.length === 1) throw failures[0];

  if (failures.length > 1)
    throw new AggregateError(failures, "Build publication and admission release failed");

  return result!;
}

/**
 * Publish one targeted production build after capturing its control and byte inventories.
 *
 * Required fields, map entries and control data are captured before the first byte await.
 * The control Blob must be the canonical encoding of the typed control. Publication writes
 * an isolated capture and atomically replaces the completed record only after validation.
 * Failed attempts remove only their own staging; previous published captures are retained.
 *
 * @param root - Project whose `.hesperia/build` directory receives the completed capture.
 * @param build - Untrusted selected production prepared-build variant, including its control Blob.
 * @param selection - Optional actual Hosting deployment selection persisted in the V4 record and
 * used by any generated static startup artifacts.
 * @returns The absolute build directory after the completed record is replaced.
 * @throws {TypeError} Through rejection for malformed, untargeted, crossed or unchecked inputs.
 * Byte and filesystem failures retain their cause; cleanup failures aggregate with the original.
 * This artifact writer does not establish renderer, source-provenance or profile availability.
 */
export async function publishTargetedBuild(
  root: string,
  build: unknown,
  selection?: HostSelection,
): Promise<string> {
  const selected = snapshotHostSelection(selection);
  const fields = preparedFields(build);

  if (!fields.has("buildKind") || !fields.has("control"))
    throw new TypeError(
      "missing-production-target: Publication requires a targeted prepared build; rebuild with an explicit production target",
    );

  const buildKind = fields.get("buildKind");
  const control = snapshotTargetedControl(fields.get("control"));
  const expectedVersion =
    buildKind === "production-browser-v1"
      ? 1
      : buildKind === "production-browser-v2"
        ? 2
        : buildKind === "production-server-v3"
          ? 3
          : undefined;

  if (
    expectedVersion === undefined ||
    control.hosting.version !== expectedVersion ||
    control.kind !== (expectedVersion === 3 ? "server" : "browser")
  )
    throw new TypeError("Prepared build kind does not match its typed control");

  if (control.kind === "browser" && control.resolution.mode !== "production")
    throw new TypeError("Production publication requires production browser resolution");

  const hasPublic = fields.has("publicFiles");
  const hasServer = fields.has("serverFiles");

  if (hasPublic !== (expectedVersion !== 1) || hasServer !== (expectedVersion === 3))
    throw new TypeError("Prepared build maps do not match its targeted variant");

  if (!Array.isArray(fields.get("sources")))
    throw new TypeError("Prepared build sources must be an array");

  assertCheckedDiagnostics(fields.get("diagnostics"));

  const files = snapshotPreparedMap(fields.get("files"), "files");
  const record = files.get(controlPath);

  if (!record) throw new TypeError("Prepared build has no completed control Blob");

  const managed = new Map<string, Blob>();

  for (const [path, blob] of files) {
    if (path === controlPath) continue;

    if (!path.startsWith("/assets/"))
      throw new TypeError(`Prepared build contains an undeclared artifact: ${path}`);

    managed.set(path, blob);
  }

  const inventory = {
    hosting: fields.get("hosting"),
    files: managed,
    ...(hasPublic
      ? { publicFiles: snapshotPreparedMap(fields.get("publicFiles"), "publicFiles") }
      : {}),
    ...(hasServer
      ? { serverFiles: snapshotPreparedMap(fields.get("serverFiles"), "serverFiles") }
      : {}),
  };
  const source = encodeTargetedControlRecord(control);
  const expectedBytes = new TextEncoder().encode(source);
  const verification = validateTargetedCapturedBuild({ control, inventory });
  const controlVerification = (async () => {
    const bytes = new Uint8Array(await record.arrayBuffer());

    if (
      bytes.length !== expectedBytes.length ||
      bytes.some((byte, index) => byte !== expectedBytes[index])
    )
      throw new TypeError("Prepared control Blob does not match its typed canonical control");
  })();
  const [captured] = await Promise.all([verification, controlVerification]);
  const staticTarget =
    captured.control.productionTarget.descriptorIdentity === "hesperia.target/browser-static/1" &&
    !("serverFiles" in captured.inventory);

  return withBuildPublication(root, async (publication) => {
    const { output } = publication;
    const deployment = resolveCapturedDeployment(
      captured.inventory,
      selected,
      publication.deployment,
    );
    const staticFiles = staticTarget
      ? await browserStaticFiles(captured.inventory, deployment)
      : undefined;

    if (staticFiles)
      includeRetainedStaticFiles(staticFiles, captured.inventory.files, publication.history);

    const captures = join(output, ".captures");

    await ensureRealDirectory(captures);

    const destination = join(output, "hesperia-build.json");

    await assertRecordDestination(destination);

    const captureId = randomUUID();
    const capture = containedDestination(captures, captureId);
    const assetRoot = join(capture, "assets");
    const publicRoot = join(capture, "public");
    const serverRoot = join(capture, "server");
    const staticRoot = join(capture, "static");
    const temporary = containedDestination(output, `.hesperia-build.${randomUUID()}.tmp`);
    let captureCreated = false;
    let temporaryCreated = false;
    let temporaryHandle: FileHandle | undefined;

    try {
      await mkdir(capture);
      captureCreated = true;

      await ensureRealDirectory(assetRoot);

      for (const asset of captured.inventory.hosting.assets)
        await writeArtifact(
          assetRoot,
          asset.path.slice("/assets/".length),
          captured.inventory.files.get(asset.path)!,
        );

      if ("publicFiles" in captured.inventory) {
        await ensureRealDirectory(publicRoot);

        for (const file of captured.inventory.hosting.publicFiles)
          await writeArtifact(
            publicRoot,
            file.relativePath,
            captured.inventory.publicFiles.get(file.urlPath)!,
          );
      }

      if ("serverFiles" in captured.inventory) {
        await ensureRealDirectory(serverRoot);

        for (const artifact of captured.inventory.hosting.serverArtifacts)
          await writeArtifact(
            serverRoot,
            artifact.path,
            captured.inventory.serverFiles.get(artifact.path)!,
          );
      }

      if (staticFiles) {
        await ensureRealDirectory(staticRoot);

        for (const [path, blob] of staticFiles) await writeArtifact(staticRoot, path, blob);
      }

      const completed = {
        version: 4 as const,
        control: captured.control,
        deployment,
        assetDirectory: `.captures/${captureId}/assets`,
        ...(expectedVersion !== 1 ? { publicDirectory: `.captures/${captureId}/public` } : {}),
        ...(expectedVersion === 3 ? { serverDirectory: `.captures/${captureId}/server` } : {}),
      };
      const completedBytes = new TextEncoder().encode(JSON.stringify(completed, null, 2) + "\n");
      temporaryHandle = await open(temporary, "wx");
      temporaryCreated = true;

      await temporaryHandle.writeFile(completedBytes);

      await temporaryHandle.close();
      temporaryHandle = undefined;

      await publication.replace(temporary);
      temporaryCreated = false;
    } catch (cause) {
      const failures = [cause];

      if (temporaryHandle) {
        try {
          await temporaryHandle.close();
        } catch (cleanup) {
          failures.push(cleanup);
        }
      }

      if (temporaryCreated) {
        try {
          await rm(temporary, { force: true });
        } catch (cleanup) {
          failures.push(cleanup);
        }
      }

      if (captureCreated) {
        try {
          await rm(capture, { recursive: true, force: true });
        } catch (cleanup) {
          failures.push(cleanup);
        }
      }

      if (failures.length > 1)
        throw new AggregateError(failures, "Targeted publication and owned staging cleanup failed");

      throw cause;
    }

    return output;
  });
}

/**
 * Read retained managed inventories only from real, canonical publication receipts.
 * @param buildDirectory - Completed build root with same-capture receipt files.
 * @returns Validated managed-only captures; an unreceipted staging directory is ignored.
 * @throws TypeError through rejection for linked, malformed or corrupt retained records/bytes.
 * This reader does not consult application sources or retire captures.
 * @internal
 */
export async function readRetainedManagedHistory(
  buildDirectory: string,
): Promise<RetainedManagedBuild[]> {
  const output = resolve(buildDirectory);

  if (!(await existingRealDirectory(dirname(output))) || !(await existingRealDirectory(output)))
    return [];

  const captures = join(output, ".captures");

  if (!(await existingRealDirectory(captures))) return [];

  const directories = await readdir(captures, { withFileTypes: true });
  const history: RetainedManagedBuild[] = [];

  for (const directory of directories.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  )) {
    if (!captureIdPattern.test(directory.name)) continue;

    if (!directory.isDirectory() || directory.isSymbolicLink())
      throw new TypeError("A retained capture must be a real directory");

    const receipt = join(captures, directory.name, "hesperia-build.json");

    if ((await readOptionalRecordSource(receipt)) === undefined) continue;

    history.push(await readRetainedManagedCapture(output, directory.name));
  }

  return history;
}

async function observePublishedRecord(output: string): Promise<ObservedPublication | undefined> {
  if (!(await existingRealDirectory(dirname(output))) || !(await existingRealDirectory(output)))
    return undefined;

  const recordPath = join(output, "hesperia-build.json");

  for (let attempt = 0; attempt < 3; attempt++) {
    const source = await readOptionalRecordSource(recordPath);

    if (source === undefined) return undefined;

    const record: unknown = JSON.parse(source);

    if (record === null || typeof record !== "object" || Array.isArray(record))
      throw new TypeError("The previous completed build record must be an object");

    const recordVersion = Reflect.getOwnPropertyDescriptor(record, "version")?.value;
    const targeted = recordVersion === 3 || recordVersion === 4;
    const hosting = Reflect.getOwnPropertyDescriptor(record, "hosting")?.value;
    const development =
      hosting !== null &&
      typeof hosting === "object" &&
      Reflect.getOwnPropertyDescriptor(hosting, "mode")?.value === "development";
    let managed: RetainedManagedBuild | undefined;
    let deployment: ResolvedDeployment | undefined;
    let assetDirectory: string;

    if (targeted) {
      managed = await readManagedBuildRecord(output, source);
      assetDirectory = `.captures/${managed.captureId}/assets`;

      deployment = managed.deployment;
    } else if (development) {
      await readDevelopmentBuildRecord(output, source);

      const directory =
        Reflect.getOwnPropertyDescriptor(record, "assetDirectory")?.value ?? "assets";

      if (typeof directory !== "string")
        throw new TypeError("The previous development asset directory must be a string");

      assetDirectory = directory;
    } else {
      if (recordVersion !== undefined && recordVersion !== 1)
        throw new TypeError("Browser publication cannot replace this legacy server record");

      const directory =
        Reflect.getOwnPropertyDescriptor(record, "assetDirectory")?.value ?? "assets";

      if (
        typeof directory !== "string" ||
        !/^(?:assets|\.captures\/[0-9a-f-]{36}\/assets)$/u.test(directory)
      )
        throw new TypeError("The previous legacy asset directory is invalid");

      assetDirectory = directory;
    }

    if ((await readOptionalRecordSource(recordPath)) === source)
      return {
        source,
        assetDirectory,
        ...(deployment ? { deployment } : {}),
        ...(managed ? { managed } : {}),
      };
  }

  throw new TypeError("The published build changed while capturing its managed history");
}

async function archivePublishedRecord(
  output: string,
  captureId: string,
  source: string,
): Promise<void> {
  const directory = containedDestination(join(output, ".captures"), captureId);

  if (!(await existingRealDirectory(directory)))
    throw new TypeError("The previously published capture is missing before archival");

  const destination = join(directory, "hesperia-build.json");
  const archived = await readOptionalRecordSource(destination);

  if (archived !== undefined) {
    if (archived !== source)
      throw new TypeError("The retained publication receipt disagrees with its original record");

    return;
  }

  const temporary = containedDestination(directory, `.hesperia-build.${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  let created = false;

  try {
    handle = await open(temporary, "wx");
    created = true;

    await handle.writeFile(source);

    await handle.close();
    handle = undefined;

    await rename(temporary, destination);
    created = false;
  } catch (cause) {
    const failures = [cause];

    if (handle) {
      try {
        await handle.close();
      } catch (cleanup) {
        failures.push(cleanup);
      }
    }

    if (created) {
      try {
        await rm(temporary, { force: true });
      } catch (cleanup) {
        failures.push(cleanup);
      }
    }

    if (failures.length > 1)
      throw new AggregateError(failures, "Publication receipt archival and owned cleanup failed");

    throw cause;
  }
}

async function readOptionalRecordSource(path: string): Promise<string | undefined> {
  try {
    const stats = await lstat(path);

    if (!stats.isFile() || stats.isSymbolicLink())
      throw new TypeError("The published or retained build record must be a regular file");

    return await readFile(path, "utf8");
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;

    throw cause;
  }
}

async function existingRealDirectory(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path);

    if (!stats.isDirectory() || stats.isSymbolicLink())
      throw new TypeError(`Captured output must be a real directory: ${path}`);

    return true;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return false;

    throw cause;
  }
}

function includeRetainedStaticFiles(
  files: Map<string, Blob>,
  current: ReadonlyMap<string, Blob>,
  history: readonly RetainedManagedBuild[],
): void {
  const retained = new Map<string, { readonly sha256: string; readonly contentType: string }>();

  for (const build of history) {
    for (const asset of build.inventory.hosting.assets) {
      if (asset.path === BROWSER_MODULE_PRELOADS_ASSET || current.has(asset.path)) continue;

      const previous = retained.get(asset.path);

      if (
        previous &&
        (previous.sha256 !== asset.sha256 || previous.contentType !== asset.contentType)
      )
        throw new TypeError(
          `Retained generated URL has conflicting bytes or media type: ${asset.path}`,
        );

      retained.set(asset.path, asset);
      files.set(staticManagedPath(asset.path), build.inventory.files.get(asset.path)!);
    }
  }

  assertStaticDestinations(files);
}

function staticManagedPath(path: string): string {
  return `_hesperia/assets/${path.slice("/assets/".length).split("/").map(decodeURIComponent).join("/")}`;
}

async function browserStaticFiles(
  inventory: CapturedBuild,
  deployment: ResolvedDeployment,
): Promise<Map<string, Blob>> {
  const routing = await readBrowserStaticRouting(inventory);
  const host = await createHostForDeployment(inventory, deployment, routing);

  if (
    host.mount.pathname !== deployment.mountPathname ||
    host.generatedAssets !== deployment.generatedAssets
  )
    throw new TypeError(
      "Static artifacts and the persisted deployment must use one resolved binding",
    );

  const artifacts = createBrowserArtifacts(
    host.mount.pathname,
    inventory.hosting.startupAsset,
    host.generatedAssets,
    await readBrowserModulePreloads(
      inventory.files.get(BROWSER_MODULE_PRELOADS_ASSET),
      inventory.hosting.startupAsset,
      inventory.files,
    ),
  );
  const files = new Map<string, Blob>([
    ["index.html", artifacts.document],
    ["_hesperia/startup.js", artifacts.startupWrapper],
  ]);

  for (const asset of inventory.hosting.assets) {
    files.set(staticManagedPath(asset.path), inventory.files.get(asset.path)!);
  }

  if ("publicFiles" in inventory) {
    for (const file of inventory.hosting.publicFiles) {
      if (files.has(file.relativePath))
        throw new TypeError(`Static export has a file destination collision: ${file.relativePath}`);

      files.set(file.relativePath, inventory.publicFiles.get(file.urlPath)!);
    }
  }

  assertStaticDestinations(files);

  return files;
}

function assertStaticDestinations(files: ReadonlyMap<string, Blob>): void {
  for (const path of files.keys()) {
    const segments = path.split("/");

    for (let end = 1; end < segments.length; end++) {
      const ancestor = segments.slice(0, end).join("/");

      if (files.has(ancestor))
        throw new TypeError(
          `Static export has a file/directory destination collision: ${ancestor}`,
        );
    }
  }
}

function preparedFields(value: unknown): ReadonlyMap<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Prepared build must be an object with own data fields");

  const allowed = new Set([
    "buildKind",
    "control",
    "hosting",
    "files",
    "publicFiles",
    "serverFiles",
    "sources",
    "diagnostics",
    "styles",
    "watch",
    "styleRevision",
    "developmentDependencies",
  ]);
  const fields = new Map<string, unknown>();

  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key))
      throw new TypeError(`Prepared build has an unknown field: ${String(key)}`);

    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);

    if (!descriptor || !("value" in descriptor))
      throw new TypeError(`Prepared build ${key} must be an own data field`);

    fields.set(key, descriptor.value);
  }

  return fields;
}

function snapshotPreparedMap(value: unknown, label: string): ReadonlyMap<string, Blob> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof (value as ReadonlyMap<unknown, unknown>).entries !== "function" ||
    typeof (value as ReadonlyMap<unknown, unknown>).get !== "function"
  )
    throw new TypeError(`Prepared ${label} must be a ReadonlyMap`);

  const result = new Map<string, Blob>();

  for (const entry of (value as ReadonlyMap<unknown, unknown>).entries()) {
    const [path, blob] = entry;

    if (typeof path !== "string" || !(blob instanceof Blob))
      throw new TypeError(`Prepared ${label} must map string paths to Blobs`);

    if (result.has(path)) throw new TypeError(`Prepared ${label} repeats artifact ${path}`);

    result.set(path, blob);
  }

  return result;
}

function assertCheckedDiagnostics(value: unknown): void {
  if (!Array.isArray(value)) throw new TypeError("Prepared build diagnostics must be an array");

  for (const diagnostic of value) {
    if (diagnostic === null || typeof diagnostic !== "object")
      throw new TypeError("Prepared build has an invalid checking diagnostic");

    const severity = Reflect.getOwnPropertyDescriptor(diagnostic, "severity");

    if (
      !severity ||
      !("value" in severity) ||
      (severity.value !== "error" && severity.value !== "warning" && severity.value !== "info")
    )
      throw new TypeError("Checking diagnostic severity must be an own valid data field");

    if (severity.value === "error")
      throw new TypeError("Cannot publish a build with checking errors");
  }
}

function containedDestination(root: string, path: string): string {
  const destination = resolve(root, ...path.split("/"));
  const fromRoot = relative(root, destination);

  if (!fromRoot || isAbsolute(fromRoot) || fromRoot === ".." || fromRoot.startsWith(`..${sep}`))
    throw new TypeError("Captured artifact destination must remain within its owned directory");

  return destination;
}

async function ensureRealDirectory(path: string): Promise<void> {
  try {
    await mkdir(path);
  } catch (cause) {
    if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "EEXIST") throw cause;
  }

  const stats = await lstat(path);

  if (!stats.isDirectory() || stats.isSymbolicLink())
    throw new TypeError(`Captured output must be a real directory: ${path}`);
}

async function assertRecordDestination(path: string): Promise<void> {
  try {
    const stats = await lstat(path);

    if (!stats.isFile() || stats.isSymbolicLink())
      throw new TypeError("The published build record must be a regular file");
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return;

    throw cause;
  }
}

async function writeArtifact(root: string, path: string, blob: Blob): Promise<void> {
  const destination = containedDestination(root, path);
  const directories = relative(root, dirname(destination)).split(sep).filter(Boolean);
  let parent = root;

  for (const directory of directories) {
    parent = join(parent, directory);

    await ensureRealDirectory(parent);
  }

  await writeFile(destination, new Uint8Array(await blob.arrayBuffer()), { flag: "wx" });

  const stats = await lstat(destination);

  if (!stats.isFile() || stats.isSymbolicLink() || stats.size !== blob.size)
    throw new TypeError(`Captured output must be the complete regular file: ${destination}`);
}
