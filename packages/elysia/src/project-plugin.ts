import { fileURLToPath } from "node:url";
import type { Plugin, PluginProjectDeclaration } from "@hesperia/tooling/project-service";
import {
  analyzeConfiguredApp,
  appRoutesModuleId,
  type ConfiguredAppBinding,
} from "./app-analysis.ts";
import { analyzeConfiguredEffects, type ConfiguredEffectExports } from "./effect-analysis.ts";
import { appEffectsModuleId } from "./effect-facts.ts";

const declarationCode = `declare module "${appRoutesModuleId}" {
  export interface Route {
    readonly method: string;
    readonly path: string;
  }
  export const routes: readonly Route[];
}
`;

const effectsDeclarationCode = `declare module "${appEffectsModuleId}" {
  export interface Effect {
    readonly source: { readonly method: string; readonly path: string };
    readonly target: { readonly method: string; readonly path: string };
    readonly select: (input: {
      readonly params?: Readonly<Record<string, string | number>>;
      readonly body?: unknown;
      readonly query?: unknown;
      readonly headers?: unknown;
    }) => unknown;
    readonly on: "invalidate" | "revalidate";
  }
  export const effects: readonly Effect[];
}
`;

/**
 * Create the private Plugin consumed by configured project compilation.
 *
 */
export function configuredElysiaProjectPlugin(
  binding: ConfiguredAppBinding & ConfiguredEffectExports,
): Plugin {
  const declaration: PluginProjectDeclaration = {
    id: appRoutesModuleId,
    code: declarationCode,
    origin: { filename: fileURLToPath(import.meta.url), start: 0, end: 0 },
  };
  const effectsDeclaration: PluginProjectDeclaration = {
    id: appEffectsModuleId,
    code: effectsDeclarationCode,
    origin: declaration.origin,
  };

  return {
    name: "@hesperia/elysia",
    projectSources: [
      binding.serverModule,
      ...(binding.clientEffectsModule !== undefined ? [binding.clientEffectsModule] : []),
    ],
    projectDeclarations: [declaration, effectsDeclaration],

    async analyzeProject(input) {
      const analysis = await analyzeConfiguredApp(input, binding);
      const effects = await analyzeConfiguredEffects(input, binding, analysis.routes);
      const result = {
        browserModules: [
          ...(analysis.result.browserModules ?? []),
          ...(effects.browserModules ?? []),
        ],
        diagnostics: [...(analysis.result.diagnostics ?? []), ...(effects.diagnostics ?? [])],
        watch: [...(analysis.result.watch ?? []), ...(effects.watch ?? [])],
      };
      const unsupportedRoutes = analysis.routes.filter(
        (route) =>
          route.method.toUpperCase() === "SUBSCRIBE" ||
          (route.method.toUpperCase() === "GET" && route.path === "/subscribe"),
      );
      const reservedSubscribeRoutes = analysis.routes.filter(
        (route) =>
          route.path.split("/").includes("subscribe") &&
          !(route.method.toUpperCase() === "GET" && route.path === "/subscribe"),
      );

      if (
        unsupportedRoutes.length === 0 &&
        reservedSubscribeRoutes.length === 0 &&
        analysis.streamingResponses.length === 0
      )
        return result;

      return {
        ...result,
        diagnostics: [
          ...result.diagnostics,
          ...unsupportedRoutes.map((route) => ({
            severity: "error" as const,
            origin: analysis.origin,
            message:
              route.method.toUpperCase() === "SUBSCRIBE"
                ? `HTTP SUBSCRIBE route ${route.path} cannot be adapted through @elysia/eden: Treaty reserves ".subscribe()" for WebSocket transport. ` +
                  "HTTP SUBSCRIBE support is a work in progress pending a distinct transport design."
                : 'HTTP GET route /subscribe cannot be adapted through @elysia/eden: Treaty\'s checked client types reserve the "subscribe" property for WebSocket transport. ' +
                  "The GET /subscribe collision is a work in progress pending milestone-three design.",
          })),
          ...reservedSubscribeRoutes.map((route) => ({
            severity: "error" as const,
            origin: analysis.origin,
            message:
              `HTTP ${route.method} route ${route.path} cannot be adapted through @elysia/eden: ` +
              'Treaty reserves the exact "subscribe" path segment for WebSocket transport. ' +
              "Support for this collision is a work in progress pending milestone-three design.",
          })),
          ...analysis.streamingResponses.map((route) => ({
            severity: "error" as const,
            origin: analysis.origin,
            message:
              `HTTP ${route.method} route ${route.path} has a streaming success response at ` +
              `status ${route.statuses.join(", ")}; @hesperia/elysia does not support HTTP ` +
              "streaming responses yet. Streaming response support is a work in progress.",
          })),
        ],
      };
    },
  };
}
