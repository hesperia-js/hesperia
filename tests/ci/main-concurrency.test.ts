import { expect, test } from "bun:test";

const workflow = Bun.YAML.parse(
  await Bun.file(new URL("../../.github/workflows/ci.yml", import.meta.url)).text(),
) as {
  concurrency: { group: string };
  jobs: Record<string, { steps?: { name?: string; with?: { script?: string } }[] }>;
};
const script =
  workflow.jobs["cancel-stale-main"]?.steps?.find(
    (step) => step.name === "Cancel superseded ordinary main CI",
  )?.with?.script ?? "";
const repository = { full_name: "hesperia-js/hesperia" };
const oldSha = "a".repeat(40);
const newSha = "b".repeat(40);

function scenario() {
  const current = {
    id: 200,
    run_number: 20,
    run_attempt: 1,
    workflow_id: 7,
    path: ".github/workflows/ci.yml",
    event: "push",
    head_branch: "main",
    head_sha: newSha,
    status: "in_progress",
    repository: structuredClone(repository),
    head_repository: structuredClone(repository),
    created_at: "2026-10-20T12:00:00Z",
  };
  const candidate = {
    ...structuredClone(current),
    id: 190,
    run_number: 19,
    head_sha: oldSha,
    created_at: "2026-10-20T11:30:00Z",
  };
  const pull = {
    number: 10,
    state: "closed",
    merged: true,
    merged_at: "2026-10-20T11:00:00Z",
    merge_commit_sha: oldSha,
    base: { ref: "main", repo: structuredClone(repository) },
    head: { ref: "fix/example", repo: structuredClone(repository) },
  };

  return {
    current,
    candidate,
    refreshed: structuredClone(candidate),
    runs: [candidate],
    associated: [{ number: pull.number }],
    currentAssociated: [{ number: 20 }],
    pull,
    currentPull: { ...structuredClone(pull), number: 20, merge_commit_sha: newSha },
    heads: [newSha, newSha],
    comparison: { status: "ahead", ahead_by: 1, behind_by: 0, merge_base_commit: { sha: oldSha } },
    eventName: "push",
    ref: "refs/heads/main",
    fail: "",
  };
}

type Scenario = ReturnType<typeof scenario>;

async function execute(fixture: Scenario) {
  const canceled: number[] = [];
  const calls: string[] = [];
  let branchReads = 0;
  let candidateReads = 0;

  function read(name: string) {
    calls.push(name);

    if (fixture.fail === name) {
      throw new Error(`Unavailable ${name}`);
    }
  }

  const actions = {
    getWorkflowRun: async ({ run_id }: { run_id: number }) => {
      read(`run:${run_id}`);

      return {
        data:
          run_id === 200
            ? fixture.current
            : candidateReads++ === 0
              ? fixture.candidate
              : fixture.refreshed,
      };
    },
    listWorkflowRuns: async () => {
      read("runs");

      return fixture.runs;
    },
    cancelWorkflowRun: async ({ run_id }: { run_id: number }) => {
      calls.push(`cancel:${run_id}`);
      canceled.push(run_id);

      return { status: 202 };
    },
  };
  const repos = {
    getBranch: async () => {
      read("branch");
      const sha = fixture.heads[Math.min(branchReads++, fixture.heads.length - 1)];

      return { data: { name: "main", commit: { sha } } };
    },
    listPullRequestsAssociatedWithCommit: async ({ commit_sha }: { commit_sha: string }) => {
      read(commit_sha === newSha ? "current-associated" : "associated");

      return commit_sha === newSha ? fixture.currentAssociated : fixture.associated;
    },
    compareCommitsWithBasehead: async ({ basehead }: { basehead: string }) => {
      read("compare");

      expect(basehead).toBe(`${oldSha}...${newSha}`);

      return { data: fixture.comparison };
    },
  };
  const pulls = {
    get: async ({ pull_number }: { pull_number: number }) => {
      read(pull_number === 20 ? "current-pull" : "pull");

      return { data: pull_number === 20 ? fixture.currentPull : fixture.pull };
    },
  };
  const invoke = new Function(
    "github",
    "context",
    "core",
    "process",
    `return (async () => {\n${script}\n})();`,
  ) as (...args: unknown[]) => Promise<void>;

  await invoke(
    {
      rest: { actions, repos, pulls },
      paginate: (endpoint: (input: unknown) => Promise<unknown>, input: unknown) => endpoint(input),
    },
    {
      repo: { owner: "hesperia-js", repo: "hesperia" },
      runId: 200,
      runNumber: 20,
      sha: newSha,
      ref: fixture.ref,
      eventName: fixture.eventName,
      payload: { repository, ref: fixture.ref, after: newSha },
    },
    { info: () => undefined, warning: () => undefined, notice: () => undefined },
    { env: { GITHUB_RUN_ID: "200", GITHUB_RUN_NUMBER: "20", GITHUB_RUN_ATTEMPT: "1" } },
  );

  return { canceled, calls };
}

