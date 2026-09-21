import { signal } from "aeolia";
import { defineComponent, element, mount, rawHTML } from "hesperia/runtime";

const errors: string[] = [];
const warnings: string[] = [];
const table = signal("<tr><td>one</td></tr>");
const choices = signal('<option value="one">One</option>');
const article = signal<unknown>("<p>First</p>");
const trusted = new URL(location.href).searchParams.has("trusted");
const factory = (
  globalThis as unknown as {
    trustedTypes?: {
      createPolicy(
        name: string,
        rules: { createHTML(value: string): string },
      ): { createHTML(value: string): unknown };
    };
  }
).trustedTypes;
const policy = trusted
  ? factory?.createPolicy("hesperia-test", { createHTML: (value) => value })
  : undefined;
if (policy) article.set(policy.createHTML("<p>Trusted</p>"));

const App = defineComponent((owner) => {
  const hostRegion = rawHTML(
    owner,
    "article",
    () => article.get(),
    (child) => element(child, "article", { "data-host": "" }, []),
  );
  if (trusted) return hostRegion;
  const rows = rawHTML(owner, "rows", () => table.get(), null, "tbody");
  const options = rawHTML(owner, "options", () => choices.get(), null, "select");
  return element(owner, "main", {}, [
    hostRegion,
    element(owner, "table", {}, [element(owner, "tbody", {}, [rows])]),
    element(owner, "select", { "aria-label": "Raw choices" }, [options]),
  ]);
});
const app = mount(
  document.getElementById("app")!,
  App,
  {},
  {
    onError: (error) => errors.push(error instanceof Error ? error.message : String(error)),
    warn: (message) => warnings.push(message),
    development: true,
  },
);
Object.assign(globalThis, {
  rawFixture: {
    errors,
    warnings,
    supportsTrustedTypes: Boolean(factory),
    replace() {
      article.set("<p>Second</p>");
      table.set("<tr><td>two</td></tr><tr><td>three</td></tr>");
      choices.set('<option value="two">Two</option>');
    },
    untrusted() {
      article.set("<p>Rejected</p>");
    },
    trusted() {
      article.set(policy!.createHTML("<p>Accepted</p>"));
    },
    dispose() {
      app.dispose();
    },
  },
});
await app.settled();
document.documentElement.dataset.ready = "true";
