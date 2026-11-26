import type { ConcreteRoutePlan, RoutePlanCapabilitiesV1 } from "@hesperia/hosting";

export type { ConcreteRoutePlan, RoutePlanCapabilitiesV1 } from "@hesperia/hosting";

/** A normalized route-render constraint value. */
export type RouteRenderConstraint = "required" | "optional" | "forbidden";

/** One of the five route-render fields resolved by this module. */
export type RouteRenderField = "clientRender" | "ssr" | "stream" | "ssg" | "hydration";

/** A normalized constraint with the source that declared it. */
export interface SourcedRouteRenderConstraint {
  /** The literal route-render constraint. */
  readonly value: RouteRenderConstraint;
  /** Non-empty provenance for the normalized declaration. */
  readonly source: string;
}

/** Partial facts for one route layer; omitted fields remain missing during inheritance. */
export interface SourcedRouteRenderPolicy {
  /** Browser rendering capability constraint. */
  readonly clientRender?: SourcedRouteRenderConstraint;
  /** Request-time rendering constraint. */
  readonly ssr?: SourcedRouteRenderConstraint;
  /** Progressive response-delivery constraint. */
  readonly stream?: SourcedRouteRenderConstraint;
  /** Static rendering constraint. */
  readonly ssg?: SourcedRouteRenderConstraint;
  /** Client adoption of an SSR or SSG result. */
  readonly hydration?: SourcedRouteRenderConstraint;
}

/** One sourced fact retained while resolving a route layer. */
export interface RouteRenderFactProvenance {
  /** The route layer index in the root-to-leaf input sequence. */
  readonly layer: number;
  /** The literal fact from that layer. */
  readonly value: RouteRenderConstraint;
  /** Source of the normalized fact. */
  readonly source: string;
}

/** The intersected value for one field and every input fact that produced it. */
export interface EffectiveRouteRenderConstraint {
  /** `missing` means no layer declared the field; `conflict` means required and forbidden both occur. */
  readonly value: RouteRenderConstraint | "missing" | "conflict";
  /** All sourced facts in root-to-leaf order, including optional facts. */
  readonly facts: readonly RouteRenderFactProvenance[];
}

/** Effective values and provenance for the five inherited route-render fields. */
export interface EffectiveRouteRenderPolicy {
  /** Effective browser-rendering constraint. */
  readonly clientRender: EffectiveRouteRenderConstraint;
  /** Effective request-time-rendering constraint. */
  readonly ssr: EffectiveRouteRenderConstraint;
  /** Effective progressive-delivery constraint. */
  readonly stream: EffectiveRouteRenderConstraint;
  /** Effective static-rendering constraint. */
  readonly ssg: EffectiveRouteRenderConstraint;
  /** Effective hydration constraint. */
  readonly hydration: EffectiveRouteRenderConstraint;
}

/** Snapshot of normalized constraints and the declared target capabilities used for resolution. */
export interface RoutePlanInputSnapshot {
  /** Intersected constraints with every supplied source fact retained. */
  readonly constraints: EffectiveRouteRenderPolicy;
  /** Cloned, validated capability descriptor and supported plan tuples. */
  readonly capabilities: RoutePlanCapabilitiesV1;
}

/** A deterministic reason that valid input facts cannot produce a plan. */
export type RoutePlanDiagnostic =
  | { readonly code: "missing-constraint"; readonly field: RouteRenderField }
  | {
      readonly code: "required-forbidden-conflict";
      readonly field: RouteRenderField;
      readonly requiredSources: readonly string[];
      readonly forbiddenSources: readonly string[];
    }
  | {
      readonly code: "hydration-needs-allowed-producer";
      readonly hydrationSources: readonly string[];
      readonly ssrForbiddenSources: readonly string[];
      readonly ssgForbiddenSources: readonly string[];
    }
  | {
      readonly code: "stream-needs-allowed-ssr";
      readonly streamSources: readonly string[];
      readonly ssrForbiddenSources: readonly string[];
    }
  | { readonly code: "no-supported-plan"; readonly capabilityIdentity: string };

interface RoutePlanEvidence {
  readonly input: RoutePlanInputSnapshot;
}

/** Resolution outcome for this five-field predicate; it does not establish full route acceptance. */
export type RoutePlanResolution =
  | (RoutePlanEvidence & { readonly kind: "admissible-plan"; readonly plan: ConcreteRoutePlan })
  | (RoutePlanEvidence & {
      readonly kind: "ambiguous";
      readonly candidates: readonly ConcreteRoutePlan[];
    })
  | (RoutePlanEvidence & {
      readonly kind: "no-plan";
      readonly diagnostics: readonly RoutePlanDiagnostic[];
    });

