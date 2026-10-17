import * as client from "hesperia/client";
import * as stylex from "@stylexjs/stylex";
import "../../installed.css";

const styles = stylex.create({
  root: { color: "red" },
  dynamicColor: (color: string) => ({ color }),
});

export default function Page() {
  const count = client.state(0);

  const color = client.state("rebeccapurple");

  const attrs = () => stylex.attrs(styles.root, styles.dynamicColor(color()));

  return (
    <main>
      <p id="postcss-proof">PostCSS marker</p>
      <div id="tailwind-proof" class="bg-fuchsia-950 px-7">
        Tailwind utility
      </div>
      <div id="css-update-proof">CSS revision</div>
      <button
        id="stylex-proof"
        class={attrs().class ?? ""}
        style={attrs().style ?? ""}
        on:click={() => color.set("steelblue")}
      >
        StyleX
      </button>
      <button id="counter" on:click={() => count.update((value) => value + 1)}>
        Count: {count()}
      </button>
    </main>
  );
}
