export default function App() {
  const rows = [
    { id: "a", label: "Alpha" },
    { id: "b", label: "Beta" },
  ];

  // prettier-ignore
  return <ul>{rows.map((row) => { return <li key={row.id}>{row.label}</li>; })}</ul>;
}
