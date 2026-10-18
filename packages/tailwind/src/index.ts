import { resolve } from "node:path";
import tailwindPostcss from "@tailwindcss/postcss";
import type { Plugin } from "@hesperia/tooling/project-service";
import { postcss } from "@hesperia/postcss";

/** Project files scanned for static utility classes. */
export interface TailwindOptions {
  /** Absolute or configuration-directory-relative scan base; defaults to the config process cwd. */
  readonly base?: string;
}

/** Register Tailwind's PostCSS transform for imported and generated stylesheet inputs. */
export function tailwind(options: TailwindOptions = {}): Plugin {
  const base = resolve(options.base ?? process.cwd());
  const processed = postcss({
    plugins: [tailwindPostcss({ base, optimize: false })],
  });
  return Object.freeze({ ...processed, name: "@hesperia/tailwind" });
}
