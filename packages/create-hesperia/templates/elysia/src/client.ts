import { treaty } from "@elysia/eden";
import { withAeolia } from "@hesperia/elysia/client";
import type { App } from "./server.ts";

export const api = withAeolia(treaty<App>(globalThis.location.origin));
