import { mount } from "hesperia/runtime";
import {
  asyncEvents,
  awaitedChildBodies,
  createAsyncBoundary,
  createIndependentParent,
  refusedChildBodies,
} from "../Async.tsx";

const errors: string[] = [];
const independentErrors: string[] = [];
const primary = mount(
  document.getElementById("async-app")!,
  createAsyncBoundary,
  {},
  {
    onError: (error) => errors.push(error instanceof Error ? error.message : String(error)),
  },
);
const independent = mount(
  document.getElementById("independent-app")!,
  createIndependentParent,
  {},
  {
    onError: (error) =>
      independentErrors.push(error instanceof Error ? error.message : String(error)),
  },
);
Object.assign(globalThis, {
  asyncFixture: {
    errors,
    independentErrors,
    get events() {
      return [...asyncEvents];
    },
    get awaitedChildBodies() {
      return awaitedChildBodies;
    },
    get refusedChildBodies() {
      return refusedChildBodies;
    },
    dispose() {
      primary.dispose();
      independent.dispose();
    },
  },
});
await primary.settled();
await independent.settled();
document.documentElement.dataset.ready = "true";
