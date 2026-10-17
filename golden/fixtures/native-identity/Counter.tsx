import * as client from "hesperia/client";

export default function Counter() {
  const count = client.state(0);

  return (
    <main>
      <label>
        Draft note
        <input id="draft-note" aria-label="Draft note" />
      </label>
      <button id="counter" type="button" on:click={() => count.update((value) => value + 1)}>
        Count: {count()}
      </button>
    </main>
  );
}
