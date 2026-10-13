# Optional styling Golden coverage

The optional styling Golden fixture builds the same application in development and production mode with the public `@hesperia/postcss`, `@hesperia/tailwind`, and `@hesperia/stylex` factories. The browser test checks rendered output, not only build success:

- PostCSS changes a sentinel declaration to `rgb(12, 34, 56)`.
- Tailwind emits `px-7` as `28px` and a nontransparent `bg-fuchsia-950` color.
- StyleX emits its initial `rebeccapurple` style and reacts to a click by changing it to `steelblue`.
- The browser receives a successful managed CSS asset and reports no page errors.

Development and production builds are served from separate hosts created with `createHost` from `@hesperia/hosting` at `/optional-styling/development` and `/optional-styling/production`. The host owns the document wrapper, mount path, and managed asset URLs, so the Golden server does not rewrite generated HTML or asset paths.

Run the focused Chromium case from the repository root with:

```powershell
bun run --cwd golden test:chromium -- tests/optional-styling.spec.ts
```

The Windows browser run passed 6/6 executions across development and production in Chromium, Firefox, and WebKit. Computed PostCSS, Tailwind, and StyleX styles matched, the StyleX click updated the color, CSS assets returned HTTP 200, and there were no page errors; Linux verification remains open. The project uses Tailwind CSS and `@tailwindcss/postcss` 4.3.3, StyleX Babel plugin and runtime 0.19.1, and PostCSS 8.5.28. Installed-consumer checks cover these factories separately.
