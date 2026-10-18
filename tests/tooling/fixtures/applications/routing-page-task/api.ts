import { createGraph, createStore, defineContract } from "aeolia";
import { withAeolia } from "hesperia/aeolia";

const shared = createStore({ name: "page-task.shared", initial: "initial" });

const contract = defineContract({ namespace: "page-task", operations: { shared } });

const graph = createGraph({ contract });

export const api = withAeolia(graph, contract);
