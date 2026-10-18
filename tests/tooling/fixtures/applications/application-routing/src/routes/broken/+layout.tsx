import type { Component, Rendered } from "hesperia";

export default function BrokenLayout(props: Component.Props<{ children: Rendered }>) {
  return <section id="broken-layout">{props.children()}</section>;
}
