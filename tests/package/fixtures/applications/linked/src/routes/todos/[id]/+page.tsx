import type { PageProps } from "hesperia/runtime";
import { rawApi } from "../../../../api";

export default function Todo(props: PageProps<{}, { id: string }>) {
  const { value: todo, pending, status } = rawApi.todos.get(props.params.id);

  return (
    <main>
      <h1 id="detail-heading">Todo {props.params.id}</h1>
      {pending.get() ? (
        <span id="detail-loading">Loading...</span>
      ) : todo.get() ? (
        <>
          <p id="detail-text">Text: {todo.get()!.text}</p>
          <p id="detail-status">{todo.get()!.completed ? "Completed" : "Pending"}</p>
          <span id="detail-query-status">{status.get()}</span>
          <button
            id="detail-toggle"
            on:click={async () => {
              const current = todo.get();

              if (current)
                return await rawApi.todos.update({ ...current, completed: !current.completed });
            }}
          >
            Toggle Complete
          </button>
        </>
      ) : (
        <span>Todo not found.</span>
      )}
    </main>
  );
}
