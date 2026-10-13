import { component, defineComponent, dynamic, element, mount } from "hesperia/runtime";
import { errorBoundary } from "../../../packages/hesperia/dist/runtime/error-boundary.js";
import { ErrorView, FailingContent, errorEvents } from "../ErrorViews.tsx";

const errors: string[] = [];
const App = defineComponent((owner) => [
  element(owner, "input", { id: "error-sibling" }),
  errorBoundary(
    owner,
    "outer",
    (viewOwner, error) =>
      element(viewOwner, "p", { id: "outer-error" }, [(error() as Error).message]),
    (outerContent) =>
      errorBoundary(
        outerContent,
        "inner",
        (viewOwner, error) =>
          component(viewOwner, ErrorView, { error: dynamic(error) }, "error-view"),
        (contentOwner) => component(contentOwner, FailingContent, {}, "content"),
      ),
  ),
]);
const app = mount(
  document.getElementById("app")!,
  App,
  {},
  {
    onError: (error) => errors.push(String(error)),
  },
);

Object.assign(window, {
  errorBoundaryFixture: {
    snapshot: () => ({ events: errorEvents(), errors: errors.slice() }),
    dispose: () => app.dispose(),
  },
});

await app.settled();

document.documentElement.dataset.ready = "true";
