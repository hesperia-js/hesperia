import * as client from "hesperia/client";
import { staticProof } from "../../static.ts";
import "./page.css";
import NativeMedia from "./native-media.html" with { type: "html" };

export default function Page() {
  const dynamicResult = client.state("DYNAMIC_MODULE_WAITING");

  client.effect(() => {
    const global = globalThis as typeof globalThis & {
      __generatedAssetAudit?: {
        staticEvaluations: number;
        dynamicEvaluations: number;
        committedEffects: number;
      };
    };
    const audit = (global.__generatedAssetAudit ??= {
      staticEvaluations: 0,
      dynamicEvaluations: 0,
      committedEffects: 0,
    });

    audit.committedEffects += 1;
  });

  return (
    <main id="asset-proof" class="asset-proof">
      <NativeMedia />
      <p id="static-proof">{staticProof}</p>
      <p id="dynamic-proof">{dynamicResult()}</p>
      <p id="font-proof">{"\uE000"}</p>
      <div id="asset-image" aria-label="Generated SVG background" />
      <a id="literal-url-proof" href="https://literal.invalid/preserved?x=1">
        Literal URL
      </a>
      <a id="next-route-link" href="/next">
        Next route
      </a>
      <button
        id="load-dynamic"
        on:click={async () => {
          const loaded = await import("../../dynamic.ts");
          dynamicResult.set(loaded.dynamicProof);
        }}
      >
        Load dynamic module
      </button>
    </main>
  );
}
