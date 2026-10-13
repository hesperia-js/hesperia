# Project configuration and plugins

Put compiler and build settings in `hesperia.config.ts` or `hesperia.config.json` at the application root. Use one file; having both is an error. JSON supports data-only settings. TypeScript also supports ordered plugin instances. An empty JSON file is invalid; `{}` selects the defaults.

`app.config.ts` has a different job: it configures the running application. Neither file is bundled into the browser merely because it exists.

```ts
// hesperia.config.ts
import { defineConfig } from "@hesperia/tooling";

export default defineConfig({
  allowUnsafeHTML: false,
  allowUnsafeEmbed: false,
  mountURL: "/",
  resolutionOverrides: { browser: {} },
  public: { SITE_NAME: "Example", FLAGS: { search: true } },
  plugins: [],
});
```

The defaults are `allowUnsafeHTML: false`, `allowUnsafeEmbed: false`, `mountURL: "/"`, and an empty `resolutionOverrides.browser` map. Unknown settings fail validation. Browser resolution overrides match exact import names and are checked as browser code after replacement. See [getting started](getting-started.md) for an override example and [environment values](env.md) for environment loading and exposure rules.

## Application mount and generated assets

`mountURL` is the application's path prefix, such as `/dashboard`. It must be a pathname on the serving origin, without a query or fragment. The build saves its canonical value with the browser asset inventory. At the root mount, Hesperia serves its startup wrapper and generated assets under `/_hesperia/`; at `/dashboard`, that namespace is `/dashboard/_hesperia/`. Route navigation uses the same mount prefix. See [routing](routing.md) for the author-facing navigation behavior.

The `@hesperia/hosting` package exposes `createHost` for a Fetch-based server adapter. Pass the captured build's `hosting` record and `files` map, which must contain exactly the recorded `/assets/...` Blobs. A host selection can place the same captured build at another mount without recompiling it:

```ts
import { createHost } from "@hesperia/hosting";

const host = await createHost({ hosting, files }, { mountURL: "/dashboard" });
```

`createHost` checks the record, asset map, and digests before resolving; invalid input rejects without a usable host. After it resolves, `host.handle(request)` is synchronous. It returns a `Response` for claimed document and managed-asset requests, or `undefined` for unclaimed requests. The wrapper imports the captured startup asset and starts the application at the selected mount. The production build record and raw project files are not served as routes; generated source maps remain in the asset inventory.

Filesystem adapters can load a published production build through `readBuild`:

```ts
import { resolve } from "node:path";
import { createHost, readBuild } from "@hesperia/hosting";

const captured = await readBuild(resolve(".hesperia/build"));
const host = await createHost(captured, { mountURL: "/dashboard" });
```

`readBuild` needs only the build directory. It checks the production record, complete asset inventory, and byte digests, and rejects symlinks in the captured paths. An interrupted read retries only when the published record changed, with at most three attempts. An unchanged missing or modified asset rejects immediately. In-memory hosting does not load filesystem APIs.

Production preparation removes abandoned capture directories before compilation. Publication writes the complete validated build into an empty capture directory, replaces the published record, then retires the prior capture. A failed compilation or capture write leaves the prior published build available. There is no generated disk `index.html`; Fetch hosts generate the document wrapper for the selected mount. Static-file deployment is not part of this host format.

Mounts and asset keys use the browser's WHATWG pathname representation. For example, `/@team/:scope+a` stays literal, while spaces, Unicode, and `^` use percent encoding. Mounts cannot contain query or fragment delimiters. Generated asset keys encode filename data such as `#` and `%`: a file named `image%20name.png` has the key `image%2520name.png`. The host looks up these encoded keys exactly, and build files use the same literal keys on disk. It never decodes them a second time. Traversal segments, once-decoded separators, malformed escapes, and control characters remain invalid. The host escapes HTML attributes when placing these URLs in the wrapper.

