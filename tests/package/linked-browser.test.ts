import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, firefox, webkit } from "playwright";

const packageRoot = resolve(import.meta.dir, "../..");
const aeoliaRoot = resolve(packageRoot, "../aeolia");

test("linked packages share state and revalidate live invalidated queries", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "hesperia-linked-browser-"));
  const application = join(workspace, "application");
  let preview: ReturnType<typeof Bun.spawn> | undefined;

  async function run(cwd: string, ...args: string[]): Promise<string> {
    const process_ = Bun.spawn([process.execPath, ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [status, stdout, stderr] = await Promise.all([
      process_.exited,
      new Response(process_.stdout).text(),
      new Response(process_.stderr).text(),
    ]);
    if (status !== 0) throw new Error(`${args.join(" ")} failed (${status})\n${stdout}\n${stderr}`);
    return stdout;
  }

  try {
    await run(packageRoot, resolve(packageRoot, "dist/tooling/cli.js"), "init", application);
    await mkdir(join(application, "node_modules"), { recursive: true });
    await symlink(packageRoot, join(application, "node_modules/hesperia"), "junction");
    await symlink(aeoliaRoot, join(application, "node_modules/aeolia"), "junction");
    await writeFile(
      join(application, "api.ts"),
      `import { affects, createGraph, createMutation, createQuery, defineContract } from "aeolia";
import { withAeolia } from "hesperia/aeolia";
const greetings = new Map([["Hesperia", "Hello Hesperia"]]);
const greeting = createQuery({ name: "greeting", key: (name: string) => name, fetch: async (name: string) => greetings.get(name) ?? "Unknown greeting" });
const rename = createMutation({
  name: "greeting.rename",
  run: async ({ name, text }: { name: string; text: string }) => {
    greetings.set(name, text);
    return text;
  },
  affects: [affects(greeting, { select: ({ name }: { name: string; text: string }) => name, on: "revalidate" })],
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
    todos = todos.map((candidate) => candidate.id === input.id ? { ...input } : candidate);
    return { ...input };
  },
  affects: [
    affects(todoList, { on: "invalidate", select: () => undefined }),
    affects(todo, { on: "revalidate", select: (input: Todo) => input.id }),
  ],
});
const contract = defineContract({ namespace: "linked", operations: { greeting, rename, todos: { list: todoList, get: todo, create: todoCreate, update: todoUpdate } } });
const graph = createGraph({ contract });
export default withAeolia(graph, contract);
export const rawApi = graph.api;
`,
    );
    await writeFile(
      join(application, "src/routes/+page.tsx"),
      `import api, { rawApi } from "../../api";
export default function Page() {
  const adapted = api.greeting("Hesperia");
  const { value: rawValue, pending: rawPending, status: rawStatus } = rawApi.greeting("Hesperia");
  const { value: todos, pending: todosPending, status: todosStatus } = rawApi.todos.list(undefined);
  const rename = api.rename();
  return <main><span id="adapted">{adapted.value() ?? "Waiting"}</span><span id="raw">{rawPending.get() ? "Loading" : rawValue.get() ?? "Waiting"}</span><span id="raw-status">{rawStatus.get()}</span><button id="rename" on:click={() => void rename.run({ name: "Hesperia", text: "Hello Aeolia" })}>Rename</button><section id="todos">{todosPending.get() ? <span id="todo-loading">Loading...</span> : <>{todos.get()?.length === 0 ? <span id="todo-empty">No todos found.</span> : <ul id="todo-list">{todos.get()!.map((todo) => <li key={todo.id}><a id="todo-link" href={"/todos/" + todo.id}>{todo.text} - {todo.completed ? "Completed" : "Pending"}</a></li>)}</ul>}<span id="todo-status">{todosStatus.get()}</span><form id="todo-form" on:submit={async (event) => { event.preventDefault(); const input = (event.currentTarget as HTMLFormElement).elements.namedItem("todoText") as HTMLInputElement; return await rawApi.todos.create(input.value); }}><input name="todoText" placeholder="New todo" /><button type="submit" id="todo-submit">Add Todo</button></form></>}</section></main>;
}
`,
    );
    await mkdir(join(application, "src/routes/todos/[id]"), { recursive: true });
    await writeFile(
      join(application, "src/routes/todos/[id]/+page.tsx"),
      `import type { PageProps } from "hesperia/runtime";
import { rawApi } from "../../../../api";
export default function Todo(props: PageProps<{}, { id: string }>) {
  const { value: todo, pending, status } = rawApi.todos.get(props.params.id);
  return <main><h1 id="detail-heading">Todo {props.params.id}</h1>{pending.get() ? <span id="detail-loading">Loading...</span> : todo.get() ? <><p id="detail-text">Text: {todo.get()!.text}</p><p id="detail-status">{todo.get()!.completed ? "Completed" : "Pending"}</p><span id="detail-query-status">{status.get()}</span><button id="detail-toggle" on:click={async () => { const current = todo.get(); if (current) return await rawApi.todos.update({ ...current, completed: !current.completed }); }}>Toggle Complete</button></> : <span>Todo not found.</span>}</main>;
}
`,
    );
    await run(application, join(application, "node_modules/hesperia/dist/tooling/cli.js"), "build");
    preview = Bun.spawn(
      [
        process.execPath,
        join(application, "node_modules/hesperia/dist/tooling/cli.js"),
        "preview",
        "--port",
        "0",
      ],
      { cwd: application, stdout: "pipe", stderr: "pipe" },
    );
    const reader = (preview.stdout as ReadableStream<Uint8Array>).getReader();
    let output = "";
    let url: string | undefined;
    try {
      while (!url) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error(`Preview exited before listening: ${output}`);
        output += new TextDecoder().decode(chunk.value);
        url = output.match(/http:\/\/127\.0\.0\.1:\d+\//u)?.[0];
      }
    } finally {
      reader.releaseLock();
    }

    for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) {
      const browser = await engine.launch();
      try {
        const page = await browser.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(url);
        await page.waitForFunction(
          () => document.querySelector("#adapted")?.textContent === "Hello Hesperia",
        );
        await page.waitForFunction(
          () => document.querySelector("#raw")?.textContent === "Hello Hesperia",
        );
        await page.waitForFunction(
          () => document.querySelector("#todo-empty")?.textContent === "No todos found.",
        );
        await page.locator("#rename").click();
        await page.waitForFunction(
          () => document.querySelector("#adapted")?.textContent === "Hello Aeolia",
        );
        await page.waitForFunction(
          () => document.querySelector("#raw")?.textContent === "Hello Aeolia",
        );
        await page.locator("#todo-form input").fill("Linked todo");
        await page.locator("#todo-submit").click();
        await page.waitForFunction(
          () => document.querySelector("#todo-list li")?.textContent === "Linked todo - Pending",
        );
        const listMain = await page.locator("main").elementHandle();
        await page.locator("#todo-link").click();
        await page.waitForFunction(
          () => document.querySelector("#detail-status")?.textContent === "Pending",
        );
        await page.locator("#detail-toggle").click();
        await page.waitForFunction(
          () => document.querySelector("#detail-status")?.textContent === "Completed",
        );
        await page.goBack();
        expect(listMain).not.toBeNull();
        expect(
          await page.locator("main").evaluate((node, original) => node === original, listMain),
        ).toBe(true);
        await page.waitForFunction(
          () => document.querySelector("#todo-link")?.textContent === "Linked todo - Completed",
          undefined,
          { timeout: 5_000 },
        );
        await page.goForward();
        await page.waitForFunction(
          () => document.querySelector("#detail-status")?.textContent === "Completed",
        );
        await page.locator("#detail-toggle").click();
        await page.waitForFunction(
          () => document.querySelector("#detail-status")?.textContent === "Pending",
        );
        await page.goBack();
        expect(
          await page.locator("main").evaluate((node, original) => node === original, listMain),
        ).toBe(true);
        await page.waitForFunction(
          () => document.querySelector("#todo-link")?.textContent === "Linked todo - Pending",
          undefined,
          { timeout: 5_000 },
        );
        expect(errors, `${name}: ${await page.content()}`).toStrictEqual([]);
      } finally {
        await browser.close();
      }
    }
  } finally {
    if (preview) {
      preview.kill();
      await preview.exited;
    }
    await rm(workspace, { recursive: true, force: true });
  }
}, 120_000);
