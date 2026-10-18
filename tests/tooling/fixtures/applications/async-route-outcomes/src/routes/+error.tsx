import type { Component } from "hesperia";

export default function RootError(props: Component.Props<{ error: unknown }>) {
  return <main id="root-error">{String(props.error())}</main>;
}
