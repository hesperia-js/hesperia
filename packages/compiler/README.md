# @hesperia/compiler

Hesperia's compiler turns authored TypeScript and JSX into JavaScript that creates
and updates native DOM objects. It also provides authored-source diagnostics,
source maps, browser capability analysis, and route analysis for Hesperia tools.

Application authors normally use the commands in
[@hesperia/tooling](https://github.com/hesperia-js/hesperia/blob/main/packages/tooling/README.md).
Install the compiler directly when building a compiler integration or inspecting
generated modules.

## Install

Install the prerelease from the `alpha` tag:

```sh
bun add --dev @hesperia/compiler@alpha
```

## Compile a module

Run compiler integrations under Bun. `compile` is asynchronous. Supply a stable filename so diagnostics and source maps
identify the authored module:

```ts
import { compile } from "@hesperia/compiler";

const result = await compile("export default function Greeting() { return <h1>Hello</h1>; }", {
  filename: "src/Greeting.tsx",
});

if (result.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
  throw new Error(JSON.stringify(result.diagnostics));
}

console.log(result.code);
```

The result includes generated code, its source map, compiler diagnostics, and a
canonical representation with a semantic hash. Use `checkProjectModules` for
TypeScript diagnostics across a project; compiler diagnostics alone are not a
complete project check.

The package also exports `@hesperia/compiler/tooling` for build integrations and
`@hesperia/compiler/editor` for retained checking sessions. An editor integration
must await a session's `dispose()` when it no longer needs the native checker.

Read the [compiler behavior guide](https://github.com/hesperia-js/hesperia/blob/main/packages/compiler/docs/compiler.md)
for supported syntax, component rules, dynamic imports, and browser checks. The
[Hesperia introduction](https://github.com/hesperia-js/hesperia/blob/main/README.md)
explains the component model.

## License

See the [license notice](https://github.com/hesperia-js/hesperia/blob/main/LICENSE),
[MPL-2.0 text](https://github.com/hesperia-js/hesperia/blob/main/COPYING), and
[commercial terms](https://github.com/hesperia-js/hesperia/blob/main/LICENSE-COMMERCIAL.md).
