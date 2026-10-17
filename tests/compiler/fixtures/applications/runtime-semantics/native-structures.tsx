import * as client from "hesperia/client";

export default function App() {
  const show = client.state(true);

  const rows = client.state([{ id: "a", label: "A" }]);

  // prettier-ignore
  return <main>{show() ? <i>on</i> : <b>off</b>}{rows().map((row) => <input key={row.id} value={row.label} />)}</main>;
}
