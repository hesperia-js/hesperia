import { app } from "./server.ts";
import { initializeHesperiaHost } from "./server-internals.ts";

await initializeHesperiaHost();

const port = Number(process.env.PORT ?? "3000");

if (!Number.isInteger(port) || port < 0 || port > 65535)
  throw new TypeError("PORT must be an integer from 0 to 65535");

app.listen(port, ({ url }) => console.log("Hesperia Elysia: " + url.href));
