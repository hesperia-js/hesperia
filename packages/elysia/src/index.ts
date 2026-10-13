import type { Plugin } from "@hesperia/tooling/project-service";
import { configuredElysiaProjectPlugin } from "./project-plugin.ts";

/** Options selecting the server-side Elysia App whose routes Eden exposes. */
export interface ElysiaOptions {
  /** Server module path, resolved relative to the configured project root. */
  readonly serverModule: string;
  /** Exported Elysia App value whose checked `~Routes` type is analyzed. */
  readonly appExport: string;
  /** Optional effect declaration array exported by `serverModule`. */
  readonly serverEffectsExport?: string;
  /** Client effect module, relative to the project root; requires `clientEffectsExport`. */
  readonly clientEffectsModule?: string;
  /** Effect declaration array in `clientEffectsModule`; requires that module path. */
  readonly clientEffectsExport?: string;
}

/**
 * Configure checked route facts for the client entrypoint from
 * `@hesperia/elysia/client`.
 *
 * The selected server App is checked without executing its construction. When
 * effects are configured, only their selected browser-safe declarations and
 * dependencies are published to the browser.
 * Missing or ambiguous Eden client associations are reported as project
 * diagnostics.
 *
 * @param options - Server App and optional server/client effect exports to inspect.
 * @returns A Hesperia project plugin that provides checked routes and effects.
 */
export function elysia(options: ElysiaOptions): Plugin {
  return configuredElysiaProjectPlugin({
    serverModule: options.serverModule,
    serverExport: options.appExport,
    serverEffectsExport: options.serverEffectsExport,
    clientEffectsModule: options.clientEffectsModule,
    clientEffectsExport: options.clientEffectsExport,
  });
}
