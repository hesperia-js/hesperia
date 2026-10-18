import { createGraph, createMutation, createQuery, defineContract } from "aeolia";
import { withAeolia } from "hesperia/aeolia";

export const queryResolvers = [];

export const saveCalls = [];

export const activeTasks = [];

export const listResolvers: ((value: string) => void)[] = [];

export const optionLikeResolvers: {
  readonly input: { readonly revalidateAfterMs: string };
  readonly resolve: (value: string) => void;
}[] = [];

export const optionalInputCalls: unknown[] = [];

export const queryViewSets = [];

export let currentLabel = "before";

export const native = {
  value: "before",

  method() {
    return this.value;
  },
};

export class Box {
  constructor(value) {
    this.value = value;
  }
}

export let renderCount = 0;

export const recordRender = () => {
  renderCount++;
};

export const registerTask = (task) => {
  activeTasks.push(task);
};

export const registerQueryViews = (views) => {
  queryViewSets.push(views);
};

const user = createQuery({
  name: "fixture.user",
  key: (id) => id,
  // eslint-disable-next-line no-unused-vars -- Keep the query fetch input to preserve the callback shape.
  // eslint-disable-next-line no-unused-vars -- Keep the query fetch input to preserve the callback shape.
  fetch: (id) => new Promise((resolve) => queryResolvers.push(resolve)),
});

const list = createQuery({
  name: "fixture.list",
  key: () => "fixture.list",
  fetch: () => new Promise<string>((resolve) => listResolvers.push(resolve)),
});

const optionLike = createQuery({
  name: "fixture.option-like",
  key: (input: { readonly revalidateAfterMs: string }) =>
    "fixture.option-like/" + input.revalidateAfterMs,
  fetch: (input: { readonly revalidateAfterMs: string }) =>
    new Promise<string>((resolve) => optionLikeResolvers.push({ input, resolve })),
});

const overlap = createQuery({
  name: "fixture.overlap",
  key: (input: { readonly initial: string }) => "fixture.overlap/" + input.initial,
  fetch: async (input: { readonly initial: string }) => input.initial,
});

const optionalInput = createQuery({
  name: "fixture.optional-input",
  key: (input: { readonly value?: string } | undefined) =>
    "fixture.optional-input/" + (input?.value ?? "undefined"),
  fetch: async (input: { readonly value?: string } | undefined) => {
    optionalInputCalls.push(input);

    return input === undefined ? "input was undefined" : (input.value ?? "input object");
  },
});

const save = createMutation({
  name: "fixture.save",
  run: async (name) => {
    saveCalls.push(name);

    return { saved: name };
  },
  affects: [],
});

export const contract = defineContract({
  namespace: "fixture",
  operations: { user: { get: user }, list, optionLike, overlap, optionalInput, save },
});

export const graph = createGraph({ contract });

export const api = withAeolia(graph, contract);

export default api;
