import type { Component, Rendered } from "hesperia";

export default function Layout(props: Component.Props<{ children: Rendered }>) {
  return <section id="root-layout">{props.children()}</section>;
}
