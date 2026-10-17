import { createQuery, createGraph, defineContract } from "aeolia";
import { withAeolia } from "hesperia/aeolia";

const message = createQuery({
  name: "message",
  key: (id: string) => id,
  fetch: async (id, { abortSignal }) => {
    const response = await fetch("/api/message/" + id, { signal: abortSignal });

    if (!response.ok) throw new Error(await response.text());

    return (await response.json()) as { message: string };
  },
});

const contract = defineContract({ namespace: "outcomes", operations: { message } });

const graph = createGraph({ contract });

export const api = withAeolia(graph, contract);

export function waitForSlowCommit() {
  return graph.api.message("slow").ready;
}
