import type { GeneratedAssetRoot, ResolvedGeneratedAssets } from "hesperia/runtime";
import { canonicalizeMountURL } from "./internal/mount.ts";

/** Optional settings bound once when deploying a compiled graph or starting its host. */
export interface GeneratedAssetSelection {
  /**
   * Generated-resource directory, independent of the application mount and public files.
   * Accepts an origin-relative pathname or an absolute HTTP(S) URL. Native URL serialization
   * normalizes the directory, and an omitted trailing slash is appended. Relative paths,
   * protocol-relative URLs, user information, query strings and fragments are rejected.
   * Omission uses the canonical application mount followed by `/_hesperia/`.
   */
  readonly baseURL?: string;
  /**
   * Native generated-module loading and preparation mode. Defaults to anonymous, whose derived
   * credentials mode is same-origin; use-credentials derives include. This setting does not
   * override authored stylesheet, image, font, CSS-subresource or fetch controls.
   */
  readonly moduleCredentials?: "anonymous" | "use-credentials";
}

const parsingOrigin = "https://hesperia.invalid";

function resolveRoot(mountPathname: string, baseURL: string | undefined): GeneratedAssetRoot {
  if (baseURL === undefined)
    return Object.freeze({
      kind: "path",
      pathname: `${mountPathname === "/" ? "" : mountPathname}/_hesperia/`,
    });

  if (baseURL.startsWith("//") || baseURL.includes("?") || baseURL.includes("#"))
    throw new TypeError(
      "generatedAssets baseURL cannot be protocol-relative or contain a query or fragment",
    );

  const pathOnly = baseURL.startsWith("/");
  let url: URL;

  try {
    url = pathOnly ? new URL(baseURL, parsingOrigin) : new URL(baseURL);
  } catch {
    throw new TypeError(
      "generatedAssets baseURL must be an origin-relative path or absolute HTTP(S) URL",
    );
  }

  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new TypeError("generatedAssets baseURL must use HTTP or HTTPS");

  if (url.username || url.password || (pathOnly && url.origin !== parsingOrigin))
    throw new TypeError(
      "generatedAssets baseURL cannot contain user information or a network-path authority",
    );

  if (!url.pathname.endsWith("/")) url.pathname += "/";

  return pathOnly
    ? Object.freeze({ kind: "path", pathname: url.pathname })
    : Object.freeze({ kind: "url", href: url.href });
}

/**
 * Capture own scalar settings before a host reads its saved mount or begins asynchronous work.
 * This snapshot does not resolve directory syntax or apply omitted-option defaults.
 *
 * @param selection - Optional own-data deployment settings; values are captured synchronously.
 * @returns A frozen scalar snapshot, or undefined for an omitted selection.
 * @throws {TypeError} Synchronously for non-object settings, unexpected fields, accessors,
 * a non-string or empty base, or an unsupported module mode.
 */
export function snapshotGeneratedAssetSelection(
  selection?: GeneratedAssetSelection,
): GeneratedAssetSelection | undefined {
  if (selection === undefined) return undefined;

  if (selection === null || typeof selection !== "object" || Array.isArray(selection))
    throw new TypeError("generatedAssets must be an object with own data fields");

  if (Reflect.ownKeys(selection).some((key) => key !== "baseURL" && key !== "moduleCredentials"))
    throw new TypeError("generatedAssets has unexpected fields");

  const base = Object.getOwnPropertyDescriptor(selection, "baseURL");
  const mode = Object.getOwnPropertyDescriptor(selection, "moduleCredentials");

  if ((base && !("value" in base)) || (mode && !("value" in mode)))
    throw new TypeError("generatedAssets settings must be own data fields");

  const baseURL: unknown = base?.value;
  const moduleCredentials: unknown = mode?.value;

  if (baseURL !== undefined && (typeof baseURL !== "string" || baseURL.length === 0))
    throw new TypeError("generatedAssets baseURL must be a nonempty directory string");

  if (
    moduleCredentials !== undefined &&
    moduleCredentials !== "anonymous" &&
    moduleCredentials !== "use-credentials"
  )
    throw new TypeError("generatedAssets moduleCredentials must be anonymous or use-credentials");

  return Object.freeze({
    ...(baseURL === undefined ? {} : { baseURL }),
    ...(moduleCredentials === undefined ? {} : { moduleCredentials }),
  });
}

/**
 * Resolve one snapshotted generated-asset selection before host admission or document generation.
 * This function performs no fetch, credential acquisition or resource rewriting.
 *
 * @param mountPathname - Application mount, validated with the existing mount authority.
 * @param selection - Optional own-data deployment settings, captured before resolution.
 * @returns A frozen directory identity and a consistent native module/credentials pair.
 * @throws {TypeError} For an invalid mount, invalid selection or malformed directory.
 * Throws synchronously before any deployment work.
 */
export function resolveGeneratedAssets(
  mountPathname: string,
  selection?: GeneratedAssetSelection,
): ResolvedGeneratedAssets {
  const mount = canonicalizeMountURL(mountPathname);
  const snapshot = snapshotGeneratedAssetSelection(selection);
  const root = resolveRoot(mount, snapshot?.baseURL);

  return snapshot?.moduleCredentials === "use-credentials"
    ? Object.freeze({ root, moduleCredentials: "use-credentials", credentials: "include" })
    : Object.freeze({ root, moduleCredentials: "anonymous", credentials: "same-origin" });
}

/** @internal Match the configured origin and return the path beneath its generated directory. */
export function relativeGeneratedRequestPath(
  url: URL,
  binding: ResolvedGeneratedAssets,
): string | undefined {
  const root = binding.root;
  const absolute = root.kind === "url" ? new URL(root.href) : undefined;

  if (absolute && url.origin !== absolute.origin) return undefined;

  const base = root.kind === "path" ? root.pathname : absolute!.pathname;

  return url.pathname.startsWith(base) ? url.pathname.slice(base.length) : undefined;
}
