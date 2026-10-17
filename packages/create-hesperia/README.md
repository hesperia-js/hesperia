# create-hesperia

Create a Hesperia application with a document shell, a counter route, project
configuration, and development scripts. The default starter includes an Elysia
server and a typed Eden client. A frontend-only starter is also available.

## Create an application

Use Bun to run the creator from the prerelease `alpha` tag:

```sh
bunx create-hesperia@alpha my-app
cd my-app
bun run dev
```

The destination must be new or empty. In an interactive terminal, the creator asks
which host integration to use: Enter selects Elysia, and option 2 selects no host.
Without an interactive terminal, it defaults to Elysia. Dependencies install
automatically unless you pass `--no-install`.

Choose the frontend-only starter explicitly and install its dependencies later:

```sh
bunx create-hesperia@alpha my-frontend --host none --no-install
cd my-frontend
bun install
bun run dev
```

`--host elysia` explicitly selects the default integration. Both starters include
`bun run check`, `bun run build`, and `bun run preview`. In the Elysia starter,
`preview` builds the browser application before starting the server, and
`bun run start` serves the latest completed build. Frontend-only `preview` serves
an existing build, so run `bun run build` first.

## Edit the generated project

| File                   | Purpose                                                 |
| ---------------------- | ------------------------------------------------------- |
| `app.tsx`              | The application's document shell and global CSS import. |
| `src/routes/+page.tsx` | The initial counter page.                               |
| `hesperia.config.ts`   | Build settings, mount path, and plugins.                |
| `app.config.ts`        | Application startup settings, including the page cache. |
| `src/server.ts`        | Elysia routes, when the host integration is selected.   |

The generated project pins matching Hesperia package versions. See the
[application authoring guide](https://github.com/hesperia-js/hesperia/blob/main/docs/getting-started.md),
[project configuration guide](https://github.com/hesperia-js/hesperia/blob/main/packages/tooling/docs/project-configuration.md),
and [Elysia guide](https://github.com/hesperia-js/hesperia/blob/main/packages/elysia/docs/elysia.md)
for routes, configuration, and typed server calls.

## License

See the [license notice](https://github.com/hesperia-js/hesperia/blob/main/LICENSE),
[MPL-2.0 text](https://github.com/hesperia-js/hesperia/blob/main/COPYING), and
[commercial terms](https://github.com/hesperia-js/hesperia/blob/main/LICENSE-COMMERCIAL.md).
