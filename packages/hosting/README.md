# @hesperia/hosting

Host a captured Hesperia browser build through a Fetch request handler. This
package verifies the build's inventories and digests, then serves its document
wrapper, managed assets, and captured public files at the selected mount path.
Use `createTargetedHost` for an explicit browser/static production capture. It
validates the selected target and static routing before serving captured bytes.
Its `close()` fences new requests synchronously and waits for admitted response
bodies to complete or be canceled; callers must consume or cancel those bodies.
Repeated close calls return the same completion promise. Unavailable native and
worker profiles reject admission.

## Install

Install the prerelease in your server application:

```sh
bun add @hesperia/hosting@alpha
```

Build the Hesperia application with `hesperia build`. Use `hesperia preview` to
serve its completed target-bound production capture. An application created by
[create-hesperia](https://github.com/hesperia-js/hesperia/blob/main/packages/create-hesperia/README.md)
provides this as `bun run build`.

## Serve a legacy browser capture

For an existing outer-version-1 browser capture, load `.hesperia/build` from the
application root and connect its handler to Bun:

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
pass `createHost` a `CapturedBuild`: either a `CapturedBrowserBuild` with its
managed-asset map, or a `CapturedPublicBuild` with separate managed-asset and
public-file maps.

Builds with public files use the version 2 hosting record and keep public-file
bytes in a separate map from managed assets. `createHost` serves each public file
at its exact mount-relative URL for GET and HEAD requests, with its captured bytes
and media type. Public files under `/assets/...` remain distinct from managed
assets under `/_hesperia/assets/...`. A public-file miss continues through the
existing HTML document fallback or backend fallthrough
policy; methods other than GET and HEAD remain available to the backend handler.
Builds with no public files retain the version 1 record format.

## Serve a target-bound capture

Use `readTargetedBuild` for a completed outer-version-3 production capture. It
validates the selected target control and matching capture directories, then
verifies every present managed, public, and private inventory byte without
evaluating an application entry. It returns the complete validated
control/inventory wrapper for `createTargetedHost`; it does not convert legacy
captures or select a host profile. `readBuild` continues to read
outer-version-1 browser captures, while `readServerBuild` owns outer-version-2
server captures. The targeted reader
rejects both legacy shapes and Workerd captures. Recognized non-Workerd targets
can be read even when their host profile is unavailable; `createTargetedHost`
continues to decide which profiles it can admit.

The current Tooling build does not produce outer-version-3 captures. The reader
and host accept a capture produced elsewhere that meets this format.

```ts
import { resolve } from "node:path";
import { createTargetedHost, readTargetedBuild } from "@hesperia/hosting";

const captured = await readTargetedBuild(resolve(".hesperia/build"));
const resource = await createTargetedHost(captured, { mountURL: "/dashboard" });

try {
  if (resource.kind !== "browser") throw new TypeError("Expected browser/static hosting");

  const response = resource.host.handle(new Request("http://localhost/dashboard"));

  if (response?.body) await response.body.cancel();
} finally {
  await resource.close();
}
```

`createTargetedHost` currently admits browser/static captures and rejects
unavailable profiles. The example calls the host directly; when embedding it in
a listener, the caller owns stopping that listener as well as closing the
resource. Its `close()` call fences new host requests synchronously, then waits
for admitted response bodies to be consumed or canceled. Consume or cancel those
bodies before awaiting the close promise; repeated calls return the same
completion promise.

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