test("a newer main push cancels older ordinary main CI after fresh run and branch checks", async () => {
  const result = await execute(scenario());

  expect(result.canceled).toEqual([190]);

  const cancellation = result.calls.indexOf("cancel:190");

  expect(result.calls.lastIndexOf("run:190")).toBeLessThan(cancellation);
  expect(result.calls.lastIndexOf("run:190")).toBeGreaterThan(result.calls.indexOf("pull"));
  expect(result.calls.lastIndexOf("branch")).toBeGreaterThan(result.calls.lastIndexOf("run:190"));
  expect(result.calls.lastIndexOf("branch")).toBeLessThan(cancellation);
});

test("ordinary feature merges and queued candidates remain eligible for cancellation", async () => {
  const fixture = scenario();
  fixture.pull.head.ref = "feature/example";
  fixture.currentPull.head.ref = "feature/newer";
  fixture.candidate.status = "queued";
  fixture.refreshed.status = "queued";

  expect((await execute(fixture)).canceled).toEqual([190]);
});

const retained: [string, (f: Scenario) => void][] = [
  [
    "initiating release merge",
    (f) => {
      f.currentPull.head.ref = "release/1.0.0";
    },
  ],
  [
    "initiating merge without provenance",
    (f) => {
      f.currentAssociated = [];
    },
  ],
  [
    "release merge",
    (f) => {
      f.pull.head.ref = "release/1.0.0";
    },
  ],
  [
    "ordinary and release association ambiguity",
    (f) => {
      f.associated.push({ number: 11 });
    },
  ],
  [
    "no PR provenance",
    (f) => {
      f.associated = [];
    },
  ],
  [
    "unmerged PR",
    (f) => {
      f.pull.merged = false;
    },
  ],
  [
    "open PR",
    (f) => {
      f.pull.state = "open";
    },
  ],
  [
    "wrong merge SHA",
    (f) => {
      f.pull.merge_commit_sha = newSha;
    },
  ],
  [
    "wrong PR base",
    (f) => {
      f.pull.base.ref = "release/1.0.0";
    },
  ],
  [
    "foreign PR base",
    (f) => {
      f.pull.base.repo.full_name = "other/hesperia";
    },
  ],
  [
    "fork PR head",
    (f) => {
      f.pull.head.repo.full_name = "other/hesperia";
    },
  ],
  [
    "unknown PR branch",
    (f) => {
      f.pull.head.ref = "maintenance/example";
    },
  ],
  [
    "missing merge date",
    (f) => {
      f.pull.merged_at = "";
    },
  ],
  [
    "merge after current run",
    (f) => {
      f.pull.merged_at = "2026-10-20T13:00:00Z";
    },
  ],
  [
    "merge after candidate run",
    (f) => {
      f.pull.merged_at = "2026-10-20T11:45:00Z";
    },
  ],
  [
    "completed candidate",
    (f) => {
      f.candidate.status = "completed";
    },
  ],
  [
    "same SHA",
    (f) => {
      f.candidate.head_sha = newSha;
    },
  ],
  [
    "current run",
    (f) => {
      f.candidate.id = 200;
    },
  ],
  [
    "newer run",
    (f) => {
      f.candidate.run_number = 21;
    },
  ],
  [
    "different workflow",
    (f) => {
      f.candidate.workflow_id = 8;
    },
  ],
  [
    "different workflow path",
    (f) => {
      f.candidate.path = ".github/workflows/release.yml";
    },
  ],
  [
    "PR run",
    (f) => {
      f.candidate.event = "pull_request";
    },
  ],
  [
    "different branch",
    (f) => {
      f.candidate.head_branch = "release/1.0.0";
    },
  ],
  [
    "foreign run repository",
    (f) => {
      f.candidate.repository.full_name = "other/hesperia";
    },
  ],
  [
    "foreign run head",
    (f) => {
      f.candidate.head_repository.full_name = "other/hesperia";
    },
  ],
  [
    "diverged history",
    (f) => {
      f.comparison.status = "diverged";
    },
  ],
  [
    "wrong merge base",
    (f) => {
      f.comparison.merge_base_commit.sha = newSha;
    },
  ],
  [
    "behind commits",
    (f) => {
      f.comparison.behind_by = 1;
    },
  ],
  [
    "no newer commits",
    (f) => {
      f.comparison.ahead_by = 0;
    },
  ],
  [
    "refreshed completed run",
    (f) => {
      f.refreshed.status = "completed";
    },
  ],
  [
    "refreshed attempt changed",
    (f) => {
      f.refreshed.run_attempt = 2;
    },
  ],
  [
    "refreshed SHA changed",
    (f) => {
      f.refreshed.head_sha = newSha;
    },
  ],
  [
    "current push already stale",
    (f) => {
      f.heads = [oldSha];
    },
  ],
  [
    "new push during checks",
    (f) => {
      f.heads = [newSha, oldSha];
    },
  ],
  [
    "PR invocation",
    (f) => {
      f.eventName = "pull_request";
    },
  ],
  [
    "manual invocation",
    (f) => {
      f.eventName = "workflow_dispatch";
    },
  ],
  [
    "tag invocation",
    (f) => {
      f.ref = "refs/tags/v1.0.0";
    },
  ],
];

