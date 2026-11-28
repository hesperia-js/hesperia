import * as client from "hesperia/client";
import {
  client as clientCapability,
  type Form,
  type FormOptions,
  type FormRunOptions,
} from "hesperia/client";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { debounce, throttle } from "hesperia/scheduling";
import { beforeLeave, navigation, type HesperiaNavigation } from "hesperia/navigation";
// @ts-expect-error beforeLeave is exposed by hesperia/navigation, not hesperia/routing.
import { beforeLeave as legacyBeforeLeave } from "hesperia/routing"; // oxlint-disable-line no-unused-vars
import { Router, route, type Route } from "hesperia/routing";
import { env } from "hesperia/env";
import { SETTINGS } from "hesperia/config/public";
import { defineConfig, type Plugin } from "@hesperia/tooling";
import { checkProjectModules, type ProjectCheckingResult } from "@hesperia/compiler";

interface ValidationInput {
  readonly source: string;
}

interface ValidationOutput {
  readonly normalized: string;
}

function isValidationInput(value: unknown): value is ValidationInput {
  return (
    typeof value === "object" &&
    value !== null &&
    "source" in value &&
    typeof value.source === "string"
  );
}

const schema: StandardSchemaV1<ValidationInput, ValidationOutput> = {
  "~standard": {
    version: 1,
    vendor: "hesperia-installed-consumer",
    validate(value) {
      if (!isValidationInput(value)) return { issues: [{ message: "Expected source" }] };

      return { value: { normalized: value.source.trim() } };
    },
  },
};

const formOptions: FormOptions<ValidationInput> = {
  map(formData) {
    const source = formData.get("source");

    if (typeof source !== "string") throw new TypeError("Expected a source field");

    return { source };
  },
};

const validation: Form<ValidationInput, ValidationOutput> = client.form(schema, formOptions);
const directRun = validation.run({ source: " Ada " });
const directRunId: number = directRun.id;
const directRunSignal: AbortSignal = directRun.signal;

directRun.cancel();
const directResult: StandardSchemaV1.Result<ValidationOutput> = await directRun;
const runOptions: FormRunOptions = { submitter: document.createElement("button") };
const formRun = validation.runForm(document.createElement("form"), runOptions);
const formResult: StandardSchemaV1.Result<ValidationOutput> = await formRun;

// @ts-expect-error a form run requires the schema input
validation.run();

const wrongFormOptions = { map: () => ({ source: 42 }) };

// @ts-expect-error the map must return the schema input shape
const rejectedFormOptions: FormOptions<ValidationInput> = wrongFormOptions;

void rejectedFormOptions;

const ordinaryTask = client.task(() => (input: string) => input);

// @ts-expect-error reset is part of form validation, not ordinary tasks
ordinaryTask.reset();

void [directRunId, directRunSignal, directResult, formResult, validation.value()];

const scheduledOptional = debounce((value = "default") => value.length, 10);
const scheduledNumber: Promise<number> = scheduledOptional();
const scheduledRest = throttle(
  async (first: string, ...rest: number[]) => first.length + rest.length,
  2,
  100,
);
const scheduledAsyncNumber: Promise<number> = scheduledRest("value", 1, 2);
const scheduledSame: typeof scheduledRest = scheduledRest.unref().ref();
const scheduledPending: Promise<number> | null = scheduledRest.pending;

// @ts-expect-error the callback's required first argument stays required
scheduledRest();

// @ts-expect-error callback argument types remain checked
scheduledRest(42);

// @ts-expect-error throttle has no flush control
scheduledRest.flush();

// @ts-expect-error the awaited callback result remains numeric
const scheduledWrong: Promise<string> = scheduledOptional();

void [scheduledNumber, scheduledAsyncNumber, scheduledSame, scheduledPending, scheduledWrong];

const plugin: Plugin<{ value: string }> = { name: "typed" };
const configured = defineConfig({ plugins: [plugin] });
const palette: "packed plugin data" = SETTINGS.palette;
const flag: true = SETTINGS.flags[0];

void [configured, palette, flag];
const count = client.state(0);
const inputlessTask = client.task(() => async () => 42);
const inputlessResult: number = await inputlessTask.run();

await inputlessTask.run(undefined);

// @ts-expect-error an inputless task does not accept a payload
inputlessTask.run("unexpected");

const capabilityTask = clientCapability.task(() => () => "ready");
const capabilityResult: string = await capabilityTask.run();
const optionalTask = client.task(() => (input?: string) => input ?? "default");
const optionalResult: string = await optionalTask.run();

optionalTask.run("provided");

optionalTask.run(undefined);

// @ts-expect-error optional input still checks supplied values
optionalTask.run(42);

const defaultedTask = clientCapability.task(
  () =>
    async (input = "default") =>
      input,
);
const defaultedResult: string = await defaultedTask.run();

