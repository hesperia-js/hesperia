import { client as capability, mount as preservedMount } from "hesperia";
import {
  state as makeState,
  derived as makeDerived,
  effect as observe,
  cleanup as onCleanup,
  bind as makeBind,
} from "hesperia/client";

export default function App() {
  const value = makeState(1);

  const extra = capability.state(0);

  const doubled = makeDerived(() => value() * 2);

  const button = makeBind<HTMLButtonElement>();

  observe(() => {
    preservedMount; // oxlint-disable-line no-unused-expressions -- keep the mixed import intentionally live

    doubled();
  });

  onCleanup(() => {});

  // prettier-ignore
  return <button bind={button} on:click={() => value.set(value() + 1)}>{doubled() + extra()}</button>;
}
