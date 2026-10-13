import { defineConfig } from "@hesperia/tooling";

export default defineConfig({
  public: {
    PUBLIC_SHAPE: {
      explicitUndefined: undefined,
      explicitNull: null,
    },
  },
});
