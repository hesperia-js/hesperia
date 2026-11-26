import {
  compareRoutes,
  matchRoute,
  type RouteManifest,
  type RouteNode,
  type RouteSegment,
} from "hesperia/routing";
import {
  captureInput,
  resolveMountPath,
  validateAssets,
  validatePublicFiles,
} from "./captured-build.ts";
import { assertCanonicalPublicFilePath, canonicalizeMountURL } from "./internal/mount.ts";
import type { CapturedBuild } from "./index.ts";

/** Fixed managed key of the captured browser/static routing policy. */
export const BROWSER_STATIC_ROUTING_ASSET = "/assets/static-routing.json";

/** Source-free page projection from the producer's checked route manifest. */
export interface BrowserStaticPageV1 {
  /** Logical scanner identity, including the empty identity of a real root page. */
  readonly id: string;
  /** Declared URL pattern retained for delivery metadata. */
  readonly pattern: string;
  /** Canonical match segments, with filesystem groups already omitted. */
  readonly segments: readonly RouteSegment[];
}

/** Closed complete-CSR routing policy captured alongside browser assets. */
export interface BrowserStaticRoutingV1 {
  /** Routing data format version. */
  readonly version: 1;
  /** Fixed browser/static policy discriminator. */
  readonly kind: "browser-static-routing";
  /** Canonical saved application mount, before an explicit preview override. */
  readonly mountURL: string;
  /** Actual checked pages in canonical matcher precedence order. */
  readonly pages: readonly BrowserStaticPageV1[];
  /** Exact canonical app-relative public URLs, in lexical order. */
  readonly publicFiles: readonly string[];
  /** HTTP outcomes supported by this complete-CSR policy version. */
  readonly outcomes: {
    /** Successful matched page document. */
    readonly page: 200;
    /** Unmatched application document. */
    readonly missingPage: 404;
    /** Unavailable resource in the reserved managed namespace. */
    readonly missingManaged: 404;
  };
}

/**
 * Path admission; the host retains its existing method and Accept handling.
 * Managed pathname and public urlPath are app-relative; routeId is the scanner identity.
 */
export type BrowserStaticPath =
  | { readonly kind: "outside" }
  | { readonly kind: "managed"; readonly pathname: string }
  | { readonly kind: "public"; readonly urlPath: string }
  | { readonly kind: "page"; readonly routeId: string; readonly status: 200 }
  | { readonly kind: "missing-page"; readonly status: 404 };

const manifests = new WeakMap<BrowserStaticRoutingV1, RouteManifest>();

/**
 * Snapshot the closed routing data without invoking accessor values.
 * @param value - Producer or decoded routing data with only the declared own fields.
 * @returns A copied, frozen policy with canonical page and public URL ordering.
 * @throws TypeError for malformed, duplicate, sparse or unsupported data.
 * @internal
 */
