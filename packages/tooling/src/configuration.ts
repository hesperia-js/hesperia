import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalizeMountURL } from "@hesperia/hosting/internal";
import type {
  BrowserResolutionOverrides,
  ProjectResolutionOverrides,
} from "@hesperia/compiler/tooling";
import type { Plugin } from "./plugins.ts";
import { projectPublicValues, type PublicValue } from "./public-values.ts";
import { isMissingFile, isNonArrayObject } from "./utils.ts";

/** Settings authored in exactly one TypeScript or JSON project configuration file. */
export interface ProjectConfigurationInput<
  Plugins extends readonly Plugin<any>[] = readonly Plugin<any>[],
> {
  /** Permit the explicit unsafe HTML primitive. */
  readonly allowUnsafeHTML?: boolean;
  /** Permit the explicit unsafe embedded document component in this project. */
  readonly allowUnsafeEmbed?: boolean;
  /** Path-only default mount used by standalone serving; defaults to `/`. */
  readonly mountURL?: string;
  /** Exact browser import replacements. */
  readonly resolutionOverrides?: ProjectResolutionOverrides;
  /** Plugin instances invoked in this order. TypeScript configuration only. */
  readonly plugins?: Plugins;
  /** Explicit fixed values copied into `hesperia/config/public` during a build. */
  readonly public?: Readonly<Record<string, PublicValue>>;
}

/** Preserve the types of heterogeneous plugin instances in a TypeScript configuration. */
export function defineConfig<const Plugins extends readonly Plugin<any>[]>(
  configuration: ProjectConfigurationInput<Plugins>,
): ProjectConfigurationInput<Plugins> {
  return configuration;
}

/** Resolved project inputs used by checking, generation, and the build record. */
export interface ProjectConfiguration {
  /** Permit the explicit unsafe HTML primitive; browser enforcement and warnings still apply. */
  readonly allowUnsafeHTML: boolean;
  /** Permit embedded documents only for roots started from this project's compiled definitions. */
  readonly allowUnsafeEmbed?: boolean;
  /** Canonical path-only default mount used by standalone serving. */
  readonly mountURL: string;
  /** Exact browser import names mapped to packages or project-config-relative modules. */
  readonly resolutionOverrides: ProjectResolutionOverrides;
  /** Configured plugin instances, kept in the project process. */
  readonly plugins?: readonly Plugin<any>[];
  /** Validated, fixed public values. */
  readonly public?: Readonly<Record<string, PublicValue>>;
}

const loadedTypeScript = new Map<string, string>();

/** Read exactly one optional project file in its project-root Bun process. */
export async function readConfiguration(root: string): Promise<ProjectConfiguration> {
  root = resolve(root);
  const jsonFile = resolve(root, "hesperia.config.json");
  const tsFile = resolve(root, "hesperia.config.ts");
  const [jsonPresent, tsPresent] = await Promise.all([exists(jsonFile), exists(tsFile)]);

  if (jsonPresent && tsPresent)
    throw new TypeError("Use either hesperia.config.ts or hesperia.config.json, not both");

  if (!jsonPresent && !tsPresent)
    return Object.freeze({
      allowUnsafeHTML: false,
      allowUnsafeEmbed: false,
      mountURL: "/",
      resolutionOverrides: { browser: {} },
    });

  let value: unknown;

  if (jsonPresent) value = JSON.parse(await readFile(jsonFile, "utf8"));
  else {
    if (process.cwd() !== root)
      throw new Error("hesperia.config.ts must run in a Bun process started from the project root");

    const source = await readFile(tsFile, "utf8");
    const digest = new Bun.CryptoHasher("sha256").update(source).digest("hex");
    const previous = loadedTypeScript.get(tsFile);

    if (previous && previous !== digest)
      throw new Error("hesperia.config.ts changed; restart the project Bun command to load it");

    loadedTypeScript.set(tsFile, digest);

    const module = await import(pathToFileURL(tsFile).href);
    value = module.default;
  }

  if (!isNonArrayObject(value))
    throw new TypeError("Hesperia project configuration must contain an object");

  const entries = Object.entries(value);
  let mountURL = "/";

  for (const [name, setting] of entries) {
    if (
      name !== "allowUnsafeHTML" &&
      name !== "allowUnsafeEmbed" &&
      name !== "mountURL" &&
      name !== "resolutionOverrides" &&
      name !== "plugins" &&
      name !== "public"
    )
      throw new TypeError(`Unknown Hesperia configuration option: ${name}`);

    if (name === "allowUnsafeHTML" || name === "allowUnsafeEmbed") {
      if (typeof setting !== "boolean") throw new TypeError(`${name} must be a boolean`);

      continue;
    }

    if (name === "mountURL") {
      if (typeof setting !== "string") throw new TypeError("mountURL must be a string");

      mountURL = canonicalizeMountURL(setting);
    } else if (name === "resolutionOverrides") validateResolutionOverrides(setting);
    else if (name === "public") projectPublicValues(setting);
    else {
      if (jsonPresent) throw new TypeError("plugins require hesperia.config.ts");

      validatePlugins(setting);
    }
  }

  const overrides =
    typeof (value as { resolutionOverrides?: unknown }).resolutionOverrides === "object" &&
    (value as { resolutionOverrides?: unknown }).resolutionOverrides !== null &&
    !Array.isArray((value as { resolutionOverrides?: unknown }).resolutionOverrides)
      ? ((value as { resolutionOverrides?: { browser?: BrowserResolutionOverrides } })
          .resolutionOverrides?.browser ?? {})
      : {};
  const plugins = (value as { plugins?: readonly Plugin<any>[] }).plugins;
  const publicValues = Object.hasOwn(value, "public")
    ? projectPublicValues((value as { public?: unknown }).public).values
    : undefined;
  return Object.freeze({
    allowUnsafeHTML: (value as { allowUnsafeHTML?: boolean }).allowUnsafeHTML ?? false,
    allowUnsafeEmbed: (value as { allowUnsafeEmbed?: boolean }).allowUnsafeEmbed ?? false,
    mountURL,
    resolutionOverrides: { browser: Object.freeze({ ...overrides }) },
    ...(plugins ? { plugins: Object.freeze([...plugins]) } : {}),
    ...(publicValues ? { public: publicValues } : {}),
  });
}

