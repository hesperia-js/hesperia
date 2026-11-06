import { mount } from "hesperia";
import GraphQL from "./graphql.tsx";
import {
  disposeGraphQL,
  disposeGraphQLGraph,
  disposeGraphQLSocket,
  resetGraphQLGraph,
} from "./graphql-api.ts";

const application = mount(
  document.getElementById("app")!,
  GraphQL,
  {},
  {
    onError(error) {
      document.documentElement.dataset.fault = String(error);
    },
  },
);
let disposal: Promise<void> | undefined;

function dispose(): Promise<void> {
  disposal ??= Promise.resolve().then(async () => {
    const failures: unknown[] = [];

    for (const release of [() => application.dispose(), disposeGraphQL, disposeGraphQLSocket]) {
      try {
        await release();
      } catch (cause) {
        failures.push(cause);
      }
    }

    if (failures.length > 0)
      throw new AggregateError(
        failures,
        "The GraphQL browser fixture could not release every resource",
      );
  });

  return disposal;
}

Object.assign(globalThis, {
  graphqlFixture: {
    dispose,
    subscription: {
      resetGraph: resetGraphQLGraph,
      disposeGraph: disposeGraphQLGraph,
      disposeSocket: disposeGraphQLSocket,
    },
  },
});

addEventListener("pagehide", () => void dispose(), { once: true });

await application.settled();

document.documentElement.dataset.ready = "true";
