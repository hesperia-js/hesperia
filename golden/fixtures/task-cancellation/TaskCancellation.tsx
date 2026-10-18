import * as client from "hesperia/client";

type TaskOutcome = { kind: "resolved"; value: string } | { kind: "rejected"; name: string };

type DeferredBackend = {
  resolve(value: string): void;

  settled: Promise<void>;
};

type TaskHarness = {
  currentId(): number | undefined;

  cancel(): void;

  resolveBackend(value: string): void;

  backendSettled(): Promise<void>;

  outcome(): Promise<TaskOutcome>;
};

let activeHarness: TaskHarness | undefined;

export function getTaskHarness(): TaskHarness {
  if (!activeHarness) throw new Error("The task application has not mounted");

  return activeHarness;
}

function rejectionName(reason: unknown): string {
  if (typeof reason === "object" && reason !== null && "name" in reason) {
    return String(reason.name);
  }

  return String(reason);
}

export default function TaskCancellation() {
  const action = client.task<void, string>(() => () => {
    let resolve!: (value: string) => void;
    let markSettled!: () => void;
    const settled = new Promise<void>((done) => {
      markSettled = done;
    });
    const request = new Promise<string>((done) => {
      resolve = done;
    }).finally(markSettled);

    backend = { resolve, settled };
    return request;
  });
  let backend: DeferredBackend | undefined;
  let currentRun: ReturnType<typeof action.run> | undefined;
  let currentOutcome: Promise<TaskOutcome> | undefined;

  function start(): void {
    const run = action.run();
    currentRun = run;
    currentOutcome = Promise.resolve(run).then(
      (value) => ({ kind: "resolved", value }),
      (reason: unknown) => ({ kind: "rejected", name: rejectionName(reason) }),
    );
  }

  function cancel(): void {
    if (!currentRun) throw new Error("Start the task before cancelling it");

    currentRun.cancel(new DOMException("Cancelled by the golden scenario", "AbortError"));
  }

  activeHarness = {
    currentId: () => currentRun?.id,
    cancel,

    resolveBackend(value) {
      if (!backend) throw new Error("The task backend has not started");

      backend.resolve(value);
    },

    async backendSettled() {
      if (!backend) throw new Error("The task backend has not started");

      await backend.settled;
    },

    outcome() {
      if (!currentOutcome) throw new Error("The task has not started");

      return currentOutcome;
    },
  };

  return (
    <main>
      <button id="start-task" type="button" on:click={start}>
        Start task
      </button>
      <button id="cancel-task" type="button" on:click={cancel}>
        Cancel task
      </button>
      <output id="task-outcome">
        {action.status()}:{action.value() ?? "none"}
      </output>
    </main>
  );
}
