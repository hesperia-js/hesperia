import type { Component } from "hesperia";
import * as client from "hesperia/client";
import { api, emitNumber } from "./api.ts";

function Consumer(props: Component.Props<{ name: string }>) {
  const feed = api.events.numbers("shared");
  const name = props.name();
  return (
    <output id={`stream-${name}`} data-consumer={name}>
      {feed.status()}:{feed.value() ?? "empty"}
    </output>
  );
}

export default function StreamProbe() {
  const firstVisible = client.state(true);
  const secondVisible = client.state(true);

  return (
    <main>
      <button id="remove-first" type="button" on:click={() => firstVisible.set(false)}>
        Remove first consumer
      </button>
      <button id="remove-second" type="button" on:click={() => secondVisible.set(false)}>
        Remove second consumer
      </button>
      <button id="remount-first" type="button" on:click={() => firstVisible.set(true)}>
        Remount first consumer
      </button>
      <button id="emit-one" type="button" on:click={() => emitNumber(1)}>
        Emit one
      </button>
      <button id="emit-two" type="button" on:click={() => emitNumber(2)}>
        Emit two
      </button>
      <button id="emit-three" type="button" on:click={() => emitNumber(3)}>
        Emit three
      </button>
      {firstVisible() ? <Consumer name="first" /> : null}
      {secondVisible() ? <Consumer name="second" /> : null}
    </main>
  );
}
