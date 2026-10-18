import { mount } from "hesperia";
import * as client from "hesperia/client";
import { Card } from "../Card";
import message from "../../message.txt";
import data from "../../data.json" with { type: "json" };
import svgText from "../../logo.svg";
import svgBlob from "../../logo.svg" with { type: "image/svg+xml" };
import pixel from "../../pixel.png" with { type: "image" };
import Markup from "../panel.html" with { type: "html" };
import Icon from "../icon.svg" with { type: "svg" };

export default function Page() {
  const result = client.state("not loaded");

  let cardMount: ReturnType<typeof mount> | undefined;

  client.cleanup(() => cardMount?.dispose());

  function toggleCard() {
    if (cardMount) {
      cardMount.dispose();

      cardMount = undefined;

      return;
    }

    cardMount = mount(document.querySelector("#direct-target")!, Card, {});
  }

  const count: number = data.count;

  const text: string = message;

  const image: Blob = pixel;

  async function load() {
    const [json, binary] = await Promise.all([
      import("../../data.json", { with: { type: "json" } }),
      import("../../pixel.png", { with: { type: "image/png" } }),
    ]);

    const bytes = [...new Uint8Array(await binary.default.arrayBuffer())];

    result.update(() => json.default.count + ":" + binary.default.type + ":" + bytes.join(","));
  }

  return (
    <main>
      <p id="text">{text}</p>
      <p id="json">
        {count}:{String(Object.hasOwn(data, "__proto__"))}
      </p>
      <p id="svg-text">{svgText}</p>
      <p id="svg-blob">
        {svgBlob.type}:{svgBlob.size}
      </p>
      <p id="image">
        {image.type}:{image.size}
      </p>
      <Markup />
      <Icon />
      <button id="load" on:click={() => void load()}>
        Load assets
      </button>
      <p id="dynamic">{result()}</p>
      <button id="toggle-card" on:click={toggleCard}>
        Toggle card
      </button>
      <div id="direct-target"></div>
    </main>
  );
}
