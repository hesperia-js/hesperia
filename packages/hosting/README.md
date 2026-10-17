# @hesperia/hosting

Host a captured Hesperia browser build through a Fetch request handler. This
package verifies the build's asset inventory and digests, then serves its document
wrapper and managed assets at the selected mount path.

## Install

Install the prerelease in your server application:

```sh
bun add @hesperia/hosting@alpha
```

Build the Hesperia application with `hesperia build` before loading its production
output. An application created by
[create-hesperia](https://github.com/hesperia-js/hesperia/blob/main/packages/create-hesperia/README.md)
provides this as `bun run build`.

## Serve a production build

Load `.hesperia/build` from the application root and connect its handler to Bun:

```ts
import { resolve } from "node:path";
import { createHost, readBuild } from "@hesperia/hosting";

const captured = await readBuild(resolve(".hesperia/build"));
const host = await createHost(captured, { mountURL: "/dashboard" });

Bun.serve({
  port: 3000,
  fetch(request) {
    return host.handle(request) ?? new Response("Not found", { status: 404 });
  },
});
```

Open `http://localhost:3000/dashboard` in a browser. Omitting `mountURL` uses the
build's saved mount. `createHost` validates the complete captured input before it
resolves; the resulting `handle(request)` is synchronous and returns `undefined`
for requests the application does not claim, allowing another handler to run.

`readBuild` loads a completed production build without the source tree. It rejects
missing or changed assets and symlinks in captured paths. For in-memory adapters,
pass `createHost` a `CapturedBrowserBuild` containing the hosting record and the
exact map of asset Blobs.

This host serves a browser startup wrapper; it does not render components on the
server or produce a static-file deployment. See
[mounts and generated assets](https://github.com/hesperia-js/hesperia/blob/main/packages/tooling/docs/project-configuration.md#application-mount-and-generated-assets)
for the capture format and URL rules. The
[Elysia integration](https://github.com/hesperia-js/hesperia/blob/main/packages/elysia/docs/elysia.md)
adds application routes and typed clients around the same hosting API.

## License

See the [license notice](https://github.com/hesperia-js/hesperia/blob/main/LICENSE),
[MPL-2.0 text](https://github.com/hesperia-js/hesperia/blob/main/COPYING), and
[commercial terms](https://github.com/hesperia-js/hesperia/blob/main/LICENSE-COMMERCIAL.md).
