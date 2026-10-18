import * as client from "hesperia/client";
import { api } from "../../../../api";
import palette from "../../../../palette.dat" with { type: "palette" };
import { beforeLeave, navigation } from "hesperia/navigation";
import * as NavigationApi from "hesperia/navigation";

Object.assign(globalThis, {
  installedNavigationProof: {
    directChecks: 0,
    namespaceChecks: 0,
    capturedChecks: 0,
    disposableChecks: 0,
    reassignedCalls: 0,
    reassignedChecks: 0,
    allow: false,
    outcomes: [] as string[],
  },
});

function Counter() {
  const count = client.state(0);
  return (
    <button id="count" on:click={() => count.update((value) => value + 1)}>
      Count: {count()}
    </button>
  );
}

function CapturedGuards() {
  const proof = (
    globalThis as unknown as {
      installedNavigationProof: {
        directChecks: number;
        namespaceChecks: number;
        capturedChecks: number;
        reassignedCalls: number;
        reassignedChecks: number;
        allow: boolean;
      };
    }
  ).installedNavigationProof;
  const importedGuard = beforeLeave;
  const aliasedGuard = importedGuard;

  aliasedGuard(() => {
    proof.directChecks += 1;
    return proof.allow;
  });

  const navigationModule = NavigationApi;
  const namespaceGuard = navigationModule.beforeLeave;

  namespaceGuard(() => {
    proof.namespaceChecks += 1;
    return proof.allow;
  });

  let mutableGuard = beforeLeave;

  mutableGuard(() => {
    proof.capturedChecks += 1;
    return true;
  });

  mutableGuard = () => {
    proof.reassignedCalls += 1;
  };

  mutableGuard(() => {
    proof.reassignedChecks += 1;
    return false;
  });

  return <span id="captured-guards">Captured guards</span>;
}

function DisposableGuard() {
  const proof = (
    globalThis as unknown as {
      installedNavigationProof: { disposableChecks: number; allow: boolean };
    }
  ).installedNavigationProof;
  const navigationModule = NavigationApi;
  const capturedGuard = navigationModule.beforeLeave;

  capturedGuard(() => {
    proof.disposableChecks += 1;
    return proof.allow;
  });

  return <span id="disposable-guard">Disposable guard</span>;
}

export default function NestedPage() {
  const proof = globalThis as unknown as {
    installedNavigationProof: { allow: boolean; outcomes: string[] };
  };
  const removeDisposable = client.state(false);
  const greeting = api.greeting("Hesperia");
  const rename = api.rename();
  return (
    <main>
      <CapturedGuards />
      {!removeDisposable() ? (
        <DisposableGuard />
      ) : (
        <span id="disposable-removed">Disposable guard removed</span>
      )}
      <span id="greeting">{greeting.value() ?? "Waiting"}</span>
      <span id="palette">{palette}</span>
      <button id="remove-disposable" on:click={() => removeDisposable.set(true)}>
        Remove disposable guard
      </button>
      <button
        id="try-leave"
        on:click={() => {
          const result = navigation.navigate("/");

          void result.committed.then(
            () => proof.installedNavigationProof.outcomes.push("committed"),
            () => proof.installedNavigationProof.outcomes.push("denied"),
          );
        }}
      >
        Try navigation
      </button>
      <button
        id="rename"
        on:click={() => void rename.run({ name: "Hesperia", text: "Hello Aeolia" })}
      >
        Rename
      </button>
      <Counter />
    </main>
  );
}
