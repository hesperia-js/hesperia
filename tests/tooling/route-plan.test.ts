import { expect, test } from "bun:test";
import {
  resolveRoutePlan,
  type ConcreteRoutePlan,
  type RoutePlanCapabilitiesV1,
  type RouteRenderConstraint,
  type RouteRenderField,
  type SourcedRouteRenderPolicy,
} from "../../packages/tooling/src/route-plan.ts";

const allOptional = {
  clientRender: "optional",
  ssr: "optional",
  stream: "optional",
  ssg: "optional",
  hydration: "optional",
} as const satisfies Record<RouteRenderField, RouteRenderConstraint>;

function completePolicy(
  source: string,
  overrides: Partial<Record<RouteRenderField, RouteRenderConstraint>> = {},
): SourcedRouteRenderPolicy {
  return sourcedPolicy(source, { ...allOptional, ...overrides });
}

function sourcedPolicy(
  source: string,
  values: Partial<Record<RouteRenderField, RouteRenderConstraint>>,
): SourcedRouteRenderPolicy {
  return Object.fromEntries(
    Object.entries(values).map(([field, value]) => [
      field,
      { value, source: `${source}:${field}` },
    ]),
  ) as SourcedRouteRenderPolicy;
}

function capabilities(
  supportedPlans: readonly ConcreteRoutePlan[],
  clientRender = true,
): RoutePlanCapabilitiesV1 {
  return {
    version: 1,
    identity: "test-target/v1",
    provenance: "tests/tooling/route-plan.test.ts capability fixture",
    clientRender,
    supportedPlans,
  };
}

const csrMount: ConcreteRoutePlan = {
  producer: "csr",
  activation: "mount",
  delivery: "complete",
  hydrationMismatch: "fatal",
};
const ssrHydrateComplete: ConcreteRoutePlan = {
  producer: "ssr",
  activation: "hydrate",
  delivery: "complete",
  hydrationMismatch: "client-remount",
};
const ssrHydrateProgressive: ConcreteRoutePlan = {
  producer: "ssr",
  activation: "hydrate",
  delivery: "progressive",
  hydrationMismatch: "client-remount",
};
const ssrNoneComplete: ConcreteRoutePlan = {
  producer: "ssr",
  activation: "none",
  delivery: "complete",
  hydrationMismatch: "fatal",
};
const ssrNoneProgressive: ConcreteRoutePlan = {
  producer: "ssr",
  activation: "none",
  delivery: "progressive",
  hydrationMismatch: "fatal",
};
const ssgHydrateComplete: ConcreteRoutePlan = {
  producer: "ssg",
  activation: "hydrate",
  delivery: "complete",
  hydrationMismatch: "client-remount",
};
const ssgNoneComplete: ConcreteRoutePlan = {
  producer: "ssg",
  activation: "none",
  delivery: "complete",
  hydrationMismatch: "fatal",
};

test("required client rendering remains a capability while explicit constraints select SSR hydration", () => {
  const result = resolveRoutePlan(
    [
      completePolicy("root/+layout.tsx", { clientRender: "required" }),
      completePolicy("routes/[id]/+page.tsx", {
        ssr: "required",
        stream: "forbidden",
        ssg: "forbidden",
        hydration: "required",
      }),
    ],
    capabilities([
      csrMount,
      ssrHydrateComplete,
      ssrHydrateProgressive,
      ssrNoneComplete,
      ssgHydrateComplete,
      ssgNoneComplete,
    ]),
  );

  expect(result.kind).toBe("admissible-plan");

  if (result.kind !== "admissible-plan") throw new Error("Expected one route plan");

  expect(result.plan).toStrictEqual({
    producer: "ssr",
    activation: "hydrate",
    delivery: "complete",
    hydrationMismatch: "client-remount",
  });
  expect(result.input.constraints.clientRender.facts.map((fact) => fact.source)).toStrictEqual([
    "root/+layout.tsx:clientRender",
    "routes/[id]/+page.tsx:clientRender",
  ]);
  expect(result.input.constraints.ssr.facts.map((fact) => fact.value)).toStrictEqual([
    "optional",
    "required",
  ]);
  expect(result.input.capabilities.identity).toBe("test-target/v1");
  expect(result.input.capabilities.supportedPlans).toHaveLength(6);
});