const fields: readonly RouteRenderField[] = ["clientRender", "ssr", "stream", "ssg", "hydration"];

const constraintValues: readonly RouteRenderConstraint[] = ["required", "optional", "forbidden"];

/**
 * Resolve inherited normalized constraints against an explicit target capability declaration.
 *
 * `inherited` is ordered from root to leaf. Missing fields remain missing and cause `no-plan`;
 * this function never creates optional facts or chooses an implicit root policy. Capability tuples
 * supply the producer, activation, delivery, and `hydrationMismatch` values. The resolver does not
 * infer target support or choose a mismatch action. Q208 prefers progressive only when complete
 * and progressive SSR tuples differ solely in delivery. Distinct producers, activations, or
 * mismatch actions remain ambiguous.
 *
 * This predicate resolves only the five supplied route-render fields. It does not inspect route
 * files or establish contextual A31 conditions such as `+route.ts` SSG eligibility, request-private
 * ancestor data, or static build policy. Those facts remain the caller's responsibility.
 *
 * The descriptor is caller-supplied input. This function checks its shape and legal tuple pairings;
 * it does not verify that a runtime or host actually provides the declared capabilities. The
 * caller remains responsible for target qualification.
 *
 * @throws {TypeError} If normalized facts or the versioned capability descriptor are malformed,
 * including unsupported projection pairings or a target tuple that requires unavailable client
 * rendering. Valid but missing, conflicting, or unsupported constraints return `no-plan`.
 */
export function resolveRoutePlan(
  inherited: readonly SourcedRouteRenderPolicy[],
  capabilities: RoutePlanCapabilitiesV1,
): RoutePlanResolution {
  const capabilitySnapshot = snapshotCapabilities(capabilities);
  const constraintSnapshot = resolveConstraints(inherited);
  const input = Object.freeze({
    constraints: constraintSnapshot,
    capabilities: capabilitySnapshot,
  });
  const diagnostics = constraintDiagnostics(constraintSnapshot);

  if (diagnostics.length > 0) return noPlan(input, diagnostics);

  const policyDiagnostics = crossFieldDiagnostics(constraintSnapshot);

  if (policyDiagnostics.length > 0) return noPlan(input, policyDiagnostics);

  const candidates = capabilitySnapshot.supportedPlans.filter((plan) =>
    satisfiesPolicy(plan, constraintSnapshot, capabilitySnapshot),
  );
  const preferred = preferProgressiveSSR(candidates, constraintSnapshot.stream.value);

  if (preferred.length === 0)
    return noPlan(input, [
      { code: "no-supported-plan", capabilityIdentity: capabilitySnapshot.identity },
    ]);

  if (preferred.length === 1)
    return Object.freeze({ kind: "admissible-plan" as const, input, plan: preferred[0]! });

  return Object.freeze({ kind: "ambiguous" as const, input, candidates: Object.freeze(preferred) });
}

function snapshotCapabilities(value: RoutePlanCapabilitiesV1): RoutePlanCapabilitiesV1 {
  const descriptor = asRecord(value, "capabilities");
  assertExactKeys(
    descriptor,
    ["version", "identity", "provenance", "clientRender", "supportedPlans"],
    "capabilities",
  );

  if (descriptor.version !== 1) throw new TypeError("unsupported route-plan capability version");

  const identity = nonEmptyString(descriptor.identity, "capabilities.identity");
  const provenance = nonEmptyString(descriptor.provenance, "capabilities.provenance");

  if (typeof descriptor.clientRender !== "boolean")
    throw new TypeError("capabilities.clientRender must be a boolean");

  if (!Array.isArray(descriptor.supportedPlans))
    throw new TypeError("capabilities.supportedPlans must be an array");

  const seen = new Set<string>();
  const supportedPlans = descriptor.supportedPlans.map((value, index) => {
    const plan = snapshotPlan(value, index);
    const key = planKey(plan);

    if (seen.has(key)) throw new TypeError(`capabilities.supportedPlans repeats tuple ${key}`);

    seen.add(key);

    if (
      (plan.producer === "csr" || plan.activation === "hydrate") &&
      descriptor.clientRender !== true
    )
      throw new TypeError(
        `capabilities.supportedPlans[${index}] requires client rendering but capabilities.clientRender is false`,
      );

    return plan;
  });

  return Object.freeze({
    version: 1,
    identity,
    provenance,
    clientRender: descriptor.clientRender,
    supportedPlans: Object.freeze(supportedPlans),
  });
}

