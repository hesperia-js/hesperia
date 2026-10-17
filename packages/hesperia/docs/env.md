# Server environment values

Reader: application authors configuring server and build code.

Import the callable `env` helper from `hesperia/env` in code that runs under Bun
on the server or during a build:

```ts
import { env } from "hesperia/env";

const token = env("TOKEN");
const optionalToken = env("OPTIONAL_TOKEN", undefined, true);
const port = env.num("PORT", 3000);
const optionalPort = env.num("OPTIONAL_PORT", undefined, true);
const enabled = env.bool("FEATURE_ENABLED");
```

`env(name)` returns the string value or throws synchronously when it is missing.
For strings, an empty or missing value uses a supplied default. The third
argument, `true`, permits a missing value to return `undefined`; an existing
empty string remains an empty string when there is no default.

`env.num(name, defaultValue)` converts the string with JavaScript's `Number()`.
It rejects `NaN`, while values such as `0x10` and `Infinity` retain `Number()`
behavior. Its optional form is `env.num(name, undefined, true)`. An empty or
missing value uses the numeric default when one is supplied.

`env.bool(name, defaultValue?)` accepts case-insensitive `true` and `false`.
Missing or empty values use the default, which is `false` when omitted. Other
values throw. There is no optional boolean form.

Bun loads project `.env` files according to its [environment rules](https://bun.com/docs/runtime/environment-variables).
The helper reads `process.env` as Bun presents it; it does not parse files or
publish values to browser code. Restart the running Bun command after changing
its `.env` files. A child process inherits the parent's environment, including
values Bun previously loaded, so restarting only that child can retain old values.
Hesperia preserves inherited environment variables and Bun's precedence rules.

Hesperia rejects browser value imports of
`hesperia/env`, including imports re-exported through another file or renamed locally.
Type-only imports can be used for declarations without adding the helper to a
browser bundle. Keep the helper out of modules that a browser page, shell, or
client route guard uses at runtime.
