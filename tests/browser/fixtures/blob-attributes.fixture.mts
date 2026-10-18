import { Router } from "hesperia/routing";
import type { Component } from "hesperia";
import { defineComponent, element, mount } from "hesperia/runtime";
import { createRuntimeRoot } from "../../../packages/hesperia/dist/runtime/dom.js";
import {
  createRouteHost,
  type RouteHostModule,
} from "../../../packages/hesperia/dist/routing/route-host.js";
import {
  AwayPage,
  BlobAttributes,
  getBlobAttributesControl,
} from "../../../golden/fixtures/blob-attributes/BlobAttributes.tsx";

declare global {
  interface Window {
    blobAttributesBrowserFixture: {
      goAway(): Promise<string>;

      replaceSources(): void;

      restorePrevious(): Promise<string>;

      dispose(): Promise<{ created: string[]; revoked: string[] }>;

      snapshot(): { created: string[]; revoked: string[] };

      detachedDocumentProbe(): {
        missingView: boolean;
        faults: { name: string; kind: string | undefined }[];
        imageRendered: boolean;
        impostorSource: string | null;
        impostorGetterCalls: number;
        createdURLs: number;
      };
    };
  }
}

const target = document.getElementById("app");

if (!target) throw new Error("Browser fixture host is missing");

const created: string[] = [];
const revoked: string[] = [];
const createObjectURL = window.URL.createObjectURL.bind(window.URL);
const revokeObjectURL = window.URL.revokeObjectURL.bind(window.URL);
window.URL.createObjectURL = (blob) => {
  const url = createObjectURL(blob);

  created.push(url);

  return url;
};
window.URL.revokeObjectURL = (url) => {
  revoked.push(url);

  revokeObjectURL(url);
};

const runtime = createRuntimeRoot(target, { onError: (error) => console.error(error) });
const host = createRouteHost(runtime, target);

runtime.owner.commit();

const blobModule: RouteHostModule = {
  node: {},
  definition: BlobAttributes as Component<unknown>,
};
const awayModule: RouteHostModule = {
  node: {},
  definition: AwayPage as Component<unknown>,
};
const router = new Router({
  window,
  pageCacheSize: 2,

  resolve(url) {
    const page = url.pathname === "/away" ? awayModule : blobModule;
    return {
      params: {},
      departingOwners: host.departingOwners([]),

      prepare(inputs) {
        return host.prepare({ layouts: [], page, inputs });
      },
    };
  },
});

function snapshot(): { created: string[]; revoked: string[] } {
  return { created: created.slice(), revoked: revoked.slice() };
}

function detachedDocumentProbe() {
  const detached = document.implementation.createHTMLDocument("detached");
  const missingView = detached.defaultView === null;
  const faults: unknown[] = [];
  const createdBefore = created.length;
  const BlobApp = defineComponent((owner) => element(owner, "img", { src: new Blob(["image"]) }));
  const blobApp = mount(detached.body, BlobApp, {}, { onError: (error) => faults.push(error) });

  let impostorGetterCalls = 0;

  class BlobImpostor {
    get size() {
      impostorGetterCalls += 1;
      return 5;
    }
  }

  const ImpostorApp = defineComponent((owner) =>
    element(owner, "div", { src: new BlobImpostor() }),
  );
  const impostorApp = mount(
    detached.body,
    ImpostorApp,
    {},
    {
      onError: (error) => faults.push(error),
    },
  );
  const result = {
    missingView,
    faults: faults.map((error) => ({
      name: error instanceof Error ? error.name : String(error),
      kind: (error as { kind?: string }).kind,
    })),
    imageRendered: detached.querySelector("img") !== null,
    impostorSource: detached.querySelector("div")?.getAttribute("src") ?? null,
    impostorGetterCalls,
    createdURLs: created.length - createdBefore,
  };

  impostorApp.dispose();

  blobApp.dispose();

  return result;
}

async function goAway(): Promise<string> {
  const result = await router.navigate("/away", { history: "push" });

  await runtime.context.scheduler.settled();

  return result.status;
}

async function restorePrevious(): Promise<string> {
  const popped = new Promise<void>((resolve) => {
    window.addEventListener("popstate", () => resolve(), { once: true });
  });

  window.history.back();

  await popped;
  const result = await router.navigate(window.location.href, { history: "none" });

  await runtime.context.scheduler.settled();

  return result.status;
}

async function dispose(): Promise<{ created: string[]; revoked: string[] }> {
  router.dispose();

  host.dispose();

  runtime.owner.dispose();

  await runtime.context.scheduler.settled();

  return snapshot();
}

const initial = await router.navigate("/blob-attributes-cache", { history: "replace" });

if (initial.status !== "committed") throw new Error("Blob cache route did not commit");

await runtime.context.scheduler.settled();

Object.assign(window, {
  blobAttributesBrowserFixture: {
    goAway,

    replaceSources() {
      getBlobAttributesControl().replaceSources();
    },

    restorePrevious,
    dispose,
    snapshot,
    detachedDocumentProbe,
  },
});

document.documentElement.dataset.ready = "true";
