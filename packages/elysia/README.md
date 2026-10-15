# @hesperia/elysia

Connect an Elysia HTTP API to component-owned Hesperia queries and mutation tasks.
The project plugin checks your server's App type and supplies route metadata to
the browser adapter. Eden sends the HTTP requests, and Aeolia owns their shared
query state.

This package is part of Hesperia's alpha release channel.

## Install

Add the integration, Elysia, and Eden to a Hesperia application:

```sh
bun add @hesperia/elysia@alpha elysia@1.4.30 @elysia/eden@1.4.10
```

Use matching `hesperia`, `@hesperia/compiler`, and `@hesperia/tooling` alpha
packages, with `aeolia@1.0.0-alpha.1` and `typescript@7.0.2`. The
[Elysia guide](https://github.com/hesperia-js/hesperia/blob/main/packages/elysia/docs/elysia.md)
describes the server host, request shapes, effects, and current transport limits.

## Configure the server and client

Export your Elysia application from `src/server.ts`:

```ts
import { Elysia } from "elysia";

export const app = new Elysia().get("/api/message", () => "Hello from Elysia");

export type App = typeof app;
```

Select that export in `hesperia.config.ts`:

```ts
import { elysia } from "@hesperia/elysia";
import { defineConfig } from "@hesperia/tooling";

export default defineConfig({
  plugins: [elysia({ serverModule: "./src/server.ts", appExport: "app" })],
});
```

Create `src/client.ts` with the browser-safe client entry point. Keep the App
import type-only:

```ts
import { treaty } from "@elysia/eden";
import { withAeolia } from "@hesperia/elysia/client";
import type { App } from "./server.ts";

export const api = withAeolia(treaty<App>(globalThis.location.origin));
```

Acquire a query inside a component that owns its lifetime:

```tsx
import { api } from "../client.ts";

export default function MessagePage() {
  const message = api.api.message.get();

  return <p>{message.value() ?? "Loading…"}</p>;
}
```

The example page belongs in `src/routes/+page.tsx`. Serve `/api/message` from
the Elysia App at the client URL; the type parameter cannot verify the deployed
server. Use the Elysia starter or the guide's hosting setup to serve both the
Hesperia application and API routes.

The server module is analyzed for types and is not executed in the browser.
Import `withAeolia` from `@hesperia/elysia/client`, configure the project plugin
from `@hesperia/elysia`, and declare query effects with
`defineEdenEffect` from `@hesperia/elysia/effects`.

See the project's [license notice](https://github.com/hesperia-js/hesperia/blob/main/LICENSE),
[MPL-2.0 text](https://github.com/hesperia-js/hesperia/blob/main/COPYING), and
[commercial license terms](https://github.com/hesperia-js/hesperia/blob/main/LICENSE-COMMERCIAL.md).
