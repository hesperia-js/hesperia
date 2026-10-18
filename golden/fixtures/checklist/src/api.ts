import { affects, createGraph, createMutation, createQuery, defineContract } from "aeolia";
import { withAeolia } from "hesperia/aeolia";

export interface ChecklistItem {
  readonly id: string;
  readonly label: string;
  readonly done: boolean;
}

export interface ChecklistItemInput {
  readonly id: string;
  readonly label: string;
  readonly done: boolean;
}

export interface ChecklistUpdateInput extends ChecklistItemInput {}

export interface ChecklistRemoveInput {
  readonly id: string;
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, init);

  if (!response.ok) throw new Error("Checklist request failed: " + response.status);

  return (await response.json()) as T;
}

const itemList = createQuery<void, readonly ChecklistItem[], string>({
  name: "checklist.items.list",
  key: () => "checklist/items",
  fetch: (_input, { abortSignal }) => requestJson("/checklist-api/items", { signal: abortSignal }),
});

const itemDetail = createQuery<string, ChecklistItem | null, string>({
  name: "checklist.items.detail",
  key: (id) => "checklist/items/" + id,
  fetch: (id, { abortSignal }) =>
    requestJson("/checklist-api/items/" + encodeURIComponent(id), { signal: abortSignal }),
});

const createItem = createMutation<ChecklistItemInput, ChecklistItem>({
  name: "checklist.items.create",
  run: (input, { abortSignal }) =>
    requestJson("/checklist-api/items", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      signal: abortSignal,
    }),
  affects: [affects(itemList, { on: "revalidate" })],
});

const updateItem = createMutation<ChecklistUpdateInput, ChecklistItem>({
  name: "checklist.items.update",
  run: (input, { abortSignal }) =>
    requestJson("/checklist-api/items/" + encodeURIComponent(input.id), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      signal: abortSignal,
    }),
  affects: [
    affects(itemList, { on: "revalidate" }),
    affects(itemDetail, { select: ({ id }) => id, on: "revalidate" }),
  ],
});

const updateItemWithParkedListInvalidation = createMutation<ChecklistUpdateInput, ChecklistItem>({
  name: "checklist.items.update-parked-list",
  run: (input, { abortSignal }) =>
    requestJson("/checklist-api/items/" + encodeURIComponent(input.id), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      signal: abortSignal,
    }),
  affects: [
    affects(itemList, { on: "invalidate" }),
    affects(itemDetail, { select: ({ id }) => id, on: "revalidate" }),
  ],
});

const removeItem = createMutation<ChecklistRemoveInput, void>({
  name: "checklist.items.remove",

  async run({ id }, { abortSignal }) {
    const response = await fetch("/checklist-api/items/" + encodeURIComponent(id), {
      method: "DELETE",
      signal: abortSignal,
    });

    if (!response.ok) throw new Error("Checklist removal failed: " + response.status);
  },

  affects: [
    affects(itemList, { on: "revalidate" }),
    affects(itemDetail, { select: ({ id }) => id, on: "revalidate" }),
  ],
});

const contract = defineContract({
  namespace: "hesperia.golden.checklist",
  operations: {
    items: {
      list: itemList,
      detail: itemDetail,
      create: createItem,
      update: updateItem,
      updateWhileParked: updateItemWithParkedListInvalidation,
      remove: removeItem,
    },
  },
});

const graph = createGraph({ contract });

export const api = withAeolia(graph, contract);
