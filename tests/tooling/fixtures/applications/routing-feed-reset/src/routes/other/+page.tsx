import * as client from "hesperia/client";
import { clear } from "../../../api";

export default function OtherPage() {
  const resets = client.state(0);

  return (
    <main id="other-page">
      <button
        id="reset"
        on:click={async () => {
          await clear();

          resets.update((value) => value + 1);
        }}
      >
        Reset
      </button>
      <output id="resets">{resets()}</output>
    </main>
  );
}
