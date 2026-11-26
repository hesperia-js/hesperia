import {
  createGeneratedAssetHost,
  createHost,
  type ApplicationHost,
  type CapturedBrowserBuild,
  type CapturedPublicBuild,
  type GeneratedAssetHost,
  type HostSelection,
  type InProcessTargetedDeploymentCapturedBuildV4,
} from "../../../packages/hosting/src/index.ts";

export type GeneratedAssetCredentials = "anonymous" | "use-credentials";

export type GeneratedAssetCorsPolicy = "allow" | "wrong-origin" | "missing-credentials";

export type GeneratedAssetBase = "same-origin" | "external-a" | "external-b";

export interface GeneratedAssetScenarioInput {
  readonly id: string;
  readonly base: GeneratedAssetBase;
  readonly credentials: GeneratedAssetCredentials;
  readonly corsPolicy?: GeneratedAssetCorsPolicy;
  readonly holdStylesheet?: boolean;
  readonly denyAssetScripts?: boolean;
}

export interface GeneratedAssetProviderEvent {
  readonly kind: "asset" | "seed" | "unmatched";
  readonly path: string;
  readonly method: string;
  readonly origin: string | null;
  readonly syntheticCookiePresent: boolean;
  readonly responseStatus: number;
  readonly contentType: string | null;
  readonly allowOrigin: string | null;
  readonly allowCredentials: string | null;
  readonly corsPolicy: GeneratedAssetCorsPolicy;
  readonly heldForStylesheet: boolean;
  readonly released: boolean;
}

export interface GeneratedAssetApplicationEvent {
  readonly path: string;
  readonly method: string;
  readonly kind: "seed" | "document" | "unclaimed";
  readonly syntheticCookiePresent: boolean;
  readonly status: number;
  readonly contentSecurityPolicy: string | null;
}

export interface GeneratedAssetScenario {
  readonly id: string;
  readonly appOrigin: string;
  readonly assetOrigin: string;
  readonly assetRoot: string;
  readonly assetRootPath: string;
  readonly cookieSeedURL: string;
  readonly sameOrigin: boolean;
  readonly credentials: GeneratedAssetCredentials;
  readonly corsPolicy: GeneratedAssetCorsPolicy;
  readonly applicationEvents: GeneratedAssetApplicationEvent[];
  readonly providerEvents: GeneratedAssetProviderEvent[];
  readonly nativeReferenceEvents: GeneratedAssetProviderEvent[];
  readonly eventOverflow: () => boolean;
  nativeReferenceURL(stage: "script" | "preload"): string;
  waitForStylesheetRequest(timeoutMs?: number): Promise<void>;
  releaseStylesheet(): void;
}

export interface GeneratedAssetProviderFixture {
  readonly appOrigin: string;
  readonly externalAOrigin: string;
  readonly externalBOrigin: string;
  configure(input: GeneratedAssetScenarioInput): Promise<GeneratedAssetScenario>;
  close(): Promise<void>;
}

interface BoundedRows<Row> {
  readonly rows: Row[];
  overflow: boolean;
  bytes: number;
}

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

interface ActiveScenario extends GeneratedAssetScenario {
  readonly applicationHost: ApplicationHost;
  readonly localAssetHost: GeneratedAssetHost;
  readonly externalAssetHost: GeneratedAssetHost;
  readonly externalIndex: 0 | 1 | undefined;
  readonly holdStylesheet: boolean;
  readonly denyAssetScripts: boolean;
  readonly stylesheetRequested: Deferred;
  readonly stylesheetGate: Deferred;
  readonly applicationLog: BoundedRows<GeneratedAssetApplicationEvent>;
  readonly providerLog: BoundedRows<GeneratedAssetProviderEvent>;
  readonly nativeReferenceLog: BoundedRows<GeneratedAssetProviderEvent>;
  readonly nativeReferenceManagedType: string | undefined;
  stylesheetHeld: boolean;
}

interface OwnedServer {
  readonly url: URL;
  stop(closeActiveConnections?: boolean): void | Promise<void>;
}

const syntheticCookieName = "hesperia-generated-assets";
const eventLimit = 512;
const byteLimit = 512 * 1024;

