# Compiler behavior

Reader: a junior TypeScript engineer writing Hesperia components and imported helpers.

Hesperia compiles component source into code that creates and updates native DOM objects. It also checks the code reached through browser imports, so a helper cannot bring server-only operations into the browser indirectly. Type-only imports do not include executable code.

The compiler first removes TypeScript syntax while retaining JSX. It then records the meaning of the remaining expressions, bindings, and statements before generating JavaScript. Source locations are kept separately so diagnostics and source maps can point back to the authored TypeScript. Unsupported executable syntax is an error; the compiler does not copy it through unchecked.

Browser package resolution follows the active `browser`, `import`, build-mode, and `default` conditions. A project may replace one exact import name for browser builds in `hesperia.config.json`:

```json
{
  "resolutionOverrides": {
    "browser": {
      "some-package": "./src/browser-replacement.ts",
      "some-package/optional": "fallback-package",
      "./local-package.ts": "../src/browser-replacement.ts"
    }
  }
}
```

Keys are complete import names. A key for `some-package` does not match `some-package/optional`, and relative keys are matched with the same exact rule. Relative targets, including `../` targets, are resolved from the project configuration root; a bare target is resolved as a package using the same browser conditions. The selected module is captured once and then reused by TypeScript checking, capability analysis, route extraction, and the browser bundle. The replacement is checked as a new browser dependency, so importing a host capability through it still fails. The build record lists the exact overrides, selected source digests, and resolution edges.

TypeScript declarations and configuration files read during checking are also captured. The build record lists their content digests, so it identifies the types used for that build. Development mode watches those dependencies: an invalid declaration edit reports an error and keeps the last successful build; a valid repair publishes the new build and reloads the application. TypeScript's own pinned toolchain files are excluded from the project input list.

Compiler integrations can read `result.checkingInputs` from `checkProjectModules`. Each entry contains its absolute `filename`, captured `source` text, and SHA-256 `digest`. Entries follow first-read order and retain the snapshot's bytes after files change on disk. Configure replacement imports through `resolutionOverrides`; the `resolution` and `runtimeModule` options are internal tooling connections.

Conventional page, layout, loading, error, and not-found files identify their default export as a component even when it returns `null` or always throws. A separate function declaration, an arrow, a function expression, or a local alias can supply that export. An unrelated helper in the same file remains an ordinary function. Declaring component props through `Component.Props` also identifies a component without requiring a JSX return.

Ordinary helpers support native `for`, `for...of`, `for...in`, `while`, and `do...while`, including labeled `break` and `continue`. Initializers, conditions, updates, and destructuring defaults keep JavaScript's evaluation order. A `let` binding in a loop has a separate value for each iteration's closures; `var` retains its function-scoped binding.

Ordinary helpers can also be native generator functions. Calling a generator creates a paused iterator; its body does not run until `next()` advances it. `yield` pauses with one value and receives the next value passed to `next`, while `yield*` delegates to another iterable and preserves its completion value. Async generators use the same native rules with promises from `next()`. Generator functions remain ordinary helpers even when their body returns JSX; they are not component factories. Generator methods in classes remain outside this compiler profile.

```ts
export function total(values: readonly number[]) {
  let result = 0;
  for (const value of values) {
    result += value;
  }
  return result;
}
```

Loops inside a component execute as part of its body. They do not change the component's usual single-execution lifetime or turn local variables into signals. A binding read in immediate loop work is still a forbidden component-body read, including reads in conditions, updates, or defaults. Deferred event and effect callbacks retain their separate execution timing.

Ordinary async functions support native `for await...of`. Such a function can be declared inside a component and called later from an effect or event. Direct async iteration in a component body is not supported by the current component await driver and produces `HES-ASYNC-ITERATION` at the authored loop. Component bodies may await registered queries, child renders, and dynamic import Promises emitted by Hesperia. An enclosing async boundary is required.

Call an async helper from a deferred event or effect. The component body does not await the helper, so its loop stays ordinary async work.

Here, `AsyncIterable<string>` is a source that supplies strings asynchronously.
Clicking the button starts collecting them and updates the displayed values as
they arrive.