function snapshotPlan(value: unknown, index: number): ConcreteRoutePlan {
  const record = asRecord(value, `capabilities.supportedPlans[${index}]`);
  assertExactKeys(
    record,
    ["producer", "activation", "delivery", "hydrationMismatch"],
    `capabilities.supportedPlans[${index}]`,
  );

  const producer = record.producer;
  const activation = record.activation;
  const delivery = record.delivery;
  const hydrationMismatch = record.hydrationMismatch;

  if (hydrationMismatch !== "client-remount" && hydrationMismatch !== "fatal")
    throw new TypeError(`capabilities.supportedPlans[${index}].hydrationMismatch is invalid`);

  if (producer === "csr" && activation === "mount" && delivery === "complete")
    return Object.freeze({ producer, activation, delivery, hydrationMismatch });

  if (
    producer === "ssr" &&
    (activation === "hydrate" || activation === "none") &&
    (delivery === "complete" || delivery === "progressive")
  )
    return Object.freeze({ producer, activation, delivery, hydrationMismatch });

  if (
    producer === "ssg" &&
    (activation === "hydrate" || activation === "none") &&
    delivery === "complete"
  )
    return Object.freeze({ producer, activation, delivery, hydrationMismatch });

  throw new TypeError(`capabilities.supportedPlans[${index}] is not a legal A31 projection tuple`);
}

function resolveConstraints(
  inherited: readonly SourcedRouteRenderPolicy[],
): EffectiveRouteRenderPolicy {
  if (!Array.isArray(inherited)) throw new TypeError("inherited route policies must be an array");

  const facts = new Map<RouteRenderField, RouteRenderFactProvenance[]>();

  for (const field of fields) facts.set(field, []);

  inherited.forEach((value, layer) => {
    const policy = asRecord(value, `inherited[${layer}]`);
    assertOnlyKeys(policy, fields, `inherited[${layer}]`);

    for (const field of fields) {
      if (!Object.hasOwn(policy, field)) continue;

      const constraint = asRecord(policy[field], `inherited[${layer}].${field}`);
      assertExactKeys(constraint, ["value", "source"], `inherited[${layer}].${field}`);

      if (!constraintValues.includes(constraint.value as RouteRenderConstraint))
        throw new TypeError(`inherited[${layer}].${field}.value is invalid`);

      const source = nonEmptyString(constraint.source, `inherited[${layer}].${field}.source`);
      facts.get(field)!.push(
        Object.freeze({
          layer,
          value: constraint.value as RouteRenderConstraint,
          source,
        }),
      );
    }
  });

  function resolveField(field: RouteRenderField): EffectiveRouteRenderConstraint {
    const fieldFacts = Object.freeze(facts.get(field)!);
    const hasRequired = fieldFacts.some((fact) => fact.value === "required");
    const hasForbidden = fieldFacts.some((fact) => fact.value === "forbidden");
    const value: EffectiveRouteRenderConstraint["value"] =
      hasRequired && hasForbidden
        ? "conflict"
        : hasRequired
          ? "required"
          : hasForbidden
            ? "forbidden"
            : fieldFacts.length > 0
              ? "optional"
              : "missing";

    return Object.freeze({ value, facts: fieldFacts });
  }

  return Object.freeze({
    clientRender: resolveField("clientRender"),
    ssr: resolveField("ssr"),
    stream: resolveField("stream"),
    ssg: resolveField("ssg"),
    hydration: resolveField("hydration"),
  });
}

function constraintDiagnostics(policy: EffectiveRouteRenderPolicy): RoutePlanDiagnostic[] {
  const diagnostics: RoutePlanDiagnostic[] = [];

  for (const field of fields) {
    const constraint = policy[field];

    if (constraint.value === "missing") {
      diagnostics.push({ code: "missing-constraint", field });

      continue;
    }

    if (constraint.value === "conflict")
      diagnostics.push({
        code: "required-forbidden-conflict",
        field,
        requiredSources: sourcesFor(constraint, "required"),
        forbiddenSources: sourcesFor(constraint, "forbidden"),
      });
  }

  return diagnostics;
}

