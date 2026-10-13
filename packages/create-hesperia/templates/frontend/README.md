# HESPERIA_PROJECT_NAME

Created with `bun create hesperia`. If you used `--no-install`, run `bun install`, then start the development server with `bun run dev`.

`app.tsx` supplies the HTML shell and imports `src/styles.css`. Edit `src/routes/+page.tsx` to change the counter example. Add `+loading.tsx` beside a route to choose its loading view while that route is pending.

`app.config.ts` holds application startup options such as `pageCacheSize`. `hesperia.config.ts` holds mount and compiler configuration. Generated route types live in `hesperia.d.ts`; `.vscode/extensions.json` recommends the Hesperia editor extension.

Run `bun run check`, `bun run build`, and `bun run preview` to check authored files, create browser assets, and serve the build.
