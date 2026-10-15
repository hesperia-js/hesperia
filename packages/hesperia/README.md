# hesperia

Hesperia is a frontend framework whose compiler turns TypeScript and JSX into
code that creates and updates native DOM objects. Aeolia supplies signals and
dependency tracking. A component normally runs its body once; reads in rendered
content connect that content to later updates.

Hesperia is in alpha. APIs may change, and the current implementation targets
browser rendering.

## Install

Add the runtime and its Aeolia peer dependency to your application:

```sh
bun add hesperia@alpha aeolia@1.0.0-alpha.1
bun add --dev @hesperia/tooling@alpha typescript@7.0.2
```

Hesperia's compiler must process authored components. Use the
[application setup guide](https://github.com/hesperia-js/hesperia/blob/main/docs/getting-started.md)
for the document shell, routes, configuration, and application scripts.

## Create a reactive page

In a Hesperia application, put this component in `src/routes/+page.tsx`:

```tsx
import * as client from "hesperia/client";

export default function CounterPage() {
  const count = client.state(0);

  return (
    <button type="button" on:click={() => count.update((value) => value + 1)}>
      Count: {count()}
    </button>
  );
}
```

Start the application's development server with `bun run dev`. Clicking the
button updates its existing text and preserves the native button. State writes
publish synchronously, so dependent DOM updates finish before the write returns.

The `hesperia` entry point exports `mount`, `AsyncBoundary`, and component types
for explicit mounting and composition. Author component state, effects, bindings,
and tasks through `hesperia/client`. The compiler binds those operations to the
component's lifetime.

## Read more

- [Server environment values (`hesperia/env`)](https://github.com/hesperia-js/hesperia/blob/main/packages/hesperia/docs/env.md)
- [Native elements, bindings, and events](https://github.com/hesperia-js/hesperia/blob/main/docs/native-elements.md)
- [Component props](https://github.com/hesperia-js/hesperia/blob/main/docs/component-props.md)
- [Queries, mutations, and tasks](https://github.com/hesperia-js/hesperia/blob/main/docs/data.md)
- [Navigation and page lifetimes](https://github.com/hesperia-js/hesperia/blob/main/docs/routing.md)
- [CSS readiness and ownership](https://github.com/hesperia-js/hesperia/blob/main/docs/css.md)
- [Compiler behavior and current limits](https://github.com/hesperia-js/hesperia/blob/main/packages/compiler/docs/compiler.md)

See the project's [license notice](https://github.com/hesperia-js/hesperia/blob/main/LICENSE),
[MPL-2.0 text](https://github.com/hesperia-js/hesperia/blob/main/COPYING), and
[commercial license terms](https://github.com/hesperia-js/hesperia/blob/main/LICENSE-COMMERCIAL.md).