function crossFieldDiagnostics(policy: EffectiveRouteRenderPolicy): RoutePlanDiagnostic[] {
  const diagnostics: RoutePlanDiagnostic[] = [];

  if (
    policy.hydration.value !== "forbidden" &&
    policy.ssr.value === "forbidden" &&
    policy.ssg.value === "forbidden"
  )
    diagnostics.push({
      code: "hydration-needs-allowed-producer",
      hydrationSources: sourcesForAllowed(policy.hydration),
      ssrForbiddenSources: sourcesFor(policy.ssr, "forbidden"),
      ssgForbiddenSources: sourcesFor(policy.ssg, "forbidden"),
    });

  if (policy.stream.value !== "forbidden" && policy.ssr.value === "forbidden")
    diagnostics.push({
      code: "stream-needs-allowed-ssr",
      streamSources: sourcesForAllowed(policy.stream),
      ssrForbiddenSources: sourcesFor(policy.ssr, "forbidden"),
    });

  return diagnostics;
}

function satisfiesPolicy(
  plan: ConcreteRoutePlan,
  policy: EffectiveRouteRenderPolicy,
  capabilities: RoutePlanCapabilitiesV1,
): boolean {
  if (policy.clientRender.value === "required" && !capabilities.clientRender) return false;

  if (policy.clientRender.value === "forbidden" && needsClientRender(plan)) return false;

  if (policy.ssr.value === "required" && plan.producer !== "ssr") return false;

  if (policy.ssr.value === "forbidden" && plan.producer === "ssr") return false;

  if (policy.ssg.value === "required" && plan.producer !== "ssg") return false;

  if (policy.ssg.value === "forbidden" && plan.producer === "ssg") return false;

  if (
    policy.stream.value === "required" &&
    (plan.producer !== "ssr" || plan.delivery !== "progressive")
  )
    return false;

  if (policy.stream.value === "forbidden" && plan.delivery !== "complete") return false;

  if (policy.hydration.value === "required" && plan.activation !== "hydrate") return false;

  if (
    policy.hydration.value === "forbidden" &&
    plan.producer !== "csr" &&
    plan.activation !== "none"
  )
    return false;

  return true;
}

function preferProgressiveSSR(
  candidates: readonly ConcreteRoutePlan[],
  streamConstraint: EffectiveRouteRenderConstraint["value"],
): ConcreteRoutePlan[] {
  if (streamConstraint !== "optional") return [...candidates];

  return candidates.filter((candidate) => {
    if (candidate.producer !== "ssr" || candidate.delivery !== "complete") return true;

    return !candidates.some(
      (other) =>
        other.producer === "ssr" &&
        other.activation === candidate.activation &&
        other.hydrationMismatch === candidate.hydrationMismatch &&
        other.delivery === "progressive",
    );
  });
}

function needsClientRender(plan: ConcreteRoutePlan): boolean {
  return plan.producer === "csr" || plan.activation === "hydrate";
}

function sourcesFor(
  constraint: EffectiveRouteRenderConstraint,
  value: RouteRenderConstraint,
): string[] {
  return constraint.facts.filter((fact) => fact.value === value).map((fact) => fact.source);
}

function sourcesForAllowed(constraint: EffectiveRouteRenderConstraint): string[] {
  return constraint.facts.filter((fact) => fact.value !== "forbidden").map((fact) => fact.source);
}

function planKey(plan: ConcreteRoutePlan): string {
  return `${plan.producer}\0${plan.activation}\0${plan.delivery}\0${plan.hydrationMismatch}`;
}

function noPlan(
  input: RoutePlanInputSnapshot,
  diagnostics: readonly RoutePlanDiagnostic[],
): RoutePlanResolution {
  return Object.freeze({
    kind: "no-plan" as const,
    input,
    diagnostics: Object.freeze(diagnostics),
  });
}

function asRecord(value: unknown, label: string): Record<PropertyKey, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError(`${label} must be an object`);

  return value as Record<PropertyKey, unknown>;
}

function assertExactKeys(
  value: Record<PropertyKey, unknown>,
  keys: readonly string[],
  label: string,
): void {
  assertOnlyKeys(value, keys, label);

  if (Reflect.ownKeys(value).length !== keys.length)
    throw new TypeError(`${label} has missing fields`);
}

function assertOnlyKeys(
  value: Record<PropertyKey, unknown>,
  keys: readonly string[],
  label: string,
): void {
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key)))
    throw new TypeError(`${label} has unexpected fields`);
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new TypeError(`${label} must be a non-empty string`);

  return value;
}
