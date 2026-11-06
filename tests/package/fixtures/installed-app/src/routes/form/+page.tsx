import type { StandardSchemaV1 } from "@standard-schema/spec";
import * as client from "hesperia/client";

interface NameInput {
  readonly name: string;
}

interface NameOutput {
  readonly greeting: string;
}

function isNameInput(value: unknown): value is NameInput {
  return (
    typeof value === "object" && value !== null && "name" in value && typeof value.name === "string"
  );
}

const nameSchema: StandardSchemaV1<NameInput, NameOutput> = {
  "~standard": {
    version: 1,
    vendor: "hesperia-installed-app",
    validate(value) {
      if (!isNameInput(value)) return { issues: [{ message: "Enter a name" }] };

      return { value: { greeting: `Hello, ${value.name.trim().toUpperCase()}` } };
    },
  },
};

function displayResult(result: StandardSchemaV1.Result<NameOutput> | undefined): string {
  if (result === undefined) return "";
  if (result.issues) return result.issues[0]?.message ?? "";

  return result.value.greeting;
}

export default function FormPage() {
  const validation = client.form(nameSchema, {
    map(formData) {
      const name = formData.get("name");

      return { name: typeof name === "string" ? name : "" };
    },
  });

  const form = client.bind<HTMLFormElement>();

  return (
    <main>
      <form
        id="installed-form"
        bind={form}
        on:submit={(event: SubmitEvent) => {
          event.preventDefault();

          const run = validation.runForm(form(), { submitter: event.submitter });

          void run.then(undefined, () => undefined);
        }}
      >
        <label>
          Name
          <input id="form-name" name="name" required />
        </label>
        <button id="validate-form" type="submit" name="intent" value="validate">
          Validate
        </button>
        <button id="reset-form-validation" type="button" on:click={() => validation.reset()}>
          Clear validation
        </button>
        <output id="form-status">{validation.status()}</output>
        <output id="form-result">{displayResult(validation.value())}</output>
      </form>
    </main>
  );
}
