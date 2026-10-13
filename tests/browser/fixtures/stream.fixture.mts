import { mount } from "hesperia";
import Streams from "../Streams.tsx";
import { disposeGraph, streamStats } from "./stream-api.fixture.mts";

const application = mount(
  document.getElementById("app")!,
  Streams,
  {},
  {
    onError(error) {
      document.documentElement.dataset.fault = String(error);
    },
  },
);

Object.assign(globalThis, { streamFixture: { streamStats } });

addEventListener(
  "pagehide",
  () => {
    application.dispose();

    disposeGraph();
  },
  { once: true },
);

await application.settled();

document.documentElement.dataset.ready = "true";