defaultedTask.run("provided");

// @ts-expect-error a default value does not erase the input type
defaultedTask.run(42);

// @ts-expect-error optional parameters do not erase the output type
const wrongOptionalResult: number = await optionalTask.run();

void wrongOptionalResult;
const requiredUndefinedTask = client.task(() => (input: string | undefined) => input ?? "default");

requiredUndefinedTask.run(undefined);

requiredUndefinedTask.run("provided");

// @ts-expect-error a required parameter accepting undefined is not an optional parameter
requiredUndefinedTask.run();

const conditionalTask = client.task((): (() => number) | ((input: string) => number) =>
  count() > 0 ? () => 0 : (input: string) => input.length,
);
const conditionalResult: number = await conditionalTask.run("provided");

// @ts-expect-error every possible operation must allow an omitted input
conditionalTask.run();

// @ts-expect-error a required operation cannot receive the optional operation's undefined input
conditionalTask.run(undefined);

const explicitTask = client.task<string, number>(() => (input) => input.length);
const explicitResult: number = await explicitTask.run("provided");

// @ts-expect-error an explicit required input still needs an argument
explicitTask.run();

const callableInputTask = client.task<(name: string) => string>(() => (input) => input("Ada"));

callableInputTask.run((name) => name.toUpperCase());

// @ts-expect-error a callable input is a required payload, not the task's operation type
callableInputTask.run();

// @ts-expect-error a task receives one payload, not multiple required arguments
client.task(() => (first: string, second: number) => first + second);

const inputTask = client.task(() => async (input: { name: string }) => input.name);
const inputResult: string = await inputTask.run({ name: "Ada" });

// @ts-expect-error the callback's required input stays required
inputTask.run();

// @ts-expect-error the callback's input type stays checked
inputTask.run({ name: 42 });

const unionTask = client.task(() => (input: string | number) => String(input));

unionTask.run("one");

unionTask.run(1);

// @ts-expect-error a union of required inputs does not make the input optional
unionTask.run();

const unknownTask = client.task(() => (input: unknown) => String(input));

unknownTask.run(undefined);

// @ts-expect-error explicitly accepting unknown still declares an input
unknownTask.run();

void [
  inputlessResult,
  capabilityResult,
  optionalResult,
  defaultedResult,
  conditionalResult,
  explicitResult,
  inputResult,
];
const typedNavigation: HesperiaNavigation = navigation;

beforeLeave(() => true);

void typedNavigation;
void Router;
// @ts-expect-error beforeLeave is not a Client capability.
clientCapability.navigation; // oxlint-disable-line no-unused-expressions
const result: Promise<ProjectCheckingResult> = checkProjectModules([]);

void result;
const required: string = env("TOKEN", "fallback");
const optional: string | undefined = env("TOKEN", undefined, true);
const numeric: number = env.num("PORT", 3000);
const optionalNumeric: number | undefined = env.num("PORT", undefined, true);
const boolean: boolean = env.bool("FEATURE_ENABLED");

void [required, optional, numeric, optionalNumeric, boolean];
// @ts-expect-error optional environment values can be undefined
const wrongOptional: string = env("TOKEN", undefined, true);

void wrongOptional;
// @ts-expect-error numeric state is not a string
const wrong: string = count();

void wrong;

function checkLiteralRouteTagTypes(): void {
  const declaration = route({ tags: ["products", "catalog"], load: () => "product" as const });
  const tags: readonly ["products", "catalog"] = declaration.tags;
  const values = ["mutable"];
  const fromArray = route({ tags: values });
  const optional = route({});
  const optionalGuard: Route.Guard | undefined = optional.guard;
  const optionalHeaders: Readonly<Record<string, string>> | undefined = optional.headers;
  const optionalLoad: unknown = optional.load;
  const optionalTags: readonly string[] | undefined = optional.tags;
  const pattern = route<"products/[id]">({ guard: ({ params }) => params.id.length > 0 });
  const typedGuard: Route.Guard<"products/[id]"> | undefined = pattern.guard;

  // @ts-expect-error misspelled untagged declaration fields remain errors
  route({ load: () => "", gaurd: () => false });
  // @ts-expect-error misspelled tagged declaration fields remain errors
  route({ tags: ["products"], gaurd: () => false });
  // @ts-expect-error route tag declarations are readonly
  declaration.tags = [];
  // @ts-expect-error route tag elements cannot be replaced
  declaration.tags[0] = "other";
  // @ts-expect-error route tag arrays cannot be extended
  declaration.tags.push("other");
  // @ts-expect-error a mutable input array is readonly through the declaration
  fromArray.tags.push("other");
  void [tags, optionalGuard, optionalHeaders, optionalLoad, optionalTags, typedGuard];
}

void checkLiteralRouteTagTypes;
