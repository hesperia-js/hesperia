import { readConfiguration } from "./configuration.ts";
import { checkProjectLocal, prepareBuildLocal, preparePluginEditorWire } from "./project.ts";

type Request =
  | { readonly kind: "check" }
  | { readonly kind: "build"; readonly development: boolean }
  | { readonly kind: "editor"; readonly sources: readonly (readonly [string, string])[] };

const PREFIX = "\nHESPERIA_PROJECT_WORKER:";
let response: unknown;
let status = 0;

try {
  const request = JSON.parse(await Bun.stdin.text()) as Request;
  const root = process.cwd();

  if (request.kind === "check") {
    const diagnostics = await checkProjectLocal(root);
    response = { ok: true, value: diagnostics };
  } else if (request.kind === "build") {
    const build = await prepareBuildLocal(root, request.development);
    const files = await Promise.all(
      [...build.files].map(
        async ([path, blob]) =>
          [path, blob.type, Buffer.from(await blob.arrayBuffer()).toString("base64")] as const,
      ),
    );
    response = {
      ok: true,
      value: {
        files,
        hosting: build.hosting,
        sources: build.sources,
        diagnostics: build.diagnostics,
        styles: build.styles,
        ...(build.styleRevision ? { styleRevision: build.styleRevision } : {}),
        ...(build.developmentDependencies
          ? { developmentDependencies: build.developmentDependencies }
          : {}),
        watch: build.watch,
      },
    };
  } else if (request.kind === "editor") {
    const configuration = await readConfiguration(root);
    const sources = new Map(request.sources);
    const wire = await preparePluginEditorWire(sources, root, configuration);
    response = { ok: true, value: wire };
  } else throw new TypeError("Unknown project worker request");
} catch (error) {
  const value = error instanceof Error ? error : new Error(String(error));
  const diagnostics = (value as Error & { diagnostics?: unknown }).diagnostics;
  response = {
    ok: false,
    error: {
      name: value.name,
      message: value.message,
      ...(Array.isArray(diagnostics) ? { diagnostics } : {}),
    },
  };
  status = 1;
}

await new Promise<void>((done, fail) => {
  process.stdout.once("error", fail);

  process.stdout.end(`${PREFIX}${JSON.stringify(response)}\n`, done);
});

process.exit(status);
