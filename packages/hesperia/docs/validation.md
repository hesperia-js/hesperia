# Schema validation

Hesperia's client form helper connects an application's native controls to a
Standard Schema validator. It stores the latest validation result for the
component that creates it. The application keeps control of submission,
feedback, focus, and saving.

`client.form(schema, options?)` is an authoring operation from
`hesperia/client`. Call it inside a compiled component:

```tsx
import type { StandardSchemaV1 } from "@standard-schema/spec";
import * as client from "hesperia/client";

type Fields = Record<string, FormDataEntryValue | FormDataEntryValue[]>;

const emailSchema: StandardSchemaV1<Fields, { email: string }> = {
  "~standard": {
    version: 1,
    vendor: "example",
    validate(input) {
      const email =
        typeof input === "object" && input !== null && !Array.isArray(input)
          ? (input as Fields).email
          : undefined;

      if (typeof email !== "string" || !email.includes("@"))
        return { issues: [{ message: "Enter a valid email", path: ["email"] }] };

      return { value: { email } };
    },
  },
};

function Signup() {
  const validation = client.form(emailSchema);
  const form = client.bind<HTMLFormElement>();

  return (
    <form
      bind={form}
      on:submit={(event) => {
        event.preventDefault();
        const run = validation.runForm(form(), { submitter: event.submitter });

        void run.then(undefined, () => undefined);
      }}
    >
      <label>
        Email
        <input name="email" type="email" required />
      </label>
      <button type="submit" name="intent" value="signup">
        Sign up
      </button>
      <output>{validation.pending() ? "Checking" : ""}</output>
      <output>{validation.value()?.issues?.[0]?.message ?? ""}</output>
      <output>{validation.error() ? "Validation failed" : ""}</output>
    </form>
  );
}
```

Import `StandardSchemaV1` as a type. Hesperia does not load a provider package
for you. Use any schema implementation that conforms to the Standard Schema
V1 protocol. Add `@standard-schema/spec` as a direct development dependency of
your application when importing its types as shown above.

## Validation state and runs

The returned form controller exposes `value()`, `pending()`, `error()`, and
`status()` accessors. Status is `idle`, `pending`, `success`, `failure`, or
`cancelled`. The controller also provides `run(input)`,
`runForm(form, options?)`, and `reset()`.

`run(input)` validates an authored value directly. `runForm(form, options?)`
captures the form's successful controls synchronously and then validates the
captured data. Pass the submit event's `submitter` to include the clicked
submit button's name and value. Later edits to controls do not change the
captured input.

Without a mapper, Hesperia projects each native field name to its submitted
value. A missing name is absent, an empty value remains an empty string, one
value stays a string or `File`, and repeated values become an ordered array.
Unknown field names are included. Names such as `profile.name` and
`metadata[code]` remain literal keys; Hesperia does not infer nested objects.
The mapper receives the original `FormData` when the application needs a
different input shape:

```ts
const validation = client.form(emailSchema, {
  map(formData) {
    return { email: String(formData.get("contact-email") ?? "") };
  },
});
```

A Standard Schema result with `issues` is a completed validation run. It is
published through `value()` and the task status is `success`; issues do not set
`error()`. If mapping, form capture, or schema validation throws or rejects,
the run rejects, `status()` becomes `failure`, and `error()` contains that
failure.

Each new run takes latest-result authority immediately. It clears the previous
result, issues, and error while setting `pending()`. Starting a newer run
cancels the prior run and starts the new one without queueing. Each returned
`TaskRun` is awaitable and exposes an `id`, an `AbortSignal` named `signal`, and
`cancel(reason?)`. Cancelling the current run sets `status()` to `cancelled` and
rejects that run. Superseded runs also reject, while the new run owns the
published status. A settled run is not cancelled retroactively. Reset cancels
the active run and returns the controller to `idle`; disposing the component
owner aborts its active run. A schema provider may continue work that it cannot
abort, but its late result cannot replace the latest state.

## Native submission and reset

Use the browser's native form event and choose when to validate or save.
Required controls and other native constraints can prevent the submit event
before Hesperia receives it. A submit handler can call `runForm` on submit, or
authors can call `run` or `runForm` from other event handlers for input or blur
validation.

Hesperia does not install a submit handler, save data, change controls, focus a
field, or set accessibility attributes. `reset()` revokes the current
validation run and returns validation state to idle. It does not call the
native form reset operation or change control values. Applications decide how
to render issues and failures and whether to clear native controls.
