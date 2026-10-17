import * as client from "hesperia/client";

let effects = 0;

export function effectRuns() {
  return effects;
}

export default function AppShell() {
  const binding = client.bind<HTMLInputElement>();
  const value = client.state("first");

  client.effect(() => {
    effects++;

    binding().focus();
  });

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>Document shell</title>
      </head>
      <body>
        <input id="shell-input" bind={binding} value={value()} />
        <button id="shell-update" on:click={() => value.set("second")}>
          Update
        </button>
      </body>
    </html>
  );
}