test("required and forbidden facts from different route layers report both sources", () => {
  const result = resolveRoutePlan(
    [
      completePolicy("root/+layout.tsx", { ssr: "forbidden" }),
      completePolicy("routes/account/+page.tsx", { ssr: "required" }),
    ],
    capabilities([ssrNoneComplete]),
  );

  expect(result.kind).toBe("no-plan");

  if (result.kind !== "no-plan") throw new Error("Expected a route constraint conflict");

  expect(result.diagnostics).toContainEqual({
    code: "required-forbidden-conflict",
    field: "ssr",
    requiredSources: ["routes/account/+page.tsx:ssr"],
    forbiddenSources: ["root/+layout.tsx:ssr"],
  });
  expect(result.input.constraints.ssr.facts.map((fact) => fact.layer)).toStrictEqual([0, 1]);
});

test("missing inherited fields stay missing instead of becoming optional", () => {
  const empty = resolveRoutePlan([], capabilities([csrMount]));
  const partial = resolveRoutePlan(
    [sourcedPolicy("root/+layout.tsx", { clientRender: "optional", ssr: "forbidden" })],
    capabilities([csrMount]),
  );

  expect(empty.kind).toBe("no-plan");

  if (empty.kind !== "no-plan") throw new Error("Expected missing constraints");

  expect(empty.input.constraints.clientRender.value).toBe("missing");
  expect(empty.diagnostics).toHaveLength(5);

  expect(partial.kind).toBe("no-plan");

  if (partial.kind !== "no-plan") throw new Error("Expected missing constraints");

  expect(partial.input.constraints.clientRender.value).toBe("optional");
  expect(partial.input.constraints.ssr.value).toBe("forbidden");
  expect(partial.input.constraints.stream.value).toBe("missing");
  expect(partial.diagnostics).toContainEqual({ code: "missing-constraint", field: "stream" });
});

test("incompatible required producers return no-plan with both source facts retained", () => {
  const result = resolveRoutePlan(
    [completePolicy("routes/+layout.tsx", { ssr: "required", ssg: "required" })],
    capabilities([ssrNoneComplete, ssgNoneComplete]),
  );

  expect(result.kind).toBe("no-plan");

  if (result.kind !== "no-plan") throw new Error("Expected incompatible producer constraints");

  expect(result.diagnostics).toStrictEqual([
    { code: "no-supported-plan", capabilityIdentity: "test-target/v1" },
  ]);
  expect(result.input.constraints.ssr.facts[0]?.source).toBe("routes/+layout.tsx:ssr");
  expect(result.input.constraints.ssg.facts[0]?.source).toBe("routes/+layout.tsx:ssg");
});

test("optional hydration requires an allowed SSR or SSG producer", () => {
  const result = resolveRoutePlan(
    [
      completePolicy("routes/+page.tsx", {
        ssr: "forbidden",
        stream: "forbidden",
        ssg: "forbidden",
        hydration: "optional",
      }),
    ],
    capabilities([csrMount]),
  );

  expect(result.kind).toBe("no-plan");

  if (result.kind !== "no-plan") throw new Error("Expected hydration producer precondition");

  expect(result.diagnostics).toContainEqual({
    code: "hydration-needs-allowed-producer",
    hydrationSources: ["routes/+page.tsx:hydration"],
    ssrForbiddenSources: ["routes/+page.tsx:ssr"],
    ssgForbiddenSources: ["routes/+page.tsx:ssg"],
  });
});

test("optional streaming requires SSR to remain allowed", () => {
  const result = resolveRoutePlan(
    [
      completePolicy("routes/+page.tsx", {
        ssr: "forbidden",
        stream: "optional",
        ssg: "forbidden",
        hydration: "forbidden",
      }),
    ],
    capabilities([csrMount]),
  );

  expect(result.kind).toBe("no-plan");

  if (result.kind !== "no-plan") throw new Error("Expected streaming SSR precondition");

  expect(result.diagnostics).toContainEqual({
    code: "stream-needs-allowed-ssr",
    streamSources: ["routes/+page.tsx:stream"],
    ssrForbiddenSources: ["routes/+page.tsx:ssr"],
  });
});

