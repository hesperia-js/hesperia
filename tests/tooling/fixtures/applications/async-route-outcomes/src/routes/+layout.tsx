import type { Component, Rendered } from "hesperia";

export default function Layout(props: Component.Props<{ children: Rendered }>) {
  return <section id="outcome-layout">{props.children()}</section>;
}
