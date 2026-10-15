# Hesperia

Hesperia is a frontend framework under development. Its compiler turns TypeScript
and JSX into browser code that creates and updates native DOM objects. Aeolia
supplies signals and dependency tracking.

A component normally runs its body once. Reading a signal in rendered content
connects that content to future updates, so changing a counter updates its existing
button. Recovery from a damaged prop mapping can end that component lifetime and
create a fresh one.

```tsx
import * as client from "hesperia/client";

export default function Counter() {
  const count = client.state(0);

  return <button on:click={() => count.update((value) => value + 1)}>Count: {count()}</button>;
}
```

Hesperia's compiler must process this source. The current implementation targets
browser rendering; server rendering, hydration, and static generation follow
after the browser execution model is verified.

This package is not yet ready for application adoption. To work on it, follow
the [contributor guide](CONTRIBUTING.md)
and [test guide](tests/README.md).

The [native element guide](docs/native-elements.md) explains element handles,
bindings, and browser event types.
The [getting-started guide](docs/getting-started.md) covers application
creation, configuration, the HTML shell, head and titles, routes, and boundary views.
The [component props guide](docs/component-props.md) explains value accessors,
callable props, and optional inputs.
The [page inputs guide](docs/page-props.md) explains generated route parameters
and author-declared query names.
The [compiler guide](packages/compiler/docs/compiler.md) explains native control flow, browser import
checking, and the current syntax limitations.

## Packages

Each package README covers installation and its public entry points.

| Package                                                         | Purpose                                                       |
| --------------------------------------------------------------- | ------------------------------------------------------------- |
| [hesperia](packages/hesperia/README.md)                         | Components, DOM updates, routing, and data lifetimes.         |
| [@hesperia/compiler](packages/compiler/README.md)               | TypeScript and JSX compilation, checking, and source maps.    |
| [@hesperia/tooling](packages/tooling/README.md)                 | Application checks, browser builds, and development servers.  |
| [@hesperia/hosting](packages/hosting/README.md)                 | Serve captured builds through Fetch request handlers.         |
| [@hesperia/language-server](packages/language-server/README.md) | Diagnostics and source navigation for editors.                |
| [create-hesperia](packages/create-hesperia/README.md)           | Generate an application with an optional Elysia host.         |
| [@hesperia/elysia](packages/elysia/README.md)                   | Connect Elysia HTTP routes and Eden clients to Hesperia data. |
| [@hesperia/postcss](packages/postcss/README.md)                 | Run an application's PostCSS plugins.                         |
| [@hesperia/tailwind](packages/tailwind/README.md)               | Generate Tailwind CSS utilities.                              |
| [@hesperia/stylex](packages/stylex/README.md)                   | Compile StyleX definitions and collect application CSS.       |
