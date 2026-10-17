import { affects, createGraph, createMutation, createQuery, defineContract } from "aeolia";
import { withAeolia } from "hesperia/aeolia";
const greetings = new Map([["Hesperia", "Hello Hesperia"]]);
const greeting = createQuery({
  name: "greeting",
  key: (name: string) => name,
  fetch: async (name) => greetings.get(name) ?? "Unknown greeting",
});
const rename = createMutation({
  name: "greeting.rename",
  run: async ({ name, text }: { name: string; text: string }) => {
    greetings.set(name, text);

    return text;
  },
  affects: [
    affects(greeting, {
      select: ({ name }: { name: string; text: string }) => name,
      on: "revalidate",
    }),
  ],
});
const contract = defineContract({ namespace: "installed", operations: { greeting, rename } });
const graph = createGraph({ contract });
export const api = withAeolia(graph, contract);
