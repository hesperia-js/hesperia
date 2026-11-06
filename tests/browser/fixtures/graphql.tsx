import type { Component } from "hesperia";
import * as client from "hesperia/client";
import { component, defineComponent } from "hesperia/runtime";
import { api } from "./graphql-api.ts";

type NativeSubscriptionMode = "events" | "reset" | "dispose";
type NativeSubscriptionPolicy = "none" | "all" | "ignore";
type NativeSubscriptionName = "first" | "second" | "all" | "ignore" | "lifecycle";
type NativeSubscriptionProps = {
  readonly name: NativeSubscriptionName;
  readonly id: string;
  readonly policy: NativeSubscriptionPolicy;
};

const subscriptionParameters = new URLSearchParams(globalThis.location.search);
const subscriptionModeParameter = subscriptionParameters.get("subscription-mode");

function readSubscriptionMode(value: string | null): NativeSubscriptionMode | undefined {
  if (value === null) return undefined;

  if (value === "events" || value === "reset" || value === "dispose") return value;

  throw new Error(`Unsupported browser GraphQL subscription mode: ${value}`);
}

const subscriptionMode = readSubscriptionMode(subscriptionModeParameter);
const lifecycleSubscriptionId =
  subscriptionParameters.get("subscription-id") ?? "browser-lifecycle";

function json(value: unknown): string {
  return JSON.stringify(value) ?? "null";
}

function formatSubscriptionError(error: unknown): string {
  if (error === undefined || error === null) return "none";

  return error instanceof Error ? `${error.name}:${error.message}` : String(error);
}

function NativeSubscriptionConsumer(props: Component.Props<NativeSubscriptionProps>) {
  const name = props.name();
  const id = props.id();
  const policy = props.policy();
  const feed =
    policy === "all"
      ? api.browserEventsAll({ id }, {})
      : policy === "ignore"
        ? api.browserEventsIgnore({ id }, {})
        : api.browserEventsNone({ id }, {});

  return (
    <section data-testid={`subscription-${name}`}>
      <output data-testid={`subscription-result-${name}`}>{json(feed.value() ?? null)}</output>
      <output data-testid={`subscription-status-${name}`}>{feed.status()}</output>
      <output data-testid={`subscription-error-${name}`}>
        {formatSubscriptionError(feed.error())}
      </output>
    </section>
  );
}

function createNativeSubscriptionConsumer(
  name: NativeSubscriptionName,
  id: string,
  policy: NativeSubscriptionPolicy,
) {
  return defineComponent((owner) =>
    component(owner, NativeSubscriptionConsumer, { name, id, policy }),
  );
}

const FirstSharedEventsConsumer = createNativeSubscriptionConsumer(
  "first",
  "browser-shared",
  "none",
);
const SecondSharedEventsConsumer = createNativeSubscriptionConsumer(
  "second",
  "browser-shared",
  "none",
);
const AllEventsConsumer = createNativeSubscriptionConsumer("all", "browser-all", "all");
const IgnoreEventsConsumer = createNativeSubscriptionConsumer("ignore", "browser-ignore", "ignore");
const LifecycleEventsConsumer = createNativeSubscriptionConsumer(
  "lifecycle",
  lifecycleSubscriptionId,
  "none",
);

function SubscriptionEventsJourney() {
  const showFirst = client.state(true);

  return (
    <main>
      <nav aria-label="Shared subscription consumers">
        <button data-testid="remove-subscription-owner" on:click={() => showFirst.set(false)}>
          Remove subscription owner
        </button>
        <button data-testid="restore-subscription-owner" on:click={() => showFirst.set(true)}>
          Restore subscription owner
        </button>
      </nav>
      {showFirst() ? <FirstSharedEventsConsumer /> : null}
      <SecondSharedEventsConsumer />
      <AllEventsConsumer />
      <IgnoreEventsConsumer />
    </main>
  );
}

function SubscriptionLifecycleJourney() {
  return (
    <main>
      <LifecycleEventsConsumer />
    </main>
  );
}

export default function GraphQLNative() {
  if (subscriptionMode === "events") return <SubscriptionEventsJourney />;
  if (subscriptionMode === "reset" || subscriptionMode === "dispose")
    return <SubscriptionLifecycleJourney />;
  throw new Error("The GraphQL fixture requires a subscription mode");
}
