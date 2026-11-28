interface GeneratedAssetAudit {
  staticEvaluations: number;
  dynamicEvaluations: number;
  committedEffects: number;
}

const global = globalThis as typeof globalThis & { __generatedAssetAudit?: GeneratedAssetAudit };
const audit = (global.__generatedAssetAudit ??= {
  staticEvaluations: 0,
  dynamicEvaluations: 0,
  committedEffects: 0,
});

audit.staticEvaluations += 1;

window.dispatchEvent(
  new CustomEvent("hesperia:generated-asset-module", {
    detail: { kind: "static", url: import.meta.url },
  }),
);

export const staticProof = `STATIC_MODULE_READY:${audit.staticEvaluations}`;
