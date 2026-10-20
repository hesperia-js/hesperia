import * as client from "hesperia/client";
import { api, clear, emitNumber } from "../../api";

export default function FeedPage() {
  const feed = api.numbers("shared");
  const history = feed.project({ kind: "accumulate", max: 10 });
  const total = feed.project({ kind: "reduce", initial: 100, step: (sum, item) => sum + item });
  const resets = client.state(0);

  return (
    <main id="feed-page">
      <output id="values">{JSON.stringify(history.value())}</output>
      <output id="total">{total.value()}</output>
      <output id="resets">{resets()}</output>
      <button id="emit-two" on:click={() => emitNumber(2)}>
        Emit two
      </button>
      <button id="emit-seven" on:click={() => emitNumber(7)}>
        Emit seven
      </button>
      <button
        id="reset"
        on:click={async () => {
          await clear();

          resets.update((value) => value + 1);
        }}
      >
        Reset
      </button>
      <a id="other" href="/other">
        Other
      </a>
    </main>
  );
}
