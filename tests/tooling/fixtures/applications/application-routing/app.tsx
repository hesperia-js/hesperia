import type { Component, Rendered } from "hesperia";
import { effect, cleanup } from "hesperia/client";

export default function App(props: Component.Props<{ children: Rendered }>) {
  const marker = <span id="shell-effects" data-runs="0" />;

  effect(() => {
    marker.dataset.runs = String(Number(marker.dataset.runs) + 1);
  });

  cleanup(() => {
    marker.dataset.cleanup = "true";
  });

  return (
    <html>
      <head>
        <title>Routing fixture</title>
      </head>
      <body>
        <input id="shell-draft" />
        {marker}
        {props.children()}
      </body>
    </html>
  );
}
