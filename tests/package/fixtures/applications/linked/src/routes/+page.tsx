import api, { rawApi } from "../../api";
import * as client from "hesperia/client";

export default function Page() {
  const local = client.state(0);

  const adapted = api.greeting("Hesperia");

  const { value: rawValue, pending: rawPending, status: rawStatus } = rawApi.greeting("Hesperia");

  const { value: todos, pending: todosPending, status: todosStatus } = rawApi.todos.list(undefined);

  const rename = api.rename();

  return (
    <main>
      <button id="local-count" on:click={() => local.update((value) => value + 1)}>
        Local: {local()}
      </button>
      <span id="adapted">{adapted.value() ?? "Waiting"}</span>
      <span id="raw">{rawPending.get() ? "Loading" : (rawValue.get() ?? "Waiting")}</span>
      <span id="raw-status">{rawStatus.get()}</span>
      <button
        id="rename"
        on:click={() => void rename.run({ name: "Hesperia", text: "Hello Aeolia" })}
      >
        Rename
      </button>
      <section id="todos">
        {todosPending.get() ? (
          <span id="todo-loading">Loading...</span>
        ) : (
          <>
            {todos.get()?.length === 0 ? (
              <span id="todo-empty">No todos found.</span>
            ) : (
              <ul id="todo-list">
                {todos.get()!.map((todo) => (
                  <li key={todo.id}>
                    <a id="todo-link" href={"/todos/" + todo.id}>
                      {todo.text} - {todo.completed ? "Completed" : "Pending"}
                    </a>
                  </li>
                ))}
              </ul>
            )}
            <span id="todo-status">{todosStatus.get()}</span>
            <form
              id="todo-form"
              on:submit={async (event) => {
                event.preventDefault();

                const input = (event.currentTarget as HTMLFormElement).elements.namedItem(
                  "todoText",
                ) as HTMLInputElement;

                return await rawApi.todos.create(input.value);
              }}
            >
              <input name="todoText" placeholder="New todo" />
              <button type="submit" id="todo-submit">
                Add Todo
              </button>
            </form>
          </>
        )}
      </section>
    </main>
  );
}
