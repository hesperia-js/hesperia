import { readdir } from "node:fs/promises";
import { resolve, relative, sep, isAbsolute } from "node:path";
import {
  compareRoutes,
  type RouteFiles,
  type RouteManifest,
  type RouteNode,
  type RouteSegment,
} from "./manifest.ts";

const conventions: Readonly<Record<string, keyof RouteFiles>> = {
  "+page.tsx": "page",
  "+layout.tsx": "layout",
  "+loading.tsx": "loading",
  "+error.tsx": "error",
  "+not-found.tsx": "notFound",
  "+route.ts": "route",
};

/** A deterministic route collision or invalid segment, with every relevant source path. */
export class RouteScanError extends Error {
  /** Files or directories responsible for the diagnostic. */
  readonly paths: readonly string[];
  /** Create a diagnostic that names both sides of a collision. */
  constructor(message: string, paths: readonly string[]) {
    super(`${message}: ${paths.join(", ")}`);
    this.name = "RouteScanError";
    this.paths = Object.freeze([...paths]);
  }
}

function segment(name: string, path: string): RouteSegment | null {
  if (/^\([^()]+\)$/.test(name)) return null;
  const rest = /^\[\.\.\.([^\]]+)\]$/.exec(name);
  const optionalRest = /^\[\[\.\.\.([^\]]+)\]\]$/.exec(name);
  const optional = /^\[\[([^\]]+)\]\]$/.exec(name);
  const param = /^\[([^\]]+)\]$/.exec(name);
  if ((rest ?? optionalRest ?? optional ?? param)?.[1]?.includes("["))
    throw new RouteScanError("Invalid route segment", [path]);
  if (!optionalRest && optional?.[1]?.startsWith("..."))
    throw new RouteScanError("Invalid route segment", [path]);
  if (rest) return { kind: "rest", value: rest[1]! };
  if (optionalRest) return { kind: "optional-rest", value: optionalRest[1]! };
  if (optional) return { kind: "optional", value: optional[1]! };
  if (param) return { kind: "param", value: param[1]! };
  if (["[", "]", "(", ")"].some((character) => name.includes(character)))
    throw new RouteScanError("Invalid route segment", [path]);
  return { kind: "static", value: name };
}

/** Scan explicit source paths; no file evaluation or platform enumeration order affects the result. */
export function scanRouteFiles(rootPath: string, sourcePaths: readonly string[]): RouteManifest {
  const root = resolve(rootPath);
  const directories = new Map<string, Record<string, string>>([["", {}]]);
  for (const source of [...sourcePaths].sort()) {
    const absolute = resolve(source);
    const local = relative(root, absolute);
    if (
      isAbsolute(local) ||
      local === ".." ||
      local.startsWith(`..${sep}`) ||
      resolve(root, local) !== absolute
    )
      throw new RouteScanError("Route source is outside its root", [absolute]);
    const parts = local.split(sep);
    const name = parts.pop()!;
    if (parts.some((part) => part.startsWith("_")) || !conventions[name]) continue;
    for (let index = 0; index <= parts.length; index++) {
      const directory = parts.slice(0, index).join("/");
      if (!directories.has(directory)) directories.set(directory, {});
    }
    const files = directories.get(parts.join("/"))!;
    const kind = conventions[name]!;
    if (files[kind])
      throw new RouteScanError("Duplicate conventional route file", [files[kind]!, absolute]);
    files[kind] = absolute;
  }
  const pages: RouteNode[] = [];
  const shapes = new Map<string, RouteNode>();
  const build = (id: string, inherited: readonly RouteSegment[]): RouteNode => {
    const own = id ? segment(id.split("/").at(-1)!, resolve(root, id)) : null;
    const segments = own ? [...inherited, Object.freeze(own)] : [...inherited];
    const names = segments.filter((part) => part.kind !== "static").map((part) => part.value);
    if (new Set(names).size !== names.length)
      throw new RouteScanError("Repeated route parameter name", [resolve(root, id)]);
    const childIds = [...directories.keys()]
      .filter(
        (key) =>
          key !== id &&
          key.slice(0, key.lastIndexOf("/") < 0 ? 0 : key.lastIndexOf("/")) === id &&
          (id !== "" || !key.includes("/")),
      )
      .sort();
    const dynamicSiblings = new Map<string, string>();
    for (const childId of childIds) {
      const part = segment(childId.split("/").at(-1)!, resolve(root, childId));
      if (part && part.kind !== "static") {
        const prior = dynamicSiblings.get(part.kind);
        if (prior)
          throw new RouteScanError("Ambiguous sibling route segments", [
            resolve(root, prior),
            resolve(root, childId),
          ]);
        dynamicSiblings.set(part.kind, childId);
      }
    }
    const node: RouteNode = Object.freeze({
      id: `/${id}`,
      pattern: `/${segments.map((part) => (part.kind === "static" ? part.value : part.kind === "param" ? `[${part.value}]` : part.kind === "optional" ? `[[${part.value}]]` : part.kind === "rest" ? `[...${part.value}]` : `[[...${part.value}]]`)).join("/")}`,
      segments: Object.freeze(segments),
      files: Object.freeze(directories.get(id)!),
      children: Object.freeze(childIds.map((child) => build(child, segments))),
    });
    if (node.files.page) {
      const shape = JSON.stringify(
        segments.map((part) => [part.kind, part.kind === "static" ? part.value : ""]),
      );
      const prior = shapes.get(shape);
      if (prior)
        throw new RouteScanError("Ambiguous route patterns", [prior.files.page!, node.files.page]);
      shapes.set(shape, node);
      pages.push(node);
    }
    return node;
  };
  const tree = build("", []);
  return Object.freeze({ root: tree, routes: Object.freeze(pages.sort(compareRoutes)) });
}

/** Read conventional route paths without following symlinks or evaluating server modules. */
export async function scanRoutes(rootPath: string): Promise<RouteManifest> {
  const root = resolve(rootPath);
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || entry.name.startsWith("_")) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && conventions[entry.name]) files.push(path);
    }
  };
  await visit(root);
  return scanRouteFiles(root, files);
}
