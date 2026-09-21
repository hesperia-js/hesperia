# Next milestone constraints

Reader: the framework designer and engineers planning Hesperia's packages, developer tools, and deployment support.

This document records the approved direction for the next milestone, the later dependency review, and the package decisions that still require discussion with the framework designer.

## Minimal dependencies

Hesperia's standards-first design includes using as few outside libraries as practical. Prefer platform capabilities when they meet the required behavior. Every added dependency needs a concrete purpose.

The current lean dependencies are accepted for the first browser milestone. This acceptance does not make them permanent choices. The Oxc libraries are accepted for compiler work. During the pre-1.0 review, after the execution model is working, reassess the need for the HTML5 parsing and source-mapping libraries and the remaining dependency set. That review does not presume removal or authorize replacement with custom parsers.

## Packages and optional integrations

The next milestone will separate responsibilities currently housed under `src/` into packages within a monorepo: a repository containing several related packages. The package design must leave room for adapters and third-party integrations.

Optional `@hesperia/*` packages must own the dependencies required by their optional features. Those dependencies must stay out of the main Hesperia package's dependency list. Tree shaking, which removes unused code from a generated application bundle, does not justify making every installation acquire optional integration dependencies.

The compiler, browser runtime, routing, tooling, editor support, and data adapters provide responsibilities to examine when proposing boundaries. This list is not an approved package map. Exact package names, boundaries, dependency relationships, and publishing arrangements remain decisions for the framework designer.

Before moving source, inspect the existing imports and dependency ownership, then propose the package boundaries for discussion. Preserve Aeolia's ownership of reactivity and shared stores. The resulting verification must cover an application installed outside the repository and establish that the base installation works without optional integration packages.

## Asset imports

The next milestone must support importing styles, markup, data files, and other assets from application modules. These imports need compiler support, correct editor types, and working development and production builds. Without explicit import attributes, the file extension selects these defaults:

| Imported file                                    | Required behavior                                                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| CSS (`.css`)                                     | Support stylesheet imports such as `import "./styles.css"`; add the styles to the document's `<head>`. |
| HTML and SVG (`.html`, `.svg`)                   | Import as native Hesperia HTML/SVG intrinsics: markup the author can render as elements.               |
| JSON and XML (`.json`, `.xml`)                   | Import the file contents as strings for the author to parse.                                           |
| Other asset files, including other image formats | Import as `Blob` objects containing the file data.                                                     |

These file-to-value rules are approved for the next milestone. The exact syntax for consuming imported markup and its ownership and reuse rules still need discussion with the framework designer. Document and test the agreed behavior through an application that imports these files; adding type declarations alone does not provide import support.

### CSS imports and bundling

Deliver ordinary stylesheet imports first, using Bun's built-in CSS bundler:

```tsx
// app.tsx
import "./src/global.css";
```

Hesperia must accept these imports in the compiler and editor, pass CSS and its
dependencies to Bun, publish the emitted stylesheets and referenced assets, and
attach the appropriate `<link rel="stylesheet">` elements to the document's
`<head>`. Preserve predictable stylesheet order and account for pages loaded
during navigation. Stylesheet edits must participate in development reloads.
Missing stylesheets must produce useful diagnostics at their imports.

Use Bun for CSS parsing, bundling, nested `@import` processing, `url(...)` asset
handling, and minification. Ordinary CSS support should not introduce another
CSS parser or bundler dependency. A feasibility check with Bun 1.4.2 confirmed
that a JavaScript stylesheet import emits separate CSS, includes a nested
stylesheet, processes a referenced image, and minifies the result. This check
establishes Bun's capability; Hesperia integration is still next-milestone work.
See [Bun's CSS documentation](https://bun.com/docs/bundler/css).

Verify the complete application flow in development and production: imported
styles affect the rendered page, nested imports and referenced assets resolve,
CSS edits appear after reload, and navigation loads the required styles in the
intended order. Replace the encoded CSS-string workaround in the getting-started
guide once this path is implemented and verified. Discuss route stylesheet
retention and unloading with the framework designer before choosing that policy.

### Import attributes and browser compatibility

Support import attributes in authored source so the author can explicitly select how the compiler interprets an asset. An explicit supported type takes precedence over the extension default. For example, `import data from "./file.json" with { type: "json" }` requests JSON parsing during compilation, while the same import without attributes returns a string. Invalid JSON under an explicit JSON import must fail compilation at the import; it must not silently fall back to text.

Import attributes are a source-language feature for Hesperia. The compiler must consume them and emit code and assets compatible with the existing 2024 browser baseline. Newer source syntax does not by itself raise that baseline. The planned implementation must not leave native asset import attributes in browser output or require browser feature detection, separate bundles selected by browser capability, or polyfills to support them.

For CSS, adding imported styles to `<head>` is Hesperia's responsibility. A native CSS module provides a `CSSStyleSheet`; importing it does not itself apply the stylesheet to the document. Keep the distinction explicit when discussing stylesheet import syntax and return values.

Discuss the supported attributes, their exact syntax, and parsed-value typing in the next milestone. Inferring a parsed JSON import's type from the file contents is the proposed direction; retaining `unknown` until the author checks its shape remains an alternative to settle. Do not promise that every JSON value is a record: JSON also permits arrays, primitive values, and `null`, and JSON object keys are strings. Syntax and return values for other explicitly parsed file types remain to be designed.

## Scope and timing

Developer experience and deployment support belong to the next milestone. Deployment-setting imports were explicitly deferred there; the current `app.config.ts` startup configuration remains supported. Package separation is now part of that next-milestone planning. Backend-specific adapters need an appropriate package home, but no complete adapter catalog has been approved for implementation.

The developer-experience milestone also includes two command-line entry points:

- A `create` CLI for creating a Hesperia application.
- The Hesperia CLI for running and managing the scripts used within a Hesperia application.

Build on the first milestone's existing init/dev/build/preview/check tooling when designing these entry points. Their package names, invocation syntax, options, and generated application scripts remain to be discussed with the framework designer.

Review authored event-handler syntax in the next milestone with the framework designer. The current editor completes `on:` attributes using native browser event names, such as `click`, `dragstart`, and `mouseenter`. This completion work does not settle future syntax or approve alternative spellings; any author-facing syntax must still map to the corresponding web-standard events.

The dependency review above belongs to the pre-1.0 pass. Route and component transitions, chained stream projections, and further rendering targets remain deferred work; this document does not assign them to the next milestone. Server rendering, server HTML streaming, hydration, and static generation follow establishment of the browser execution model.

The completed browser scope and its verification are recorded in [the implementation ledger](implementation-milestone.md#browser-milestone-completion-2026-09-12). Read this document before planning package moves, adding optional integrations, or selecting dependencies for the next milestone.
