import { mount } from "hesperia";
import Counter from "./Counter.tsx";

const host = document.getElementById("app");

if (!(host instanceof HTMLElement)) throw new Error("Golden application host is missing");

const application = mount(host, Counter, {});

await application.settled();

document.documentElement.dataset.ready = "true";
