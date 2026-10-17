import type { Component, Rendered } from "hesperia";

// oxfmt-ignore
export default function App(props: Component.Props<{ children: Rendered }>) {
  return <html><head><title>Development browser</title></head><body>{props.children()}</body></html>;
}
