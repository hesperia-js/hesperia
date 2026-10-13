const controlCharacters = /\p{Cc}/u;

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
