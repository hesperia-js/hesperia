import * as client from "hesperia/client";

export default function App() {
  const rows = client.state([
    { id: "a", label: "A", show: true },
    { id: "b", label: "B", show: true },
  ]);

  const toggle = () =>
    rows.set([
      { id: "a", label: "A", show: false },
      { id: "b", label: "B", show: true },
    ]);

  const reorder = () =>
    rows.set([
      { id: "b", label: "B", show: true },
      { id: "a", label: "A", show: true },
    ]);

  return (
    <>
      <button id="toggle" on:click={toggle}>
        toggle
      </button>
      <button id="reorder" on:click={reorder}>
        reorder
      </button>
      <ul>
        {rows().map((row) => (
          <li key={row.id} data-row={row.id}>
            {row.show ? <span data-label={row.label}>{row.label}</span> : null}
          </li>
        ))}
      </ul>
    </>
  );
}