export function snapshotBrowserStaticRouting(value: unknown): BrowserStaticRoutingV1 {
  const fields = ownFields(
    value,
    ["version", "kind", "mountURL", "pages", "publicFiles", "outcomes"],
    "static routing",
  );

  if (fields.version !== 1 || fields.kind !== "browser-static-routing")
    throw new TypeError("unsupported browser/static routing format");

  const mountURL = requiredString(fields.mountURL, "routing mountURL");

  if (canonicalizeMountURL(mountURL) !== mountURL)
    throw new TypeError("routing mountURL must already be canonical");

  const identities = new Set<string>();
  const pages = dataArray(fields.pages, "routing pages").map((value) => {
    const page = ownFields(value, ["id", "pattern", "segments"], "routing page");
    const id = requiredString(page.id, "routing page id", true);
    const pattern = requiredString(page.pattern, "routing page pattern");

    if (identities.has(id)) throw new TypeError("routing page identities must be unique");

    if (!pattern.startsWith("/")) throw new TypeError("routing page pattern must be absolute");

    identities.add(id);

    const segments = Object.freeze(
      dataArray(page.segments, "routing segments").map((value) => {
        const segment = ownFields(value, ["kind", "value"], "routing segment");
        const kind = segment.kind;

        if (
          kind !== "static" &&
          kind !== "param" &&
          kind !== "optional" &&
          kind !== "rest" &&
          kind !== "optional-rest"
        )
          throw new TypeError("unsupported routing segment kind");

        return Object.freeze({
          kind,
          value: requiredString(segment.value, "routing segment value"),
        });
      }),
    );
    const pageSnapshot = Object.freeze({ id, pattern, segments });
    const node: RouteNode = Object.freeze({
      ...pageSnapshot,
      files: Object.freeze({}),
      children: Object.freeze([]),
    });

    return { page: pageSnapshot, node };
  });

  if (pages.length === 0) throw new TypeError("browser/static requires at least one captured page");

  pages.sort((left, right) => compareRoutes(left.node, right.node));

  const publicURLs = dataArray(fields.publicFiles, "routing publicFiles").map((value) => {
    const path = requiredString(value, "routing public URL");

    assertCanonicalPublicFilePath(path);

    return path;
  });

  if (new Set(publicURLs).size !== publicURLs.length)
    throw new TypeError("routing public URLs must be unique");

  publicURLs.sort(compareStrings);

  const outcomes = ownFields(
    fields.outcomes,
    ["page", "missingPage", "missingManaged"],
    "routing outcomes",
  );

  if (outcomes.page !== 200 || outcomes.missingPage !== 404 || outcomes.missingManaged !== 404)
    throw new TypeError("unsupported browser/static HTTP outcomes");

  const policy: BrowserStaticRoutingV1 = Object.freeze({
    version: 1,
    kind: "browser-static-routing",
    mountURL,
    pages: Object.freeze(pages.map(({ page }) => page)),
    publicFiles: Object.freeze(publicURLs),
    outcomes: Object.freeze({ page: 200, missingPage: 404, missingManaged: 404 }),
  });
  const nodes = Object.freeze(pages.map(({ node }) => node));
  const root: RouteNode = Object.freeze({
    id: "",
    pattern: "/",
    segments: Object.freeze([]),
    files: Object.freeze({}),
    children: nodes,
  });

  manifests.set(policy, Object.freeze({ root, routes: nodes }));

  return policy;
}

/**
 * Encode the canonical captured policy.
 * @param value - Routing data accepted by the closed snapshot validator.
 * @returns Two-space JSON followed by exactly one newline.
 * @throws TypeError synchronously for invalid routing data.
 * @internal
 */
export function encodeBrowserStaticRouting(value: unknown): string {
  return JSON.stringify(snapshotBrowserStaticRouting(value), null, 2) + "\n";
}

/**
 * Decode only canonical policy text, including its field and array order.
 * @param source - Exact captured UTF-8 text, without a byte order mark.
 * @returns A frozen validated policy with its private canonical matcher projection.
 * @throws SyntaxError for invalid JSON; TypeError for invalid or noncanonical data.
 * @internal
 */
export function decodeBrowserStaticRouting(source: string): BrowserStaticRoutingV1 {
  if (typeof source !== "string") throw new TypeError("routing source must be a string");

  const policy = snapshotBrowserStaticRouting(JSON.parse(source));

  if (JSON.stringify(policy, null, 2) + "\n" !== source)
    throw new TypeError("static routing must use its canonical JSON encoding");

  return policy;
}

/**
 * Verify and read the fixed policy from the captured managed inventory.
 * @param inventory - Browser capture with the same saved mount and exact public URL set.
 * @returns The policy after byte-digest, media-type and inventory agreement checks.
 * @throws TypeError through rejection for missing, corrupt or divergent routing data;
 * SyntaxError for invalid JSON. Byte and UTF-8 failures retain their original rejection.
 * @internal
 */
