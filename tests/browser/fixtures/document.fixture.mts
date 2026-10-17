import AppShell, { effectRuns } from "../AppShell.tsx";
import { mount } from "hesperia/runtime";

const previous = document.documentElement;
const errors: unknown[] = [];
const application = mount(document, AppShell, {}, { onError: (error) => errors.push(error) });

await application.settled();

Object.assign(globalThis, {
  documentFixture: {
    previous,
    errors,
    application,

    get effects() {
      return effectRuns();
    },
  },
});

document.documentElement.dataset.ready = "true";
