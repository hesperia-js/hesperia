import type { ClientApp } from "./src/client-types";
import { routes } from "hesperia:plugin/elysia/app-routes";

// eslint-disable-next-line no-unused-vars -- Keep the configured App type alias in the analysis input.
type ConfiguredApp = ClientApp;

const routeCapture = globalThis as typeof globalThis & {
  __hesperiaConfiguredElysiaRoutesR16?: unknown;
};

routeCapture.__hesperiaConfiguredElysiaRoutesR16 = routes;

export default function AppShell() {
  // prettier-ignore
  return <html><head></head><body><h1>Elysia route analysis</h1></body></html>;
}
