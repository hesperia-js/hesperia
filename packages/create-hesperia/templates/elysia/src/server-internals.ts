import { resolve } from "node:path";
import { createHost, readBuild, type ApplicationHost } from "@hesperia/hosting";

let browserHost: ApplicationHost | undefined;

export function handleHesperiaRequest(request: Request): Response | undefined {
  return browserHost?.handle(request);
}

export async function initializeHesperiaHost(root = process.cwd()): Promise<void> {
  browserHost = await createHost(await readBuild(resolve(root, ".hesperia/build")));
}
