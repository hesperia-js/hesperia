import {
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
  statSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import {
  createHost,
  readBuild,
  type ApplicationHost,
  type HostingAssetRecord,
  type HostingPublicFileRecord,
  type HostingRecordV1,
  type HostingRecordV2,
  type HostSelection,
} from "@hesperia/hosting";
import { prepareBuild, ProjectError, type BrowserBuild } from "./project.ts";
import { isMissingFile } from "./utils.ts";

/** A local server handle owns its file watchers and connected development clients. */
export interface ProjectServer {
  /** Loopback origin and selected port; valid while the server remains open. */
  readonly url: URL;

  /** Stop listening, close reload streams, and release every filesystem watcher. */
  close(): Promise<void>;
}

/** Start a loopback preview of the most recent successful build. Port zero selects a free port. */
export async function previewProject(
  root: string,
  port = 4173,
  selection?: HostSelection,
): Promise<ProjectServer> {
  const build = await readBuild(resolve(root, ".hesperia/build"));
  const host = await createHost(build, selection);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: (request) => host.handle(request) ?? new Response(null, { status: 404 }),
  });
  return {
    url: server.url,

    async close() {
      await server.stop(true);
    },
  };
}

/** Development reports compilation failures without replacing the last successful application. */
export interface DevelopmentOptions {
  /** Loopback port; defaults to 5173, while 0 asks the operating system for a free port. */
  readonly port?: number;
  /** Receives compile failures and forwarded browser development warnings. */
  readonly report?: (message: string) => void;
}

interface DevelopmentCaptureMetadata {
  readonly files: ReadonlyMap<string, Blob>;
  readonly sourceFiles: readonly string[];
  readonly dependencies?: BrowserBuild["developmentDependencies"];
}

type DevelopmentCapture = DevelopmentCaptureMetadata &
  (
    | { readonly hosting: HostingRecordV1 }
    | {
        readonly hosting: HostingRecordV2;
        readonly publicFiles: ReadonlyMap<string, Blob>;
      }
  );

type PublishedDevelopmentRevision = DevelopmentCapture & {
  readonly host: ApplicationHost;
  readonly fingerprint: string;
};

type DevelopmentWatchEntry = NonNullable<BrowserBuild["watch"]>[number];

interface WatchTarget {
  readonly kind: "file" | "directory";
  readonly path: string;
  readonly identityPath?: string;
}

