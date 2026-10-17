import { defineConfig } from "@hesperia/tooling";
export default defineConfig({
  public: { SETTINGS: { flags: [true, undefined, Infinity], nested: { label: "visible" } } },
  plugins: [
    {
      name: "palette",
      importTypes: {
        palette: async (input) => {
          const contents = await input.file.blob.text();
          const label = input.importer.endsWith("app.tsx") ? "app" : "detail";
          return {
            declaration: {
              code: "declare const value: string; export default value;",
              origin: input.importSpan,
            },
            browser: {
              code: "export default " + JSON.stringify(contents + ":" + label) + ";",
              origin: input.importSpan,
            },
          };
        },
      },
    },
  ],
});
