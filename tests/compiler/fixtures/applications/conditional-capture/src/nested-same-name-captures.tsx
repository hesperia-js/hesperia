export default function App() {
  const groups = [{ id: "g", items: [{ id: "i", label: "inner", show: true }] }];

  return (
    <ul>
      {groups.map((row) => (
        <li key={row.id} data-group={row.id}>
          {row.items.map((row) => (
            <span key={row.id} data-item={row.id}>
              {row.show ? <b>{row.label}</b> : null}
            </span>
          ))}
        </li>
      ))}
    </ul>
  );
}
