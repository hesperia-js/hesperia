interface InstalledNavigationProof {
  directChecks: number;
  namespaceChecks: number;
  capturedChecks: number;
  disposableChecks: number;
  reassignedCalls: number;
  reassignedChecks: number;
  allow: boolean;
  outcomes: string[];
}

declare global {
  var installedNavigationProof: InstalledNavigationProof;
}

export {};
