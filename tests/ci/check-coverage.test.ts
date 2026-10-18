import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { checkCoverage } from "../../scripts/ci/check-coverage.ts";

const defaultSources = ["packages/sample/src/measured.ts"];

async function createFixture(sources: readonly string[], lcov: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hesperia-coverage-"));

  for (const source of sources) {
    const path = join(root, ...source.split(/[\\/]/u));

    await mkdir(join(path, ".."), { recursive: true });

    await writeFile(path, "export const source = 1;\n");
  }

  await mkdir(join(root, ".hesperia", "coverage"), { recursive: true });

  await writeFile(join(root, ".hesperia", "coverage", "lcov.info"), lcov);

  return root;
}

function record(
  filename: string,
  linesFound: number | string,
  linesHit: number | string,
  functionsFound: number | string = linesFound,
  functionsHit: number | string = linesHit,
  branchRecords = "",
): string {
  return [
    `SF:${filename}`,
    `FNF:${functionsFound}`,
    `FNH:${functionsHit}`,
    `LF:${linesFound}`,
    `LH:${linesHit}`,
    branchRecords,
    "end_of_record",
    "",
  ]
    .filter((line, index) => line !== "" || index === 6)
    .join("\n");
}

test("requires LCOV only for authored TypeScript with Istanbul coverage units", async () => {
  const sourcePath = "packages/sample/src/unmeasured.ts";
  const examples: readonly {
    readonly name: string;
    readonly source: string;
    readonly executable: boolean;
    readonly extraRecord?: string;
  }[] = [
    {
      name: "type-only imports, interfaces, and aliases",
      source:
        'import type { Shape } from "./types.js";\nexport interface PublicShape { value: Shape }\nexport type PublicValue = string;\n',
      executable: false,
    },
    { name: "empty export marker", source: "export {};\n", executable: false },
    {
      name: "pure value re-export barrel",
      source: 'export { value } from "./values.js";\n',
      executable: false,
    },
    {
      name: "measured pure re-export barrel stays in the aggregate",
      source: 'export { value } from "./values.js";\n',
      executable: false,
      extraRecord: record("packages/sample/src/unmeasured.ts", 10, 0),
    },
    {
      name: "exported function",
      source: "export function uncovered() { return 1; }\n",
      executable: true,
    },
    {
      name: "side-effect import without local units",
      source: 'import "./register.js";\n',
      executable: false,
    },
    {
      name: "runtime value import",
      source: 'import { value } from "./values.js";\nexport const result = value;\n',
      executable: true,
    },
    {
      name: "string content resembling an export marker",
      source: "export const marker = 'export {};';\n",
      executable: true,
    },
  ];

  for (const example of examples) {
    const root = await createFixture(
      [...defaultSources, sourcePath],
      [
        "TN:",
        record("packages/sample/src/measured.ts", 10, 9),
        ...(example.extraRecord ? [example.extraRecord] : []),
        "",
      ].join("\n"),
    );

    try {
      await writeFile(join(root, ...sourcePath.split("/")), example.source);

      const result = checkCoverage({ lcovPath: ".hesperia/coverage/lcov.info", repoPath: root });

      expect(result.passed).toBe(!example.executable && !example.extraRecord);

      expect(result.lineFound).toBe(example.extraRecord ? 20 : 10);

      expect(result.lineHit).toBe(9);

      expect(result.functionFound).toBe(example.extraRecord ? 20 : 10);

      expect(result.functionHit).toBe(9);

      expect(result.linePercent).toBe(example.extraRecord ? 45 : 90);

      expect(result.functionPercent).toBe(example.extraRecord ? 45 : 90);

      expect(result.branchRecordsPresent).toBe(false);

      expect(result.unmeasuredSources).toStrictEqual(example.executable ? [sourcePath] : []);

      expect(result.nonExecutableSources).toStrictEqual(example.executable ? [] : [sourcePath]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("empty LCOV records do not measure an executable source", async () => {
  const source = "packages/sample/src/unmeasured.ts";
  const root = await createFixture(
    [...defaultSources, source],
    [record("packages/sample/src/measured.ts", 10, 9), record(source, 0, 0, 0, 0)].join("\n"),
  );

  try {
    await writeFile(
      join(root, ...source.split(/[\\/]/u)),
      "export function uncovered() { return 1; }\n",
    );

    const result = checkCoverage({ lcovPath: ".hesperia/coverage/lcov.info", repoPath: root });

    expect(result.lineFound).toBe(10);

    expect(result.functionFound).toBe(10);

    expect(result.unmeasuredSources).toStrictEqual([source]);

    expect(result.passed).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails when either measured line or function coverage is below the floor", async () => {
  const root = await createFixture(
    defaultSources,
    record("packages/sample/src/measured.ts", 100, 89, 100, 99),
  );

  try {
    const result = checkCoverage({ lcovPath: ".hesperia/coverage/lcov.info", repoPath: root });

    expect(result.passed).toBe(false);

    expect(result.linePercent).toBe(89);

    expect(result.functionPercent).toBe(99);

    expect(
      checkCoverage({ lcovPath: ".hesperia/coverage/lcov.info", repoPath: root, threshold: 89 })
        .passed,
    ).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails below the function floor when line coverage is exactly 90 percent", async () => {
  const root = await createFixture(
    defaultSources,
    record("packages/sample/src/measured.ts", 100, 90, 100, 89),
  );

  try {
    const result = checkCoverage({ lcovPath: ".hesperia/coverage/lcov.info", repoPath: root });

    expect(result.linePercent).toBe(90);

    expect(result.functionPercent).toBe(89);

    expect(result.passed).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not let tests, fixtures, generated files, dependencies, or temp modules pad production coverage", async () => {
  const sources = [
    "packages/sample/src/app.ts",
    "packages/sample/src/unmeasured.ts",
    "packages/sample/src/__tests__/ignored.test.ts",
    "packages/sample/src/fixtures/ignored.ts",
    "packages/sample/src/temp/ignored.ts",
    "packages/sample/src/dist/generated.ts",
    "packages/sample/src/node_modules/dependency.ts",
    "packages/sample/src/public.d.ts",
    "scripts/build-packages.ts",
    "scripts/new-production-tool.ts",
    "scripts/ci/check-coverage.ts",
    "scripts/ci/select-golden.ts",
    "scripts/ci/plan-golden.ts",
    "scripts/ci/new-gate.ts",
    "scripts/ci/fixtures/ignored.ts",
    "scripts/ci/nested/ignored.ts",
    "scripts/ci/helper.test.ts",
    "scripts/ci/generated.d.ts",
    "tests/ci/helper.ts",
    "editors/vscode/src/extension.ts",
    "editors/vscode/tests/host.ts",
  ];
  const temporaryModule = resolve(tmpdir(), "hesperia-generated", "projected.mjs");
  const lcov = [
    record("packages/sample/src/app.ts", 10, 10),
    record("scripts/ci/check-coverage.ts", 10, 0),
    record("packages/sample/src/__tests__/ignored.test.ts", 1000, 1000),
    record("packages/sample/src/fixtures/ignored.ts", 1000, 1000),
    record("packages/sample/src/temp/ignored.ts", 1000, 1000),
    record("packages/sample/src/dist/generated.ts", 1000, 1000),
    record("packages/sample/src/node_modules/dependency.ts", 1000, 1000),
    record("packages/sample/src/public.d.ts", 1000, 1000),
    record("scripts/ci/fixtures/ignored.ts", 1000, 1000),
    record("scripts/ci/nested/ignored.ts", 1000, 1000),
    record("scripts/ci/helper.test.ts", 1000, 1000),
    record("scripts/ci/generated.d.ts", 1000, 1000),
    record("tests/ci/helper.ts", 1000, 1000, 1000, 1000, "BRF:1\nBRH:1"),
    record(temporaryModule, 1000, 1000),
    record("outside/source/app.ts", 1000, 1000),
  ].join("\n");
  const root = await createFixture(sources, lcov);

  try {
    const result = checkCoverage({ lcovPath: ".hesperia/coverage/lcov.info", repoPath: root });

    expect(result.lineFound).toBe(20);

    expect(result.lineHit).toBe(10);

    expect(result.functionFound).toBe(20);

    expect(result.functionHit).toBe(10);

    expect(result.linePercent).toBe(50);

    expect(result.functionPercent).toBe(50);

    expect(result.passed).toBe(false);

    expect(result.branchRecordsPresent).toBe(false);

    expect(result.unmeasuredSources).toStrictEqual(
      [
        "packages/sample/src/unmeasured.ts",
        "scripts/build-packages.ts",
        "scripts/ci/new-gate.ts",
        "scripts/ci/plan-golden.ts",
        "scripts/ci/select-golden.ts",
        "scripts/new-production-tool.ts",
        "editors/vscode/src/extension.ts",
      ].sort((left, right) => left.localeCompare(right)),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("normalizes absolute and relative LCOV paths with either separator", async () => {
  const sources = ["packages/sample/src/measured.ts", "scripts/ci/direct-tool.ts"];
  const root = await createFixture(sources, "");

  try {
    const absoluteSlashPath = resolve(root, "packages", "sample", "src", "measured.ts").replaceAll(
      "\\",
      "/",
    );
    const relativeBackslashPath = relative(
      root,
      join(root, "scripts", "ci", "direct-tool.ts"),
    ).replaceAll("/", "\\");

    await writeFile(
      join(root, ".hesperia", "coverage", "lcov.info"),
      [record(absoluteSlashPath, 1, 1), record(relativeBackslashPath, 1, 1)].join("\n"),
    );

    const result = checkCoverage({ lcovPath: ".hesperia/coverage/lcov.info", repoPath: root });

    expect(result.lineFound).toBe(2);

    expect(result.lineHit).toBe(2);

    expect(result.unmeasuredSources).toStrictEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uses native filesystem case semantics when matching LCOV paths", async () => {
  const sources = ["packages/sample/src/measured.ts", "scripts/ci/control.ts"];
  const root = await createFixture(sources, "");

  try {
    const caseVariant = "PACKAGES/sample/src/measured.ts";

    await writeFile(
      join(root, ".hesperia", "coverage", "lcov.info"),
      [record(caseVariant, 1, 1), record("scripts/ci/control.ts", 1, 1)].join("\n"),
    );

    const result = checkCoverage({ lcovPath: ".hesperia/coverage/lcov.info", repoPath: root });

    if (process.platform === "win32") {
      expect(result.lineFound).toBe(2);

      expect(result.unmeasuredSources).toStrictEqual([]);
    } else {
      expect(result.lineFound).toBe(1);

      expect(result.unmeasuredSources).toContain("packages/sample/src/measured.ts");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects duplicate in-scope source records after path normalization", async () => {
  const source = "packages/sample/src/measured.ts";
  const root = await createFixture([source], "");

  try {
    const absoluteSource = resolve(root, source).replaceAll("\\", "/");

    await writeFile(
      join(root, ".hesperia", "coverage", "lcov.info"),
      [record(source, 1, 1), record(absoluteSource, 1, 1)].join("\n"),
    );

    expect(() =>
      checkCoverage({ lcovPath: ".hesperia/coverage/lcov.info", repoPath: root }),
    ).toThrow("duplicate production source records for packages/sample/src/measured.ts");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps measured branch records outside the line and function floor", async () => {
  const root = await createFixture(
    defaultSources,
    record("packages/sample/src/measured.ts", 1, 1, 1, 1, "BRF:2\nBRH:1"),
  );

  try {
    const result = checkCoverage({ lcovPath: ".hesperia/coverage/lcov.info", repoPath: root });

    expect(result.passed).toBe(true);

    expect(result.branchRecordsPresent).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects reports without measurable records and invalid floors", async () => {
  const root = await createFixture(defaultSources, "TN:\nend_of_record\n");

  try {
    expect(() =>
      checkCoverage({ lcovPath: ".hesperia/coverage/lcov.info", repoPath: root }),
    ).toThrow("no measurable line or function records");

    await writeFile(
      join(root, ".hesperia", "coverage", "lcov.info"),
      record("packages/sample/src/measured.ts", 1, 1),
    );

    expect(() =>
      checkCoverage({ lcovPath: ".hesperia/coverage/lcov.info", repoPath: root, threshold: 101 }),
    ).toThrow("between 0 and 100");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects malformed LCOV counts and hits greater than their found totals", async () => {
  const filename = "packages/sample/src/measured.ts";
  const invalidRecords = [
    { lcov: record(filename, 1, 1, 1, "Infinity"), message: "invalid FNH count" },
    { lcov: record(filename, "NaN", 0, 1, 0), message: "invalid LF count" },
    { lcov: record(filename, 1, "-1", 1, 0), message: "invalid LH count" },
    { lcov: record(filename, 1, 1, "0.5", 0), message: "invalid FNF count" },
    {
      lcov: record(filename, 1, 1, 1, "9007199254740992"),
      message: "invalid FNH count",
    },
    { lcov: record(filename, 1, 2), message: "line hits exceed found count" },
    { lcov: record(filename, 1, 1, 1, 2), message: "function hits exceed found count" },
    {
      lcov: record(filename, 10, 90, 1, 1).replace("end_of_record", "LF:90\nend_of_record"),
      message: "duplicate LF count",
    },
    {
      lcov: record(filename, 100, 10, 1, 1).replace("end_of_record", "LH:80\nend_of_record"),
      message: "duplicate LH count",
    },
    {
      lcov: record(filename, 1, 1, 10, 90).replace("end_of_record", "FNF:90\nend_of_record"),
      message: "duplicate FNF count",
    },
    {
      lcov: record(filename, 1, 1, 100, 10).replace("end_of_record", "FNH:80\nend_of_record"),
      message: "duplicate FNH count",
    },
  ] as const;

  for (const invalid of invalidRecords) {
    const root = await createFixture(defaultSources, invalid.lcov);

    try {
      expect(() =>
        checkCoverage({ lcovPath: ".hesperia/coverage/lcov.info", repoPath: root }),
      ).toThrow(invalid.message);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("rejects LCOV aggregate counts that exceed the safe integer range", async () => {
  const first = "packages/sample/src/measured.ts";
  const second = "packages/sample/src/second.ts";
  const cases = [
    {
      records: [
        record(first, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
        record(second, 1, 1),
      ],
      message: "aggregate LF count exceeds the safe integer range",
    },
    {
      records: [
        record(first, 1, 1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
        record(second, 1, 1, 1, 1),
      ],
      message: "aggregate FNF count exceeds the safe integer range",
    },
  ] as const;

  for (const example of cases) {
    const root = await createFixture([first, second], example.records.join("\n"));

    try {
      expect(() =>
        checkCoverage({ lcovPath: ".hesperia/coverage/lcov.info", repoPath: root }),
      ).toThrow(example.message);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
