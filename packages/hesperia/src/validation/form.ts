import type { StandardSchemaV1 } from "@standard-schema/spec";
import { createTaskController } from "../data/task.ts";
import type { Accessor, Task, TaskRun, TaskStatus } from "../data/types.ts";
import type { Owner } from "../runtime/owner.ts";
import { validateStandardSchema } from "./standard-schema.ts";

/** Options for projecting a captured native form collection to schema input. */
export interface FormOptions<Input> {
  /**
   * Project a captured native collection before validation.
   *
   * @param formData - Native entries, including the selected submitter. The
   * collection retains repeated values, files, and undeclared fields.
   * @returns The authored schema input. Returned values remain borrowed.
   * @throws A mapping fault rejects the validation run through Task state.
   */
  readonly map?: (formData: FormData) => Input;
}

/** Native submission details captured for one form-validation run. */
export interface FormRunOptions {
  /** Native submit control to include; null or omission adds no submitter. */
  readonly submitter?: HTMLElement | null;
}

/**
 * Owner-bound schema validation state composed with native form collection.
 *
 * A result with `issues` is a successful validation execution; provider
 * exceptions and cancelled runs reject their individual TaskRun.
 */
export interface Form<Input, Output> {
  /** Latest validation result, including provider issues when input is invalid. */
  readonly value: Accessor<StandardSchemaV1.Result<Output> | undefined>;

  /** Whether the latest validation run is pending. */
  readonly pending: Accessor<boolean>;

  /** Latest provider, mapping, or execution failure. */
  readonly error: Accessor<unknown>;

  /** Lifecycle status of the shared latest validation run. */
  readonly status: Accessor<TaskStatus>;

  /**
   * Validate an authored value directly without native form collection.
   *
   * @param input - Value supplied to the Standard Schema validator.
   * @returns The TaskRun for this validation attempt.
   */
  readonly run: Task<Input, StandardSchemaV1.Result<Output>>["run"];

  /**
   * Capture native form values synchronously, project them, then validate.
   *
   * The supplied submitter is included in the captured FormData. Subsequent
   * control edits do not change that collection. Mapping/provider exceptions
   * reject this run; an issues result resolves normally. Captured objects are
   * not deep-cloned, and schema transformations do not write into controls.
   *
   * @param form - Native form whose successful controls are captured.
   * @param options - Optional native submission metadata.
   * @returns The TaskRun for this validation attempt.
   */
  readonly runForm: (
    form: HTMLFormElement,
    options?: FormRunOptions,
  ) => TaskRun<StandardSchemaV1.Result<Output>>;

  /**
   * Cancel current validation authority and clear validation state to idle.
   *
   * Reset does not change native controls or add reset behavior to ordinary
   * Tasks. A superseded or reset run cannot publish a late result.
   */
  readonly reset: () => void;
}

type FormInvocation<Input> =
  | { readonly kind: "input"; readonly input: Input }
  | {
      readonly kind: "form";
      readonly form: HTMLFormElement;
      readonly options: FormRunOptions | undefined;
    };

type PreparedFormInvocation<Input> =
  | { readonly kind: "input"; readonly input: Input }
  | { readonly kind: "form"; readonly formData: FormData };

/**
 * Create one owner-bound form-validation controller backed by the Task engine.
 *
 * @param owner - Component lifetime that owns validation work and state.
 * @param schema - Provider-neutral schema used by both run entry points.
 * @param options - Optional FormData projection for native form runs.
 * @returns The shared latest-run form controller.
 * @throws A rendering fault if the owner is no longer active.
 */
export function createForm<Input, Output>(
  owner: Owner,
  schema: StandardSchemaV1<Input, Output>,
  options: FormOptions<Input> = {},
): Form<Input, Output> {
  owner.assertActive();

  const controller = createTaskController<
    FormInvocation<Input>,
    StandardSchemaV1.Result<Output>,
    PreparedFormInvocation<Input>
  >(
    owner,
    () => (invocation) => {
      if (invocation.kind === "input") {
        return validateStandardSchema(schema, invocation.input);
      }

      const formData = invocation.formData;
      const mapFormData = options.map;
      let input: unknown;

      if (mapFormData === undefined) {
        input = projectFormData(formData);
      } else {
        if (typeof mapFormData !== "function") {
          throw new TypeError("Form map must be a function");
        }

        input = mapFormData(formData);
      }

      return validateStandardSchema(schema, input);
    },
    (invocation) => {
      if (invocation.kind === "input") return invocation;

      const submitter = invocation.options?.submitter;
      const formData =
        submitter === undefined
          ? new FormData(invocation.form)
          : new FormData(invocation.form, submitter);

      return { kind: "form", formData };
    },
  );

  const run = ((...args: Parameters<Form<Input, Output>["run"]>) => {
    return controller.task.run({ kind: "input", input: args[0] as Input });
  }) as Form<Input, Output>["run"];

  const form: Form<Input, Output> = {
    value: controller.task.value,
    pending: controller.task.pending,
    error: controller.task.error,
    status: controller.task.status,
    run,
    runForm: (nativeForm, runOptions) => {
      return controller.task.run({
        kind: "form",
        form: nativeForm,
        options: runOptions,
      });
    },
    reset: controller.reset,
  };

  return Object.freeze(form);
}

function projectFormData(formData: FormData): unknown {
  const valuesByName = new Map<string, FormDataEntryValue[]>();

  for (const [name, value] of formData.entries()) {
    const values = valuesByName.get(name);

    if (values) {
      values.push(value);
    } else {
      valuesByName.set(name, [value]);
    }
  }

  const projection: Record<string, FormDataEntryValue | FormDataEntryValue[]> = {};

  for (const [name, values] of valuesByName) {
    Object.defineProperty(projection, name, {
      configurable: true,
      enumerable: true,
      value: values.length === 1 ? values[0] : values,
      writable: true,
    });
  }

  return projection;
}