interface BigIntWatchStats {
  readonly dev: bigint;
  readonly ino: bigint;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

interface WatcherRegistration {
  readonly watcher: FSWatcher;
  readonly recursive: boolean;
  readonly device: bigint;
  readonly inode: bigint;
  readonly parentDevice: bigint;
  readonly parentInode: bigint;
  readonly identityAvailable: boolean;
  targets: readonly WatchTarget[];
}

interface WatchInstallResult {
  readonly installed: boolean;
  readonly coverageExpanded: boolean;
  readonly closeFailures: readonly unknown[];
  readonly retired: readonly WatcherRegistration[];
}

/** Build before listening, rebuild serially, and notify connected browsers only when served bytes change. Reload streams remain connected across rebuilds. The optional preparation function is a test seam for revision races. */
export async function devProject(
  root: string,
  options: DevelopmentOptions = {},
  prepareRevision?: (root: string, signal?: AbortSignal) => Promise<BrowserBuild>,
): Promise<ProjectServer> {
  root = resolve(root);
  const report = options.report ?? console.warn;

  const prepare = async (signal?: AbortSignal): Promise<BrowserBuild> =>
    prepareRevision
      ? prepareRevision(root, signal)
      : existsSync(join(root, "hesperia.config.ts"))
        ? (await import("./project-worker-client.ts")).buildInProjectProcess(root, true, signal)
        : prepareBuild(root, true);

  let build: BrowserBuild = await prepare();
  const initialCapture = developmentCapture(build);
  const initialHost = await createHost(developmentHostInput(initialCapture));
  let published = publishDevelopmentCapture(
    initialCapture,
    initialHost,
    developmentFingerprint(build, initialCapture.hosting),
  );
  let closed = false;
  let pending = false;
  let building: Promise<void> | undefined;
  let buildAbort: AbortController | undefined;
  const dependencyWatchers = new Map<string, WatcherRegistration>();
  const missingDirectories = new Set<string>();
  let failedWatchDependencies: readonly DevelopmentWatchEntry[] = [];
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();
  const developmentRoots = new Map<string, Blob>();

  function canonicalDirectoryPath(path: string): string {
    let current = resolve(path);
    const suffix: string[] = [];

    for (;;) {
      try {
        const canonical = realpathSync(current);

        if (lstatSync(canonical, { bigint: true }).isDirectory())
          return resolve(canonical, ...suffix);
      } catch (error) {
        if (!isMissingWatchPath(error)) throw error;
      }

      const parent = dirname(current);

      if (parent === current) return resolve(current, ...suffix);

      let segment = basename(current);

      try {
        lstatSync(current, { bigint: true });
        segment = basename(canonicalWatchPath(current, "file"));
      } catch (error) {
        if (!isMissingWatchPath(error)) throw error;
      }

      suffix.unshift(segment);
      current = parent;
    }
  }

  function nativeEntryName(directory: string, name: string): string {
    let entries: string[];

    try {
      entries = readdirSync(directory);
    } catch (error) {
      if (isMissingWatchPath(error)) return name;

      throw error;
    }
    const exact = entries.find((entry) => entry === name);

    if (exact !== undefined) return exact;

    let requested: Pick<BigIntWatchStats, "dev" | "ino">;

    try {
      requested = lstatSync(join(directory, name), { bigint: true });
    } catch (error) {
      if (isMissingWatchPath(error)) return name;

      throw error;
    }

    const parent = lstatSync(directory, { bigint: true });

    if (sameFileIdentity(requested, parent)) return name;

    const matches: string[] = [];

    for (const entry of entries) {
      try {
        const candidate = lstatSync(join(directory, entry), { bigint: true });

        if (sameFileIdentity(candidate, requested) && !sameFileIdentity(candidate, parent))
          matches.push(entry);
      } catch (error) {
        if (!isMissingWatchPath(error)) throw error;
      }
    }

    return matches.length === 1 ? matches[0]! : name;
  }

  function canonicalWatchPath(path: string, kind: WatchTarget["kind"]): string {
    const absolute = resolve(path);

    if (kind === "file") {
      const directory = canonicalDirectoryPath(dirname(absolute));

      return resolve(directory, nativeEntryName(directory, basename(absolute)));
    }

    try {
      const canonical = realpathSync(absolute);

      if (lstatSync(canonical, { bigint: true }).isDirectory()) return canonical;

      return canonicalWatchPath(absolute, "file");
    } catch (error) {
      if (!isMissingWatchPath(error)) throw error;

      try {
        if (lstatSync(absolute, { bigint: true }).isSymbolicLink())
          return canonicalWatchPath(absolute, "file");
      } catch (entryError) {
        if (!isMissingWatchPath(entryError)) throw entryError;
      }

      return canonicalDirectoryPath(absolute);
    }
  }

  function pathParts(path: string): {
    readonly root: string;
    readonly segments: readonly string[];
  } {
    const absolute = resolve(path);
    const parsed = parse(absolute);

    return {
      root: parsed.root,
      segments: absolute.slice(parsed.root.length).split(sep).filter(Boolean),
    };
  }

  function isWithin(parent: string, child: string): boolean {
    const parentParts = pathParts(parent);
    const childParts = pathParts(child);

    return (
      parentParts.root === childParts.root &&
      parentParts.segments.length <= childParts.segments.length &&
      parentParts.segments.every((segment, index) => segment === childParts.segments[index])
    );
  }

  function sameFileIdentity(
    left: { readonly dev: bigint; readonly ino: bigint },
    right: { readonly dev: bigint; readonly ino: bigint },
  ): boolean {
    return left.dev === right.dev && left.ino === right.ino;
  }

  const canonicalProjectRoot = canonicalDirectoryPath(root);
  const canonicalProjectRootStats = statSync(canonicalProjectRoot, { bigint: true });
  const canonicalProjectRootParentStats = statSync(dirname(canonicalProjectRoot), { bigint: true });

  function projectRelativeSegments(path: string): readonly string[] | undefined {
    const absolute = resolve(path);
    const targetParts = pathParts(absolute);

    for (const boundary of [root, canonicalProjectRoot]) {
      const boundaryParts = pathParts(boundary);
      const exactPrefix =
        boundaryParts.root === targetParts.root &&
        boundaryParts.segments.length <= targetParts.segments.length &&
        boundaryParts.segments.every((segment, index) => segment === targetParts.segments[index]);

      if (exactPrefix) return targetParts.segments.slice(boundaryParts.segments.length);

      const relativePath = relative(boundary, absolute);

      if (
        !relativePath ||
        isAbsolute(relativePath) ||
        relativePath === ".." ||
        relativePath.startsWith(`..${sep}`)
      )
        continue;

      const segments = relativePath.split(sep).filter(Boolean);
      const targetPrefix = resolve(
        targetParts.root,
        ...targetParts.segments.slice(0, boundaryParts.segments.length),
      );

      try {
        const prefixStats = statSync(targetPrefix, { bigint: true });
        const prefixParentStats = statSync(dirname(targetPrefix), { bigint: true });

        if (
          !sameFileIdentity(prefixStats, prefixParentStats) &&
          !sameFileIdentity(canonicalProjectRootStats, canonicalProjectRootParentStats) &&
          sameFileIdentity(prefixStats, canonicalProjectRootStats) &&
          sameFileIdentity(prefixParentStats, canonicalProjectRootParentStats)
        )
          return segments;
      } catch {
        continue;
      }
    }

    return undefined;
  }

  function scopedWatchTargets(target: WatchTarget): readonly WatchTarget[] {
    const segments = projectRelativeSegments(target.path);

    if (segments === undefined) return [target];
    if (segments.length === 0)
      return [{ ...target, path: canonicalProjectRoot, identityPath: canonicalProjectRoot }];

    const entries: WatchTarget[] = [];
    let current = canonicalProjectRoot;
    let currentStats: BigIntWatchStats = lstatSync(current, { bigint: true });

    for (let index = 0; index < segments.length; index++) {
      const entryPath = resolve(current, segments[index]!);
      let entryStats: BigIntWatchStats;

      try {
        entryStats = lstatSync(entryPath, { bigint: true });
      } catch (error) {
        if (isMissingWatchPath(error))
          return uniqueWatchTargets([
            ...entries,
            {
              kind: target.kind,
              path: resolve(current, ...segments.slice(index)),
              identityPath: resolve(current, ...segments.slice(index)),
            },
          ]);

        return uniqueWatchTargets([
          ...entries,
          {
            kind: "file",
            path: canonicalWatchPath(entryPath, "file"),
            identityPath: canonicalWatchPath(entryPath, "file"),
          },
        ]);
      }

      const entryIdentityPath = canonicalWatchPath(entryPath, "file");
      const entryTarget: WatchTarget = {
        kind: "file",
        path: entryIdentityPath,
        identityPath: entryIdentityPath,
      };

      if (sameFileIdentity(entryStats, currentStats))
        return uniqueWatchTargets([...entries, entryTarget]);

      if (entryStats.isSymbolicLink()) entries.push(entryTarget);

      if (index < segments.length - 1 && !entryStats.isSymbolicLink() && !entryStats.isDirectory())
        return uniqueWatchTargets([...entries, entryTarget]);

      let resolvedEntry: string;

      try {
        resolvedEntry = realpathSync(entryPath);
      } catch {
        return uniqueWatchTargets([
          ...entries,
          { kind: "file", path: entryIdentityPath, identityPath: entryIdentityPath },
        ]);
      }

      if (!isWithin(canonicalProjectRoot, resolvedEntry))
        return uniqueWatchTargets([...entries, entryTarget]);

      let stableEntry: BigIntWatchStats;
      let stableParent: BigIntWatchStats;
      let resolvedStats: BigIntWatchStats;

      try {
        stableEntry = lstatSync(entryPath, { bigint: true });
        stableParent = lstatSync(current, { bigint: true });
        resolvedStats = lstatSync(resolvedEntry, { bigint: true });

        if (
          realpathSync(entryPath) !== resolvedEntry ||
          !sameFileIdentity(entryStats, stableEntry) ||
          !sameFileIdentity(currentStats, stableParent) ||
          (!entryStats.isSymbolicLink() &&
            (!sameFileIdentity(entryStats, resolvedStats) ||
              !sameFileIdentity(currentStats, lstatSync(dirname(resolvedEntry), { bigint: true }))))
        )
          return uniqueWatchTargets([...entries, entryTarget]);
      } catch {
        return uniqueWatchTargets([...entries, entryTarget]);
      }

      if (
        index === segments.length - 1 &&
        target.kind === "directory" &&
        !resolvedStats.isDirectory()
      )
        return uniqueWatchTargets([...entries, entryTarget]);

      if (index < segments.length - 1 && !resolvedStats.isDirectory())
        return uniqueWatchTargets([...entries, entryTarget]);

      current = resolvedEntry;
      currentStats = resolvedStats;

      if (index === segments.length - 1)
        return uniqueWatchTargets([
          ...entries,
          {
            kind: target.kind,
            path: target.kind === "file" ? entryIdentityPath : resolvedEntry,
            identityPath: target.kind === "file" ? entryIdentityPath : resolvedEntry,
          },
        ]);
    }

    return uniqueWatchTargets([...entries, target]);
  }

  function uniqueWatchTargets(targets: readonly WatchTarget[]): readonly WatchTarget[] {
    const unique: WatchTarget[] = [];

    for (const target of targets) {
      const path = resolve(target.path);
      const identityPath =
        target.identityPath !== undefined ? resolve(target.identityPath) : undefined;
      const existing = unique.find(
        (current) => current.kind === target.kind && resolve(current.path) === path,
      );

      if (existing) continue;

      unique.push({
        ...target,
        path,
        ...(identityPath !== undefined ? { identityPath } : {}),
      });
    }

    return unique;
  }

  function targetMatches(target: WatchTarget, changed: string): boolean {
    const targetPaths = new Set([
      ...(target.identityPath !== undefined ? [target.identityPath] : []),
      canonicalWatchPath(target.path, target.kind),
    ]);

    if (target.kind === "file")
      return [...targetPaths].some(
        (targetPath) => changed === targetPath || isWithin(changed, targetPath),
      );

    return [...targetPaths].some(
      (targetPath) => isWithin(targetPath, changed) || isWithin(changed, targetPath),
    );
  }

  function isMissingWatchPath(error: unknown): boolean {
    return (
      isMissingFile(error) ||
      (typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error.code === "ENOTDIR" || error.code === "ENOENT"))
    );
  }

