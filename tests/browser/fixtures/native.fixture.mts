import { mount } from "hesperia";
import Native, { nativeFormEvents, nativeOptionEvents } from "../Native.tsx";

const application = mount(
  document.getElementById("app")!,
  Native,
  {},
  {
    onError(error) {
      document.documentElement.dataset.fault =
        error instanceof Error ? error.message : String(error);
    },
  },
);

await application.settled();

Object.assign(window, {
  nativeFixture: {
    events: nativeFormEvents,
    optionEvents: nativeOptionEvents,
    dispose: () => application.dispose(),
  },
});

document.documentElement.dataset.ready = "true";
