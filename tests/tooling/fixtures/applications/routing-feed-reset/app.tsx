import type { Component, Rendered } from "hesperia";
import * as client from "hesperia/client";
import { streamStats } from "./api";

export default function App(props: Component.Props<{ children: Rendered }>) {
  const stats = client.state("");

  return (
    <html>
      <head>
        <title>Feed reset</title>
      </head>
      <body>
        <button id="stats" on:click={() => stats.set(JSON.stringify(streamStats()))}>
          Stats
        </button>
        <output id="stream-stats">{stats()}</output>
        {props.children()}
      </body>
    </html>
  );
}
