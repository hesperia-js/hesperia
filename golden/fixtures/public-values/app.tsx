import type { Component, Rendered } from "hesperia";

export default function PublicValuesShell(props: Component.Props<{ children: Rendered }>) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>Public configuration values</title>
      </head>
      <body>{props.children()}</body>
    </html>
  );
}
