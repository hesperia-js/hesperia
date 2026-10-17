import type { Component } from "hesperia";

export default function BrokenError(props: Component.Props<{ error: unknown }>) {
  // prettier-ignore
  return <main id="render-error">{String(props.error())}</main>;
}
