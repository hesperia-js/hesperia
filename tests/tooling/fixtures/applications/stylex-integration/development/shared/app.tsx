import type { Component, Rendered } from "hesperia";

// prettier-ignore
export default function App(props: Component.Props<{ children: Rendered }>) { return <html><head></head><body>{props.children()}</body></html>; }