```tsx
import { type Component } from "hesperia";
import * as client from "hesperia/client";

function Values(props: Component.Props<{ values: AsyncIterable<string> }>) {
  const received = client.state<string[]>([]);
  const error = client.state("");

  async function collect() {
    try {
      for await (const value of props.values()) {
        received.update((current) => [...current, value]);
      }
    } catch (cause) {
      error.set(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <section>
      <button on:click={() => void collect()}>Collect values</button>
      <output>{received().join(", ")}</output>
      <output>{error()}</output>
    </section>
  );
}
```

Native `try`, `catch`, and `finally` preserve JavaScript's handling of returns, thrown values, and loop exits. Catch bindings remain local to their catch clause, including destructured bindings and their defaults. Creating a callback inside one of these blocks does not execute its body. Immediate binding reads in a component still fail checking, while deferred event and effect callbacks can read bindings when they run.

Native `switch` statements preserve case order, fallthrough, and `break`. The case bodies share a lexical scope; the discriminant is evaluated in the enclosing scope. Array, object, and parameter rest patterns retain their native binding behavior. Destructuring a keyed row does not freeze it: rendered content and callbacks see that row's current values after an update.

Classes retain native inheritance, private names, fields, methods, and static blocks. Class creation evaluates the parent class expression, computed names, static fields, and static blocks. Instance fields and method bodies run later. Component-body binding checks respect that distinction, and browser dependency checking includes the methods and fields of retained classes.

Assignments, including compound and logical assignments, and spreads in arrays, function arguments, or constructor arguments preserve native evaluation order. Array holes remain holes; spreading an iterable uses its iterator. Regular expression and bigint literals produce native JavaScript values. Destructuring assignment and writes that replace an extracted keyed-list parameter are not implemented. Updating a property of the referenced object is distinct from replacing that parameter.

Comma expressions in ordinary JavaScript evaluate each operand from left to right and return the last value. For example, `(record(), value)` calls `record` before returning `value`. Earlier operands keep their side effects and signal reads. A call such as `(0, object.method)()` also keeps JavaScript's behavior: it calls the method without binding `this` to `object`.

Browser checking rejects references to native `eval` and the native `Function` constructor, including direct aliases and explicit access through `globalThis`, `window`, or `self`. It also follows proven aliases to those global objects, finite computed property names, and constant-name `Reflect.get` lookups; an unknown computed property on a proven global object fails closed. A finite property union that includes `constructor` remains unsafe unless the receiver is proven to use a safe own constructor or a known ordinary constructor.

Native constructor checks include the ECMAScript callable globals and standard callable namespace members listed by the installed TypeScript 7.0.2 `lib.es2025.*` definitions. Unknown `.constructor` values fail closed, while `.constructor.name`/`.length`, proven own constructors, and known ordinary constructors such as `Object.prototype.constructor` remain readable. Locally defined functions with those names, including a function with an explicitly assigned custom `constructor`, remain ordinary functions. Reading native function metadata such as `Function.prototype` remains supported.

This enforcement is still being extended to indirect access paths; it is not yet a complete proof for arbitrary JavaScript reflection.

Dynamic imports can choose among targets the compiler can enumerate. The current analysis understands string literals, conditional branches, string concatenation, templates, and local `const` aliases. Every possible target undergoes browser dependency checking. An arbitrary runtime string or a mutable binding is rejected when the compiler cannot establish all its possible targets.

```ts
export function loadEditor(compact: boolean) {
  const name = compact ? "compact-editor" : "full-editor";
  return import("./" + name + ".ts");
}
```

Browser generation publishes the possible modules and preserves lazy execution: only the selected module runs when the import is called. Source and options expressions are evaluated once; a thrown operand rejects the returned promise. Repeated JavaScript module imports retain native module identity. Ordinary authored `.ts` and `.mts` helpers use the same canonical generation pipeline as `.tsx`, so their import transformations are included in the final browser build.

The compiler registers the original dynamic import Promise for component awaits
without assigning it to a component. A module-level variable can hold that Promise
for several components to await, each within its own lifetime. This does not make
arbitrary Promises valid component waits. See [asset imports](assets.md) for direct
and stored-Promise examples.

Extracted route guards can also import finite TypeScript targets lazily. The compiler includes those modules and their dependencies in the emitted graph, including module initialization, side-effect imports, and dependencies reached through `yield` or `yield*`. They still execute at the native import timing, and shared dependencies initialize once. Browser capability checking applies to that emitted graph before publication.
