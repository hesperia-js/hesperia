import { cleanup, effect } from "hesperia/client";
import { api } from "../../../api";

let slowBodies = 0;

export default async function Slow() {
  const body = ++slowBodies;

  (globalThis as unknown as { slowBodies: number }).slowBodies = slowBodies;

  const marker = (
    <span id="slow-effects" data-runs="0" data-effect-cleanups="0" data-disposals="0" />
  );

  cleanup(() => {
    marker.dataset.disposals = String(Number(marker.dataset.disposals) + 1);
  });

  effect(() => {
    marker.dataset.runs = String(Number(marker.dataset.runs) + 1);

    return () => {
      marker.dataset.effectCleanups = String(Number(marker.dataset.effectCleanups) + 1);
    };
  });

  const message = await api.message("one");

  return (
    <main id="ready" data-body={body}>
      <h1>{message().message}</h1>
      {marker}
      <a href="/">Home</a>
    </main>
  );
}