function deferred(): Deferred {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });

  return {
    promise,
    resolve() {
      resolvePromise?.();
      resolvePromise = undefined;
    },
  };
}

function append<Row>(bounded: BoundedRows<Row>, row: Row): void {
  const serialized = JSON.stringify(row);

  if (serialized === undefined) {
    bounded.overflow = true;

    return;
  }

  const size = new TextEncoder().encode(serialized).byteLength;

  if (bounded.rows.length >= eventLimit || bounded.bytes + size > byteLimit) {
    bounded.overflow = true;

    return;
  }

  bounded.rows.push(row);
  bounded.bytes += size;
}

function originAndPath(
  root:
    | { readonly kind: "path"; readonly pathname: string }
    | { readonly kind: "url"; readonly href: string },
  appOrigin: string,
): URL {
  return root.kind === "path" ? new URL(root.pathname, appOrigin) : new URL(root.href);
}

function isBrowserInventory(
  inventory: InProcessTargetedDeploymentCapturedBuildV4["inventory"],
): inventory is CapturedBrowserBuild | CapturedPublicBuild {
  return !("serverFiles" in inventory);
}

function hasSyntheticCookie(request: Request): boolean {
  const cookies = request.headers.get("cookie")?.split(/;\s*/u) ?? [];

  return cookies.includes(`${syntheticCookieName}=present`);
}

function cookieSeedResponse(request: Request): Response {
  const url = new URL(request.url);
  const cookiePath = url.searchParams.get("path") ?? "";

  if (!/^\/[A-Za-z0-9_./-]+\/$/u.test(cookiePath))
    return new Response("Invalid cookie path", { status: 400 });

  return new Response("Cookie seeded", {
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
      "set-cookie": `${syntheticCookieName}=present; Path=${cookiePath}; SameSite=Lax; HttpOnly`,
    },
  });
}

function responseWithHeaders(response: Response, headers: Headers): Response {
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function nativeReferenceSource(
  active: ActiveScenario,
  pathname: string,
): { readonly source: string; readonly contentType: string } | undefined {
  const prefix = `${active.assetRootPath}__hesperia-native-reference/`;

  if (!pathname.startsWith(prefix)) return undefined;

  const parts = pathname.slice(prefix.length).split("/");

  if (parts.length !== 2 || (parts[0] !== "script" && parts[0] !== "preload")) return undefined;

  const contentType =
    parts[0] === "script" && parts[1] === "entry.mjs"
      ? "text/javascript; charset=utf-8"
      : active.nativeReferenceManagedType;

  if (!contentType) throw new Error("The captured JavaScript media type is not unambiguous");

  if (parts[1] === "entry.mjs")
    return {
      source:
        'import "./static.mjs"; globalThis.__hesperiaNativeReferenceEntry = true; await import("./dynamic.mjs"); globalThis.__hesperiaNativeReferenceComplete = true;\n',
      contentType,
    };

  if (parts[1] === "static.mjs")
    return { source: "globalThis.__hesperiaNativeReferenceStatic = true;\n", contentType };
  if (parts[1] === "dynamic.mjs")
    return { source: "globalThis.__hesperiaNativeReferenceDynamic = true;\n", contentType };

  return undefined;
}

async function providerResponse(
  active: ActiveScenario | undefined,
  request: Request,
  host: GeneratedAssetHost | undefined,
  appOrigin: string,
): Promise<Response> {
  const url = new URL(request.url);
  const reference =
    active && host && request.method === "GET"
      ? nativeReferenceSource(active, url.pathname)
      : undefined;
  const referenceBlob =
    reference === undefined
      ? undefined
      : new Blob([reference.source], { type: reference.contentType });
  const response = referenceBlob
    ? new Response(referenceBlob, {
        headers: {
          "content-type": referenceBlob.type,
          "content-length": String(referenceBlob.size),
        },
      })
    : host?.handle(request);

  if (!active || !response) {
    if (active)
      append(active.providerLog, {
        kind: "unmatched",
        path: url.pathname,
        method: request.method,
        origin: request.headers.get("origin"),
        syntheticCookiePresent: hasSyntheticCookie(request),
        responseStatus: 404,
        contentType: null,
        allowOrigin: null,
        allowCredentials: null,
        corsPolicy: active.corsPolicy,
        heldForStylesheet: false,
        released: true,
      });

    return new Response("Not found", { status: 404 });
  }

  const headers = new Headers(response.headers);
  const allowOrigin =
    active.corsPolicy === "wrong-origin" ? "https://wrong-origin.invalid" : appOrigin;

  headers.set("access-control-allow-origin", allowOrigin);
  headers.set("vary", "Origin");

  if (active.corsPolicy !== "missing-credentials")
    headers.set("access-control-allow-credentials", "true");
  else headers.delete("access-control-allow-credentials");

  const event: GeneratedAssetProviderEvent = {
    kind: "asset",
    path: url.pathname,
    method: request.method,
    origin: request.headers.get("origin"),
    syntheticCookiePresent: hasSyntheticCookie(request),
    responseStatus: response.status,
    contentType: headers.get("content-type"),
    allowOrigin: headers.get("access-control-allow-origin"),
    allowCredentials: headers.get("access-control-allow-credentials"),
    corsPolicy: active.corsPolicy,
    heldForStylesheet: false,
    released: true,
  };
  const heldStylesheet =
    active.holdStylesheet &&
    !active.stylesheetHeld &&
    (headers.get("content-type") ?? "").startsWith("text/css");

  if (heldStylesheet) {
    active.stylesheetHeld = true;
    active.stylesheetRequested.resolve();
    Object.assign(event, { heldForStylesheet: true, released: false });
    append(active.providerLog, event);
    await active.stylesheetGate.promise;
    Object.assign(event, { released: true });
  } else append(referenceBlob ? active.nativeReferenceLog : active.providerLog, event);

  return responseWithHeaders(response, headers);
}

async function stopOwnedServers(servers: readonly OwnedServer[]): Promise<void> {
  const results = await Promise.allSettled(servers.map(async (server) => await server.stop(true)));
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );

  if (failures.length)
    throw new AggregateError(failures, "Generated-asset provider cleanup failed");
}

