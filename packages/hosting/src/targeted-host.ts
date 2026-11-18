import type { InProcessTargetedCapturedBuild } from "./build-control.ts";
import {
  captureInput,
  resolveMountPath,
  validateAssets,
  validateTargetedCapturedBuild,
} from "./captured-build.ts";
import { snapshotHostSelection } from "./host-selection.ts";
import {
  createHost,
  type ApplicationHost,
  type AsyncServerApplicationHost,
  type CapturedBrowserBuild,
  type HostSelection,
} from "./index.ts";
import { resolveCapturedProductionTarget } from "./target-profile.ts";
import {
  classifyBrowserStaticPath,
  readBrowserStaticRouting,
  type BrowserStaticRoutingV1,
} from "./static-routing.ts";

/** A gated target host and the lifetime of its admitted response work. */
export type TargetedHostResource =
  | {
      /** Browser artifacts served without evaluating an application server entry. */
      readonly kind: "browser";
      /** Host whose copied handler references share this resource's admission gate. */
      readonly host: ApplicationHost;
      /**
       * Close admission synchronously and await response completion or cancellation.
       * Repeated calls return the same promise, including a retained drain failure.
       * Callers must consume or cancel returned bodies before awaiting completion.
       * @returns The cached drain promise, rejecting with original cleanup failures.
       */
      close(): Promise<void>;
    }
  | {
      /** Server resource reserved for an implemented owned native target. */
      readonly kind: "server";
      /** Host whose admitted requests and bodies belong to the selected native owner. */
      readonly host: AsyncServerApplicationHost;
      /**
       * Close admission and await the owned request, response and loader drain.
       * @returns The cached completion, including any retained cleanup rejection.
       */
      close(): Promise<void>;
    };

/**
 * Validate an in-process production capture and construct its owned target host.
 * @param build - Correlated control and captured inventory, excluding workerd packages.
 * @param selection - Optional application mount selection, canonicalized before verification.
 * @returns The admitted browser resource; native profiles require their owned implementation.
 * @throws TypeError through rejection for malformed captures, unavailable profiles or selections.
 * Artifact verification failures retain their original rejection. Native evaluation requires
 * the matching available profile and actual runtime after verification.
 */
export async function createTargetedHost(
  build: InProcessTargetedCapturedBuild,
  selection?: HostSelection,
): Promise<TargetedHostResource> {
  const selected = snapshotHostSelection(selection);
  const captured = await validateTargetedCapturedBuild(build);
  const binding = captured.control.productionTarget;

  if (binding.declaration.runtime === "workerd")
    throw new TypeError("workerd builds require their separate worker package and preview owner");

  const profile = resolveCapturedProductionTarget(binding);

  if (profile.kind === "unavailable")
    throw new TypeError(
      `production-target-unavailable: ${profile.binding.descriptorIdentity}: ${profile.missingImplementation}`,
    );

  if (
    captured.control.kind !== "browser" ||
    "serverFiles" in captured.inventory ||
    profile.moduleABI !== "browser-static-directory-v1" ||
    !profile.capabilities.clientRender ||
    !profile.capabilities.supportedPlans.some(
      (plan) =>
        plan.producer === "csr" && plan.activation === "mount" && plan.delivery === "complete",
    )
  )
    throw new TypeError(
      "browser/static requires its complete CSR/mount capability and browser inventory",
    );

  const routing = await readBrowserStaticRouting(captured.inventory);

  return browserResource(await createHost(captured.inventory, selected), routing);
}

/**
 * Own retained production bytes without claiming old documents or public files.
 * @param build - Strict managed-only V1 projection from the retained capture reader.
 * @param selection - Optional explicit mount, captured before byte verification.
 * @returns A browser resource claiming only the selected reserved managed namespace.
 * @throws TypeError through rejection for invalid or non-production V1 inventories.
 * Byte failures retain their original cause. No application entry is evaluated.
 * @internal
 */
