import type { Component, Rendered } from "hesperia";

export default function ComponentCssShell(props: Component.Props<{ children: Rendered }>) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>Component CSS readiness</title>
      </head>
      <body>{props.children()}</body>
    </html>
  );
}
