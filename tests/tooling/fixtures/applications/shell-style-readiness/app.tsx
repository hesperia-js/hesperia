import type { Component, Rendered } from "hesperia";
import * as client from "hesperia/client";
import "./shell.css";

function Child() {
  client.effect(() => {
    window.dispatchEvent(new CustomEvent("fixture-effect", { detail: "child" }));
  });

  return <header id="shell">Shell</header>;
}

export default function App(props: Component.Props<{ children: Rendered }>) {
  client.effect(() => {
    window.dispatchEvent(new CustomEvent("fixture-effect", { detail: "shell" }));
  });

  return (
    <html>
      <head>
        <title>Styled shell</title>
      </head>
      <body>
        <Child />
        {props.children()}
      </body>
    </html>
  );
}
