import type { Component, Rendered } from "hesperia";

export default function OptionalStylingShell(props: Component.Props<{ children: Rendered }>) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Optional styling integrations</title>
      </head>
      <body>{props.children()}</body>
    </html>
  );
}
