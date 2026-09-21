import { resolveAppConfiguration } from "../application.ts";
import { installHistoryTracking } from "../routing/history.ts";
import { createRouteHost } from "../routing/route-host.ts";
import { createFilesystemRouter } from "../routing/filesystem.ts";
import type { RouteTable } from "../tooling/route-table.ts";
import { instantiateComponent, prepareComponent, type Component } from "./components.ts";
import { createRuntimeRoot, prepareTree, type MountedApplication, type Rendered } from "./dom.ts";
import { RenderFault } from "./owner.ts";

/** Deferred authored modules, evaluated only after browser history tracking is installed. */
export interface ApplicationModules {
  /** Load the optional root configuration, or return an empty object when absent. */
  configuration(): unknown | PromiseLike<unknown>;
  /** Load the compiled root HTML shell. */
  shell(): Component<{ children: Rendered }> | PromiseLike<Component<{ children: Rendered }>>;
  /** Load the generated route table without evaluating its lazy page modules. */
  routes(): RouteTable | PromiseLike<RouteTable>;
}

/**
 * Start a generated browser application. History tracking precedes every authored
 * module; the shell is installed before the initial route is resolved. Rejection
 * disposes any partially built component tree and releases the history lease.
 */
export async function bootstrapApplication(
  window: Window,
  modules: ApplicationModules,
): Promise<MountedApplication> {
  const history = installHistoryTracking(window);
  let runtime: ReturnType<typeof createRuntimeRoot> | undefined;
  let router: ReturnType<typeof createFilesystemRouter> | undefined;
  try {
    const configuration = resolveAppConfiguration(await modules.configuration());
    const [shell, table] = await Promise.all([modules.shell(), modules.routes()]);
    runtime = createRuntimeRoot(window.document);
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
    tree.install(window.document);
    router = createFilesystemRouter(window, runtime, host, table, configuration);
    await router.navigate(window.location.href, { history: "replace" });
    router.installHistoryNavigation();
    router.listenToLinks();
    const mountedRuntime = runtime;
    const mountedRouter = router;
    return {
      dispose(reason) {
        try {
          mountedRouter.dispose(reason);
        } finally {
          mountedRuntime.owner.dispose(reason);
        }
      },
      settled: () => mountedRuntime.context.scheduler.settled(),
    };
  } catch (error) {
    try {
      router?.dispose(error);
    } finally {
      runtime?.owner.dispose(error);
    }
    throw error;
  } finally {
    history.release();
  }
}
