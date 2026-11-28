import type { BigIntStats } from "node:fs";
import { lstat, open, readdir, readlink, realpath } from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
  toNamespacedPath,
} from "node:path";
import type { RouteManifest } from "hesperia/routing";
import type { HostingPublicFileRecord } from "@hesperia/hosting";
import {
  assertCanonicalPublicFilePath,
  canonicalizePublicFilePath,
} from "@hesperia/hosting/internal";
import { isMissingFile } from "./utils.ts";
import type { PluginWatch } from "./plugins.ts";

interface CapturedPublicFileEntry {
  readonly record: HostingPublicFileRecord;
  readonly blob: Blob;
  readonly source: string;
}

interface StorageNode {
  source?: string;
  readonly children: Map<string, StorageNode>;
}

/** Captured public files with source paths kept outside the runtime inventory. */
export interface CapturedPublicFiles {
  /** Public file records sorted by their canonical app-relative URL path. */
  readonly records: readonly HostingPublicFileRecord[];
  /** Public file bytes keyed by the matching canonical app-relative URL path. */
  readonly files: ReadonlyMap<string, Blob>;
  /** Absolute authored source paths keyed by canonical app-relative URL path. */
  readonly sources: ReadonlyMap<string, string>;
}

/**
 * Capture files from `projectRoot/public` without parsing or transforming their contents.
 *
 * Each record's `relativePath` is the raw slash-separated storage name beneath `public/`; its
 * `urlPath` is the corresponding canonical app-relative URL. File bytes are read once into a Blob,
 * and each SHA-256 digest is calculated from that same Blob. `sources` keeps absolute source paths
 * outside the runtime records. Exact all-static page paths, the reserved hosting namespace,
 * duplicate canonical URLs, and storage file/ancestor conflicts reject capture; dynamic route
 * overlap is allowed. A missing `public/` directory produces empty inventories.
 *
 * Source links, including a linked public root, may select regular files or directories whose
 * resolved paths remain inside the project root. Broken, cyclic, or escaping links reject capture.
 * Public URLs retain the link's logical path beneath public, and separate aliases are captured
 * separately. This source policy does not permit links in captured deployment paths.
 *
 * @param reportWatch - Optional synchronous build-attempt observer. Receives fresh entry and
 * directory-content dependencies before their filesystem operations, including contained missing
 * target intent. Dependencies already reported remain useful if capture later rejects. The caller
 * owns their snapshots and watchers; no dependency paths enter the returned runtime records.
 *
 * @throws {TypeError} The returned promise rejects if a path is not a directory or regular file, a
 * public path is unsafe, a source link is broken, cyclic, or escaping, or a reserved, route, URL,
 * or storage collision is found.
 * @throws {Error} Other filesystem failures reject the returned promise; a missing public root is
 * the only filesystem error treated as an empty inventory.
 */
