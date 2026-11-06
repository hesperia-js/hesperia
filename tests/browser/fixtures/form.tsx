import { mount } from "hesperia";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import * as client from "hesperia/client";

type ProjectionValue = FormDataEntryValue | readonly FormDataEntryValue[];
type Projection = Record<string, ProjectionValue>;
type ValidationResult = StandardSchemaV1.Result<string>;

let releaseDelayedValidations: () => void = () => undefined;

function displayValue(value: ProjectionValue): unknown {
  if (Array.isArray(value)) return value.map(displayEntry);

  return displayEntry(value as FormDataEntryValue);
}

function displayEntry(value: FormDataEntryValue): unknown {
  if (value instanceof File) return { file: value.name, type: value.type, size: value.size };

  return value;
}

function displayResult(result: ValidationResult | undefined): string {
  if (result === undefined) return "";
  if (result.issues) return JSON.stringify({ issues: result.issues });

  return result.value;
}

function displayError(error: unknown): string {
  if (error === undefined) return "";
  if (error instanceof Error) return `${error.name}:${error.message}`;

  return String(error);
}

function FormValidation() {
  const schemaCalls = client.state(0);
  const captureTiming = client.state("not-run");
  const delayed: Array<() => void> = [];

  const schema: StandardSchemaV1<Projection, string> = {
    "~standard": {
      version: 1,
      vendor: "hesperia-browser-fixture",
      validate(input) {
        schemaCalls.set(schemaCalls() + 1);

        if (typeof input !== "object" || input === null || Array.isArray(input))
          return { issues: [{ message: "Expected form fields" }] };

        const projection = input as Projection;

        if (projection.required === "invalid")
          return {
            issues: [{ message: "Enter a usable value", path: [{ key: "required" }] }],
          };

        const output = JSON.stringify(
          Object.fromEntries(
            Object.entries(projection).map(([name, value]) => [name, displayValue(value)]),
          ),
        );

        if (projection.delay === "slow")
          return new Promise<ValidationResult>((resolve) => {
            delayed.push(() => resolve({ value: output }));
          });

        return { value: output };
      },
    },
  };

  const validation = client.form(schema);
  const mappedValidation = client.form(schema, {
    map(formData) {
      const source = formData.get("source");

      if (source === "map-fault") throw new Error("form mapping failed");

      return {
        required: source ?? "",
        mappedOnly: formData.get("extra") ?? "",
      };
    },
  });

  const nativeForm = client.bind<HTMLFormElement>();
  const mappedForm = client.bind<HTMLFormElement>();

  const startNativeRun = (event: SubmitEvent) => {
    event.preventDefault();

    let capturedDuringCall = false;
    const observeCapture = () => {
      capturedDuringCall = true;
    };

    const form = nativeForm();

    form.addEventListener("formdata", observeCapture, { once: true });
    const run = validation.runForm(form, { submitter: event.submitter });
    form.removeEventListener("formdata", observeCapture);
    captureTiming.set(capturedDuringCall ? "true" : "false");
    void run.then(undefined, () => undefined);
  };

  const startMappedRun = (event: SubmitEvent) => {
    event.preventDefault();

    const run = mappedValidation.runForm(mappedForm(), { submitter: event.submitter });
    void run.then(undefined, () => undefined);
  };

  const releaseDelayed = () => {
    for (const release of delayed.splice(0)) {
      release();

      const completion = document.getElementById("provider-completions");

      if (completion) completion.textContent = String(Number(completion.textContent ?? "0") + 1);
    }
  };
  releaseDelayedValidations = releaseDelayed;

  return (
    <main>
      <form id="validation-form" bind={nativeForm} on:submit={startNativeRun}>
        <label>
          Required
          <input id="required" name="required" required />
        </label>
        <label>
          Empty
          <input id="empty" name="empty" value="" />
        </label>
        <label>
          Dotted name
          <input id="dotted" name="profile.name" value="Ada Lovelace" />
        </label>
        <label>
          Bracketed name
          <input id="bracketed" name="metadata[code]" value="x7" />
        </label>
        <label>
          Special name
          <input id="special-name" name="__proto__" value="literal" />
        </label>
        <label>
          Unknown name
          <input id="unknown" name="unrecognized" value="kept" />
        </label>
        <label>
          First tag
          <input id="tag-one" name="tags" value="red" />
        </label>
        <label>
          Second tag
          <input id="tag-two" name="tags" value="blue" />
        </label>
        <label>
          Delay
          <input id="delay" name="delay" />
        </label>
        <label>
          Pending-dependent value
          <input
            id="pending-dependent"
            name="pendingState"
            value={validation.pending() ? "during-pending" : "before-run"}
          />
        </label>
        <label>
          Upload
          <input id="upload" name="upload" type="file" />
        </label>
        <label>
          Omitted checkbox
          <input id="omitted" name="omitted" type="checkbox" value="yes" />
        </label>
        <button id="submit-save" name="intent" type="submit" value="save">
          Save intent
        </button>
        <button id="submit-draft" name="intent" type="submit" value="draft">
          Draft intent
        </button>
        <output id="validation-status">{validation.status()}</output>
        <output id="captured-in-call">{captureTiming()}</output>
        <output id="validation-result">{displayResult(validation.value())}</output>
        <output id="validation-error">{displayError(validation.error())}</output>
        <output id="schema-calls">{schemaCalls()}</output>
        <button
          id="run-direct"
          type="button"
          on:click={() => {
            const run = validation.run({ required: "direct", intent: "direct" });
            void run.then(undefined, () => undefined);
          }}
        >
          Run direct input
        </button>
        <button id="reset-validation" type="button" on:click={() => validation.reset()}>
          Reset validation
        </button>
      </form>
      <form id="mapped-form" bind={mappedForm} on:submit={startMappedRun}>
        <label>
          Source value
          <input id="mapped-source" name="source" value="mapped" />
        </label>
        <label>
          Extra value
          <input id="mapped-extra" name="extra" value="from-map" />
        </label>
        <button id="mapped-submit" name="intent" type="submit" value="mapped">
          Run mapped form
        </button>
        <output id="mapped-status">{mappedValidation.status()}</output>
        <output id="mapped-result">{displayResult(mappedValidation.value())}</output>
        <output id="mapped-error">{displayError(mappedValidation.error())}</output>
      </form>
      <button
        id="bad-capture"
        type="button"
        on:click={() => {
          const submitter = document.getElementById("non-submitter");

          if (!submitter) throw new Error("The invalid submitter fixture is missing");

          const run = validation.runForm(nativeForm(), { submitter });
          void run.then(undefined, () => undefined);
        }}
      >
        Capture with invalid submitter
      </button>
      <button id="non-submitter" type="button">
        Not a submitter
      </button>
    </main>
  );
}

const application = mount(
  document.getElementById("app")!,
  FormValidation,
  {},
  {
    onError(error) {
      document.documentElement.dataset.fault =
        error instanceof Error ? error.message : String(error);
    },
  },
);

document.getElementById("remove")!.addEventListener("click", () => {
  application.dispose();
  document.documentElement.dataset.disposed = "true";
});
document.getElementById("release-validation")!.addEventListener("click", () => {
  releaseDelayedValidations();
});

await application.settled();

document.documentElement.dataset.ready = "true";
