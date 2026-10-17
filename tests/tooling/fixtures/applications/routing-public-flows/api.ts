import { affects, createGraph, createMutation, createQuery, defineContract } from "aeolia";
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

const update = createMutation({
  name: "message.update",

  run: async (input: { id: string }, { abortSignal }) => {
    const response = await fetch("/api/update", {
      method: "POST",
      body: JSON.stringify(input),
      signal: abortSignal,
    });

    if (!response.ok) throw new Error(await response.text());

    return (await response.json()) as { ok: true };
  },

  affects: [affects(message, { select: (input: { id: string }) => input.id, on: "revalidate" })],
});

const contract = defineContract({ namespace: "public-routing", operations: { message, update } });

const graph = createGraph({ contract });

export const api = withAeolia(graph, contract);