export async function capturePublicFiles(
  projectRoot: string,
  routes: RouteManifest,
  reportWatch?: (watch: PluginWatch) => void,
): Promise<CapturedPublicFiles> {
  const logicalProjectRoot = resolve(projectRoot);
  const publicRoot = join(logicalProjectRoot, "public");
  const reportEntry = (file: string): void => reportWatch?.(Object.freeze({ kind: "file", file }));
  let rootStat: BigIntStats;

  reportEntry(publicRoot);

  try {
    rootStat = await lstat(publicRoot, { bigint: true });
  } catch (error) {
    if (isMissingFile(error)) return emptyPublicFiles();

    throw error;
  }

  if (!rootStat.isDirectory() && !rootStat.isSymbolicLink())
    throw new TypeError(`public path is not a directory: ${publicRoot}`);

  reportEntry(logicalProjectRoot);

  const projectDirectory = await realpath(logicalProjectRoot);

  reportEntry(projectDirectory);

  const projectInfo = await lstat(projectDirectory, { bigint: true });
  const staticPages = staticPageSources(routes);
  const entries: CapturedPublicFileEntry[] = [];
  const urls = new Map<string, string>();
  const storage: StorageNode = { children: new Map() };
  const ancestry = new Set<string>();

  const identity = (info: BigIntStats): string => {
    if (typeof info.dev !== "bigint" || typeof info.ino !== "bigint")
      throw new TypeError(`public source filesystem identity is unavailable: ${publicRoot}`);

    return `${info.dev}:${info.ino}`;
  };
  const parts = (path: string): string[] => path.split(sep === "\\" ? /[\\/]/u : /\//u);

  const escape = (source: string, target: string): TypeError =>
    new TypeError(`public source escapes the project root: ${source} resolves to ${target}`);

  interface SourceLocation {
    readonly target: string;
    readonly info: BigIntStats;
    /** Undefined while resolving textual ancestors outside the admitted project root. */
    readonly depth: number | undefined;
  }

  const projectLocation: SourceLocation = { target: projectDirectory, info: projectInfo, depth: 0 };

  identity(projectInfo);

  if (dirname(projectDirectory) !== projectDirectory) {
    const parent = await lstat(dirname(projectDirectory), { bigint: true });

    if (identity(parent) === identity(projectInfo))
      throw new TypeError(`public source filesystem identity is not discriminating: ${publicRoot}`);
  }

  const walk = async (
    start: SourceLocation,
    components: readonly string[],
    links: Set<string>,
    source: string,
  ): Promise<SourceLocation> => {
    let { target, info, depth } = start;

    for (const component of components) {
      if (component === "" || component === ".") continue;

      if (!info.isDirectory())
        throw new TypeError(`public source parent is not a directory: ${source} at ${target}`);

      if (component === "..") {
        target = dirname(target);
        depth = depth !== undefined && depth > 0 ? depth - 1 : undefined;

        if (depth !== undefined) reportEntry(target);

        info = await lstat(target, { bigint: true });

        if (identity(info) === identity(projectInfo)) {
          target = projectDirectory;
          depth = 0;
        }

        continue;
      }

      const entry = join(target, component);

      if (depth !== undefined) reportEntry(entry);

      const entryInfo = await lstat(entry, { bigint: true });

      if (identity(entryInfo) === identity(info))
        throw new TypeError(`public source filesystem identity is not discriminating: ${entry}`);

      if (!entryInfo.isSymbolicLink()) {
        const canonical = await realpath(entry);
        const [current, parent] = await Promise.all([
          lstat(canonical, { bigint: true }),
          lstat(dirname(canonical), { bigint: true }),
        ]);

        if (
          current.isSymbolicLink() ||
          parent.isSymbolicLink() ||
          identity(current) !== identity(entryInfo) ||
          identity(parent) !== identity(info)
        )
          throw new TypeError(`public source changed during capture: ${source} at ${entry}`);

        target = canonical;
        info = current;
        depth = depth === undefined ? undefined : depth + 1;

        if (identity(info) === identity(projectInfo)) {
          target = projectDirectory;
          depth = 0;
        }

        continue;
      }

      if (depth === undefined) throw escape(source, entry);

      const key = `${identity(info)}/${identity(entryInfo)}`;

      if (links.has(key))
        throw new TypeError(`public source link cycle: ${source} through ${entry}`);

      links.add(key);

      try {
        reportEntry(entry);

        const linkDestination = await readlink(entry);
        const destination =
          process.platform === "win32" && parse(linkDestination).root === ""
            ? resolve(target, linkDestination)
            : linkDestination;
        let resolved: SourceLocation;

        if (isAbsolute(destination)) {
          const root = parse(destination).root;
          const destinationParts = parts(destination.slice(root.length));
          let remaining: readonly string[] | undefined;

          for (let index = 0; index <= destinationParts.length; index++) {
            const prefix = root + destinationParts.slice(0, index).join(sep);

            if (
              [logicalProjectRoot, projectDirectory].every(
                (candidate) =>
                  relative(toNamespacedPath(candidate), toNamespacedPath(prefix)) !== "",
              )
            )
              continue;

            const canonical = await realpath(prefix);
            const prefixInfo = await lstat(canonical, { bigint: true });

            if (identity(prefixInfo) !== identity(projectInfo)) throw escape(source, destination);

            remaining = destinationParts.slice(index);

            break;
          }

          if (remaining !== undefined)
            resolved = await walk(projectLocation, remaining, links, source);
          else {
            const canonicalVolume = await realpath(root);
            const volume =
              process.platform === "win32" && /^[A-Za-z]:$/u.test(canonicalVolume)
                ? `${canonicalVolume}${sep}`
                : canonicalVolume;
            const volumeInfo = await lstat(volume, { bigint: true });

            resolved = await walk(
              { target: volume, info: volumeInfo, depth: undefined },
              destinationParts,
              links,
              source,
            );
          }
        } else resolved = await walk({ target, info, depth }, parts(destination), links, source);

        if (resolved.depth === undefined) throw escape(source, resolved.target);

        target = resolved.target;
        info = resolved.info;
        depth = resolved.depth;
      } finally {
        links.delete(key);
      }
    }

    return { target, info, depth };
  };

  const resolveSource = async (source: string) => {
    reportEntry(source);

    try {
      const resolved = await walk(
        projectLocation,
        parts(relative(logicalProjectRoot, source)),
        new Set(),
        source,
      );

      reportEntry(source);

      const canonical = await realpath(source);
      const current = await lstat(canonical, { bigint: true });

      if (identity(current) !== identity(resolved.info))
        throw new TypeError(`public source changed during capture: ${source}`);

      return resolved;
    } catch (cause) {
      if (cause instanceof TypeError) throw cause;

      throw new TypeError(
        `public source could not be resolved (broken or cyclic link): ${source}`,
        {
          cause,
        },
      );
    }
  };

  const readSourceFile = async (
    source: string,
    resolved: { readonly target: string; readonly info: BigIntStats },
  ) => {
    reportEntry(resolved.target);

    const handle = await open(resolved.target, "r");
    let bytes: Buffer<ArrayBuffer>;

    try {
      const held = await handle.stat({ bigint: true });

      if (!held.isFile() || identity(held) !== identity(resolved.info))
        throw new TypeError(`public source changed during capture: ${source}`);

      const current = await resolveSource(source);

      if (!current.info.isFile() || identity(current.info) !== identity(held))
        throw new TypeError(`public source changed during capture: ${source}`);

      bytes = await handle.readFile();
    } catch (cause) {
      try {
        await handle.close();
      } catch (cleanup) {
        throw new AggregateError(
          [cause, cleanup],
          "Public source capture and file-handle close failed",
        );
      }

      throw cause;
    }

    await handle.close();

    return bytes;
  };

  const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
    const { target, info } = await resolveSource(directory);

    if (!info.isDirectory())
      throw new TypeError(`public path is not a directory: ${directory} resolves to ${target}`);

    const directoryIdentity = identity(info);

    if (ancestry.has(directoryIdentity))
      throw new TypeError(`public source directory link cycle: ${directory} resolves to ${target}`);

    ancestry.add(directoryIdentity);

    try {
      reportWatch?.(Object.freeze({ kind: "directory", dir: target }));

      const children = await readdir(target);
      children.sort(compareText);

      for (const name of children) {
        const source = join(directory, name);
        const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
        const resolved = await resolveSource(source);

        if (resolved.info.isDirectory()) {
          await visit(source, relativePath);

          continue;
        }

        if (!resolved.info.isFile())
          throw new TypeError(`public path entry is not a regular file or directory: ${source}`);

        let urlPath: string;

        try {
          urlPath = canonicalizePublicFilePath(relativePath);
        } catch {
          throw new TypeError(`public file has an unsafe storage path: ${source}`);
        }

        if (isReservedPublicFilePath(urlPath))
          throw new TypeError(
            `public file conflicts with the managed hosting namespace: ${source} and /_hesperia`,
          );

        assertCanonicalPublicFilePath(urlPath);

        const routeSources = staticPages.get(urlPath);

        if (routeSources)
          throw new TypeError(
            `public file conflicts with a literal page route: ${source} and ${routeSources.join(", ")}`,
          );

        const previousURLSource = urls.get(urlPath);

        if (previousURLSource)
          throw new TypeError(
            `public files have the same canonical URL ${urlPath}: ${previousURLSource} and ${source}`,
          );

        urls.set(urlPath, source);
        addStoragePath(storage, relativePath, source);

        const contentType = Bun.file(source).type || "application/octet-stream";

        const blob = new Blob([await readSourceFile(source, resolved)], { type: contentType });
        const sha256 = new Bun.CryptoHasher("sha256")
          .update(new Uint8Array(await blob.arrayBuffer()))
          .digest("hex");
        const record = Object.freeze({ relativePath, urlPath, sha256, contentType });

        entries.push({ record, blob, source });
      }
    } finally {
      ancestry.delete(directoryIdentity);
    }
  };

  await visit(publicRoot, "");
  entries.sort((left, right) => compareText(left.record.urlPath, right.record.urlPath));

  return Object.freeze({
    records: Object.freeze(entries.map((entry) => entry.record)),
    files: new Map(entries.map((entry) => [entry.record.urlPath, entry.blob])),
    sources: new Map(entries.map((entry) => [entry.record.urlPath, entry.source])),
  });
}

