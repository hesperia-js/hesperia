import { mount } from "hesperia/runtime";
import Structure, {
  getPanelCleanupCount,
  getStructureControls,
  setStructureDispose,
} from "../Structure.tsx";

const errors: string[] = [];
const warnings: string[] = [];
const app = mount(
  document.getElementById("app")!,
  Structure,
  {},
  {
    onError: (error) =>
      errors.push(error instanceof Error ? (error.stack ?? error.message) : String(error)),
    warn: (warning) => warnings.push(warning),
    development: true,
  },
);
setStructureDispose(() => app.dispose());
document.getElementById("remove")!.addEventListener("click", () => app.dispose());
Object.assign(globalThis, {
  structureFixture: {
    errors,
    warnings,
    get panelCleanups() {
      return getPanelCleanupCount();
    },
    controls: getStructureControls(),
    dispose() {
      app.dispose();
    },
  },
});
await app.settled();
document.documentElement.dataset.ready = "true";
