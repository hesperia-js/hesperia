import * as client from "hesperia/client";

export default function Page() {
  client.effect(() => {
    window.dispatchEvent(new CustomEvent("fixture-effect", { detail: "page" }));
  });

  return <main id="initial-route">Initial route</main>;
}