  function closeDependencyWatchers(failures: unknown[]): void {
    const registrations = [...dependencyWatchers.values()];

    dependencyWatchers.clear();

    for (const registration of registrations) closeWatcher(registration.watcher, failures);
  }

  function closeWatcher(watcher: FSWatcher, failures: unknown[]): void {
    try {
      watcher.close();
    } catch (error) {
      failures.push(error);
    }
  }

  function reportWatchError(error: unknown): void {
    try {
      report(String(error));
    } catch {
      // A reporting callback must not change which watch set is active.
    }
  }

  function reportWatchCloseFailures(failures: readonly unknown[]): void {
    for (const failure of failures) reportWatchError(failure);
  }

  function closeRetiredWatchers(registrations: readonly WatcherRegistration[]): readonly unknown[] {
    const failures: unknown[] = [];

    for (const registration of registrations) closeWatcher(registration.watcher, failures);

    return failures;
  }

  function commitAndRetire(
    registrations: readonly WatcherRegistration[],
    commit: () => void,
  ): readonly unknown[] {
    try {
      commit();
    } catch (error) {
      const failures = closeRetiredWatchers(registrations);

      if (failures.length) {
        reportWatchError(error);
        reportWatchCloseFailures(failures);

        throw new AggregateError(
          [error, ...failures],
          "Development watch publication and retirement failed",
          { cause: error },
        );
      }

      throw error;
    }

    return closeRetiredWatchers(registrations);
  }

  function rememberDevelopmentRoot(host: ApplicationHost): void {
    const root = host.mount.assetPath;

    developmentRoots.set(
      root,
      new Blob([developmentClientSource(root)], { type: "text/javascript; charset=utf-8" }),
    );
  }

  rememberDevelopmentRoot(published.host);

  function publish(message: unknown): void {
    for (const client of clients) {
      try {
        client.enqueue(encoder.encode(`data: ${JSON.stringify(message)}\n\n`));
      } catch {
        clients.delete(client);
      }
    }
  }

