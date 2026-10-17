import { type Component } from "hesperia";
import * as client from "hesperia/client";

type ChildOutput = { focus: () => void };

function Child(props: Component.Props<{ bind: ChildOutput }>) {
  const input = <input aria-label="Bound field" />;

  client.effect(() => {
    props.bind.set({ focus: () => input.focus() });
  });

  return <label>Child input{input}</label>;
}

export default function Counter() {
  const count = client.state(0);
  const binding = client.bind<ChildOutput>();

  client.effect(() => {
    binding().focus();
  });

  return (
    <main>
      <Child bind={binding} />
      <button on:click={() => count.update((value) => value + 1)}>{count()}</button>
    </main>
  );
}
