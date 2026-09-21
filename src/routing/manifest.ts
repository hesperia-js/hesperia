/** URL-contributing filesystem segment; groups are omitted from this sequence. */
export interface RouteSegment {
  /** Match precedence: literal, required parameter, optional parameter, required rest, optional rest. */
  readonly kind: "static" | "param" | "optional" | "rest" | "optional-rest";
  /** Literal path text or parameter name. */
  readonly value: string;
}

/** Conventional files found in one filesystem route directory. */
export interface RouteFiles {
  /** Page component source. */
  readonly page?: string;
  /** Persistent layout component source. */
  readonly layout?: string;
  /** Async waiting component source. */
  readonly loading?: string;
  /** Error boundary component source. */
  readonly error?: string;
  /** Unmatched-path component source. */
  readonly notFound?: string;
  /** Server route declaration, inspected only for the separately extracted client guard. */
  readonly route?: string;
}

/** One route-directory node, including organizational groups. */
export interface RouteNode {
  /** Root-relative directory identity including groups. */
  readonly id: string;
  /** URL pattern, excluding groups. */
  readonly pattern: string;
  /** Full root-to-node match sequence. */
  readonly segments: readonly RouteSegment[];
  /** Conventional source files at this directory. */
  readonly files: RouteFiles;
  /** Nested route directories in deterministic order. */
  readonly children: readonly RouteNode[];
}

/** Immutable scanner result consumed by the compiler and browser manifest generator. */
export interface RouteManifest {
  /** Root node, including inherited boundary and layout files. */
  readonly root: RouteNode;
  /** Routable pages in deterministic match precedence order. */
  readonly routes: readonly RouteNode[];
}

/** Decoded parameters; rest parameters retain their individual path segments. */
export type RouteParams = Readonly<Record<string, string | readonly string[]>>;

/** Successful route resolution with its complete directory ancestry. */
export interface RouteMatch {
  /** Selected page node. */
  readonly leaf: RouteNode;
  /** Root-to-leaf layout, boundary, and guard declaration chain. */
  readonly chain: readonly RouteNode[];
  /** Immutable decoded URL parameters. */
  readonly params: RouteParams;
}

const rank = { static: 0, param: 1, optional: 2, rest: 3, "optional-rest": 4 };

/** Compare segment kinds, then longer paths, then lexical identities, without locale dependence. */
export function compareRoutes(a: RouteNode, b: RouteNode): number {
  for (let index = 0; index < Math.min(a.segments.length, b.segments.length); index++) {
    const difference = rank[a.segments[index]!.kind] - rank[b.segments[index]!.kind];
    if (difference) return difference;
  }
  return b.segments.length - a.segments.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function matchSegments(
  pattern: readonly RouteSegment[],
  path: readonly string[],
  pi = 0,
  ui = 0,
  values: Record<string, string | readonly string[]> = {},
  prefix = false,
): RouteParams | null {
  if (pi === pattern.length) return prefix || ui === path.length ? Object.freeze(values) : null;
  const segment = pattern[pi]!;
  if (segment.kind === "static")
    return segment.value === path[ui]
      ? matchSegments(pattern, path, pi + 1, ui + 1, values, prefix)
      : null;
  if (segment.kind === "rest" || segment.kind === "optional-rest") {
    const allowEmpty = segment.kind === "optional-rest";
    for (let end = path.length; end >= ui + (allowEmpty ? 0 : 1); end--) {
      const captured = path.slice(ui, end);
      const result = matchSegments(
        pattern,
        path,
        pi + 1,
        end,
        captured.length ? { ...values, [segment.value]: Object.freeze(captured) } : values,
        prefix,
      );
      if (result) return result;
    }
    return null;
  }
  if (ui < path.length) {
    const result = matchSegments(
      pattern,
      path,
      pi + 1,
      ui + 1,
      { ...values, [segment.value]: path[ui]! },
      prefix,
    );
    if (result) return result;
  }
  return segment.kind === "optional"
    ? matchSegments(pattern, path, pi + 1, ui, values, prefix)
    : null;
}

/** Match a platform-parsed URL against the scanner's precedence order. */
export function matchRoute(manifest: RouteManifest, url: URL): RouteMatch | null {
  return matchManifest(manifest, url, false);
}

/** Find the nearest applicable not-found boundary after ordinary matching fails. */
export function matchNotFound(manifest: RouteManifest, url: URL): RouteMatch | null {
  return matchManifest(manifest, url, true);
}

function matchManifest(manifest: RouteManifest, url: URL, notFound: boolean): RouteMatch | null {
  const parts = url.pathname.split("/");
  if (parts[0] === "") parts.shift();
  if (parts.at(-1) === "") parts.pop();
  let decoded: string[];
  try {
    decoded = parts.map(decodeURIComponent);
  } catch {
    return null;
  }
  const ancestors = new Map<RouteNode, readonly RouteNode[]>();
  const visit = (node: RouteNode, chain: readonly RouteNode[]) => {
    const next = Object.freeze([...chain, node]);
    ancestors.set(node, next);
    for (const child of node.children) visit(child, next);
  };
  visit(manifest.root, []);
  const candidates = notFound
    ? [...ancestors.keys()].filter((node) => node.files.notFound).sort(compareRoutes)
    : manifest.routes;
  for (const leaf of candidates) {
    const params = matchSegments(leaf.segments, decoded, 0, 0, {}, notFound);
    if (params) return Object.freeze({ leaf, chain: ancestors.get(leaf)!, params });
  }
  return null;
}
