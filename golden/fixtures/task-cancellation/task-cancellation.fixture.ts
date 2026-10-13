import { mount } from "hesperia";
import TaskCancellation, { getTaskHarness } from "./TaskCancellation.tsx";

const host = document.getElementById("app");

if (!(host instanceof HTMLElement)) throw new Error("Golden application host is missing");

const application = mount(host, TaskCancellation, {});

await application.settled();

Object.assign(window, { hesperiaGoldenTask: getTaskHarness() });

document.documentElement.dataset.ready = "true";
