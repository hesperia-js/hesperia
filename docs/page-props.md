# Page inputs

Reader: a junior TypeScript engineer writing a Hesperia page.

`Page.Props` gives a page plain route parameters and a reactive view of the URL query. Hesperia derives route parameter names from the page's file path; the author declares the query names that the page reads.

For `src/routes/users/[uid]/+page.tsx`:

```tsx
import type { Page } from "hesperia";

export default function UserPage(props: Page.Props<{ queryParams: { tab?: string } }>) {
  const id = props.params.uid;
  return (
    <span>
      {id}:{props.queryParams().get("tab")}
    </span>
  );
}
```

Here `id` is a string. Accessing `props.params.userId` fails Hesperia checking because the route declares `uid`. Route parameters are immutable values for the page's lifetime; changing them creates a new page lifetime. Query changes can update the existing page through `queryParams()`.

## Route parameter shapes

| Directory segment | Matching URL segments | Property in `props.params` |
| ----------------- | --------------------- | -------------------------- |
| `[uid]`           | Exactly one           | `uid: string`              |
| `[[uid]]`         | Zero or one           | `uid?: string`             |
| `[...path]`       | One or more           | `path: readonly string[]`  |
| `[[...path]]`     | Zero or more          | `path?: readonly string[]` |

An absent optional parameter has no property in the parameter object; reading it yields `undefined`. Catch-all arrays retain separate decoded segments. An encoded slash inside one segment stays inside that array item. Both the parameter object and catch-all arrays are immutable.

## Query declarations

Query value declarations must be strings, with optional keys allowed. For example, `{ page?: string; sort?: string }` is accepted; `{ page?: number }` fails checking. The declaration constrains names accepted by `get`, `getAll`, and `has`. It does not validate or convert values received in a URL.

The read methods retain their browser meanings:

- `get("page")` returns the first value as `string | null`.
- `getAll("page")` returns all values as `string[]`.
- `has("page")` returns a boolean.

Thus `?page=2` contains the string `"2"`. An absent key yields `null` from `get`, including when its declaration is required. Authors must check and convert these values themselves. Iteration still includes every query entry, including undeclared names and repeated keys.

The query view is read-only. Change the URL through navigation; calling a mutating query method is a fault. Reading `queryParams()` inside rendered content or an effect registers its reactive dependency. Ordinary additional page props follow the [component prop rules](component-props.md).

## Generated declarations and checking

Hesperia writes route declarations to `hesperia.d.ts` at the application root during initialization, checking, builds, and editor refreshes. The starter includes that file in `tsconfig.json` and excludes it from version control. Existing applications should include it alongside their source files.

Treat this file as generated output. Hesperia updates it when route files change, leaves identical output untouched, and refuses to overwrite a file containing authored declarations. An invalid route tree leaves the last valid declaration on disk while checking reports the route error.

Use `hesperia check` and the Hesperia editor extension for page checking. They combine the generated declarations with each page's file location. Standalone TypeScript checking does not apply that per-file route context; including `hesperia.d.ts` alone does not give raw `tsc` the same page inference.

Generated filesystem startup uses its route table to supply page inputs.
The generated `hesperia.d.ts` file provides the route-specific declarations
used during checking; it is not a runtime route-table input. Use the [routing
guide](routing.md) for navigation behavior.
