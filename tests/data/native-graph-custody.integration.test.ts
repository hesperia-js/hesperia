import { expect, test } from "bun:test";
import { createGraph, defineContract } from "aeolia";
import {
  createAdmittedAeoliaGraph,
  readActualGraphConstruction,
  readRecordedAeoliaGraphConstruction,
} from "../../packages/hesperia/src/data/api.ts";
import {
  acquirePhysicalNativeModuleLifetime,
  bindPhysicalGraphConstructionUse,
  readPhysicalGraphConstructionUse,
} from "../../packages/hesperia/src/runtime/retirement.ts";

test("an admitted graph retains its exact physical ticket and checked use", async () => {
  const module = acquirePhysicalNativeModuleLifetime();
  const ticket = module.acquireGraphConstruction();
  const use = Object.freeze({ id: "native-graph", kind: "graph" as const });
  const otherUse = Object.freeze({ id: "native-graph", kind: "graph" as const });
  const contract = defineContract({ namespace: "native-graph-custody", operations: {} });
  const options = { contract };
  let calls = 0;
  let received: unknown;
  const create = (input: typeof options) => {
    calls++;
    received = input;

    return createGraph(input);
  };

  bindPhysicalGraphConstructionUse(ticket, use);
  expect(() => createAdmittedAeoliaGraph(ticket, create, options, otherUse)).toThrow();
  expect(calls).toBe(0);

  const graph = createAdmittedAeoliaGraph(ticket, create, options, use);
  const receipt = readActualGraphConstruction(graph);

  expect(calls).toBe(1);
  expect(received).toBe(options);
  expect(receipt?.graph).toBe(graph);
  expect(receipt?.contract).toBe(contract);
  expect(receipt?.options).toBe(options);
  expect(receipt?.checkedUse).toBe(use);
  expect(receipt?.construction).toBe(ticket);
  expect(readRecordedAeoliaGraphConstruction(use)).toBe(receipt);
  expect(readRecordedAeoliaGraphConstruction(otherUse)).toBeUndefined();
  expect(readPhysicalGraphConstructionUse(graph)).toBe(use);
  expect(() => createAdmittedAeoliaGraph(ticket, create, options, use)).toThrow();
  expect(calls).toBe(1);

  module.beginClose();
  module.finishAdmission();
  await module.retired;
});

test("an admitted constructor failure remains the module retirement failure", async () => {
  const module = acquirePhysicalNativeModuleLifetime();
  const ticket = module.acquireGraphConstruction();
  const use = Object.freeze({ id: "native-graph-failure", kind: "graph" as const });
  const contract = defineContract({ namespace: "native-graph-failure", operations: {} });
  const failure = new Error("original graph constructor failure");
  let caught: unknown;

  bindPhysicalGraphConstructionUse(ticket, use);

  try {
    createAdmittedAeoliaGraph(
      ticket,
      () => {
        throw failure;
      },
      { contract },
      use,
    );
  } catch (reason) {
    caught = reason;
  }

  expect(caught).toBe(failure);
  expect(readRecordedAeoliaGraphConstruction(use)).toBeUndefined();

  module.beginClose();
  module.finishAdmission();
  await expect(module.retired).rejects.toBe(failure);
});
