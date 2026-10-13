import type { Component, Rendered } from "hesperia";

export default function App(props: Component.Props<{ children: Rendered }>) {
  return (
    <html>
      <head>
        <title>Imported markup</title>
      </head>
      <body>{props.children()}</body>
    </html>
  );
}
