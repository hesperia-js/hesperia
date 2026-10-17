import type { Component, Rendered } from "hesperia";
import { waitForSlowCommit } from "./api";

Object.assign(globalThis, { routeOutcomeFixture: { waitForSlowCommit, waitingForSlow: false } });

export default function App(props: Component.Props<{ children: Rendered }>) {
  return (
    <html>
      <head>
        <title>Async route outcomes</title>
      </head>
      <body>
        <nav>
          <a href="/">Home</a>
          <a href="/reject">Reject</a>
          <a href="/broken">Broken</a>
          <a href="/slow">Slow</a>
          <a href="/fast">Fast</a>
        </nav>
        {props.children()}
      </body>
    </html>
  );
}
