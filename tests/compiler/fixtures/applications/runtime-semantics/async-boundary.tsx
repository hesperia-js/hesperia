import { AsyncBoundary } from "hesperia/runtime";

async function Child() {
  // prettier-ignore
  return <span>ready</span>;
}

export default async function App() {
  // eslint-disable-next-line unicorn/no-unnecessary-await -- Hesperia awaits the child render.
  const rendered = await (<Child />);

  // prettier-ignore
  return <AsyncBoundary fallback={<div>loading</div>}><div>{rendered}</div></AsyncBoundary>;
}
