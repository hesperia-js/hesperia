export default function App() {
  const groups = [
    {
      id: "g",
      items: [
        { id: "i", label: "L1" },
        { id: "j", label: "L2" },
      ],
    },
  ];

  // prettier-ignore
  return <ul>{groups.map((group) => <li key={group.id}>{group.items.map((group) => <span key={group.id}>{group.label}</span>)}</li>)}</ul>;
}