  function watchDependencies(
    candidate: Pick<BrowserBuild, "sources" | "watch">,
    failed: readonly DevelopmentWatchEntry[],
    isCurrent: () => boolean = () => !closed,
  ): WatchInstallResult {
    if (!isCurrent())
      return { installed: false, coverageExpanded: false, closeFailures: [], retired: [] };

    const sourceRoot = join(root, "src");
    const publicRoot = join(root, "public");
    const directories = new Map<
      string,
      {
        recursive: boolean;
        device: bigint;
        inode: bigint;
        parentDevice: bigint;
        parentInode: bigint;
        identityAvailable: boolean;
        targets: WatchTarget[];
      }
    >();
    const nextMissing = new Set<string>();
    const newlyMissing = new Set<string>();

    for (const target of scopedWatchTargets({ kind: "directory", path: publicRoot }))
      addWatchTarget(target, target.kind === "directory", false);

    const sourceTargets = scopedWatchTargets({ kind: "directory", path: sourceRoot });

    for (const target of sourceTargets) addWatchTarget(target, target.kind === "directory", false);

    const sourceRootContent = sourceTargets.find((target) => target.kind === "directory");
    const sourceRootIdentity = sourceRootContent?.identityPath;
    const sourceRootCovered =
      sourceRootIdentity !== undefined && directories.get(sourceRootIdentity)?.recursive === true;

    for (const directory of candidate.sources.map(dirname)) {
      const targets = scopedWatchTargets({ kind: "directory", path: directory });
      const coveredBySourceWatcher =
        sourceRootCovered &&
        sourceRootIdentity !== undefined &&
        targets.every((target) =>
          isWithin(
            sourceRootIdentity,
            target.identityPath ?? canonicalWatchPath(target.path, target.kind),
          ),
        );

      if (coveredBySourceWatcher) continue;

      for (const target of targets) {
        if (target.kind === "directory" && target.identityPath === canonicalProjectRoot) continue;

        addWatchTarget(target, false);
      }
    }

    for (const item of [...(candidate.watch ?? []), ...failed]) {
      const target: WatchTarget =
        item.kind === "file"
          ? { kind: "file", path: item.file }
          : { kind: "directory", path: item.dir };

      for (const scopedTarget of scopedWatchTargets(target))
        addWatchTarget(scopedTarget, scopedTarget.kind === "directory");
    }

    function addWatchTarget(target: WatchTarget, recursive: boolean, reportMissing = true): void {
      const scopedTargets = scopedWatchTargets(target);
      const currentTarget = scopedTargets.find(
        (scoped) => scoped.kind === target.kind && resolve(scoped.path) === resolve(target.path),
      );

      if (!currentTarget) {
        for (const scoped of scopedTargets)
          addScopedWatchTarget(scoped, scoped.kind === "directory", reportMissing);

        return;
      }

      addScopedWatchTarget(currentTarget, recursive, reportMissing);
    }

    function addScopedWatchTarget(
      target: WatchTarget,
      recursive: boolean,
      reportMissing: boolean,
    ): void {
      if (target.kind === "file") {
        const identityPath = target.identityPath ?? canonicalWatchPath(target.path, "file");

        addDirectory(
          dirname(identityPath),
          false,
          { ...target, path: identityPath, identityPath },
          reportMissing,
        );
        return;
      }

      const identityPath = target.identityPath ?? canonicalWatchPath(target.path, "directory");

      if (identityPath !== canonicalProjectRoot) {
        const entryPath = target.path;
        const entryIdentityPath = canonicalWatchPath(entryPath, "file");

        addDirectory(
          dirname(entryIdentityPath),
          false,
          { kind: "file", path: entryIdentityPath, identityPath: entryIdentityPath },
          reportMissing,
        );
      }

      addDirectory(
        identityPath,
        recursive && identityPath !== canonicalProjectRoot,
        { ...target, path: identityPath, identityPath },
        reportMissing,
      );
    }

    function addDirectory(
      directory: string,
      recursive: boolean,
      target: WatchTarget,
      reportMissing = true,
    ): void {
      const safeTarget = scopedWatchTargets(target).some(
        (scoped) => scoped.kind === target.kind && resolve(scoped.path) === resolve(target.path),
      );

      if (!safeTarget) return;

      let ancestor = resolve(directory);
      const requestedDirectory = resolve(directory);

      for (;;) {
        let canonical: string | undefined;

        try {
          const resolvedAncestor = realpathSync(ancestor);

          const stats = lstatSync(resolvedAncestor, { bigint: true });

          if (stats.isDirectory()) {
            canonical = resolvedAncestor;
            const parentStats = lstatSync(dirname(canonical), { bigint: true });
            const targets = directories.get(canonical)?.targets ?? [];
            const targetPath = resolve(target.path);
            const targetIdentity =
              target.identityPath ?? canonicalWatchPath(targetPath, target.kind);

            const existingTarget = targets.find(
              (current) => current.kind === target.kind && resolve(current.path) === targetPath,
            );

            if (existingTarget) {
              const index = targets.indexOf(existingTarget);

              targets[index] = { ...target, path: targetPath, identityPath: targetIdentity };
            } else targets.push({ ...target, path: targetPath, identityPath: targetIdentity });

            directories.set(canonical, {
              recursive:
                (ancestor === requestedDirectory && recursive) ||
                directories.get(canonical)?.recursive === true,
              device: stats.dev,
              inode: stats.ino,
              parentDevice: parentStats.dev,
              parentInode: parentStats.ino,
              identityAvailable: !sameFileIdentity(stats, parentStats),
              targets,
            });
          }
        } catch (error) {
          if (!isMissingWatchPath(error)) throw error;
        }

        if (canonical !== undefined) {
          if (ancestor === requestedDirectory) nextMissing.delete(requestedDirectory);
          else {
            nextMissing.add(requestedDirectory);

            if (reportMissing && !missingDirectories.has(requestedDirectory))
              newlyMissing.add(requestedDirectory);
          }

          return;
        }

        const parent = dirname(ancestor);

        if (parent === ancestor)
          throw new Error(`Unable to find a directory to watch for ${directory}`);

        ancestor = parent;
      }
    }

    function sameWatchIdentity(
      existing: WatcherRegistration,
      requested: {
        device: bigint;
        inode: bigint;
        parentDevice: bigint;
        parentInode: bigint;
        identityAvailable: boolean;
      },
    ): boolean {
      return (
        existing.identityAvailable === requested.identityAvailable &&
        existing.device === requested.device &&
        existing.inode === requested.inode &&
        existing.parentDevice === requested.parentDevice &&
        existing.parentInode === requested.parentInode
      );
    }

    function targetIsDirectory(target: WatchTarget): boolean {
      if (target.kind !== "directory") return false;

      try {
        return statSync(target.identityPath ?? target.path, { bigint: true }).isDirectory();
      } catch (error) {
        if (isMissingWatchPath(error)) return false;

        throw error;
      }
    }

    function targetEntryExists(target: WatchTarget): boolean {
      try {
        lstatSync(target.identityPath ?? target.path, { bigint: true });

        return true;
      } catch (error) {
        if (isMissingWatchPath(error)) return false;

        throw error;
      }
    }

    function registrationCoversTarget(
      directory: string,
      registration: WatcherRegistration,
      requestedDirectory: string,
      target: WatchTarget,
      recursive: boolean,
    ): boolean {
      const targetPath = resolve(target.identityPath ?? target.path);
      const targetIsPresentDirectory = targetIsDirectory(target);
      const filterCoversTarget = registration.targets.some((current) => {
        const currentPath = resolve(current.identityPath ?? current.path);

        return current.kind === "file"
          ? target.kind === "file" && currentPath === targetPath
          : isWithin(currentPath, targetPath);
      });

      if (!filterCoversTarget) return false;
      if (registration.recursive && isWithin(directory, targetPath)) return true;
      if (
        !targetEntryExists(target) &&
        directory === requestedDirectory &&
        (!recursive || registration.recursive) &&
        registration.targets.some(
          (current) =>
            current.kind === target.kind &&
            resolve(current.identityPath ?? current.path) === targetPath,
        )
      )
        return true;
      if (target.kind === "file") return dirname(targetPath) === directory;
      if (targetIsPresentDirectory)
        return directory === targetPath && (!recursive || registration.recursive);

      return directory === dirname(targetPath);
    }

    let coverageExpanded = false;

    for (const [directory, requested] of directories) {
      const existing = dependencyWatchers.get(directory);

      if (existing && !sameWatchIdentity(existing, requested)) coverageExpanded = true;

      for (const target of requested.targets) {
        const targetRecursive =
          target.kind === "directory" && requested.recursive && targetIsDirectory(target);
        const alreadyCovered = [...dependencyWatchers].some(([activeDirectory, registration]) =>
          registrationCoversTarget(
            activeDirectory,
            registration,
            directory,
            target,
            targetRecursive,
          ),
        );

        if (!alreadyCovered) coverageExpanded = true;
      }
    }

    const nextWatchers = new Map<string, WatcherRegistration>();
    const additions = new Set<WatcherRegistration>();

    try {
      for (const [directory, requested] of directories) {
        const existing = dependencyWatchers.get(directory);

        if (
          existing &&
          existing.recursive === requested.recursive &&
          existing.identityAvailable &&
          requested.identityAvailable &&
          sameWatchIdentity(existing, requested)
        ) {
          nextWatchers.set(directory, existing);
          continue;
        }

        let registration: WatcherRegistration | undefined;
        const watcher = watch(directory, { recursive: requested.recursive }, (_event, filename) => {
          if (!registration || dependencyWatchers.get(directory) !== registration) return;
          if (filename === null) {
            rebuild();
            return;
          }

          try {
            const changed = canonicalWatchPath(resolve(directory, filename.toString()), "file");

            if (registration.targets.some((target) => targetMatches(target, changed))) rebuild();
          } catch {
            rebuild();
          }
        });
        registration = {
          watcher,
          recursive: requested.recursive,
          device: requested.device,
          inode: requested.inode,
          parentDevice: requested.parentDevice,
          parentInode: requested.parentInode,
          identityAvailable: requested.identityAvailable,
          targets: requested.targets,
        };
        additions.add(registration);
        nextWatchers.set(directory, registration);
      }

      for (const directory of newlyMissing) {
        try {
          report(`Development watch directory is missing: ${directory}; watching for its creation`);
        } catch {
          // Reporting a missing directory must not invalidate the installed watch set.
        }
      }

      if (!isCurrent()) {
        const closeFailures: unknown[] = [];

        for (const registration of additions) closeWatcher(registration.watcher, closeFailures);

        return { installed: false, coverageExpanded: false, closeFailures, retired: [] };
      }

      for (const [directory, requested] of directories) {
        const registration = nextWatchers.get(directory)!;

        registration.targets = requested.targets;
      }
    } catch (error) {
      const closeFailures: unknown[] = [];

      for (const registration of additions) closeWatcher(registration.watcher, closeFailures);

      if (closeFailures.length) {
        reportWatchError(error);
        reportWatchCloseFailures(closeFailures);

        throw new AggregateError(
          [error, ...closeFailures],
          "Development watch registration and rollback failed",
          { cause: error },
        );
      }

      throw error;
    }

    const previousWatchers = [...dependencyWatchers.values()];
    const retainedWatchers = new Set(nextWatchers.values());
    const retired = previousWatchers.filter((registration) => !retainedWatchers.has(registration));

    dependencyWatchers.clear();

    for (const [directory, registration] of nextWatchers)
      dependencyWatchers.set(directory, registration);

    missingDirectories.clear();

    for (const directory of nextMissing) missingDirectories.add(directory);

    return { installed: true, coverageExpanded, closeFailures: [], retired };
  }

