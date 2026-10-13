import { defineConfig } from "@hesperia/tooling";
import { postcss } from "@hesperia/postcss";
import { tailwind } from "@hesperia/tailwind";
import { stylex } from "@hesperia/stylex";
import type { Declaration } from "postcss";

const installedPostcssProof = {
  postcssPlugin: "hesperia-installed-postcss-proof",

  Declaration(declaration: Declaration) {
    if (declaration.prop === "color" && declaration.value === "hesperia-postcss-marker")
      declaration.value = "rgb(12, 34, 56)";
  },
};

export default defineConfig({
  plugins: [stylex(), tailwind({ base: "." }), postcss({ plugins: [installedPostcssProof] })],
});
