import type { RoutePlanCapabilitiesV1 } from "./route-capabilities.ts";
import {
  snapshotCapturedProductionTarget,
  snapshotOwnedProductionTarget,
  type CapturedProductionTargetV1,
  type OwnedProductionTargetV1,
} from "./target.ts";

/** A recognized target whose owned implementation is not yet available. */
export interface UnavailableProductionTarget {
  /** Admission must fail rather than select another target. */
  readonly kind: "unavailable";
  /** The validated declaration and descriptor identity. */
  readonly binding: CapturedProductionTargetV1;
  /** The missing owned composition, without invented capability tuples. */
  readonly missingImplementation: string;
}

/** An available composition must preserve the descriptor's correlated module ABI. */
type AvailableProductionTarget<Target extends OwnedProductionTargetV1 = OwnedProductionTargetV1> =
  Target extends OwnedProductionTargetV1
    ? {
        /** Admission may continue through the implemented owned composition. */
        readonly kind: "available";
        /** The validated declaration and descriptor identity. */
        readonly binding: Target["binding"];
        /** Actual renderer/host/loader facts supplied by their implementation owners. */
        readonly capabilities: RoutePlanCapabilitiesV1;
        /** The module contract fixed by this exact descriptor. */
        readonly moduleABI: Target["moduleABI"];
      }
    : never;

/** Internal target admission result; recognition alone supplies no executable capability. */
export type ResolvedProductionTarget = UnavailableProductionTarget | AvailableProductionTarget;

const missingImplementations: Readonly<
  Record<
    Exclude<CapturedProductionTargetV1["descriptorIdentity"], "hesperia.target/browser-static/1">,
    string
  >
> = Object.freeze({
  "hesperia.target/node-fetch/1":
    "The Node loader, host resource lifetime and renderer capability composition are not implemented as a target profile.",
  "hesperia.target/workerd-module-worker/1":
    "The target-safe worker host, binary carrier codec, module packager and native preview owner are not implemented as a target profile.",
  "hesperia.target/bun-elysia/1":
    "The Bun/Elysia loader, native host resource lifetime and renderer capability composition are not implemented as a target profile.",
  "hesperia.target/bun-hono/1":
    "The Bun/Hono loader, native host resource lifetime and renderer capability composition are not implemented as a target profile.",
});

const browserStaticCapabilities: RoutePlanCapabilitiesV1 = Object.freeze({
  version: 1,
  identity: "hesperia.target/browser-static/1",
  provenance: [
    "packages/tooling/src/startup.ts browserStartupSource",
    "packages/hesperia/src/runtime/application.ts bootstrapApplication",
    "packages/hesperia/src/runtime/dom.ts prepareTree",
    "packages/hosting/src/targeted-host.ts createTargetedHost",
  ].join("; "),
  clientRender: true,
  supportedPlans: Object.freeze([
    Object.freeze({
      producer: "csr" as const,
      activation: "mount" as const,
      delivery: "complete" as const,
      hydrationMismatch: "client-remount" as const,
    }),
  ]),
});

/**
 * Resolve a declaration against the closed owned profile facts.
 *
 * Browser/static supplies its implemented complete CSR/mount composition.
 * Other recognized profiles remain unavailable. No author capability object,
 * runtime inference or loader fallback participates in this lookup.
 *
 * @param declaration - Explicit target to normalize before admission.
 * @returns The immutable admission result for that exact descriptor.
 * @throws TypeError for a malformed or unsupported declaration.
 */
export function resolveProductionTarget(declaration: unknown): ResolvedProductionTarget {
  return resolveOwnedTarget(snapshotOwnedProductionTarget(declaration));
}

/**
 * Validate a captured binding before resolving its owned profile facts.
 * @param binding - Captured target whose identity/revision must match its declaration.
 * @returns The immutable admission result without changing the captured target.
 * @throws TypeError for malformed, unsupported or crossed captured fields.
 */
export function resolveCapturedProductionTarget(binding: unknown): ResolvedProductionTarget {
  const captured = snapshotCapturedProductionTarget(binding);

  return resolveOwnedTarget(snapshotOwnedProductionTarget(captured.declaration));
}

function resolveOwnedTarget(target: OwnedProductionTargetV1): ResolvedProductionTarget {
  if (target.moduleABI === "browser-static-directory-v1")
    return Object.freeze({
      kind: "available" as const,
      binding: target.binding,
      capabilities: browserStaticCapabilities,
      moduleABI: target.moduleABI,
    });

  return Object.freeze({
    kind: "unavailable" as const,
    binding: target.binding,
    missingImplementation: missingImplementations[target.binding.descriptorIdentity],
  });
}
