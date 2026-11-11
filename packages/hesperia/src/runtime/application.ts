import { resolveAppConfiguration } from "../application.ts";
import { installHistoryTracking } from "../routing/history.ts";
import { createRouteHost } from "../routing/route-host.ts";
import { createFilesystemRouter } from "../routing/filesystem.ts";
import type { RouteTable } from "../routing/route-table.ts";
import { instantiateComponent, prepareComponent, type Component } from "./components.ts";
import {
  createRuntimeRoot,
  installStyledDocument,
  prepareTree,
  type MountedApplication,
  type Rendered,
} from "./dom.ts";
import { registerOwnerDisposalPromiseAlias, RenderFault } from "./owner.ts";
import { bootstrapDataBindingRoot } from "../data/environment.ts";
import { installRootProjectPolicy } from "./project-policy.ts";
import { internalStyleBindingFor } from "./style.ts";
import { reserveNavigation } from "../routing/navigation-api.ts";

/** Deferred authored modules, evaluated only after browser history tracking is installed. */
export interface ApplicationModules {
  /** Load the optional root configuration, or return an empty object when absent. */
  configuration(): unknown | PromiseLike<unknown>;

  /** Load the compiled root HTML shell. */
  shell(): Component<{ children: Rendered }> | PromiseLike<Component<{ children: Rendered }>>;

  /** Load the generated route table without evaluating its lazy page modules. */
  routes(): RouteTable | PromiseLike<RouteTable>;
}

/** Private generated-startup options bound before authored modules are loaded. */
export interface BootstrapApplicationOptions {
  /** Mounted route prefix used by the Navigation facade. Defaults to `/`. */
  readonly mountPath?: string;
}

/**
 * Start a generated browser application. History tracking precedes every authored
 * module. The shell stays hidden and its effects wait for its installed-head CSS
 * before initial routing begins. Rejection disposes any partially built component
 * tree and releases the history lease.
 */
export async function bootstrapApplication(
  window: Window,
  modules: ApplicationModules,
  options: BootstrapApplicationOptions = {},
): Promise<MountedApplication> {
  const navigationReservation = reserveNavigation(window, options.mountPath);
  let history: ReturnType<typeof installHistoryTracking> | undefined;
  let runtime: ReturnType<typeof createRuntimeRoot> | undefined;
  let router: ReturnType<typeof createFilesystemRouter> | undefined;

  try {
    history = installHistoryTracking(window);

    navigationReservation.setHistoryTracker(history);

    const configuration = resolveAppConfiguration(await modules.configuration());
    const [shell, table] = await Promise.all([modules.shell(), modules.routes()]);
    runtime = createRuntimeRoot(window.document);

    installRootProjectPolicy(runtime.owner, shell as Component<unknown>);

    await bootstrapDataBindingRoot(runtime.owner, configuration.dataBinding, "async");

    const outlet = window.document.createDocumentFragment();
    const host = createRouteHost(runtime, outlet);
    const tree = prepareTree(runtime.owner, () => {
      const output = instantiateComponent(
        runtime!.owner,
        prepareComponent(shell, { children: outlet }),
      ).output;

      if (output instanceof Promise) {
        void output.catch(() => undefined);

        throw new RenderFault("document-shell", "The root HTML shell must render synchronously");
      }

      return output;
    });

    const styleBinding = internalStyleBindingFor(shell);

    if (styleBinding) {
      await installStyledDocument(tree, window.document, styleBinding.runtime, {
        entryId: styleBinding.entryId,
      });
    } else tree.install(window.document);

    router = createFilesystemRouter(
      window,
      runtime,
      host,
      table,
      configuration,
      styleBinding?.runtime,
      navigationReservation.mountPath,
    );

    navigationReservation.attachRouter(
      router,
      {
        settled: () => runtime!.context.scheduler.settled(),
      },
      runtime.owner,
    );

    const initialNavigation = router.navigate(window.location.href, { history: "replace" });

    await navigationReservation.beginInitialNavigation(initialNavigation);

    router.installHistoryNavigation(navigationReservation.mountPath);

    navigationReservation.historyAdapterInstalled();

    router.listenToLinks(navigationReservation.mountPath);

    const mountedRuntime = runtime;
    const mountedRouter = router;
    let disposal: Promise<void> | undefined;
    let synchronousFailures: unknown[] = [];
    let reporterFailure: { readonly cause: unknown } | undefined;

    const beginDisposal = (reason: unknown, mode: "join" | "sync"): Promise<void> => {
      if (disposal) return disposal;

      let resolve!: () => void;
      let reject!: (cause: unknown) => void;
      disposal = new Promise<void>((accept, fail) => {
        resolve = accept;
        reject = fail;
      });
      registerOwnerDisposalPromiseAlias(mountedRuntime.owner, disposal);

      if (mode === "sync") void disposal.catch(() => undefined);

      if (mode === "sync") {
        try {
          mountedRuntime.owner.disposeSync(reason);
        } catch (cause) {
          reporterFailure = { cause };
        }
      }

      let ownerRetirement: Promise<void> | undefined;

      try {
        ownerRetirement = mountedRuntime.owner.dispose(reason);
      } catch (cause) {
        synchronousFailures.push(cause);
      }

      for (const release of [
        () => navigationReservation.release(reason),
        () => mountedRouter.dispose(reason),
        () => history?.release(),
      ]) {
        try {
          release();
        } catch (cause) {
          synchronousFailures.push(cause);
        }
      }

      void Promise.allSettled(ownerRetirement ? [ownerRetirement] : []).then((outcomes) => {
        const failures = outcomes.flatMap((outcome) => {
          if (outcome.status === "fulfilled") return [];

          const cause: unknown = outcome.reason;
          return cause instanceof AggregateError && cause.message === "Component cleanup failed"
            ? [...cause.errors]
            : [cause];
        });
        failures.push(...synchronousFailures);

        if (failures.length) reject(new AggregateError(failures, "Application disposal failed"));
        else resolve();
      }, reject);

      return disposal;
    };

    return {
      dispose(reason) {
        return beginDisposal(reason, "join");
      },

      disposeSync(reason) {
        if (disposal) return;

        beginDisposal(reason, "sync");
        const failures = reporterFailure
          ? [reporterFailure.cause, ...synchronousFailures]
          : synchronousFailures;

        if (failures.length === 1) throw failures[0];
        if (failures.length > 1)
          throw new AggregateError(failures, "Application synchronous disposal failed");
      },

      settled: () => mountedRuntime.context.scheduler.settled(),
    };
  } catch (error) {
    const failures: unknown[] = [];

    for (const release of [
      () => navigationReservation.release(error),
      () => router?.dispose(error),
      () => runtime?.owner.disposeSync(error),
      () => history?.release(),
    ]) {
      try {
        release();
      } catch (cause) {
        failures.push(cause);
      }
    }

    if (failures.length)
      throw new AggregateError([error, ...failures], "Application startup and cleanup failed", {
        cause: error,
      });

    throw error;
  }
}
