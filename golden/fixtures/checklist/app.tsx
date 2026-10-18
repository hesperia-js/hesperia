import type { Component, Rendered } from "hesperia";

export default function ChecklistShell(props: Component.Props<{ children: Rendered }>) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>Checklist</title>
      </head>
      <body>{props.children()}</body>
    </html>
  );
}
