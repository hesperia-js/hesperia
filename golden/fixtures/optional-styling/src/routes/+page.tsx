import * as client from "hesperia/client";
import * as stylex from "@stylexjs/stylex";
import "../styles.css";

const styles = stylex.create({
  root: { color: "red" },
  dynamicColor: (color: string) => ({ color }),
});

export default function OptionalStylingPage() {
  const color = client.state("rebeccapurple");

  const attrs = () => stylex.attrs(styles.root, styles.dynamicColor(color()));

  return (
    <main>
      <h1>Optional styling integrations</h1>
      <p id="postcss-proof" class="postcss-proof">
        PostCSS marker
      </p>
      <div id="tailwind-proof" class="bg-fuchsia-950 px-7">
        Tailwind utilities
      </div>
      <button
        id="stylex-proof"
        class={attrs().class ?? ""}
        style={attrs().style ?? ""}
        on:click={() => color.set("steelblue")}
      >
        Change StyleX color
      </button>
    </main>
  );
}
