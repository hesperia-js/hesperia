import { mount } from "hesperia";
import Props, { childBodies } from "../Props.tsx";

const application = mount(
  document.getElementById("app")!,
  Props,
  {},
  {
    onError(error) {
      document.documentElement.dataset.fault =
        error instanceof Error ? error.message : String(error);
    },
  },
);

Object.assign(globalThis, { propsFixture: { childBodies } });

await application.settled();

document.documentElement.dataset.ready = "true";
