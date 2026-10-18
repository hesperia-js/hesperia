import { computed, signal } from "aeolia";
import { RenderFault, type Owner, reportFault } from "../runtime/owner.ts";
import { registerFrameworkAwaitable } from "./protocol.ts";
import type {
  Accessor,
  InferredTask,
  Task,
  TaskContext,
  TaskFactory,
  TaskInvocation,
  TaskRun,
  TaskStatus,
} from "./types.ts";

function cancellationReason(message: string): unknown {
  return new DOMException(message, "AbortError");
}

/** Create an owner-bound, latest-invocation-wins task controller. */
export function createTask<
  Args extends Parameters<Operation>,
  Output,
  Operation extends TaskInvocation<never, Output>,
>(owner: Owner, factory: (context: TaskContext) => Operation): InferredTask<Args, Operation>;

/** Create a controller with explicitly selected input and output types. */
export function createTask<Input = void, Output = unknown>(
  owner: Owner,
  factory: TaskFactory<Input, Output>,
): Task<Input, Output>;

export function createTask<Input = void, Output = unknown>(
  owner: Owner,
  factory: TaskFactory<Input, Output>,
): Task<Input, Output> {
  owner.assertActive();

  if (typeof factory !== "function") throw new TypeError("Task factory must be a function");

  const stateCell = signal<TaskState<Output>>(
    { status: "idle", value: undefined, error: undefined },
    { label: "task:state" },
  );
  const statusCell = computed(() => stateCell.get().status, { label: "task:status" });
  const valueCell = computed(() => stateCell.get().value, { label: "task:value" });
  const errorCell = computed(() => stateCell.get().error, { label: "task:error" });
  const pendingCell = computed(() => stateCell.get().status === "pending", {
    label: "task:pending",
  });
  let nextId = 0;
  let current: Invocation | undefined;
  let disposed = false;

  const read = <T>(cell: { get(): T }): T => {
    owner.assertReadable();

    return cell.get();
  };

  const reportPublicationFailure = (error: unknown): void => {
    try {
      reportFault(owner, error);
    } catch {
      // The awaitable below still receives the publication failure when an unhandled boundary
      // rethrows it through the context's terminal error handler.
    }
  };

  const cancelCurrent = (reason: unknown): void => {
    current?.cancel(reason);
  };

  const onOwnerAbort = (): void => {
    cancelCurrent(owner.signal.reason);
  };

  owner.signal.addEventListener("abort", onOwnerAbort, { once: true });

  owner.onRelease(() => {
    disposed = true;

    owner.signal.removeEventListener("abort", onOwnerAbort);

    cancelCurrent(owner.signal.reason);

    current = undefined;
  });

  const run: Task<Input, Output>["run"] = (input?: Input): TaskRun<Output> => {
    owner.assertActive();

    if (owner.executingBody)
      throw new RenderFault("task-body", "Task dispatch is forbidden in a component body");

    if (disposed) throw new RenderFault("disposed", "Task owner is no longer active");

    const previous = current;
    const controller = new AbortController();
    let resolvePromise!: (value: Output | PromiseLike<Output>) => void;
    let rejectPromise!: (reason?: unknown) => void;
    const promise = new Promise<Output>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    let settled = false;
    const invocation: Invocation = {
      id: ++nextId,
      controller,

      cancel(reason = cancellationReason("Task invocation cancelled")) {
        if (settled) return;

        settled = true;

        controller.abort(reason);

        if (current === invocation) {
          current = undefined;

          try {
            stateCell.set({ status: "cancelled", value: undefined, error: undefined });
          } catch (error) {
            reportPublicationFailure(error);
          }
        }

        rejectPromise(reason);
      },
    };
    // Keep the handle a native Promise so standard promise tooling and `await` treat it exactly
    // like an ordinary result. The controller itself has no `then`, so returning it as a value
    // does not trigger promise assimilation.
    const handle = promise as unknown as TaskRun<Output>;

    Object.assign(handle, {
      id: invocation.id,
      signal: controller.signal,
      cancel: invocation.cancel,
    });

    registerFrameworkAwaitable(handle, owner, "task");

    // A caller may intentionally fire and forget. Keep that rejection observed while preserving
    // the original rejection for a later `await handle`.
    void promise.catch(() => undefined);

    current = invocation;

    previous?.cancel(cancellationReason("Task superseded by a newer invocation"));

    // An abort listener may synchronously dispatch another run. That newer run remains primary,
    // so the superseded invocation must not publish state or invoke its factory afterward.
    if (current !== invocation || controller.signal.aborted || disposed) return handle;

    try {
      stateCell.set({ status: "pending", value: undefined, error: undefined });
    } catch (error) {
      current = undefined;

      reportPublicationFailure(error);

      rejectPromise(error);

      return handle;
    }

    if (current !== invocation || controller.signal.aborted || disposed) return handle;

    let operation: ReturnType<TaskFactory<Input, Output>>;

    try {
      operation = factory({ signal: controller.signal });

      if (typeof operation !== "function")
        throw new TypeError("Task factory must return a function");

      if (current !== invocation || controller.signal.aborted || disposed) return handle;

      const outcome = operation(input as Input);

      Promise.resolve(outcome).then(
        (value) => {
          if (settled) return;

          settled = true;

          if (current !== invocation || controller.signal.aborted || disposed) {
            rejectPromise(
              controller.signal.reason ?? cancellationReason("Task invocation cancelled"),
            );

            return;
          }

          current = undefined;

          try {
            stateCell.set({ status: "success", value, error: undefined });
          } catch (error) {
            current = undefined;

            reportPublicationFailure(error);

            rejectPromise(error);

            return;
          }

          resolvePromise(value);
        },
        (error: unknown) => {
          if (settled) return;

          if (isCancellationError(error)) {
            invocation.cancel(error);

            return;
          }

          settled = true;

          if (current !== invocation || controller.signal.aborted || disposed) {
            rejectPromise(
              controller.signal.reason ?? cancellationReason("Task invocation cancelled"),
            );

            return;
          }

          current = undefined;

          try {
            stateCell.set({ status: "failure", value: undefined, error });
          } catch (publicationError) {
            current = undefined;

            reportPublicationFailure(publicationError);

            rejectPromise(publicationError);

            return;
          }

          rejectPromise(error);
        },
      );
    } catch (error) {
      if (!settled) {
        if (isCancellationError(error)) {
          invocation.cancel(error);

          return handle;
        }

        settled = true;

        if (current === invocation) {
          current = undefined;

          try {
            stateCell.set({ status: "failure", value: undefined, error });
          } catch (publicationError) {
            current = undefined;

            reportPublicationFailure(publicationError);

            rejectPromise(publicationError);
          }
        }

        rejectPromise(error);
      }
    }

    return handle;
  };

  const task: Task<Input, Output> = {
    run,
    value: (() => read(valueCell)) as Accessor<Output | undefined>,
    pending: (() => read(pendingCell)) as Accessor<boolean>,
    error: (() => read(errorCell)) as Accessor<unknown>,
    status: (() => read(statusCell)) as Accessor<TaskStatus>,
  };
  return Object.freeze(task);
}

function isCancellationError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

interface Invocation {
  readonly id: number;
  readonly controller: AbortController;
  readonly cancel: (reason?: unknown) => void;
}

interface TaskState<Output> {
  readonly status: TaskStatus;
  readonly value: Output | undefined;
  readonly error: unknown;
}

export type { Accessor, Task, TaskContext, TaskFactory, TaskRun, TaskStatus } from "./types.ts";