Custom HTTP methods require support from both the client transport and the serving runtime. Elysia accepts custom method routes and documents [`M-SEARCH` as an example](https://elysiajs.com/essential/route#custom-method). In network checks with Bun 1.4.2 and Elysia 1.4.30, `M-SEARCH` carried a JSON body to the handler. Bun's `Request` constructor changed `BREW` to `GET`, and its listener rejected raw `BREW` requests before the handler ran. These observations describe the pinned runtime versions; the Elysia adapter has no custom-method allowlist.

`allowUnsafeEmbed` permits an Embed instance to request sandbox relaxations beyond `allow-scripts`; the instance must explicitly list each requested permission. A nested imported component cannot change its host root's policy. Direct mounts without compiled project policy stay strict. The build carries this one boolean in private component metadata; the full project configuration and process environment are not exposed to the browser.

## Public values

Application modules import only explicitly named values:

```ts
import { SITE_NAME, FLAGS } from "hesperia/config/public";

console.log(SITE_NAME, FLAGS.search);
```

`check` and `build` generate the declarations in `hesperia.d.ts`. Values are fixed for one build; changing them requires another check/build and a browser reload. Public data can contain strings, numbers (including `NaN` and infinity), booleans, `null`, `undefined`, arrays, and nested plain objects. Functions, class instances, symbols, bigints, accessors, hidden properties, named array properties, and cycles are rejected. Export names must be valid, nonreserved JavaScript identifiers. The generated browser module contains these values only; it does not copy the process environment or the whole configuration object.

## Project checks and fixes

`hesperia check` runs the Hesperia compiler, Oxlint, and Oxfmt. The lint set contains `app.tsx`, `app.config.ts`, `hesperia.config.ts`, JavaScript and TypeScript files under `src`, and relative JavaScript or TypeScript imports from those inputs. Relative API modules outside `src` are included when the project imports them. The format set also contains CSS under `src` and imported CSS, plus supported root configuration and package files. Oxlint and Oxfmt load the project's own rules and ignore files from the application root.

The command excludes `node_modules`, `.hesperia`, and the generated root `hesperia.d.ts` marked by Hesperia. A default check does not rewrite authored files. It may refresh the generated declaration as part of the compiler check.

`hesperia check --fix` asks Oxfmt to write formatting changes and Oxlint to apply its safe fixes, then runs the compiler and both tools again. The option may change authored files and supported configuration files. It does not apply Oxlint suggestions or dangerous fixes. The command still fails when compiler errors or Oxc issues remain.

## Custom imports and plugin stages

TypeScript configuration can register plugin instances in execution order. A plugin may implement hooks for custom imports, source transforms, project analysis, and generated styles. Custom import types are explicit and may not replace Hesperia's built-in types or another plugin's type.

Plugins can declare `dependsOn` with configured plugin names that must appear earlier in the array. This validates the author's order; it does not reorder plugins. Each reference must identify exactly one configured plugin. Missing or ambiguous references, cycles, and dependencies listed later are errors. A plugin with an invalid dependency and plugins that depend on it are skipped; unrelated plugins keep their configured order. Repeating a dependency name has no additional effect.

```ts
import { defineConfig, type Plugin } from "@hesperia/tooling";

const base: Plugin = { name: "base" };
const theme: Plugin = { name: "theme", dependsOn: ["base"] };

export default defineConfig({ plugins: [base, theme] });
```

```ts
// hesperia.config.ts
import { defineConfig, type Plugin } from "@hesperia/tooling";

const palette: Plugin = {
  name: "palette",
  importTypes: {
    palette: async (input) => {
      const text = await input.file.blob.text();
      return {
        declaration: {
          code: "declare const palette: string; export default palette;",
          origin: input.importSpan,
        },
        browser: {
          code: `export default ${JSON.stringify(text)};`,
          origin: input.importSpan,
        },
      };
    },
  },
};

export default defineConfig({ plugins: [palette] });
```

```ts
import palette from "./palette.dat" with { type: "palette" };
```

The importer, import span, import type, and captured file Blob are supplied to each handler. The file bytes are captured once per project revision, while each import site gets its own interpretation. A handler returns a TypeScript declaration and checked browser code, each with an authored origin. Generated browser modules still pass browser capability checks, including the private environment boundary.

`projectSources` adds captured TypeScript roots for server-side project analysis. These roots are type-checked and available through `analyzeProject`, but are not transformed, discovered, or emitted as browser modules. `projectDeclarations` declares stable private IDs before source transforms; `analyzeProject` receives authored and transformed source views plus bounded TypeScript query methods, then may return browser bodies for those IDs. Every returned body is checked for valid JavaScript, declared ownership, imports, and browser capabilities before the build can emit it. Keep query handles inside the hook: they expire when it settles, while returned bodies and evidence cross only as serializable data.

`transformSource` receives the authored text and current stage text. It can return transformed code, a source map, diagnostics, watched files or directories, and data for its own `generateStyles` hook. Source transforms do not erase errors in the original TypeScript: checking includes the authored source. The compiler discovers component identities after transforms; `generateStyles` can attach application or component ownership to generated CSS. `transformCss` receives imported stylesheets without assigning one component owner; generated styles retain their declared owner. It can return another source map. Maps should relate generated positions to the immediate input stage so Hesperia can chain them back to authored files. These generic style artifacts are prepared by the build; runtime activation depends on the CSS ownership integration.

Plugin functions and their imports run in a Bun process rooted at the application. Command, build, and editor preparation pass captured data across a private process boundary; plugin closures stay in that project process. Development and editor revisions reload a changed TypeScript config without restarting the server. Changes to `.env` files still require restarting the command; see [environment values](env.md). Return watched file or directory inputs from a hook when another file controls its result, so development and editor revisions can rebuild when that input changes.

A missing watched directory produces a warning while development watches its nearest existing ancestor for that directory's creation. Unrelated writes under the ancestor do not trigger rebuilds. Once the directory exists, its own watcher observes subsequent changes.

### Optional CSS and StyleX plugins

CSS integrations are separate optional packages. Installing one does not enable it; add its factory to the ordered `plugins` array. Tailwind and ordinary PostCSS stages run for imported and generated CSS, while `stylex()` transforms recognized StyleX imports and produces one application-owned stylesheet. See [CSS integrations](css.md) for package setup, URL handling, watches, and map behavior.

```ts
// hesperia.config.ts
import { defineConfig } from "@hesperia/tooling";
import { postcss } from "@hesperia/postcss";
import { tailwind } from "@hesperia/tailwind";
import { stylex } from "@hesperia/stylex";
import nesting from "postcss-nesting";

export default defineConfig({
  plugins: [stylex(), tailwind({ base: "." }), postcss({ plugins: [nesting()] })],
});
```

The Tailwind `base` is resolved when the project-root configuration process creates the plugin. The default uses that process's working directory, which Hesperia sets to the application root, including when a tooling caller starts outside the application directory. PostCSS plugin configuration is explicit: Hesperia does not discover or load `postcss.config.*` files.
