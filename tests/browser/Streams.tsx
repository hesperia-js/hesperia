import { type Component } from "hesperia";
import * as client from "hesperia/client";
import { api, emitNumber } from "./fixtures/stream-api.fixture.mts";

function Consumer(props: Component.Props<{ name: string }>) {
  const numbers = api.numbers("shared");
  const history = numbers.project({ kind: "accumulate", max: 4 });
  const total = numbers.project({
    kind: "reduce",
    initial: 0,
    step: (sum, item) => sum + item,
  });
  return (
    <div>
      <output data-consumer={props.name()}>
        {numbers.status()}:{numbers.value() ?? "empty"}
      </output>
      <output data-history={props.name()}>{history.value().join(",")}</output>
      <output data-total={props.name()}>{total.value()}</output>
    </div>
  );
}

export default function Streams() {
  const first = client.state(true);
  const second = client.state(true);
  return (
    <main>
      <button on:click={() => emitNumber(1)}>Emit one</button>
      <button on:click={() => emitNumber(2)}>Emit two</button>
      <button on:click={() => first.set(false)}>Remove first</button>
      <button on:click={() => first.set(true)}>Restore first</button>
      <button on:click={() => second.set(false)}>Remove second</button>
      <button on:click={() => second.set(true)}>Restore second</button>
      {first() ? <Consumer name="first" /> : null}
      {second() ? <Consumer name="second" /> : null}
    </main>
  );
}
