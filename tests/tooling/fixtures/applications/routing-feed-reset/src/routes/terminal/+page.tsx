import * as client from "hesperia/client";
import { api, clear, emitNumber, finishStream } from "../../../api";

export default function TerminalPage() {
  const feed = api.numbers("shared");
  const live = feed.project({ kind: "accumulate", max: 10 });
  const overflow = feed.project({ kind: "accumulate", max: 1 });
  const reducer = feed.project({
    kind: "reduce",
    initial: 100,
    step: (sum, item) => {
      if (item === 7) throw new Error("reducer stopped");

      return sum + item;
    },
  });
  const resets = client.state(0);

  return (
    <main id="terminal-page">
      <output id="live-value">{JSON.stringify(live.value())}</output>
      <output id="live-status">{live.status()}</output>
      <output id="overflow-value">{JSON.stringify(overflow.value())}</output>
      <output id="overflow-status">{overflow.status()}</output>
      <output id="overflow-error">{String(overflow.error())}</output>
      <output id="reducer-value">{reducer.value()}</output>
      <output id="reducer-status">{reducer.status()}</output>
      <output id="reducer-error">{String(reducer.error())}</output>
      <output id="resets">{resets()}</output>
      <button id="emit-two" on:click={() => emitNumber(2)}>
        Emit two
      </button>
      <button id="emit-seven" on:click={() => emitNumber(7)}>
        Emit seven
      </button>
      <button id="emit-five" on:click={() => emitNumber(5)}>
        Emit five
      </button>
      <button id="finish" on:click={finishStream}>
        Finish
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
