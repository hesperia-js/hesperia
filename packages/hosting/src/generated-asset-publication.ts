import type { ResolvedGeneratedAssets } from "hesperia/runtime";
import { classifyBrowserStaticPath, type BrowserStaticRoutingV1 } from "./static-routing.ts";

/** The deployment needs an application-origin owner to settle a path overlap. @internal */
export class AmbiguousGeneratedDestinationError extends TypeError {}

/** Reject concrete generated destinations that conflict with the selected application. @internal */
export function assertGeneratedAssetPublication(
  mountPathname: string,
  generatedAssets: ResolvedGeneratedAssets,
  assets: ReadonlyMap<string, unknown>,
  publicFiles: ReadonlyMap<string, unknown>,
  applicationOrigin?: string,
  routing?: BrowserStaticRoutingV1,
): void {
  const root = generatedAssets.root;
  const rootURL = root.kind === "url" ? new URL(root.href) : undefined;
  const directory = root.kind === "path" ? root.pathname : rootURL!.pathname;
  const origin = rootURL?.origin ?? applicationOrigin ?? "https://hesperia.invalid";
  const mountPrefix = mountPathname === "/" ? "" : mountPathname;
  const publicPaths = new Set([...publicFiles.keys()].map((path) => `${mountPrefix}${path}`));
  const generatedPaths = [
    `${directory}startup.js`,
    ...[...assets.keys()].map((path) => `${directory}${path.slice(1)}`),
  ];

  if (rootURL && applicationOrigin === undefined) {
    for (const pathname of publicPaths) {
      if (pathname.startsWith(`${directory}assets/`))
        throw new AmbiguousGeneratedDestinationError(
          `applicationOrigin is required for ambiguous public destination: ${pathname}`,
        );
    }
  }

  for (const pathname of generatedPaths) {
    const destination = new URL(origin);

    destination.pathname = pathname;
    const route = routing && classifyBrowserStaticPath(routing, destination, mountPathname);
    const publicCollision = publicPaths.has(pathname);

    if (!publicCollision && route?.kind !== "page") continue;

    if (rootURL && applicationOrigin === undefined)
      throw new AmbiguousGeneratedDestinationError(
        `applicationOrigin is required for ambiguous generated destination: ${pathname}`,
      );

    if (!rootURL || rootURL.origin === applicationOrigin)
      throw new TypeError(
        `Generated resource collides with ${publicCollision ? "captured public file" : "captured page"}: ${pathname}`,
      );
  }
}
