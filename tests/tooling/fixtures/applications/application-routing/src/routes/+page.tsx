import { effect } from "hesperia/client";

export default function Home() {
  const marker = <span id="home-effects" data-runs="0" />;

  effect(() => {
    marker.dataset.runs = String(Number(marker.dataset.runs) + 1);

    return () => {
      marker.dataset.cleanup = "true";
    };
  });

  return (
    <main>
      <h1>Home</h1>
      <input id="draft" />
      <a href="/slow">Slow page</a>
      <a href="/broken">Broken page</a>
      {marker}
    </main>
  );
}