  function rebuild(): void {
    if (closed) return;

    pending = true;

    if (building) {
      buildAbort?.abort();

      return;
    }

    building = (async () => {
      while (pending && !closed) {
        pending = false;
        const controller = new AbortController();
        buildAbort = controller;

        try {
          const candidate = await prepare(controller.signal);
          const removed = new Set(published.sourceFiles.filter((source) => !existsSync(source)));
          const ownership = published.dependencies;
          const reloadAll = ownership?.shared.some((source) => removed.has(source)) ?? false;
          const routeIds =
            ownership?.routes
              .filter((route) => route.sources.some((source) => removed.has(source)))
              .map((route) => route.routeId) ?? [];
          const retainedSources = new Set([
            ...(reloadAll ? [] : (ownership?.shared ?? [])),
            ...(ownership?.routes
              .filter((route) => !reloadAll && !routeIds.includes(route.routeId))
              .flatMap((route) => route.sources) ?? []),
          ]);
          const retire = new Set(
            Object.entries(ownership?.assets ?? {})
              .filter(
                ([, sources]) =>
                  sources.some((source) => removed.has(source)) &&
                  !sources.some((source) => retainedSources.has(source)),
              )
              .map(([path]) => path),
          );
          const styleOnly =
            build.styleRevision &&
            candidate.styleRevision &&
            build.styleRevision.semanticKey === candidate.styleRevision.semanticKey;
          const capture = developmentCapture(candidate, styleOnly ? published : undefined, retire);
          const fingerprint = developmentFingerprint(candidate, capture.hosting);

          if (!closed && !controller.signal.aborted && !pending) {
            if (fingerprint === published.fingerprint && !routeIds.length && !reloadAll) {
              let watchInstall: WatchInstallResult;

              try {
                watchInstall = watchDependencies(
                  candidate,
                  [],
                  () => !closed && !controller.signal.aborted && !pending,
                );

                if (!watchInstall.installed) {
                  reportWatchCloseFailures(watchInstall.closeFailures);
                  continue;
                }
              } catch (watchError) {
                reportWatchError(watchError);
                continue;
              }

              const closeFailures = commitAndRetire(watchInstall.retired, () => {
                published = publishDevelopmentCapture(capture, published.host, fingerprint);
                build = candidate;
                failedWatchDependencies = [];
              });

              reportWatchCloseFailures(closeFailures);

              if (
                watchInstall.coverageExpanded &&
                !closed &&
                !controller.signal.aborted &&
                !pending
              )
                rebuild();

              continue;
            }

            const host = await createHost(developmentHostInput(capture));

            if (!closed && !controller.signal.aborted && !pending) {
              let watchInstall: WatchInstallResult;

              try {
                watchInstall = watchDependencies(
                  candidate,
                  [],
                  () => !closed && !controller.signal.aborted && !pending,
                );

                if (!watchInstall.installed) {
                  reportWatchCloseFailures(watchInstall.closeFailures);
                  continue;
                }
              } catch (watchError) {
                reportWatchError(watchError);
                continue;
              }

              const closeFailures = commitAndRetire(watchInstall.retired, () => {
                published = publishDevelopmentCapture(capture, host, fingerprint);
                build = candidate;
                failedWatchDependencies = [];

                rememberDevelopmentRoot(host);

                if (routeIds.length || reloadAll)
                  publish({ type: "source-removal", routeIds, reloadAll });

                publish(
                  styleOnly
                    ? { type: "style-revision", plan: candidate.styleRevision!.plan }
                    : "reload",
                );
              });

              reportWatchCloseFailures(closeFailures);

              if (
                watchInstall.coverageExpanded &&
                !closed &&
                !controller.signal.aborted &&
                !pending
              )
                rebuild();
            }
          }
        } catch (error) {
          if (!closed && !controller.signal.aborted) {
            const attempted = error instanceof ProjectError ? (error.watch ?? []) : [];
            let watchInstall: WatchInstallResult = {
              installed: false,
              coverageExpanded: false,
              closeFailures: [],
              retired: [],
            };

            try {
              watchInstall = watchDependencies(
                build,
                attempted,
                () => !closed && !controller.signal.aborted && !pending,
              );

              const closeFailures = commitAndRetire(watchInstall.retired, () => {
                if (watchInstall.installed) failedWatchDependencies = attempted;
              });

              reportWatchCloseFailures(closeFailures);
              reportWatchCloseFailures(watchInstall.closeFailures);
            } catch (watchError) {
              reportWatchError(watchError);
            }

            if (closed || controller.signal.aborted || pending) continue;

            const message = String(error);

            if (closed || controller.signal.aborted || pending) continue;

            report(message);

            if (closed || controller.signal.aborted || pending) continue;

            publish(message);

            if (
              watchInstall.installed &&
              watchInstall.coverageExpanded &&
              !closed &&
              !controller.signal.aborted &&
              !pending
            )
              rebuild();
          }
        } finally {
          if (buildAbort === controller) buildAbort = undefined;
        }
      }
    })().finally(() => {
      building = undefined;
    });
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 5173,

    async fetch(request, connection) {
      const url = new URL(request.url);

      for (const [assetRoot, client] of developmentRoots) {
        if (url.pathname === `${assetRoot}/events` && request.method === "GET") {
          connection.timeout(request, 0);

          let controller: ReadableStreamDefaultController<Uint8Array>;
          const stream = new ReadableStream<Uint8Array>({
            start(value) {
              controller = value;

              clients.add(value);

              value.enqueue(encoder.encode(": connected\n\n"));
            },

            cancel() {
              clients.delete(controller);
            },
          });
          return new Response(stream, {
            headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
          });
        }

        if (url.pathname === `${assetRoot}/warnings` && request.method === "POST") {
          if (request.headers.get("origin") !== url.origin)
            return new Response("Forbidden origin", { status: 403 });

          const message = await request.text();

          if (message.length > 16_384) return new Response("Warning too long", { status: 413 });

          report(message);

          return new Response(null, { status: 204 });
        }

        if (url.pathname === `${assetRoot}/client.js` && request.method === "GET")
          return new Response(client, {
            headers: { "cache-control": "no-cache", "x-content-type-options": "nosniff" },
          });
      }

      const current = published;
      const response = current.host.handle(request);

      if (!response) return new Response(null, { status: 404 });

      if (
        request.method !== "GET" ||
        !response.headers.get("content-type")?.startsWith("text/html")
      )
        return response;

      const body = await response.text();
      const clientPath = `${current.host.mount.assetPath}/client.js`;
      const html = body.replace(
        '<script type="module" src=',
        `<script type="module" src="${clientPath.replaceAll("&", "&amp;")}"></script><script type="module" src=`,
      );
      const headers = new Headers(response.headers);

      headers.delete("content-length");

      return new Response(html, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    },
  });
  const watchers: FSWatcher[] = [];

