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
import { RenderFault } from "./owner.ts";
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
    let disposed = false;
    return {
      dispose(reason) {
        if (disposed) return;

        disposed = true;

        try {
          navigationReservation.release(reason);

          mountedRouter.dispose(reason);
        } finally {
          try {
            mountedRuntime.owner.dispose(reason);
          } finally {
            history?.release();
          }
        }
      },

      settled: () => mountedRuntime.context.scheduler.settled(),
    };
  } catch (error) {
    try {
      navigationReservation.release(error);

      router?.dispose(error);
    } finally {
      try {
        runtime?.owner.dispose(error);
      } finally {
        history?.release();
      }
    }

    throw error;
  }
}