function staticPageSources(routes: RouteManifest): ReadonlyMap<string, readonly string[]> {
  const sources = new Map<string, string[]>();

  for (const route of routes.routes) {
    if (!route.files.page || route.segments.some((segment) => segment.kind !== "static")) continue;

    let urlPath: string;

    try {
      urlPath = canonicalizePublicFilePath(
        route.segments.map((segment) => segment.value).join("/"),
      );
    } catch {
      continue;
    }

    const prior = sources.get(urlPath) ?? [];
    prior.push(route.files.page);
    sources.set(urlPath, prior);
  }

  return sources;
}

function addStoragePath(root: StorageNode, relativePath: string, source: string): void {
  let current = root;
  const segments = relativePath.split("/");

  for (const segment of segments) {
    if (current.source) throw storageConflict(current.source, source, relativePath);

    let child = current.children.get(segment);

    if (!child) {
      child = { children: new Map() };
      current.children.set(segment, child);
    }

    current = child;
  }

  if (current.source) throw storageConflict(current.source, source, relativePath);

  const descendantSource = findStorageSource(current);

  if (descendantSource) throw storageConflict(source, descendantSource, relativePath);

  current.source = source;
}

function findStorageSource(node: StorageNode): string | undefined {
  if (node.source) return node.source;

  for (const child of node.children.values()) {
    const source = findStorageSource(child);

    if (source) return source;
  }

  return undefined;
}

function storageConflict(first: string, second: string, relativePath: string): TypeError {
  return new TypeError(
    `public files have a storage path conflict at ${relativePath}: ${first} and ${second}`,
  );
}

function isReservedPublicFilePath(urlPath: string): boolean {
  return urlPath === "/_hesperia" || urlPath.startsWith("/_hesperia/");
}

function emptyPublicFiles(): CapturedPublicFiles {
  return Object.freeze({
    records: Object.freeze([]),
    files: new Map<string, Blob>(),
    sources: new Map<string, string>(),
  });
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
