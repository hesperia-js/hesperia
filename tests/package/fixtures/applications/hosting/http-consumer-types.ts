import { createHost, type CapturedBrowserBuild, type HostSelection } from "@hesperia/hosting";
import { prepareBuild, type ProjectConfiguration } from "@hesperia/tooling";

declare const build: Awaited<ReturnType<typeof prepareBuild>>;

const captured: CapturedBrowserBuild = {
  hosting: build.hosting,
  files: new Map(
    build.hosting.assets.map((asset) => [asset.path, build.files.get(asset.path)!] as const),
  ),
};

const selection: HostSelection = { mountURL: "/dashboard" };

const configuration: ProjectConfiguration = {
  allowUnsafeHTML: false,
  mountURL: "/",
  resolutionOverrides: { browser: {} },
};

void [createHost(captured, selection), configuration];
