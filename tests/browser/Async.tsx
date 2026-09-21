import { type Component, type Rendered } from "hesperia";
import { AsyncBoundary } from "hesperia";
import * as client from "hesperia/client";

type ChildOutput = { focus(): void };

export const asyncEvents: string[] = [];
export let awaitedChildBodies = 0;
export let refusedChildBodies = 0;

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