const selectionMatrix: readonly {
  readonly name: string;
  readonly constraints: Partial<Record<RouteRenderField, RouteRenderConstraint>>;
  readonly supportedPlans: readonly ConcreteRoutePlan[];
  readonly expected: ConcreteRoutePlan;
}[] = [
  {
    name: "clientRender forbidden excludes CSR and hydration",
    constraints: {
      clientRender: "forbidden",
      ssr: "required",
      stream: "forbidden",
      ssg: "forbidden",
    },
    supportedPlans: [csrMount, ssrHydrateComplete, ssrNoneComplete],
    expected: ssrNoneComplete,
  },
  {
    name: "SSR required selects the request-time producer",
    constraints: { ssr: "required", stream: "forbidden", ssg: "optional", hydration: "forbidden" },
    supportedPlans: [ssrNoneComplete, ssgNoneComplete],
    expected: ssrNoneComplete,
  },
  {
    name: "SSG required selects the static producer",
    constraints: { ssr: "optional", stream: "forbidden", ssg: "required", hydration: "forbidden" },
    supportedPlans: [ssrNoneComplete, ssgNoneComplete],
    expected: ssgNoneComplete,
  },
  {
    name: "stream required selects progressive SSR",
    constraints: {
      ssr: "required",
      stream: "required",
      ssg: "forbidden",
      hydration: "forbidden",
    },
    supportedPlans: [ssrNoneComplete, ssrNoneProgressive, ssgNoneComplete],
    expected: ssrNoneProgressive,
  },
  {
    name: "stream forbidden selects complete delivery",
    constraints: {
      ssr: "required",
      stream: "forbidden",
      ssg: "forbidden",
      hydration: "forbidden",
    },
    supportedPlans: [ssrNoneComplete, ssrNoneProgressive],
    expected: ssrNoneComplete,
  },
  {
    name: "hydration required selects a server-produced hydrated plan",
    constraints: {
      ssr: "required",
      stream: "forbidden",
      ssg: "forbidden",
      hydration: "required",
    },
    supportedPlans: [ssrHydrateComplete, ssrNoneComplete],
    expected: ssrHydrateComplete,
  },
  {
    name: "hydration forbidden selects no client activation for SSR or SSG",
    constraints: {
      ssr: "required",
      stream: "forbidden",
      ssg: "forbidden",
      hydration: "forbidden",
    },
    supportedPlans: [ssrHydrateComplete, ssrNoneComplete],
    expected: ssrNoneComplete,
  },
];

for (const scenario of selectionMatrix) {
  test(`route plan matrix: ${scenario.name}`, () => {
    const result = resolveRoutePlan(
      [completePolicy("routes/+page.tsx", scenario.constraints)],
      capabilities(scenario.supportedPlans),
    );

    expect(result.kind).toBe("admissible-plan");

    if (result.kind !== "admissible-plan") throw new Error("Expected one route plan");

    expect(result.plan).toStrictEqual(scenario.expected);
  });
}

test("Q208 prefers progressive only within the same SSR activation and mismatch action", () => {
  const result = resolveRoutePlan(
    [
      completePolicy("routes/+page.tsx", {
        clientRender: "required",
        ssr: "required",
        stream: "optional",
        ssg: "forbidden",
        hydration: "required",
      }),
    ],
    capabilities([ssrHydrateComplete, ssrHydrateProgressive]),
  );

  expect(result.kind).toBe("admissible-plan");

  if (result.kind !== "admissible-plan") throw new Error("Expected progressive SSR");

  expect(result.plan).toStrictEqual(ssrHydrateProgressive);
});

