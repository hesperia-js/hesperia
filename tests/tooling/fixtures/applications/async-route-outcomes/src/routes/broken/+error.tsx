import type { Component } from "hesperia";

export default function BrokenError(_props: Component.Props<{ error: unknown }>) {
  throw new Error("nested error fallback failed");
}
