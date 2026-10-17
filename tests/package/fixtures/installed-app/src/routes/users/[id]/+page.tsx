import type { Page } from "hesperia";
import { api } from "../../../../api";

export default async function Page(props: Page.Props) {
  const id: string = props.params.id;
  const greeting = await api.greeting(id);
  return (
    <main>
      <h1>User {id}</h1>
      <p>{greeting().toUpperCase()}</p>
    </main>
  );
}
