import { routes } from "hesperia:plugin/elysia/app-routes";
import { effects } from "hesperia:plugin/elysia/app-effects";
import { createElysiaHttpApi } from "./http-adapter.ts";
import type { ElysiaHttpApi } from "./http-adapter.ts";

/**
 * Adapt a native Eden client for the Elysia App configured by the
 * `@hesperia/elysia` project plugin.
 *
 * Call this with an Eden Treaty value whose checked `App` type resolves to the
 * configured server export. The returned graph is shared by this API instance;
 * multiple calls create independent graphs over the same checked route facts.
 * Hesperia's compiler validates the association and supplies browser-safe route
 * metadata and configured browser-safe effect selectors. The server App is
 * analyzed for types and is never executed during compilation.
 *
 * @param client - Native Eden client created for the configured Elysia App.
 * @returns A Treaty-shaped API whose data members are projected to each
 *   consuming component owner.
 * @throws {TypeError} If the checked route metadata contains duplicate routes
 *   or an HTTP `SUBSCRIBE` route, which Eden reserves for WebSocket transport,
 *   or an effect declaration contains invalid route references.
 */
export function withAeolia<Client extends object>(client: Client): ElysiaHttpApi<Client> {
  return createElysiaHttpApi(client, routes, effects);
}

export type { ElysiaHttpApi } from "./http-adapter.ts";
