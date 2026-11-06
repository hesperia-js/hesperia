# @hesperia/graphql

Declare typed finite GraphQL queries and mutations through Apollo's native
transport links. Aeolia owns their shared result state and declared optimistic
effects. Hesperia binds the resulting handles to each consuming component.

Use `@hesperia/graphql/client` with Apollo Client 4.3.5, GraphQL 17.0.2,
RxJS 7.8.2 and the application's matching Hesperia/Aeolia packages.

## Declare an imported API

```ts
import { gql, HttpLink } from "@apollo/client";
import type { TypedDocumentNode } from "@apollo/client";
import { createGraphQLClient } from "@hesperia/graphql/client";
import { createGraph, defineContract } from "aeolia";
import { withAeolia } from "hesperia/aeolia";

const document = gql`
  query Greeting($name: String!) {
    greeting(name: $name)
  }
` as TypedDocumentNode<{ greeting: string }, { name: string }>;

const graphql = createGraphQLClient({
  link: new HttpLink({ uri: "/graphql" }),
});
const greeting = graphql.query({
  name: "greeting",
  document,
  key: ({ name }) => name,
});
const contract = defineContract({ namespace: "example", operations: { greeting } });
const graph = createGraph({ contract });

export const api = withAeolia(graph, contract);
```

The server must expose the typed operation at that native link's URL. Acquiring
a handle in a compiled Hesperia component starts or joins the corresponding
Aeolia query:

```tsx
import { api } from "../api.ts";

export default function Greeting() {
  const greeting = api.greeting({ name: "Ada" });

  return <p>{greeting.value()?.data?.greeting ?? "Loading…"}</p>;
}
```

A query value is the available GraphQL execution envelope. It can contain both
data and field errors, or `data: null`. Mutation execution errors reject by
default and retain available response details on the ordinary Error's `result`.
Native failure details remain available through `cause`.

See [GraphQL operations](docs/graphql.md) for error policies, explicit mutation
effects, context/key ownership, cancellation and cleanup.

## License

See the project's [license notice](https://github.com/hesperia-js/hesperia/blob/main/LICENSE),
[MPL-2.0 text](https://github.com/hesperia-js/hesperia/blob/main/COPYING), and
[commercial license terms](https://github.com/hesperia-js/hesperia/blob/main/LICENSE-COMMERCIAL.md).
