import { mount } from "hesperia/runtime";
import Counter from "./counter.tsx";

const container = document.getElementById("app")!;
const application = mount(container, Counter, {});
document.getElementById("remove")!.addEventListener("click", () => application.dispose());
await application.settled();
document.documentElement.dataset.ready = "true";