  try {
    const initialWatchInstall = watchDependencies(build, failedWatchDependencies);

    if (!initialWatchInstall.installed) {
      const error = new Error("Development dependency watches could not be installed");

      if (initialWatchInstall.closeFailures.length)
        throw new AggregateError(
          [error, ...initialWatchInstall.closeFailures],
          "Development dependency watch installation and cleanup failed",
          { cause: error },
        );

      throw error;
    }

    const closeFailures = closeRetiredWatchers(initialWatchInstall.retired);

    reportWatchCloseFailures(closeFailures);
    reportWatchCloseFailures(initialWatchInstall.closeFailures);

    watchers.push(
      watch(root, (_event, filename) => {
        if (filename === null) {
          rebuild();
          return;
        }

        try {
          const changed = filename.toString();
          const checkingInput = build.sources.some(
            (source) =>
              canonicalWatchPath(dirname(source), "directory") ===
                canonicalWatchPath(root, "directory") &&
              canonicalWatchPath(source, "file") ===
                canonicalWatchPath(resolve(root, changed), "file"),
          );
          const rootDirectoryWatch =
            build.watch?.some(
              (item) =>
                item.kind === "directory" &&
                canonicalWatchPath(item.dir, "directory") === canonicalWatchPath(root, "directory"),
            ) === true;

          if (
            changed &&
            changed !== "hesperia.d.ts" &&
            (/\.(?:ts|tsx|mts)$/u.test(changed) ||
              ["tsconfig.json", "hesperia.config.json"].includes(changed) ||
              checkingInput ||
              rootDirectoryWatch)
          )
            rebuild();
        } catch {
          rebuild();
        }
      }),
    );

    if (initialWatchInstall.coverageExpanded)
      queueMicrotask(() => {
        if (!closed && !pending) rebuild();
      });
  } catch (error) {
    closed = true;
    const failures: unknown[] = [];

    for (const watcher of watchers) closeWatcher(watcher, failures);

    closeDependencyWatchers(failures);

    try {
      await server.stop(true);
    } catch (cleanup) {
      failures.push(cleanup);
    }

    if (failures.length)
      throw new AggregateError(
        [error, ...failures],
        "Development server startup and cleanup failed",
        {
          cause: error,
        },
      );

    throw error;
  }

