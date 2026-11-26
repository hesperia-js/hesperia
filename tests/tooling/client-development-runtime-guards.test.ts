import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { Window } from "happy-dom";

type ClientGuardFixture = typeof import("./fixtures/client-development-guards.ts");

async function loadClientGuardFixture(development: boolean): Promise<ClientGuardFixture> {
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "fixtures/client-development-guards.ts")],
    target: "bun",
    format: "esm",
    define: { __HESPERIA_DEV__: String(development) },
  });

  if (!build.success) throw new AggregateError(build.logs, "Client guard fixture did not bundle");

  const encoded = Buffer.from(await build.outputs[0]!.text()).toString("base64");

  return (await import(`data:text/javascript;base64,${encoded}`)) as ClientGuardFixture;
}

for (const development of [true, false]) {
  test(`client callback guards preserve a real Owner with development ${development}`, async () => {
    const { createClient, defineComponent, mount } = await loadClientGuardFixture(development);
    const window = new Window();
    let client!: ReturnType<typeof createClient>;
    let effectRuns = 0;
    let app: ReturnType<typeof mount> | undefined;

    try {
      const App = defineComponent((owner) => {
        client = createClient(owner);

        client.effect(() => {
          effectRuns++;
        });

        return null;
      });

      app = mount(window.document.body as unknown as Element, App, {});

      await app.settled();

      expect(effectRuns).toBe(1);

      expect(client.derived(() => 42)()).toBe(42);

      if (development) {
        expect(() => client.derived(undefined as never)).toThrow(
          "HES-DEV-CLIENT-DERIVED: derived() expects compute to be a function",
        );

        expect(() => client.effect(undefined as never)).toThrow(
          "HES-DEV-CLIENT-EFFECT: effect() expects run to be a function",
        );
      }

      await app.dispose();

      expect(() => client.derived(undefined as never)).toThrow("is no longer active");

      expect(() => client.effect(undefined as never)).toThrow("is no longer active");
    } finally {
      try {
        await app?.dispose();
      } finally {
        window.close();
      }
    }
  });
}
