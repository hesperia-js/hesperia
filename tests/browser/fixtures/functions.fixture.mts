import { mount } from "hesperia";
import FunctionComponents, { bodyExecutions, Tree } from "../FunctionComponents.tsx";

const application = mount(
  document.getElementById("app")!,
  FunctionComponents,
  {},
  {
    onError(error) {
      document.documentElement.dataset.fault =
        error instanceof Error ? error.message : String(error);
    },
  },
);
let directCallFault: unknown;
try {
  Tree({ depth: 0, label: "direct" } as never);
} catch (error) {
  directCallFault = error instanceof Error && "kind" in error ? error.kind : String(error);
}
Object.assign(globalThis, { functionsFixture: { bodyExecutions, directCallFault } });
await application.settled();
document.documentElement.dataset.ready = "true";