export async function createRetainedManagedHost(
  build: CapturedBrowserBuild,
  selection?: HostSelection,
): Promise<Extract<TargetedHostResource, { readonly kind: "browser" }>> {
  const selected = snapshotHostSelection(selection);
  const captured = captureInput(build, selected);

  if (captured.version !== 1 || captured.mode !== "production")
    throw new TypeError("Retained managed hosting requires a production V1 inventory projection");

  resolveMountPath(captured);

  const assets = await validateAssets(captured);
  const inventory: CapturedBrowserBuild = {
    hosting: {
      version: 1,
      mode: "production",
      standaloneMountURL: captured.standaloneMountURL as string,
      startupAsset: captured.startupAsset as string,
      assets: captured.assets.map((asset) => ({
        path: asset.path as string,
        sha256: asset.sha256 as string,
        contentType: asset.contentType as string,
      })),
    },
    files: new Map([...assets].map(([path, asset]) => [path, asset.blob])),
  };

  return browserResource(await createHost(inventory, selected), "managed");
}

function browserResource(
  host: ApplicationHost,
  routing: BrowserStaticRoutingV1 | "managed",
): Extract<TargetedHostResource, { readonly kind: "browser" }> {
  const mount = host.mount;
  let open = true;
  let active = 0;
  let retained: ApplicationHost | undefined = host;
  let closing: Promise<void> | undefined;
  let resolveClose: (() => void) | undefined;
  let rejectClose: ((cause: unknown) => void) | undefined;
  const drainFailures: unknown[] = [];

  const finishClose = (): void => {
    if (open || active !== 0 || !resolveClose) return;

    const resolve = resolveClose;
    const reject = rejectClose!;
    resolveClose = undefined;
    rejectClose = undefined;

    if (drainFailures.length) {
      reject(
        drainFailures.length === 1
          ? drainFailures[0]
          : new AggregateError(drainFailures, "Targeted browser host drain failed"),
      );

      return;
    }

    retained = undefined;

    resolve();
  };

  const ownResponse = (response: Response, release: () => void): Response => {
    const reader = response.body!.getReader();
    let finished = false;
    let cancelling = false;

    const finish = (): void => {
      if (finished) return;

      finished = true;

      try {
        reader.releaseLock();
      } catch (cause) {
        drainFailures.push(cause);
      }

      release();
    };

    const body = new ReadableStream({
      type: "bytes",
      async pull(controller) {
        try {
          const chunk = await reader.read();

          if (cancelling) return;

          if (chunk.done) {
            controller.close();

            // A pending BYOB read needs its terminal response after close.
            controller.byobRequest?.respond(0);

            finish();
          } else controller.enqueue(new Uint8Array(chunk.value));
        } catch (cause) {
          if (cancelling) return;

          controller.error(cause);

          finish();
        }
      },
      async cancel(reason) {
        cancelling = true;

        try {
          await reader.cancel(reason);
        } catch (cause) {
          drainFailures.push(cause);

          throw cause;
        } finally {
          finish();
        }
      },
    });

    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };

  const gated: ApplicationHost = Object.freeze({
    mount,
    handle(request: Request): Response | undefined {
      if (!open) throw new TypeError("The targeted host is closed");

      active++;
      let released = false;
      let transferred = false;

      const release = (): void => {
        if (released) return;

        released = true;
        active--;

        finishClose();
      };

      try {
        const url = new URL(request.url);
        const path =
          routing === "managed"
            ? {
                kind:
                  url.pathname === mount.assetPath || url.pathname.startsWith(`${mount.assetPath}/`)
                    ? ("managed" as const)
                    : ("outside" as const),
              }
            : classifyBrowserStaticPath(routing, url, mount.pathname);

        if (path.kind === "outside") return undefined;

        let response = retained!.handle(request);

        if (path.kind === "missing-page" && response !== undefined)
          response = new Response(response.body, {
            status: path.status,
            statusText: "Not Found",
            headers: response.headers,
          });

        if (response === undefined || response.body === null) return response;

        const tracked = ownResponse(response, release);
        transferred = true;

        return tracked;
      } finally {
        if (!transferred) release();
      }
    },
  });

  return Object.freeze({
    kind: "browser" as const,
    host: gated,
    close(): Promise<void> {
      if (closing) return closing;

      open = false;
      closing = new Promise<void>((resolve, reject) => {
        resolveClose = resolve;
        rejectClose = reject;
      });

      finishClose();

      return closing;
    },
  });
}
