import { createHash } from "node:crypto";
import { dependencyClosure, type SourceImpact } from "./source-impact.ts";

// These readers are reviewed together with golden/server.ts's fixed fixture roots.
// A changed reader needs a new review; filename identity alone grants no exemption.
const REVIEWED_READERS: Readonly<Record<string, string>> = {
  "golden/server.ts": "55e18a3017a4e871a5776052273aa2ec694590784bfb40ae713a9c6f398b7c84",
  "golden/tests/public-values.spec.ts":
    "dcc73a0e3e62d1f72f9963b9120041e12ff201b6005c9420e91caa1cb8e0c169",
  "golden/verify-aeolia-inputs.ts":
    "14f0040f0b47a8ecb26a8fe6622d4c0d4f8c59d9b2fdf5a18bb74e610854e4a8",
  "golden/verify-packages.ts": "faba5b597d9ea7c741c6be1b1a73ad0d3aebdc4371bffc139676ebcc506b261f",
  "packages/compiler/src/checking-inputs.ts":
    "70ba076151acbc44b206c6755d7f80c8e372d2e6c947b3375b726894021d1dba",
  "packages/compiler/src/checking.ts":
    "322d961690a2076d8555480091d460aafc2d3b2a7d0319bf18c068882f7e78ed",
  "packages/compiler/src/module-resolution.ts":
    "1c7a7d70616640c37e7e70de5772c55f7bf0c1c204923cd07177ed589ffbf065",
  "packages/compiler/src/scanner.ts":
    "699e3c81e01a7c51152e8b831e002105ad173bc2325b333cbc1969fed7e907ea",
  "packages/elysia/src/app-analysis.ts":
    "d3ca46d55c3a99cd99c7c89c89ee40683d2a55b335ea8e160eb36704d9a1c02e",
  "packages/elysia/src/effect-analysis.ts":
    "adf18283259f32f663d162bf6d3bcb02daf4994398c78db7b8fab22d09f193d7",
  "packages/hosting/src/read-build.ts":
    "59345372a83d6f46481df0e9dc37172eacf6493d6def8992cd6cbdaad4174450",
  "packages/tooling/src/configuration.ts":
    "fc8d0a967a20784941dd9ff50235ce0112087dc66803497100ad7110b6b889da",
  "packages/tooling/src/css-bundling.ts":
    "3d10e1a4b1688e38a005c3c5b1799e87d4ee3017e16dc009830392cccdbb76c5",
  "packages/tooling/src/page-types.ts":
    "3410ab86fdd56b6a7b6bfcdccc00857b818bca1b01786a2e551f77b098a5bd8a",
  "packages/tooling/src/plugin-pipeline.ts":
    "9e54fc94899412a7dc408c2162e3b8a498fb41b3b41afa2235026964d7842ec2",
  "packages/tooling/src/project-worker-client.ts":
    "8886e4daee86bdf8543f62c8d900e24f7fc17824b9ff1d7be335b6f86dbcbe7c",
  "packages/tooling/src/project.ts":
    "9f18929a3bdbb9e06735703731c2e56c2a8145174d1fac2898460c2504a0121a",
};

// Server entrypoints and project roots are finite. Each domain owns every case in
// its suite, including inputs discovered through configuration or directory scans.
const FIXTURE_SUITES: Readonly<Record<string, string>> = {
  "blob-attributes": "tests/blob-attributes.spec.ts",
  checklist: "tests/checklist.spec.ts",
  "component-css": "tests/component-css.spec.ts",
  "embed-security": "tests/embed-security.spec.ts",
  lifecycle: "tests/lifecycle.spec.ts",
  "native-events": "tests/native-events.spec.ts",
  "native-identity": "tests/native-identity.spec.ts",
  "optional-styling": "tests/optional-styling.spec.ts",
  "public-values": "tests/public-values.spec.ts",
  "task-cancellation": "tests/task-cancellation.spec.ts",
};

/** Assess non-import inputs without treating arbitrary filesystem access as a graph edge. */
export function assessGoldenReaders(input: {
  readonly impact: SourceImpact;
  readonly behaviors: readonly { readonly id: string; readonly paths: readonly string[] }[];
  readonly cases: readonly {
    readonly id: string;
    readonly suite: string;
    readonly behaviors: readonly string[];
  }[];
}): {
  readonly fallbackReasons: readonly string[];
  readonly affectedBehaviors: readonly { readonly id: string; readonly reason: string }[];
} {
  const reachable = dependencyClosure(
    input.behaviors.flatMap((behavior) => behavior.paths),
    input.impact.graph.dependenciesByConsumer,
  );
  const readers = [...input.impact.graph.opaqueConsumers].filter(
    (path) => reachable.has(path) || path.startsWith("golden/fixtures/"),
  );
  const fallbackReasons: string[] = [];
  const affectedBehaviors: { id: string; reason: string }[] = [];

  if (readers.length === 0) return { fallbackReasons, affectedBehaviors };

  for (const path of readers) {
    const expected = REVIEWED_READERS[path];

    if (!expected) {
      fallbackReasons.push(`golden input reader has no reviewed input contract: ${path}`);
      continue;
    }

    for (const [side, snapshot] of [
      ["base", input.impact.baseSnapshot],
      ["head", input.impact.headSnapshot],
    ] as const) {
      const source = snapshot.sourceFiles.get(path);
      const actual =
        source === undefined
          ? undefined
          : createHash("sha256").update(source.replaceAll("\r\n", "\n")).digest("hex");

      if (actual !== expected)
        fallbackReasons.push(`golden input reader contract is stale in ${side}: ${path}`);
    }
  }

  for (const changed of input.impact.changedPaths) {
    const match = /^golden\/fixtures\/([^/]+)\//u.exec(changed.path);
    const scenario = match?.[1];
    const suite = scenario ? FIXTURE_SUITES[scenario] : undefined;

    if (!suite) {
      fallbackReasons.push(
        `opaque golden readers require full verification outside reviewed fixture input domains: ${changed.path}`,
      );
      continue;
    }

    const cases = input.cases.filter((item) => item.suite === suite);
    const owned = input.behaviors.some(
      (behavior) =>
        behavior.paths.some((path) => path.startsWith(`golden/fixtures/${scenario}/`)) &&
        cases.some((item) => item.behaviors.includes(behavior.id)),
    );

    if (!owned || cases.length === 0) {
      fallbackReasons.push(`reviewed golden fixture domain has no catalog owner: ${changed.path}`);
      continue;
    }

    for (const id of new Set(cases.flatMap((item) => item.behaviors))) {
      affectedBehaviors.push({
        id,
        reason: `changed input ${changed.path} belongs to reviewed fixture domain ${scenario} and its complete suite ${suite}`,
      });
    }
  }

  return { fallbackReasons: [...new Set(fallbackReasons)], affectedBehaviors };
}