for (const [name, change] of retained) {
  test(`retains CI for ${name}`, async () => {
    const fixture = scenario();

    change(fixture);

    expect((await execute(fixture)).canceled).toEqual([]);
  });
}

for (const endpoint of [
  "run:200",
  "branch",
  "current-associated",
  "current-pull",
  "runs",
  "associated",
  "pull",
  "compare",
  "run:190",
]) {
  test(`retains CI when ${endpoint} cannot establish cancellation safety`, async () => {
    const fixture = scenario();
    fixture.fail = endpoint;

    expect((await execute(fixture)).canceled).toEqual([]);
  });
}

function concurrencyGroup(github: Record<string, unknown>): string {
  const expression = workflow.concurrency.group.slice(3, -2).trim();
  const format = (template: string, ...values: unknown[]) =>
    template.replace(/\{(\d+)\}/g, (_, index: string) => String(values[Number(index)]));

  return new Function("github", "format", `return (${expression});`)(github, format) as string;
}

test("main push concurrency preserves all distinct runs including repeated release SHAs", () => {
  const push = {
    event_name: "push",
    ref: "refs/heads/main",
    sha: oldSha,
    event: { pull_request: { number: 0 } },
  };
  const groups = [
    concurrencyGroup({ ...push, run_id: 190 }),
    concurrencyGroup({ ...push, run_id: 200 }),
    concurrencyGroup({ ...push, run_id: 210 }),
    concurrencyGroup({ ...push, run_id: 220, sha: newSha }),
  ];

  expect(new Set(groups).size).toBe(4);
});

test("PR, tag, and manual concurrency retains its existing grouping", () => {
  const pull = {
    event_name: "pull_request",
    ref: "refs/pull/10/merge",
    event: { pull_request: { number: 10 } },
  };

  expect(concurrencyGroup({ ...pull, sha: oldSha, run_id: 190 })).toBe("ci-10");
  expect(concurrencyGroup({ ...pull, sha: newSha, run_id: 200 })).toBe("ci-10");
  expect(
    concurrencyGroup({
      event_name: "push",
      ref: "refs/tags/v1.0.0",
      event: { pull_request: { number: 0 } },
    }),
  ).toBe("ci-refs/tags/v1.0.0");
  expect(
    concurrencyGroup({
      event_name: "workflow_dispatch",
      ref: "refs/heads/main",
      event: { pull_request: { number: 0 } },
    }),
  ).toBe("ci-refs/heads/main");
});