export async function readBrowserStaticRouting(
  inventory: CapturedBuild,
): Promise<BrowserStaticRoutingV1> {
  const snapshot = captureInput(inventory);
  const mountURL = resolveMountPath(snapshot);
  const assets = await validateAssets(snapshot);
  const asset = assets.get(BROWSER_STATIC_ROUTING_ASSET);
  const publicFiles = await validatePublicFiles(snapshot);

  return readVerifiedBrowserStaticRouting(asset, mountURL, publicFiles);
}

/** Decode and correlate the policy with already verified capture inventories. @internal */
export async function readVerifiedBrowserStaticRouting(
  asset: { readonly blob: Blob; readonly contentType: string } | undefined,
  mountURL: string,
  publicFiles: ReadonlyMap<string, unknown>,
): Promise<BrowserStaticRoutingV1> {
  if (!asset) throw new TypeError("browser/static capture is missing its static routing asset");

  if (asset.contentType !== "application/json")
    throw new TypeError("static routing asset must have application/json media type");

  const bytes = await asset.blob.arrayBuffer();
  const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  const policy = decodeBrowserStaticRouting(source);

  if (policy.mountURL !== mountURL)
    throw new TypeError("static routing mount does not match its captured hosting record");

  const publicURLs = [...publicFiles.keys()].sort(compareStrings);

  if (
    publicURLs.length !== policy.publicFiles.length ||
    publicURLs.some((path, index) => path !== policy.publicFiles[index])
  )
    throw new TypeError("static routing public URLs do not match the captured public inventory");

  return policy;
}

/**
 * Classify a path using the captured policy and the canonical Hesperia matcher.
 * @param policy - Validated routing data; uncached inputs are snapshotted before use.
 * @param url - Platform-parsed request URL; query data does not change page matching.
 * @param mountPathname - Optional explicit preview mount; saved static output remains bound.
 * @returns Reserved/public precedence, a real page match, an explicit miss or outside scope.
 * @throws TypeError for invalid routing data or a malformed selected mount.
 * @internal
 */
export function classifyBrowserStaticPath(
  policy: BrowserStaticRoutingV1,
  url: URL,
  mountPathname?: string,
): BrowserStaticPath {
  const captured = manifests.has(policy) ? policy : snapshotBrowserStaticRouting(policy);
  const mount =
    mountPathname === undefined ? captured.mountURL : canonicalizeMountURL(mountPathname);
  const pathname = url.pathname;

  if (mount !== "/" && pathname !== mount && !pathname.startsWith(`${mount}/`))
    return { kind: "outside" };

  const relative = mount === "/" ? pathname : pathname.slice(mount.length) || "/";

  if (relative === "/_hesperia" || relative.startsWith("/_hesperia/"))
    return { kind: "managed", pathname: relative };

  if (captured.publicFiles.includes(relative)) return { kind: "public", urlPath: relative };

  const pageURL = new URL(url.href);
  pageURL.pathname = relative;
  const match = matchRoute(manifests.get(captured)!, pageURL);

  return match
    ? { kind: "page", routeId: match.leaf.id, status: captured.outcomes.page }
    : { kind: "missing-page", status: captured.outcomes.missingPage };
}

function ownFields(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`${label} must contain own data fields`);

  const actual = Reflect.ownKeys(value);

  if (
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    throw new TypeError(`${label} has unexpected or missing fields`);

  const result: Record<string, unknown> = Object.create(null);

  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);

    if (!descriptor || !("value" in descriptor))
      throw new TypeError(`${label}.${key} must be an own data field`);

    result[key] = descriptor.value;
  }

  return result;
}

function dataArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);

  const length = Object.getOwnPropertyDescriptor(value, "length")!.value as number;

  if (Reflect.ownKeys(value).length !== length + 1)
    throw new TypeError(`${label} must be a dense array without extra fields`);

  return Array.from({ length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));

    if (!descriptor || !("value" in descriptor))
      throw new TypeError(`${label} must contain only own data entries`);

    return descriptor.value;
  });
}

function requiredString(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0))
    throw new TypeError(`${label} must be ${allowEmpty ? "a string" : "a nonempty string"}`);

  return value;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
