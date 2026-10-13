import { affects, createGraph, createMutation, createQuery, defineContract } from "aeolia";
import { withAeolia } from "hesperia/aeolia";

const greetings = new Map([["Hesperia", "Hello Hesperia"]]);

const greeting = createQuery({
  name: "greeting",
  key: (name: string) => name,
  fetch: async (name: string) => greetings.get(name) ?? "Unknown greeting",
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

type Todo = { id: string; text: string; completed: boolean };

let todos: Todo[] = [];

const todoList = createQuery({
  name: "todos.list",
  key: () => "todos",
  fetch: async () => todos.map((todo) => ({ ...todo })),
});

const todo = createQuery({
  name: "todos.get",
  key: (id: string) => "todos/" + id,
  fetch: async (id: string) => {
    const match = todos.find((candidate) => candidate.id === id);

    return match === undefined ? undefined : { ...match };
  },
});

const todoCreate = createMutation({
  name: "todos.create",
  run: async (text: string) => {
    const created = { id: String(todos.length + 1), text, completed: false };

    todos = [...todos, created];

    return created;
  },
  affects: [affects(todoList, { on: "invalidate", select: () => undefined })],
});

const todoUpdate = createMutation({
  name: "todos.update",
  run: async (input: Todo) => {
    todos = todos.map((candidate) => (candidate.id === input.id ? { ...input } : candidate));

    return { ...input };
  },
  affects: [
    affects(todoList, { on: "invalidate", select: () => undefined }),
    affects(todo, { on: "revalidate", select: (input: Todo) => input.id }),
  ],
});

const contract = defineContract({
  namespace: "linked",
  operations: {
    greeting,
    rename,
    todos: { list: todoList, get: todo, create: todoCreate, update: todoUpdate },
  },
});

const graph = createGraph({ contract });

export default withAeolia(graph, contract);

export const rawApi = graph.api;
