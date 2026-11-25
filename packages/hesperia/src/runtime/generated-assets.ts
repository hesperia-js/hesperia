/** Fixed generated-resource directory selected before deployment startup. */
export type GeneratedAssetRoot =
  | {
      /** Resolve this directory against the application document's origin. */
      readonly kind: "path";
      /** Canonical origin-relative directory pathname, including its trailing slash. */
      readonly pathname: string;
    }
  | {
      /** Use this absolute directory independently of the application origin. */
      readonly kind: "url";
      /** Canonical absolute HTTP(S) directory URL, including its trailing slash. */
      readonly href: string;
    };

/**
 * Immutable deployment identity shared by generated startup, module preparation and root policy.
 * The deployment owner supplies this resolved value; browser consumers do not apply option defaults
 * or resolve a directory against document.baseURI. Authored resource request attributes retain
 * their own native semantics.
 */
export type ResolvedGeneratedAssets = {
  /** Selected generated-resource directory; application mounts and public URLs remain separate. */
  readonly root: GeneratedAssetRoot;
} & (
  | {
      /** Native anonymous CORS for generated module entry points and preparation. */
      readonly moduleCredentials: "anonymous";
      /** Derived native credentials mode, retaining same-origin credentials. */
      readonly credentials: "same-origin";
    }
  | {
      /** Native credentialed CORS for generated module entry points and preparation. */
      readonly moduleCredentials: "use-credentials";
      /** Derived native credentials mode, subject to browser and provider policy. */
      readonly credentials: "include";
    }
);

function ownRecord(value: unknown, fields: readonly string[]): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;

  const prototype = Object.getPrototypeOf(value);

  if (prototype !== Object.prototype && prototype !== null) return undefined;

  const keys = Reflect.ownKeys(value);

  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    return undefined;

  const snapshot: Record<string, unknown> = Object.create(null);

  for (const field of fields) {
    const property = Object.getOwnPropertyDescriptor(value, field);

    if (
      !property ||
      !property.enumerable ||
      !Object.prototype.hasOwnProperty.call(property, "value")
    )
      return undefined;

    snapshot[field] = property.value;
  }

  return snapshot;
}

function readRoot(value: unknown): GeneratedAssetRoot | undefined {
  const path = ownRecord(value, ["kind", "pathname"]);

  if (path) {
    if (
      path.kind !== "path" ||
      typeof path.pathname !== "string" ||
      !path.pathname.startsWith("/") ||
      path.pathname.startsWith("//") ||
      !path.pathname.endsWith("/")
    )
      return undefined;

    const url = new URL(path.pathname, "https://hesperia.invalid");

    if (
      url.origin !== "https://hesperia.invalid" ||
      url.pathname !== path.pathname ||
      url.search ||
      url.hash
    )
      return undefined;

    return Object.freeze({ kind: "path", pathname: path.pathname });
  }

  const absolute = ownRecord(value, ["kind", "href"]);

  if (absolute?.kind !== "url" || typeof absolute.href !== "string") return undefined;

  const url = new URL(absolute.href);

  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.href !== absolute.href ||
    !url.pathname.endsWith("/") ||
    url.username ||
    url.password ||
    absolute.href.includes("?") ||
    absolute.href.includes("#")
  )
    return undefined;

  return Object.freeze({ kind: "url", href: absolute.href });
}

/**
 * Validate and snapshot deployment data that has already been resolved by its owning host.
 * Does not apply author-option defaults, normalize a directory, infer an application origin or
 * establish that the binding was actually used by a producer or mounted root.
 *
 * @param value - Complete resolved binding from an actual construction or transport boundary.
 * @returns A fresh frozen binding and root, or undefined for malformed, noncanonical or inconsistent
 * data. Requires exact enumerable own data fields on ordinary or null-prototype records; never
 * invokes accessors. Record-inspection and URL parsing failures also return undefined.
 */
export function readResolvedGeneratedAssets(value: unknown): ResolvedGeneratedAssets | undefined {
  try {
    const record = ownRecord(value, ["root", "moduleCredentials", "credentials"]);

    if (!record) return undefined;

    const root = readRoot(record.root);

    if (!root) return undefined;

    if (record.moduleCredentials === "anonymous" && record.credentials === "same-origin")
      return Object.freeze({ root, moduleCredentials: "anonymous", credentials: "same-origin" });

    if (record.moduleCredentials === "use-credentials" && record.credentials === "include")
      return Object.freeze({ root, moduleCredentials: "use-credentials", credentials: "include" });

    return undefined;
  } catch {
    return undefined;
  }
}