/** Own real Bun Fetch providers for the application root and two external asset bases. */
export async function createGeneratedAssetProviderFixture(
  capture: InProcessTargetedDeploymentCapturedBuildV4,
): Promise<GeneratedAssetProviderFixture> {
  if (!isBrowserInventory(capture.inventory))
    throw new TypeError("Generated-asset provider fixture requires a browser inventory");

  const browserInventory = capture.inventory;
  const servers: OwnedServer[] = [];
  let active: ActiveScenario | undefined;
  let appOrigin = "";
  let appServer: OwnedServer | undefined;
  let providerAServer: OwnedServer | undefined;
  let providerBServer: OwnedServer | undefined;

  try {
    appServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const scenario = active;
        const url = new URL(request.url);
        const cookie = hasSyntheticCookie(request);

        if (url.pathname === "/__seed_generated_asset_cookie") {
          const response = cookieSeedResponse(request);

          if (scenario)
            append(scenario.applicationLog, {
              path: url.pathname,
              method: request.method,
              kind: "seed",
              syntheticCookiePresent: cookie,
              status: response.status,
              contentSecurityPolicy: null,
            });

          return response;
        }

        if (!scenario) return new Response("No active generated-asset scenario", { status: 503 });

        if (url.pathname === "/__hesperia_native_reference" && request.method === "GET") {
          const stage = url.searchParams.get("stage");

          if (stage !== "script" && stage !== "preload") return new Response(null, { status: 404 });

          const entry = `${scenario.assetRoot}__hesperia-native-reference/${stage}/entry.mjs`;
          const element =
            stage === "script"
              ? `<script type="module" crossorigin="${scenario.credentials}" src="${entry}"></script>`
              : `<link rel="modulepreload" crossorigin="${scenario.credentials}" href="${entry}">`;

          return new Response(`<!doctype html><html><head>${element}</head><body></body></html>`, {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }

        if (url.origin === scenario.assetOrigin && url.pathname.startsWith(scenario.assetRootPath))
          return providerResponse(scenario, request, scenario.localAssetHost, appOrigin);

        const response = scenario.applicationHost.handle(request);

        if (!response) {
          append(scenario.applicationLog, {
            path: url.pathname,
            method: request.method,
            kind: "unclaimed",
            syntheticCookiePresent: cookie,
            status: 404,
            contentSecurityPolicy: null,
          });

          return new Response("Not found", { status: 404 });
        }

        const headers = new Headers(response.headers);
        let policy: string | null = null;

        if (scenario.denyAssetScripts) {
          policy =
            "default-src 'none'; script-src 'self'; style-src 'self'; frame-ancestors 'self'";
          headers.set("content-security-policy", policy);
        }

        append(scenario.applicationLog, {
          path: url.pathname,
          method: request.method,
          kind: "document",
          syntheticCookiePresent: cookie,
          status: response.status,
          contentSecurityPolicy: policy,
        });

        return policy === null ? response : responseWithHeaders(response, headers);
      },
    });
    servers.push(appServer);
    appOrigin = appServer.url.origin;

    providerAServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);

        if (url.pathname === "/__seed_generated_asset_cookie") {
          if (!active) return new Response("No active generated-asset scenario", { status: 503 });

          const response = cookieSeedResponse(request);

          append(active.providerLog, {
            kind: "seed",
            path: url.pathname,
            method: request.method,
            origin: request.headers.get("origin"),
            syntheticCookiePresent: hasSyntheticCookie(request),
            responseStatus: response.status,
            contentType: response.headers.get("content-type"),
            allowOrigin: null,
            allowCredentials: null,
            corsPolicy: active.corsPolicy,
            heldForStylesheet: false,
            released: true,
          });

          return response;
        }

        return providerResponse(
          active,
          request,
          active?.externalIndex === 0 ? active.externalAssetHost : undefined,
          appOrigin,
        );
      },
    });
    servers.push(providerAServer);

    providerBServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);

        if (url.pathname === "/__seed_generated_asset_cookie") {
          if (!active) return new Response("No active generated-asset scenario", { status: 503 });

          const response = cookieSeedResponse(request);

          append(active.providerLog, {
            kind: "seed",
            path: url.pathname,
            method: request.method,
            origin: request.headers.get("origin"),
            syntheticCookiePresent: hasSyntheticCookie(request),
            responseStatus: response.status,
            contentType: response.headers.get("content-type"),
            allowOrigin: null,
            allowCredentials: null,
            corsPolicy: active.corsPolicy,
            heldForStylesheet: false,
            released: true,
          });

          return response;
        }

        return providerResponse(
          active,
          request,
          active?.externalIndex === 1 ? active.externalAssetHost : undefined,
          appOrigin,
        );
      },
    });
    servers.push(providerBServer);
  } catch (cause) {
    try {
      await stopOwnedServers(servers);
    } catch (cleanupCause) {
      throw new AggregateError(
        [cause, cleanupCause],
        "Generated-asset provider setup and cleanup failed",
      );
    }

    throw cause;
  }

  if (!appServer || !providerAServer || !providerBServer)
    throw new Error("Generated-asset provider listener setup was incomplete");

  const applicationOrigin = appServer.url.origin;
  const externalAOrigin = providerAServer.url.origin;
  const externalBOrigin = providerBServer.url.origin;

  return {
    appOrigin: applicationOrigin,
    externalAOrigin,
    externalBOrigin,
    async configure(input) {
      active?.releaseStylesheet();

      const externalIndex: 0 | 1 | undefined =
        input.base === "external-a" ? 0 : input.base === "external-b" ? 1 : undefined;
      const externalOrigin =
        externalIndex === 0 ? externalAOrigin : externalIndex === 1 ? externalBOrigin : undefined;
      const generatedAssets = externalOrigin
        ? input.credentials === "use-credentials"
          ? {
              baseURL: `${externalOrigin}/generated-${externalIndex === 0 ? "a" : "b"}/`,
              moduleCredentials: "use-credentials" as const,
            }
          : { baseURL: `${externalOrigin}/generated-${externalIndex === 0 ? "a" : "b"}/` }
        : input.base === "same-origin" && input.credentials === "use-credentials"
          ? { moduleCredentials: "use-credentials" as const }
          : undefined;
      const selection: HostSelection | undefined = generatedAssets
        ? { mountURL: "/", generatedAssets }
        : undefined;
      const applicationHost = await createHost(browserInventory, selection);
      const localAssetHost = await createGeneratedAssetHost(capture, selection);
      const externalAssetHost = localAssetHost;
      const root = originAndPath(applicationHost.generatedAssets.root, applicationOrigin);
      const assetHostRoot = originAndPath(localAssetHost.generatedAssets.root, applicationOrigin);
      const expectedRoot = externalOrigin
        ? `${externalOrigin}/generated-${externalIndex === 0 ? "a" : "b"}/`
        : `${applicationOrigin}/_hesperia/`;

      if (root.href !== assetHostRoot.href || root.href !== expectedRoot)
        throw new TypeError("Application and generated-asset hosts do not share the selected root");

      if (externalOrigin && root.origin !== externalOrigin)
        throw new TypeError("Selected external asset root does not match its owned listener");

      const applicationEvents: GeneratedAssetApplicationEvent[] = [];
      const providerEvents: GeneratedAssetProviderEvent[] = [];
      const nativeReferenceEvents: GeneratedAssetProviderEvent[] = [];
      const managedJavaScriptTypes = new Set(
        browserInventory.hosting.assets
          .filter((asset) => asset.contentType.includes("javascript"))
          .map((asset) => asset.contentType),
      );
      const applicationLog: BoundedRows<GeneratedAssetApplicationEvent> = {
        rows: applicationEvents,
        overflow: false,
        bytes: 0,
      };
      const providerLog: BoundedRows<GeneratedAssetProviderEvent> = {
        rows: providerEvents,
        overflow: false,
        bytes: 0,
      };
      const nativeReferenceLog: BoundedRows<GeneratedAssetProviderEvent> = {
        rows: nativeReferenceEvents,
        overflow: false,
        bytes: 0,
      };
      const stylesheetRequested = deferred();
      const stylesheetGate = deferred();
      const seedURL = new URL("/__seed_generated_asset_cookie", root.origin);
      seedURL.searchParams.set("path", root.pathname);
      const current: ActiveScenario = {
        id: input.id,
        appOrigin: applicationOrigin,
        assetOrigin: root.origin,
        assetRoot: root.href,
        assetRootPath: root.pathname,
        cookieSeedURL: seedURL.href,
        sameOrigin: root.origin === applicationOrigin,
        credentials: input.credentials,
        corsPolicy: input.corsPolicy ?? "allow",
        applicationEvents,
        providerEvents,
        nativeReferenceEvents,
        applicationHost,
        localAssetHost,
        externalAssetHost,
        externalIndex,
        holdStylesheet: input.holdStylesheet === true,
        denyAssetScripts: input.denyAssetScripts === true,
        stylesheetRequested,
        stylesheetGate,
        stylesheetHeld: false,
        applicationLog,
        providerLog,
        nativeReferenceLog,
        nativeReferenceManagedType:
          managedJavaScriptTypes.size === 1 ? [...managedJavaScriptTypes][0] : undefined,
        eventOverflow: () =>
          applicationLog.overflow || providerLog.overflow || nativeReferenceLog.overflow,
        nativeReferenceURL(stage) {
          const url = new URL("/__hesperia_native_reference", applicationOrigin);

          url.searchParams.set("stage", stage);

          return url.href;
        },
        async waitForStylesheetRequest(timeoutMs = 10_000) {
          let timeout: ReturnType<typeof setTimeout> | undefined;

          try {
            await Promise.race([
              stylesheetRequested.promise,
              new Promise<never>((_, reject) => {
                timeout = setTimeout(
                  () =>
                    reject(
                      new Error(`No generated stylesheet request arrived within ${timeoutMs} ms`),
                    ),
                  timeoutMs,
                );
              }),
            ]);
          } finally {
            if (timeout !== undefined) clearTimeout(timeout);
          }
        },
        releaseStylesheet() {
          stylesheetGate.resolve();
        },
      };

      active = current;

      return current;
    },
    async close() {
      active?.releaseStylesheet();
      await stopOwnedServers(servers);
    },
  };
}