async function exists(filename: string): Promise<boolean> {
  try {
    return (await stat(filename)).isFile();
  } catch (error) {
    if (isMissingFile(error)) return false;

    throw error;
  }
}

function validatePlugins(value: unknown): asserts value is readonly Plugin<any>[] {
  if (!Array.isArray(value)) throw new TypeError("plugins must be an array of plugin instances");

  const importTypes = new Set(["string", "json", "html", "svg", "image", "audio", "video", "css"]);

  for (const item of value) {
    if (item === null || typeof item !== "object" || typeof item.name !== "string" || !item.name)
      throw new TypeError("Each plugin must have a nonempty name");

    if (item.dependsOn !== undefined) {
      if (!Array.isArray(item.dependsOn))
        throw new TypeError(`Plugin ${item.name} dependsOn must be an array of plugin names`);

      if (item.dependsOn.some((name: unknown) => typeof name !== "string" || !name))
        throw new TypeError(`Plugin ${item.name} dependsOn must contain nonempty plugin names`);
    }

    for (const hook of [
      "transformSource",
      "generateStyles",
      "transformCss",
      "analyzeProject",
    ] as const)
      if (item[hook] !== undefined && typeof item[hook] !== "function")
        throw new TypeError(`Plugin ${item.name} ${hook} must be a function`);

    if (item.projectSources !== undefined) {
      if (!Array.isArray(item.projectSources))
        throw new TypeError(`Plugin ${item.name} projectSources must be an array of filenames`);

      if (
        item.projectSources.some((filename: unknown) => typeof filename !== "string" || !filename)
      )
        throw new TypeError(`Plugin ${item.name} projectSources must contain nonempty filenames`);
    }

    if (item.projectDeclarations !== undefined) {
      if (!Array.isArray(item.projectDeclarations))
        throw new TypeError(`Plugin ${item.name} projectDeclarations must be an array`);

      for (const declaration of item.projectDeclarations) {
        if (
          !declaration ||
          typeof declaration !== "object" ||
          typeof declaration.id !== "string" ||
          !declaration.id ||
          typeof declaration.code !== "string"
        )
          throw new TypeError(
            `Plugin ${item.name} projectDeclarations must contain IDs and declaration code`,
          );
      }
    }

    if (item.importTypes !== undefined) {
      if (
        item.importTypes === null ||
        typeof item.importTypes !== "object" ||
        Array.isArray(item.importTypes)
      )
        throw new TypeError(`Plugin ${item.name} importTypes must be an object`);

      for (const [name, handler] of Object.entries(item.importTypes)) {
        if (!name || importTypes.has(name) || name.includes("/"))
          throw new TypeError(`Duplicate or built-in import type: ${name}`);

        if (typeof handler !== "function")
          throw new TypeError(`Plugin ${item.name} import type ${name} must be a function`);

        importTypes.add(name);
      }
    }
  }
}

function validateResolutionOverrides(value: unknown): void {
  if (!isNonArrayObject(value)) throw new TypeError("resolutionOverrides must contain an object");

  const browser = (value as { browser?: unknown }).browser;

  if (browser === undefined) throw new TypeError("resolutionOverrides.browser is required");

  if (!isNonArrayObject(browser))
    throw new TypeError("resolutionOverrides.browser must contain an object");

  for (const [specifier, target] of Object.entries(browser)) {
    if (
      !specifier ||
      specifier.startsWith("/") ||
      specifier.includes("\\") ||
      specifier.includes("*")
    )
      throw new TypeError(`Invalid browser resolution override import name: ${specifier}`);

    if (
      typeof target !== "string" ||
      !target ||
      target.includes("\\") ||
      (target.startsWith(".") && !target.startsWith("./") && !target.startsWith("../")) ||
      target.startsWith("/")
    )
      throw new TypeError(
        `Browser resolution override target for ${specifier} must name a module specifier`,
      );

    if (target.startsWith("./") || target.startsWith("../")) {
      let decoded: string;

      try {
        decoded = decodeURIComponent(target);
      } catch {
        throw new TypeError(`Invalid browser resolution override target for ${specifier}`);
      }

      if (/%2f|%5c/iu.test(target) || decoded.includes("\\"))
        throw new TypeError(`Invalid browser resolution override target for ${specifier}`);
    }
  }
}