test("progressive preference keeps a different producer and activation ambiguous", () => {
  const producerAmbiguity = resolveRoutePlan(
    [
      completePolicy("routes/+page.tsx", {
        ssr: "optional",
        stream: "optional",
        ssg: "optional",
        hydration: "required",
      }),
    ],
    capabilities([ssrHydrateComplete, ssrHydrateProgressive, ssgHydrateComplete]),
  );
  const activationAmbiguity = resolveRoutePlan(
    [
      completePolicy("routes/+page.tsx", {
        ssr: "required",
        stream: "optional",
        ssg: "forbidden",
        hydration: "optional",
      }),
    ],
    capabilities([ssrHydrateComplete, ssrHydrateProgressive, ssrNoneComplete]),
  );

  expect(producerAmbiguity.kind).toBe("ambiguous");

  if (producerAmbiguity.kind !== "ambiguous")
    throw new Error("Expected producer ambiguity to remain");

  expect(producerAmbiguity.candidates).toStrictEqual([ssrHydrateProgressive, ssgHydrateComplete]);

  expect(activationAmbiguity.kind).toBe("ambiguous");

  if (activationAmbiguity.kind !== "ambiguous")
    throw new Error("Expected activation ambiguity to remain");

  expect(activationAmbiguity.candidates).toStrictEqual([ssrHydrateProgressive, ssrNoneComplete]);
});

test("the resolver does not invent a hydration mismatch action", () => {
  const result = resolveRoutePlan(
    [
      completePolicy("routes/+page.tsx", {
        clientRender: "required",
        ssr: "required",
        stream: "optional",
        ssg: "forbidden",
        hydration: "required",
      }),
    ],
    capabilities([
      ssrHydrateComplete,
      {
        producer: "ssr",
        activation: "hydrate",
        delivery: "progressive",
        hydrationMismatch: "fatal",
      },
    ]),
  );

  expect(result.kind).toBe("ambiguous");

  if (result.kind !== "ambiguous") throw new Error("Expected mismatch-action ambiguity");

  expect(result.candidates.map((candidate) => candidate.hydrationMismatch)).toStrictEqual([
    "client-remount",
    "fatal",
  ]);
});

test("malformed or duplicate target projection tuples reject the capability declaration", () => {
  const malformedTuples: readonly unknown[] = [
    { producer: "csr", activation: "hydrate", delivery: "complete", hydrationMismatch: "fatal" },
    { producer: "ssg", activation: "none", delivery: "progressive", hydrationMismatch: "fatal" },
    { producer: "ssr", activation: "hydrate", delivery: "complete", mismatch: "fatal" },
  ];

  for (const tuple of malformedTuples) {
    expect(() =>
      resolveRoutePlan(
        [completePolicy("routes/+page.tsx")],
        capabilities([tuple as ConcreteRoutePlan]),
      ),
    ).toThrow(TypeError);
  }

  expect(() =>
    resolveRoutePlan(
      [completePolicy("routes/+page.tsx")],
      capabilities([ssrNoneComplete, ssrNoneComplete]),
    ),
  ).toThrow(TypeError);
});

test("valid capabilities with no tuple matching the constraints return no-plan", () => {
  const result = resolveRoutePlan(
    [
      completePolicy("routes/+page.tsx", {
        ssr: "required",
        stream: "forbidden",
        ssg: "forbidden",
        hydration: "forbidden",
      }),
    ],
    capabilities([ssgNoneComplete]),
  );

  expect(result.kind).toBe("no-plan");

  if (result.kind !== "no-plan") throw new Error("Expected no supported projection tuple");

  expect(result.diagnostics).toStrictEqual([
    { code: "no-supported-plan", capabilityIdentity: "test-target/v1" },
  ]);
});

test("client-render requirements return no-plan when the target lacks that capability", () => {
  const result = resolveRoutePlan(
    [completePolicy("routes/+page.tsx", { clientRender: "required" })],
    capabilities([ssrNoneComplete], false),
  );

  expect(result.kind).toBe("no-plan");

  if (result.kind !== "no-plan") throw new Error("Expected unavailable capability diagnostic");

  expect(result.diagnostics).toStrictEqual([
    { code: "no-supported-plan", capabilityIdentity: "test-target/v1" },
  ]);
  expect(result.input.constraints.clientRender.facts[0]?.source).toBe(
    "routes/+page.tsx:clientRender",
  );
});
