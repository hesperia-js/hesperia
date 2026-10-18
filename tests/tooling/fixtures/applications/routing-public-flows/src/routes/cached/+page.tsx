import { api } from "../../../api";
import { effect } from "hesperia/client";

export default async function Cached() {
  const fixture = globalThis as unknown as { routingPublicFixture: { cachedBodies: number } };

  fixture.routingPublicFixture.cachedBodies += 1;

  const message = await api.message("shared");

  const marker = <span id="cached-effect" data-runs="0" data-cleanups="0" />;

  effect(() => {
    marker.dataset.value = message().message;

    marker.dataset.runs = String(Number(marker.dataset.runs) + 1);

    return () => {
      marker.dataset.cleanups = String(Number(marker.dataset.cleanups) + 1);
    };
  });

  // prettier-ignore
  return <main id="cached" data-bodies={String(fixture.routingPublicFixture.cachedBodies)}><span id="cached-message">{message().message}</span>{marker}<a id="cached-parking" href="/parking">Parking</a></main>;
}
