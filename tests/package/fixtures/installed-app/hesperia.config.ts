import { defineConfig } from "@hesperia/tooling";
export default defineConfig({
  public: { SETTINGS: { palette: "packed plugin data", flags: [true, undefined] } },
  plugins: [
    {
      name: "packed-palette",
      importTypes: {
        palette: async (input) => {
          const value = await input.file.blob.text();
          return {
            declaration: {
              code: "declare const value: string; export default value;",
              origin: input.importSpan,
            },
            browser: {
              code: "export default " + JSON.stringify(value) + ";",
              origin: input.importSpan,
            },
          };
        },
      },
    },
  ],
});
