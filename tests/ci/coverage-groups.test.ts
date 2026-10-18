import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createCoverageArtifact,
  mergeCoverageArtifacts,
  relocateCoverageArtifact,
  seedCoverageSources,
  writeCoverageFragment,
  type CoverageArtifact,
} from "../../scripts/ci/coverage-collector.ts";
import {
  coverageFamilies,
  readCoverageGroups,
  writeCoverageGroup,
} from "../../scripts/ci/coverage-group-artifacts.ts";

const temporaryRoots: string[] = [];
const execution = { revision: "a".repeat(40), runId: "12345", attempt: "1" };
const source = "packages/sample/src/value.ts";
const supportSource = "scripts/support.ts";
const authored = "export function value(input: number) { return input > 0 ? input : 0; }\n";

afterAll(() => {
  for (const root of temporaryRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function captures() {
  const root = mkdtempSync(join(tmpdir(), "hesperia-coverage-groups-"));

  temporaryRoots.push(root);

  const producer = join(root, "producer");
  const consumer = join(root, "consumer");
  const bundles = join(root, "bundles");

  for (const checkout of [producer, consumer]) {
    mkdirSync(join(checkout, "packages/sample/src"), { recursive: true });

    writeFileSync(join(checkout, source), authored);

    mkdirSync(join(checkout, "scripts"));

    writeFileSync(join(checkout, supportSource), "export function support() { return 3; }\n");
  }

  mkdirSync(bundles);

  const seeded = await seedCoverageSources([source, supportSource], producer);
  const originals: CoverageArtifact[] = [];

  for (const family of coverageFamilies) {
    const runId = randomUUID();
    const relativeDirectory =
      family === "native-editor"
        ? "ec"
        : family === "browser-css"
          ? "coverage/browser-css-runs"
          : "coverage/runs";
    const outputDirectory = join(producer, ".hesperia", relativeDirectory, runId);
    const seed = createCoverageArtifact({
      repoPath: producer,
      kind: "seed",
      runId,
      ownerId: "sample",
      populationFingerprint: seeded.population.fingerprint,
      population: seeded.population,
      coverage: seeded.coverage,
    });
    const hitCoverage = structuredClone(seeded.coverage);
    delete hitCoverage[resolve(producer, supportSource)];

    for (const record of Object.values(hitCoverage)) {
      for (const id of Object.keys(record.s)) record.s[id] = 1;

      for (const id of Object.keys(record.f)) record.f[id] = 1;
    }

    const hits = createCoverageArtifact({
      repoPath: producer,
      kind: "hits",
      runId,
      ownerId: "sample",
      populationFingerprint: seeded.population.fingerprint,
      sourcePopulation: seeded.population,
      coverage: hitCoverage,
    });

    for (const artifact of [seed, hits]) {
      writeCoverageFragment({
        directory: outputDirectory,
        contextId: artifact.kind,
        pid: process.pid,
        threadId: 0,
        repoPath: producer,
        artifact,
        sourcePopulation: seeded.population,
      });
    }

    writeFileSync(join(outputDirectory, "lcov.info"), "original family report\n");

    writeCoverageGroup({
      repoPath: producer,
      bundlePath: join(bundles, family),
      family,
      runId,
      outputDirectory,
      summary: {
        status: "completed",
        runId,
        outputDirectory,
        lcovPath: join(outputDirectory, "lcov.info"),
      },
      execution,
      captureSupport: (directory) => {
        for (const artifact of [seed, hits]) {
          const support = createCoverageArtifact({
            repoPath: producer,
            kind: artifact.kind,
            runId,
            ownerId: "final-coverage-driver",
            populationFingerprint: seeded.population.fingerprint,
            sourcePopulation: seeded.population,
            coverage: {
              [resolve(producer, supportSource)]: (() => {
                const record = structuredClone(seeded.coverage[resolve(producer, supportSource)]!);

                if (artifact.kind === "hits") {
                  for (const id of Object.keys(record.s)) record.s[id] = 1;

                  for (const id of Object.keys(record.f)) record.f[id] = 1;
                }

                return record;
              })(),
            },
          });

          writeCoverageFragment({
            directory,
            contextId: support.kind,
            pid: process.pid,
            threadId: 0,
            repoPath: producer,
            artifact: support,
            sourcePopulation: seeded.population,
          });
        }
      },
    });

    originals.push(seed, hits);
  }

  return { producer, consumer, bundles, originals };
}

test("group transport preserves original bytes and transform identities across checkout paths", async () => {
  const fixture = await captures();
  const groups = readCoverageGroups({
    repoPath: fixture.consumer,
    bundleRoot: fixture.bundles,
    execution,
  });

  expect(groups.map((group) => group.family).sort()).toEqual([...coverageFamilies].sort());

  for (const group of groups) {
    const artifacts = [group.outputDirectory, group.supportDirectory].flatMap((directory) =>
      readdirSync(directory)
        .filter((name) => name.endsWith(".json"))
        .map((name) => {
          const bytes = readFileSync(join(directory, name));
          const originalDirectory =
            directory === group.supportDirectory
              ? join(fixture.producer, ".hesperia/coverage/final-runs", String(group.summary.runId))
              : String(group.summary.outputDirectory);

          expect(bytes.equals(readFileSync(join(originalDirectory, name)))).toBe(true);

          return JSON.parse(bytes.toString("utf8")) as CoverageArtifact;
        }),
    );
    const relocated = artifacts.map((artifact) =>
      relocateCoverageArtifact(artifact, fixture.producer, fixture.consumer),
    );
    const merged = await mergeCoverageArtifacts({
      repoPath: fixture.consumer,
      expectedSources: [source, supportSource],
      seeds: relocated.filter((artifact) => artifact.kind === "seed"),
      fragments: relocated.filter((artifact) => artifact.kind === "hits"),
    });
    const record = merged.fileCoverageFor(resolve(fixture.consumer, source)).toJSON();

    expect(Object.values(record.s).every((count) => count > 0)).toBe(true);

    expect(Object.values(record.f)).toEqual([1]);

    const wrapperRecord = merged.fileCoverageFor(resolve(fixture.consumer, supportSource)).toJSON();

    expect(Object.values(wrapperRecord.f)).toEqual([1]);

    expect(Object.values(wrapperRecord.s).every((count) => count > 0)).toBe(true);

    expect(relocated.map((artifact) => artifact.ownerFiles)).toEqual(
      artifacts.map((artifact) => artifact.ownerFiles),
    );

    expect(relocated.map((artifact) => artifact.runId)).toEqual(
      artifacts.map((artifact) => artifact.runId),
    );

    expect(readFileSync(join(group.outputDirectory, "lcov.info"), "utf8")).toBe(
      "original family report\n",
    );
  }

  expect(fixture.originals[0]!.coverage[resolve(fixture.producer, source)]!.path).toBe(
    resolve(fixture.producer, source),
  );
});

test("group admission rejects missing, foreign, stale, duplicate, failed, and changed evidence", async () => {
  const fixture = await captures();
  const controls = [
    {
      label: "missing",
      change: (root: string) => rmSync(join(root, coverageFamilies[0]!), { recursive: true }),
      message: /exactly four/u,
    },
    {
      label: "changed",
      change: (root: string) => {
        const manifest = JSON.parse(
          readFileSync(join(root, coverageFamilies[0]!, "coverage-group.json"), "utf8"),
        );

        writeFileSync(
          join(
            root,
            coverageFamilies[0]!,
            "evidence",
            "coverage/runs",
            manifest.runId,
            "lcov.info",
          ),
          "changed",
        );
      },
      message: /evidence changed/u,
    },
    {
      label: "wrapper-changed",
      change: (root: string) => {
        const manifest = JSON.parse(
          readFileSync(join(root, coverageFamilies[0]!, "coverage-group.json"), "utf8"),
        );
        const name = Object.keys(manifest.supportFiles)[0]!;

        writeFileSync(
          join(root, coverageFamilies[0]!, "evidence/coverage/final-runs", manifest.runId, name),
          "{}",
        );
      },
      message: /evidence changed/u,
    },
    {
      label: "foreign",
      change: (root: string) =>
        writeFileSync(join(root, coverageFamilies[0]!, "unexpected.json"), "{}"),
      message: /foreign evidence/u,
    },
    ...["status", "revision", "attempt", "execution", "platform", "duplicate", "escaped"].map(
      (label) => ({
        label,
        change: (root: string) => {
          const path = join(root, coverageFamilies[0]!, "coverage-group.json");
          const manifest = JSON.parse(readFileSync(path, "utf8"));

          if (label === "status") manifest.status = "failed";

          if (label === "revision") manifest.execution.revision = "b".repeat(40);

          if (label === "attempt") manifest.execution.attempt = "2";

          if (label === "execution") manifest.execution.runId = "999";

          if (label === "platform")
            manifest.platform = process.platform === "win32" ? "linux" : "win32";

          if (label === "duplicate") manifest.family = coverageFamilies[1];

          if (label === "escaped")
            manifest.summary.outputDirectory = resolve(fixture.producer, "elsewhere");

          writeFileSync(path, JSON.stringify(manifest));
        },
        message: label === "escaped" ? /escaped/u : /failed, foreign, stale, or duplicated/u,
      }),
    ),
  ];

  for (const control of controls) {
    const root = mkdtempSync(join(tmpdir(), `hesperia-coverage-${control.label}-`));

    temporaryRoots.push(root);

    cpSync(fixture.bundles, root, { recursive: true });

    control.change(root);

    expect(() =>
      readCoverageGroups({ repoPath: fixture.consumer, bundleRoot: root, execution }),
    ).toThrow(control.message);
  }

  const artifact = structuredClone(fixture.originals[0]!);
  const record = Object.values(artifact.coverage)[0]!;
  record.inputSourceMap = {
    ...record.inputSourceMap!,
    sources: [resolve(fixture.producer, "../foreign.ts")],
  };

  expect(() => relocateCoverageArtifact(artifact, fixture.producer, fixture.consumer)).toThrow(
    /outside the repository/u,
  );

  writeFileSync(join(fixture.consumer, source), authored + "export const changed = true;\n");

  expect(() =>
    relocateCoverageArtifact(fixture.originals[0]!, fixture.producer, fixture.consumer),
  ).toThrow(/embedded|source content/u);
});
