import { type Component, type Rendered } from "hesperia";
import { AsyncBoundary } from "hesperia";
import * as client from "hesperia/client";
import {
  api as recoveryApi,
  captureAccessor,
  captureQuery,
} from "./fixtures/async-recovery-api.ts";

type ChildOutput = { focus(): void };

export const asyncEvents: string[] = [];
export let awaitedChildBodies = 0;
export let refusedChildBodies = 0;
export let recoveryParentBodies = 0;
export let recoveryChildBodies = 0;
export let recoveryOutsideBodies = 0;
export let recoveryProbeReady = false;
export const recoveryLifecycle = {
  parentEffects: 0,
  childEffects: 0,
  parentDisposals: 0,
  childDisposals: 0,
  outsideEffects: 0,
  probeHandlerCalls: 0,
  probeHandlerFaults: 0,
  probeHandlerFaultKind: "",
  probeTaskRuns: 0,
  probeTaskFaults: 0,
  probeTaskFaultKind: "",
};

async function AwaitedChild(props: Component.Props<{ bind: ChildOutput }>): Promise<Rendered> {
  awaitedChildBodies++;
  const input = <input id="awaited-input" aria-label="Awaited child" />;

  client.effect(() => {
    asyncEvents.push("child-effect");

    props.bind.set({ focus: () => input.focus() });
  });

  return <label>awaited child{input}</label>;
}

async function RefusedChild(props: Component.Props<{ bind: ChildOutput }>): Promise<Rendered> {
  refusedChildBodies++;
  return <span id="refused-child">{props.bind}</span>;
}

async function AwaitingParent(): Promise<Rendered> {
  const binding = client.bind<ChildOutput>();
  // The compiler lowers this authored child await into the owner-bound render wait.
  // oxlint-disable-next-line unicorn/no-unnecessary-await
  const child = await (<AwaitedChild bind={binding} />);

  client.effect(() => {
    asyncEvents.push("parent-effect");

    binding().focus();
  });

  return <section id="awaiting-parent">{child}</section>;
}

function IndependentParent() {
  const binding = client.bind<ChildOutput>();
  return <RefusedChild bind={binding} />;
}

export function createAsyncBoundary() {
  return (
    <AsyncBoundary fallback={<div id="async-loading">loading</div>}>
      <AwaitingParent />
    </AsyncBoundary>
  );
}

export function createIndependentParent() {
  return <IndependentParent />;
}

async function RecoveryParent(): Promise<Rendered> {
  recoveryParentBodies++;
  const local = client.state(0);

  client.cleanup(() => {
    recoveryLifecycle.parentDisposals++;
  });

  client.effect(() => {
    recoveryLifecycle.parentEffects++;
  });

  const view = recoveryApi.recovery("parent");

  captureQuery("parent", view);

  // This awaited value must be consumed even though it is not an API handle read.
  // oxlint-disable-next-line unicorn/no-unnecessary-await
  const value = await view;

  captureAccessor("parent", value);

  return (
    <section id="recovery-parent">
      <button id="recovery-parent-local" on:click={() => local.update((current) => current + 1)}>
        parent:{local()}
      </button>
      <output id="recovery-parent-value">{value() ?? "undefined"}</output>
      <AsyncBoundary fallback={<div id="recovery-child-loading">loading child</div>}>
        <RecoveryChild />
      </AsyncBoundary>
    </section>
  );
}

async function RecoveryChild(): Promise<Rendered> {
  recoveryChildBodies++;
  const local = client.state(0);

  client.cleanup(() => {
    recoveryLifecycle.childDisposals++;
  });

  client.effect(() => {
    recoveryLifecycle.childEffects++;
  });

  const view = recoveryApi.recovery("child");

  captureQuery("child", view);

  // oxlint-disable-next-line unicorn/no-unnecessary-await
  const value = await view;

  captureAccessor("child", value);

  return (
    <section id="recovery-child">
      <output id="recovery-child-value">{value() ?? "undefined"}</output>
      <button id="recovery-child-local" on:click={() => local.update((current) => current + 1)}>
        child:{local()}
      </button>
    </section>
  );
}

function RecoveryOutside() {
  recoveryOutsideBodies++;
  const local = client.state(0);
  const handlerResult = client.state("idle");
  const taskResult = client.state("idle");
  const probeView = recoveryApi.recovery("probe");

  captureQuery("probe", probeView);

  let probeAccessor: (() => string | undefined) | undefined;

  void probeView.then(
    (value) => {
      probeAccessor = value;

      captureAccessor("probe", value);

      recoveryProbeReady = true;
    },
    () => undefined,
  );

  const task = client.task<void, string | undefined>(() => () => {
    recoveryLifecycle.probeTaskRuns++;

    if (!probeAccessor) throw new Error("The probe query has not committed");

    return probeAccessor();
  });

  client.effect(() => {
    recoveryLifecycle.outsideEffects++;
  });

  return (
    <div id="recovery-outside">
      <button on:click={() => local.update((current) => current + 1)}>outside:{local()}</button>
      <button
        id="recovery-probe-handler"
        on:click={() => {
          recoveryLifecycle.probeHandlerCalls++;

          try {
            if (!probeAccessor) throw new Error("The probe query has not committed");

            probeAccessor();

            handlerResult.set("read");
          } catch (error) {
            recoveryLifecycle.probeHandlerFaults++;
            recoveryLifecycle.probeHandlerFaultKind =
              error !== null && typeof error === "object" && "kind" in error
                ? String(error.kind)
                : "unknown";

            handlerResult.set("fault");
          }
        }}
      >
        read probe in handler
      </button>
      <output id="recovery-probe-handler-result">{handlerResult()}</output>
      <button
        id="recovery-probe-task"
        on:click={() => {
          void task.run().then(
            () => taskResult.set("read"),
            (error: unknown) => {
              recoveryLifecycle.probeTaskFaults++;
              recoveryLifecycle.probeTaskFaultKind =
                error !== null && typeof error === "object" && "kind" in error
                  ? String(error.kind)
                  : "unknown";

              taskResult.set("fault");
            },
          );
        }}
      >
        read probe in task
      </button>
      <output id="recovery-probe-task-result">{taskResult()}</output>
    </div>
  );
}

export function createRecoveryOutside() {
  return <RecoveryOutside />;
}

export function createCachedRecoveryPage() {
  return (
    <AsyncBoundary fallback={<div id="recovery-parent-loading">loading parent</div>}>
      <RecoveryParent />
    </AsyncBoundary>
  );
}

export function createRecoveryAwayPage() {
  return <div id="async-cache-away">away</div>;
}
