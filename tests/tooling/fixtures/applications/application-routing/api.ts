import { createQuery, createGraph, defineContract } from "aeolia";
import { reset, withAeolia } from "hesperia/aeolia";

let messageRequests = 0;

const message = createQuery({
  name: "message",
  key: (id: string) => id,
  fetch: async (id, { abortSignal }) => {
    messageRequests += 1;

    const response = await fetch("/api/message/" + id, { signal: abortSignal });

    if (!response.ok) throw new Error(await response.text());

    return (await response.json()) as { message: string };
  },
});

const contract = defineContract({ namespace: "routing", operations: { message } });

const graph = createGraph({ contract });

export const api = withAeolia(graph, contract);

Object.assign(globalThis, {
  resetRoutingApi: () => reset(api),
  getRoutingMessageRequests: () => messageRequests,
});
