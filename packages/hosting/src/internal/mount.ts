const controlCharacters = /\p{Cc}/u;
const publicFilesNamespace = "/_hesperia";

/** Canonicalize a path-only application mount for generated URLs and Fetch routing. */
export function canonicalizeMountURL(value: string): string {
  if (typeof value !== "string") throw new TypeError("mountURL must be a string");

  if (!value.startsWith("/") || value.startsWith("//"))
    throw new TypeError("mountURL must start with exactly one slash");

  if (value.includes("?") || value.includes("#") || value.includes("\\"))
    throw new TypeError("mountURL must be a pathname without query, fragment, or backslash");

  if (controlCharacters.test(value))
    throw new TypeError("mountURL cannot contain control characters");

  let trimmed = value;

  if (trimmed.length > 1 && trimmed.endsWith("/")) trimmed = trimmed.slice(0, -1);

  if (trimmed === "/") return "/";

  const hadPercent = value.includes("%");
  const segments = trimmed.slice(1).split("/");

  if (segments.some((segment) => segment.length === 0))
    throw new TypeError("mountURL cannot contain empty path segments");

  const decodedSegments = segments.map((segment) => {
    let decoded = segment;

    if (segment.includes("%")) {
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        throw new TypeError("mountURL contains malformed percent encoding");
      }
    }

    if (
      decoded.length === 0 ||
      decoded === "." ||
      decoded === ".." ||
      decoded.includes("/") ||
      decoded.includes("\\") ||
      decoded.includes("%") ||
      decoded.includes("?") ||
      decoded.includes("#") ||
      controlCharacters.test(decoded)
    )
      throw new TypeError("mountURL contains an unsafe path segment");

    try {
      encodeURIComponent(decoded);

      return decoded;
    } catch {
      throw new TypeError("mountURL contains malformed UTF-16");
    }
  });

  const url = new URL("https://hesperia.invalid");
  url.pathname = `/${decodedSegments.join("/")}`;
  const canonical = url.pathname;

  if (hadPercent && trimmed !== canonical)
    throw new TypeError("mountURL with percent escapes must already be canonical");

  return canonical;
}

/**
 * Convert one raw slash-separated storage path, relative to `public/`, to its canonical app-relative
 * URL path. Percent signs are literal filename characters and are escaped as such; this function
 * runs synchronously, does not read the filesystem, and does not decide whether the path is
 * reserved for hosting.
 *
 * @throws {TypeError} If the value is not a string or the path is empty, absolute, contains an
 * empty, dot, or traversal segment, uses a backslash separator, contains control characters, or has
 * malformed UTF-16.
 */
export function canonicalizePublicFilePath(relativePath: string): string {
  if (typeof relativePath !== "string")
    throw new TypeError("public file relativePath must be a string");

  if (!relativePath || relativePath.startsWith("/"))
    throw new TypeError("public file relativePath must be non-empty and relative");

  if (relativePath.includes("\\") || controlCharacters.test(relativePath))
    throw new TypeError("public file relativePath contains an unsafe character");

  const segments = relativePath.split("/");

  if (segments.some((segment) => !segment || segment === "." || segment === ".."))
    throw new TypeError("public file relativePath contains an unsafe path segment");

  let encodedPath: string;

  try {
    for (const segment of segments) encodeURIComponent(segment);

    encodedPath = `/${segments.map((segment) => segment.replaceAll("%", "%25")).join("/")}`;
  } catch {
    throw new TypeError("public file relativePath contains malformed UTF-16");
  }

  const url = new URL("https://hesperia.invalid");
  url.pathname = encodedPath;

  return url.pathname;
}

/**
 * Require an exact canonical app-relative URL path for one public file.
 *
 * The value must be the WHATWG-escaped URL path derived from its raw `public/` storage name by
 * `canonicalizePublicFilePath`; percent escapes are decoded exactly once for this check.
 * This synchronous check validates URL-path syntax and the reserved namespace. Callers with a
 * record must also compare the canonicalized `relativePath` with this `urlPath`.
 *
 * @throws {TypeError} If the value is malformed, unsafe, noncanonical, or in the reserved
 * `/_hesperia` namespace.
 */
export function assertCanonicalPublicFilePath(urlPath: string): void {
  if (typeof urlPath !== "string") throw new TypeError("public file urlPath must be a string");

  if (!urlPath.startsWith("/") || urlPath.startsWith("//"))
    throw new TypeError("public file urlPath must start with exactly one slash");

  const encodedSegments = urlPath.slice(1).split("/");
  let decodedSegments: string[];

  try {
    decodedSegments = encodedSegments.map((segment) => decodeURIComponent(segment));
  } catch {
    throw new TypeError("public file urlPath contains malformed percent encoding");
  }

  if (
    decodedSegments.some(
      (segment) =>
        !segment ||
        segment.includes("/") ||
        segment.includes("\\") ||
        controlCharacters.test(segment),
    )
  )
    throw new TypeError("public file urlPath contains an unsafe path segment");

  const relativePath = decodedSegments.join("/");
  let canonical: string;

  try {
    canonical = canonicalizePublicFilePath(relativePath);
  } catch {
    throw new TypeError("public file urlPath is not a safe canonical path");
  }

  if (canonical !== urlPath) throw new TypeError("public file urlPath must already be canonical");

  if (urlPath === publicFilesNamespace || urlPath.startsWith(`${publicFilesNamespace}/`))
    throw new TypeError(`public file path is reserved: ${urlPath}`);
}
