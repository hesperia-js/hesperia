import { RenderFault } from "../runtime/owner.ts";

const URL_BASE = "https://hesperia.invalid";

/** Normalize the one host supplied application mount to a canonical pathname. */
export function normalizeMountPath(value = "/"): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//"))
    throw new RenderFault("navigation-mount", "The application mount must be an absolute pathname");

  if (/[?#\\]/.test(value) || /%(?:2f|5c)/i.test(value))
    throw new RenderFault("navigation-mount", "The application mount must be a canonical pathname");

  let parsed: URL;

  try {
    parsed = new URL(value, URL_BASE);
  } catch {
    throw new RenderFault("navigation-mount", "The application mount must be a valid pathname");
  }

  if (parsed.origin !== URL_BASE || parsed.search || parsed.hash)
    throw new RenderFault("navigation-mount", "The application mount must be a pathname only");

  const pathname = parsed.pathname.replace(/\/+$/, "") || "/";

  for (const segment of pathname.split("/")) {
    let decoded: string;

    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new RenderFault("navigation-mount", "The application mount contains invalid escaping");
    }

    if (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\"))
      throw new RenderFault(
        "navigation-mount",
        "The application mount contains an invalid segment",
      );
  }

  return pathname;
}

/** Resolve an application route with the accepted mount and browser URL rules. */
export function resolveNavigationTarget(
  target: string | URL,
  currentHref: string,
  mountPath: string,
): URL {
  const raw = String(target);
  let explicit: URL | undefined;

  try {
    explicit = new URL(raw);
  } catch {
    explicit = undefined;
  }

  if (explicit) return explicit;

  const current = new URL(currentHref);
  const targetUrl =
    raw.startsWith("/") && !raw.startsWith("//")
      ? new URL(`${mountPath === "/" ? "" : mountPath}${raw}`, current)
      : new URL(raw, current);

  if (targetUrl.origin !== current.origin || !isWithinMount(targetUrl.pathname, mountPath))
    throw new RenderFault(
      "navigation-mount-escape",
      "This relative destination leaves the application mount; use a full URL or the browser Navigation API",
    );

  return targetUrl;
}

/** Whether a browser URL belongs to the application's segment bounded mount. */
export function isWithinMount(pathname: string, mountPath: string): boolean {
  if (mountPath === "/") return pathname.startsWith("/");

  return pathname === mountPath || pathname.startsWith(`${mountPath}/`);
}

/** Return the browser facing href while preserving explicit external URLs. */
export function browserHref(target: URL, currentHref: string): string {
  if (target.origin !== new URL(currentHref).origin) return target.href;

  return `${target.pathname}${target.search}${target.hash}`;
}
