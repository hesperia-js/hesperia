import "./src/styles.css";
import { navigation } from "hesperia/navigation";
import type { Component, Rendered } from "hesperia";

export default function App(props: Component.Props<{ children: Rendered }>) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>HESPERIA_PROJECT_NAME</title>
      </head>
      <body>
        <header>
          <a href={navigation.href("/")}>HESPERIA_PROJECT_NAME</a>
        </header>
        {props.children()}
      </body>
    </html>
  );
}
