import type { Component, Rendered } from "hesperia";
import { api } from "./api";

Object.assign(globalThis, {
  pageTaskFixture: { started: 0, releases: 0, aborts: 0, release: undefined },
});

export default function App(props: Component.Props<{ children: Rendered }>) {
  const shared = api.shared();

  return (
    <html>
      <head>
        <title>Page task</title>
      </head>
      <body>
        <output id="shell-shared">{shared()}</output>
        {props.children()}
      </body>
    </html>
  );
}
