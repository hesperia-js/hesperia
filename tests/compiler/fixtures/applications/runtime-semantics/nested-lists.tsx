import * as client from "hesperia/client";

export default function App() {
  const groups = client.state([
    {
      id: "g",
      label: "G",
      items: [
        { id: "i", label: "L" },
        { id: "j", label: "J" },
      ],
    },
    { id: "h", label: "H", items: [{ id: "k", label: "K" }] },
  ]);

  const update = () =>
    groups.set([
      {
        id: "g",
        label: "G2",
        items: [
          { id: "i", label: "L2" },
          { id: "j", label: "J2" },
        ],
      },
      { id: "h", label: "H", items: [{ id: "k", label: "K" }] },
    ]);

  const reorder = () =>
    groups.set([
      { id: "h", label: "H", items: [{ id: "k", label: "K" }] },
      {
        id: "g",
        label: "G3",
        items: [
          { id: "j", label: "J3" },
          { id: "i", label: "L3" },
        ],
      },
    ]);

  // prettier-ignore
  return <><button id="update" on:click={update}>update</button><button id="reorder" on:click={reorder}>reorder</button><ul>{groups().map((group) => <li key={group.id} data-group={group.label}>{group.items.map((item) => <span key={item.id} data-item={item.id}>{`${group.label}:${item.label}`}</span>)}</li>)}</ul></>;
}
