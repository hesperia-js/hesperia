import * as client from "hesperia/client";
import { client as clientCapability } from "hesperia/client";
import { beforeLeave, navigation, type HesperiaNavigation } from "hesperia/navigation";
// @ts-expect-error beforeLeave is exposed by hesperia/navigation, not hesperia/routing.
import { beforeLeave as legacyBeforeLeave } from "hesperia/routing"; // oxlint-disable-line no-unused-vars
import { Router } from "hesperia/routing";
import { env } from "hesperia/env";
import { SETTINGS } from "hesperia/config/public";
import { defineConfig, type Plugin } from "@hesperia/tooling";
import { checkProjectModules, type ProjectCheckingResult } from "@hesperia/compiler";
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
