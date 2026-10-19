import assert from "node:assert/strict";
import { expect, test } from "bun:test";

const workflow = Bun.YAML.parse(
  await Bun.file(new URL("../../.github/workflows/release.yml", import.meta.url)).text(),
) as {
  jobs: Record<string, { steps: { name?: string; with?: { script?: string } }[] }>;
};

function workflowScript(job: string, name: string): string {
  const script = workflow.jobs[job]?.steps.find((step) => step.name === name)?.with?.script;

  assert.ok(script, `Missing executable release gate: ${name}`);

  return script;
}

const selection = workflowScript("verify", "Wait for the exact main CI candidate");
const publication = workflowScript("publish", "Recheck provenance before publication");
const sha = "a".repeat(40);

function scenario() {
  const run = {
    id: 41,
    workflow_id: 7,
    path: ".github/workflows/ci.yml",
    event: "push",
    head_branch: "main",
    head_sha: sha,
    repository: { full_name: "hesperia-js/hesperia" },
    head_repository: { full_name: "hesperia-js/hesperia" },
    status: "completed",
    conclusion: "success",
    run_attempt: 2,
    html_url: "https://github.com/hesperia-js/hesperia/actions/runs/41",
  };
  const upload = {
    name: "Save the package candidate",
    conclusion: "success",
    started_at: "2026-10-18T06:27:12Z",
    completed_at: "2026-10-18T06:27:14Z",
  };
  const artifact = {
    id: 53,
    name: "release-candidate",
    expired: false,
    created_at: "2026-10-18T06:27:14Z",
    workflow_run: { id: run.id, head_sha: sha },
  };
  const jobs = [
    { name: "Required", status: "completed", conclusion: "success", steps: [] },
    { name: "verify / Verification result", status: "completed", conclusion: "success", steps: [] },
    {
      name: "verify / Build, types, lint and format",
      status: "completed",
      conclusion: "success",
      steps: [upload],
    },
  ];

  return {
    run,
    current: structuredClone(run),
    runs: [run],
    upload,
    artifact,
    artifacts: [artifact],
    jobs,
  };
}

type Scenario = ReturnType<typeof scenario>;

async function execute(script: string, fixture: Scenario): Promise<Record<string, string>> {
  let reads = 0;
  const outputs: Record<string, string> = {};
  const actions = {
    getWorkflow: async () => ({ data: { id: 7 } }),
    listWorkflowRuns: async () => fixture.runs,
    getWorkflowRun: async () => ({
      data: script === selection && reads++ === 0 ? fixture.run : fixture.current,
    }),
    listJobsForWorkflowRunAttempt: async (input: { attempt_number: number }) =>
      input.attempt_number === 2 ? fixture.jobs : [],
    listWorkflowRunArtifacts: async () => fixture.artifacts,
    getArtifact: async () => ({ data: fixture.artifact }),
  };
  const summary = {
    addLink: () => summary,
    write: async () => undefined,
  };
  const invoke = new Function(
    "github",
    "core",
    "context",
    "process",
    "setTimeout",
    `return (async () => {\n${script}\n})();`,
  ) as (...args: unknown[]) => Promise<void>;

  await invoke(
    {
      rest: { actions },
      paginate: (endpoint: (input: unknown) => Promise<unknown>, input: unknown) => endpoint(input),
    },
    { setOutput: (name: string, value: string) => (outputs[name] = value), summary },
    {
      repo: { owner: "hesperia-js", repo: "hesperia" },
      payload: { pull_request: { merge_commit_sha: sha } },
    },
    { env: { CI_RUN_ID: "41", CI_RUN_ATTEMPT: "2", CI_ARTIFACT_ID: "53" } },
    () => {
      throw new Error("Unexpected polling in a completed-source scenario");
    },
  );

  return outputs;
}

test("Release admits the exact successful main CI attempt and its tested artifact", async () => {
  const fixture = scenario();

  expect(await execute(selection, fixture)).toStrictEqual({
    "run-id": "41",
    "run-attempt": "2",
    "artifact-id": "53",
  });

  await execute(publication, fixture);
});

const rejectedSelections: [string, (fixture: Scenario) => void, string][] = [
  [
    "PR event",
    (f) => {
      f.run.event = "pull_request";
    },
    "identity differs",
  ],
  [
    "different SHA",
    (f) => {
      f.run.head_sha = "b".repeat(40);
    },
    "identity differs",
  ],
  [
    "foreign repository",
    (f) => {
      f.run.repository.full_name = "other/hesperia";
    },
    "identity differs",
  ],
  [
    "foreign source",
    (f) => {
      f.run.head_repository.full_name = "other/hesperia";
    },
    "identity differs",
  ],
  [
    "failed CI",
    (f) => {
      f.run.conclusion = "failure";
    },
    "did not succeed",
  ],
  [
    "cancelled CI",
    (f) => {
      f.run.conclusion = "cancelled";
    },
    "did not succeed",
  ],
  [
    "missing Required",
    (f) => {
      f.jobs.shift();
    },
    "successful Required gate",
  ],
  [
    "failed result",
    (f) => {
      f.jobs[1]!.conclusion = "failure";
    },
    "successful verify / Verification result gate",
  ],
  [
    "missing upload",
    (f) => {
      f.jobs[2]!.steps = [];
    },
    "successful candidate upload",
  ],
  [
    "ambiguous runs",
    (f) => {
      f.runs.push(structuredClone(f.run));
    },
    "Ambiguous main CI runs",
  ],
  [
    "expired candidate",
    (f) => {
      f.artifact.expired = true;
    },
    "unexpired package candidate",
  ],
  [
    "ambiguous candidates",
    (f) => {
      f.artifacts.push({ ...f.artifact, id: 54 });
    },
    "unexpired package candidate",
  ],
  [
    "old attempt artifact",
    (f) => {
      f.artifact.created_at = "2026-10-18T06:20:00Z";
    },
    "unexpired package candidate",
  ],
  [
    "old attempt upload",
    (f) => {
      f.upload.started_at = "2026-10-18T06:19:58Z";
      f.upload.completed_at = "2026-10-18T06:20:00Z";
    },
    "unexpired package candidate",
  ],
  [
    "different artifact run",
    (f) => {
      f.artifact.workflow_run.id = 40;
    },
    "unexpired package candidate",
  ],
  [
    "attempt race",
    (f) => {
      f.current.run_attempt = 3;
    },
    "attempt changed",
  ],
];

test.each(rejectedSelections)(
  "Release rejects %s during candidate selection",
  async (_, mutate, message) => {
    const fixture = scenario();

    mutate(fixture);

    await expect(execute(selection, fixture)).rejects.toThrow(message);
  },
);

const rejectedPublications: [string, (fixture: Scenario) => void][] = [
  [
    "new CI attempt",
    (f) => {
      f.current.run_attempt = 3;
    },
  ],
  [
    "cancelled source",
    (f) => {
      f.current.conclusion = "cancelled";
    },
  ],
  [
    "expired archive",
    (f) => {
      f.artifact.expired = true;
    },
  ],
  [
    "foreign archive SHA",
    (f) => {
      f.artifact.workflow_run.head_sha = "b".repeat(40);
    },
  ],
];

test.each(rejectedPublications)("Release rejects %s before publication", async (_, mutate) => {
  const fixture = scenario();

  mutate(fixture);

  await expect(execute(publication, fixture)).rejects.toThrow(
    "provenance changed before publication",
  );
});