  return {
    url: server.url,

    async close() {
      closed = true;
      const activeBuild = building;
      const buildSettlement = activeBuild?.then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      const failures: unknown[] = [];

      try {
        buildAbort?.abort();
      } catch (error) {
        failures.push(error);
      }

      for (const watcher of watchers) closeWatcher(watcher, failures);

      closeDependencyWatchers(failures);

      for (const client of clients) {
        try {
          client.close();
        } catch {
          /* The browser may already have disconnected. */
        }
      }

      clients.clear();

      try {
        await server.stop(true);
      } catch (error) {
        failures.push(error);
      }

      const result = await buildSettlement;

      if (result && !result.ok) failures.push(result.error);
      if (failures.length === 1) throw failures[0];
      if (failures.length)
        throw new AggregateError(failures, "Development server cleanup failed", {
          cause: failures[0],
        });
    },
  };
}

function developmentCapture(
  build: BrowserBuild,
  previous?: DevelopmentCapture,
  retired: ReadonlySet<string> = new Set(),
): DevelopmentCapture {
  if (build.hosting.mode !== "development")
    throw new TypeError("The development server requires a development build");

  const assets = new Map<string, HostingAssetRecord>();
  const files = new Map<string, Blob>();

  for (const asset of build.hosting.assets) {
    assets.set(asset.path, asset);

    const blob = build.files.get(asset.path);

    if (!blob)
      throw new TypeError(
        `Development build omitted ${asset.path}; captured assets: ${[...build.files.keys()]
          .filter((path) => path.startsWith("/assets/"))
          .join(", ")}`,
      );

    files.set(asset.path, blob);
  }

  if (previous) {
    for (const asset of previous.hosting.assets) {
      if (assets.has(asset.path) || retired.has(asset.path)) continue;

      assets.set(asset.path, asset);

      const blob = previous.files.get(asset.path);

      if (blob) files.set(asset.path, blob);
    }
  }

  const managedAssets = [...assets.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  const metadata: DevelopmentCaptureMetadata = {
    files,
    sourceFiles: [
      ...new Set([
        ...build.sources.filter((source) => existsSync(source)).map(canonicalSource),
        ...(previous?.sourceFiles.filter((source) => existsSync(source)) ?? []),
      ]),
    ],
    ...(build.developmentDependencies
      ? {
          dependencies: {
            ...build.developmentDependencies,
            shared: [
              ...new Set([
                ...build.developmentDependencies.shared,
                ...(previous?.dependencies?.shared ?? []),
              ]),
            ],
            routes: build.developmentDependencies.routes.map((route) => ({
              routeId: route.routeId,
              sources: [
                ...new Set([
                  ...route.sources,
                  ...(previous?.dependencies?.routes.find(
                    (prior) => prior.routeId === route.routeId,
                  )?.sources ?? []),
                ]),
              ],
            })),
            assets: Object.fromEntries([
              ...Object.entries(previous?.dependencies?.assets ?? {}).filter(([path]) =>
                files.has(path),
              ),
              ...Object.entries(build.developmentDependencies.assets),
            ]),
          },
        }
      : {}),
  };

  if ("publicFiles" in build) {
    const currentHosting = snapshotDevelopmentHosting(build.hosting);

    if (currentHosting.version !== 2)
      throw new TypeError("A version 2 build must include its public-file hosting record");

    return {
      ...metadata,
      hosting: { ...currentHosting, assets: managedAssets },
      publicFiles: new Map(build.publicFiles),
    };
  }

  const currentHosting = snapshotDevelopmentHosting(build.hosting);

  if (currentHosting.version !== 1)
    throw new TypeError("A version 1 build cannot include a public-file hosting record");

  return { ...metadata, hosting: { ...currentHosting, assets: managedAssets } };
}

function snapshotDevelopmentHosting(
  hosting: HostingRecordV1 | HostingRecordV2,
): HostingRecordV1 | HostingRecordV2 {
  const assets = Object.freeze(hosting.assets.map((asset) => Object.freeze({ ...asset })));

  if (hosting.version === 2) {
    const publicFiles: readonly HostingPublicFileRecord[] = Object.freeze(
      hosting.publicFiles.map((file) => Object.freeze({ ...file })),
    );

    return Object.freeze({ ...hosting, assets, publicFiles });
  }

  return Object.freeze({ ...hosting, assets });
}

function developmentHostInput(capture: DevelopmentCapture) {
  if ("publicFiles" in capture)
    return {
      hosting: capture.hosting,
      files: capture.files,
      publicFiles: capture.publicFiles,
    };

  return { hosting: capture.hosting, files: capture.files };
}

function publishDevelopmentCapture(
  capture: DevelopmentCapture,
  host: ApplicationHost,
  fingerprint: string,
): PublishedDevelopmentRevision {
  if ("publicFiles" in capture) return { ...capture, host, fingerprint };

  return { ...capture, host, fingerprint };
}

function canonicalSource(filename: string): string {
  const path = resolve(filename).replaceAll("\\", "/");
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function developmentFingerprint(
  build: BrowserBuild,
  hosting: HostingRecordV1 | HostingRecordV2,
): string {
  const publicFiles =
    hosting.version === 2
      ? hosting.publicFiles
          .map((file) => [file.urlPath, file.contentType, file.sha256] as const)
          .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
      : [];

  return JSON.stringify({
    hostingVersion: hosting.version,
    mount: hosting.standaloneMountURL,
    startup: hosting.startupAsset,
    assets: hosting.assets,
    publicFiles,
    styleRevision: build.styleRevision
      ? { semanticKey: build.styleRevision.semanticKey, plan: build.styleRevision.plan }
      : null,
  });
}

function developmentClientSource(assetRoot: string): string {
  const eventsURL = JSON.stringify(`${assetRoot}/events`);
  const warningsURL = JSON.stringify(`${assetRoot}/warnings`);
  return `const warningsURL = ${warningsURL};
addEventListener("hesperia:warning", event => { if (typeof event.detail === "string") void fetch(warningsURL, { method: "POST", body: event.detail }).catch(() => {}); });
const requestHardReload = () => { const request = new CustomEvent("hesperia:dev-hard-reload", { cancelable: true }); if (window.dispatchEvent(request)) location.reload(); };
const events = new EventSource(${eventsURL});
events.onmessage = async event => { const message = JSON.parse(event.data); if (message === "reload") { requestHardReload(); return; } if (message?.type === "source-removal") { window.dispatchEvent(new CustomEvent("hesperia:dev-source-removal", { detail: { routeIds: message.routeIds, reloadAll: message.reloadAll } })); return; } if (message?.type === "style-revision") { let resolve; let reject; const settled = new Promise((accept, fail) => { resolve = accept; reject = fail; }); const update = new CustomEvent("hesperia:style-revision", { cancelable: true, detail: { plan: message.plan, resolve, reject } }); if (window.dispatchEvent(update)) { requestHardReload(); return; } try { await settled; } catch (error) { console.error(error); dispatchEvent(new CustomEvent("hesperia:warning", { detail: String(error) })); } return; } console.error(message); };
`;
}
