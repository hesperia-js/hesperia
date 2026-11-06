import {
  createHost,
  type CapturedBrowserBuild,
  type CapturedBuild,
  type CapturedPublicBuild,
  type HostSelection,
} from "@hesperia/hosting";
import { prepareBuild, type ProjectConfiguration } from "@hesperia/tooling";

declare const build: Awaited<ReturnType<typeof prepareBuild>>;

const files = new Map(
  build.hosting.assets.map((asset) => [asset.path, build.files.get(asset.path)!] as const),
);
let captured: CapturedBuild;

if ("publicFiles" in build) {
  const publicCapture: CapturedPublicBuild = {
    hosting: build.hosting,
    files,
    publicFiles: build.publicFiles,
  };
  captured = publicCapture;
} else {
  const browserCapture: CapturedBrowserBuild = { hosting: build.hosting, files };
  captured = browserCapture;
}

const selection: HostSelection = { mountURL: "/dashboard" };

const configuration: ProjectConfiguration = {
  allowUnsafeHTML: false,
  mountURL: "/",
  resolutionOverrides: { browser: {} },
};

void [createHost(captured, selection), configuration];
