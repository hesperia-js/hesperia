import { expect, spyOn, test } from "bun:test";
import * as filesystem from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import {
  createTargetedHost,
  readBuild,
  readServerBuild,
  readTargetedBuild,
  type ProductionTargetV1,
} from "../../packages/hosting/src/index.ts";
import {
  readCompletedBuildDirectory,
  readDevelopmentBuildRecord,
  readManagedBuildRecord,
  resolveProductionTarget,
  snapshotTargetedControl,
} from "../../packages/hosting/src/internal/index.ts";
import { readRetainedManagedBuild } from "../../packages/hosting/src/read-build.ts";

async function fixture() {
  const output = await filesystem.mkdtemp(join(tmpdir(), "hesperia-read-build-"));

  const write = async (revision: string, mode = "production") => {
    const directory = `.captures/${revision === "old" ? "11111111-1111-1111-1111-111111111111" : "22222222-2222-2222-2222-222222222222"}/assets`;
    const assets = ["/assets/@team/main+a.js", "/assets/lazy.js"].map((path) => ({
      path,
      sha256: new Bun.CryptoHasher("sha256").update(revision).digest("hex"),
      contentType: "text/javascript",
    }));

    await filesystem.mkdir(join(output, directory, "@team"), { recursive: true });

    for (const asset of assets)
      await filesystem.writeFile(
        join(output, directory, asset.path.slice("/assets/".length)),
        revision,
      );

    await filesystem.writeFile(
      join(output, "hesperia-build.json"),
      JSON.stringify({
        hosting: {
          version: 1,
          mode,
          standaloneMountURL: "/@team",
          startupAsset: assets[0]!.path,
          assets,
        },
        assetDirectory: directory,
      }),
    );

    return join(output, directory);
  };

  return { output, write };
}

async function writePublicBuild(
  output: string,
  content: string | Uint8Array = "captured public bytes",
  mode: "development" | "production" = "production",
) {
  const captureId = "33333333-3333-3333-3333-333333333333";
  const assetDirectory = `.captures/${captureId}/assets`;
  const publicDirectory = `.captures/${captureId}/public`;
  const assetPath = "/assets/@team/main.js";
  const assetBytes = "export function start() {}";
  const relativePath = "pages/café #%.txt";
  const urlPath = "/pages/caf%C3%A9%20%23%25.txt";
  const publicFilePath = join(output, publicDirectory, relativePath);
  const assets = [
    {
      path: assetPath,
      sha256: new Bun.CryptoHasher("sha256").update(assetBytes).digest("hex"),
      contentType: "text/javascript",
    },
  ];
  const publicFiles = [
    {
      relativePath,
      urlPath,
      sha256: new Bun.CryptoHasher("sha256").update(content).digest("hex"),
      contentType: "text/plain; charset=utf-8",
    },
  ];

  await filesystem.mkdir(join(output, assetDirectory, "@team"), { recursive: true });
  await filesystem.mkdir(join(output, publicDirectory, "pages"), { recursive: true });
  await filesystem.writeFile(join(output, assetDirectory, "@team", "main.js"), assetBytes);
  await filesystem.writeFile(publicFilePath, content);
  await filesystem.writeFile(
    join(output, "hesperia-build.json"),
    JSON.stringify({
      version: 1,
      hosting: {
        version: 2,
        mode,
        standaloneMountURL: "/@team",
        startupAsset: assetPath,
        assets,
        publicFiles,
      },
      assetDirectory,
      publicDirectory,
    }),
  );

  return { assetDirectory, publicDirectory, publicFilePath, relativePath, urlPath };
}

test("readBuild validates a copied deployment without an application source tree", async () => {
  const { output, write } = await fixture();

  try {
    const assets = await write("old");
    const captured = await readBuild(output);

    await expect(readTargetedBuild(output)).rejects.toThrow("outer version 3 targeted capture");

    expect("control" in (await readCompletedBuildDirectory(output))).toBe(false);

    expect(captured.hosting.standaloneMountURL).toBe("/@team");

    expect(await captured.files.get("/assets/@team/main+a.js")!.text()).toBe("old");

    await filesystem.writeFile(join(assets, "lazy.js"), "modified");

    await expect(readBuild(output)).rejects.toThrow("digest mismatch");

    await filesystem.rm(join(assets, "lazy.js"));

    await expect(readBuild(output)).rejects.toThrow("asset is missing");

    await write("new", "development");

    await expect(readBuild(output)).rejects.toThrow(
      "Cannot serve a development build as production",
    );
  } finally {
    await filesystem.rm(output, { recursive: true, force: true });
  }
});

test.each([1, 2] as const)(
  "supplied development hosting V%s retains its legacy mode and bytes without a current pointer",
  async (version) => {
    const { output, write } = await fixture();
    const publicBytes = new Uint8Array([0, 255, 128, 13, 10]);

    try {
      const publicBuild =
        version === 2 ? await writePublicBuild(output, publicBytes, "development") : undefined;

      if (version === 1) await write("development bytes", "development");

      const recordPath = join(output, "hesperia-build.json");
      const legacy = JSON.parse(await filesystem.readFile(recordPath, "utf8"));
      const record = {
        ...legacy,
        target: "browser",
        resolution: {
          mode: "development",
          activeConditions: ["browser", "development"],
          overrides: { "fixture-lib": "./src/replacement.ts" },
          runtimeKeyRegistry: {
            source: "registry.ts",
            revision: "fixture",
            digest: digest("registry"),
          },
          capturedSources: [{ filename: "src/app.tsx", digest: "sha256-" + digest("source") }],
          capturedManifests: [],
          edges: [],
          generatedSources: [],
        },
        checkingInputs: [],
        configuration: {
          mountURL: "/@team",
          resolutionOverrides: { browser: { "fixture-lib": "./src/replacement.ts" } },
        },
        modules: [],
        routeGuards: {},
        routeTable: legacy.hosting.startupAsset,
      };
      const source = JSON.stringify(record, null, 2) + "\n";

      await filesystem.writeFile(recordPath, source);

      await expect(readBuild(output)).rejects.toThrow(
        "Cannot serve a development build as production",
      );
      await expect(readCompletedBuildDirectory(output)).rejects.toThrow(
        "Cannot serve a development build as production",
      );
      await filesystem.rm(recordPath);

      const captured = await readDevelopmentBuildRecord(output, source);
      const startup = captured.files.get(record.hosting.startupAsset)!;
      const originalStartup = new Uint8Array(await startup.arrayBuffer());
      const startupPath = join(
        output,
        record.assetDirectory,
        record.hosting.startupAsset.slice("/assets/".length),
      );

      expect(captured.hosting).toStrictEqual(record.hosting);
      expect(captured.hosting.mode).toBe("development");
      expect(await startup.text()).toBe(
        version === 1 ? "development bytes" : "export function start() {}",
      );

      await filesystem.writeFile(startupPath, "changed managed bytes");

      await expect(readDevelopmentBuildRecord(output, source)).rejects.toThrow(
        "asset digest mismatch",
      );
      expect(new Uint8Array(await startup.arrayBuffer())).toEqual(originalStartup);

      if (publicBuild) {
        if (!("publicFiles" in captured)) throw new Error("Expected development public bytes");

        const publicFile = captured.publicFiles.get(publicBuild.urlPath)!;

        expect(new Uint8Array(await publicFile.arrayBuffer())).toEqual(publicBytes);
        expect(publicFile.type).toBe("text/plain; charset=utf-8");

        await filesystem.writeFile(startupPath, originalStartup);
        await filesystem.writeFile(publicBuild.publicFilePath, "changed public bytes");

        await expect(readDevelopmentBuildRecord(output, source)).rejects.toThrow(
          "public file digest mismatch",
        );
        expect(new Uint8Array(await publicFile.arrayBuffer())).toEqual(publicBytes);
      } else expect("publicFiles" in captured).toBe(false);
    } finally {
      await filesystem.rm(output, { recursive: true, force: true });
    }
  },
);

test("supplied development records reject other branches and unsafe capture metadata", async () => {
  const output = await filesystem.mkdtemp(join(tmpdir(), "hesperia-development-record-"));

  try {
    await writePublicBuild(output, "development public bytes", "development");

    const recordPath = join(output, "hesperia-build.json");
    const record = JSON.parse(await filesystem.readFile(recordPath, "utf8"));
    const malformed = [
      {
        record: { ...record, hosting: { ...record.hosting, mode: "production" } },
        message: "Cannot read a production build as development",
      },
      { record: { ...record, version: 2 }, message: "outer version 1" },
      { record: { ...record, version: 3 }, message: "outer version 1" },
      { record: { ...record, kind: "browser" }, message: "without targeted fields" },
      { record: { ...record, productionTarget: {} }, message: "without targeted fields" },
      {
        record: { ...record, hosting: { ...record.hosting, version: 3 } },
        message: "unsupported hosting record version",
      },
      {
        record: {
          ...record,
          publicDirectory: ".captures/44444444-4444-4444-4444-444444444444/public",
        },
        message: "share the asset capture",
      },
      {
        record: { ...record, assetDirectory: "../outside/assets" },
        message: "share the asset capture",
      },
      {
        record: {
          ...record,
          hosting: {
            ...record.hosting,
            assets: [{ ...record.hosting.assets[0], path: "/assets/../outside.js" }],
          },
        },
        message: "asset path is not a safe canonical path",
      },
      {
        record: {
          ...record,
          hosting: {
            ...record.hosting,
            publicFiles: [{ ...record.hosting.publicFiles[0], urlPath: "/different.txt" }],
          },
        },
        message: "URL path does not match its storage path",
      },
    ];

    await filesystem.rm(recordPath);

    for (const item of malformed)
      await expect(readDevelopmentBuildRecord(output, JSON.stringify(item.record))).rejects.toThrow(
        item.message,
      );
  } finally {
    await filesystem.rm(output, { recursive: true, force: true });
  }
});

test("supplied development records require a real build root", async () => {
  const root = await filesystem.mkdtemp(join(tmpdir(), "hesperia-development-root-"));
  const output = join(root, "build");
  const linked = join(root, "linked");
  let linkedCreated = false;

  try {
    await writePublicBuild(output, "development public bytes", "development");

    const source = await filesystem.readFile(join(output, "hesperia-build.json"), "utf8");

    await filesystem.symlink(output, linked, process.platform === "win32" ? "junction" : "dir");

    linkedCreated = true;

    await expect(readDevelopmentBuildRecord(linked, source)).rejects.toThrow("real directory");
  } finally {
    if (linkedCreated) await filesystem.unlink(linked);

    await filesystem.rm(root, { recursive: true, force: true });
  }
});

const declarations = [
  { version: 1, runtime: "browser", profile: "static" },
  { version: 1, runtime: "node", profile: "fetch" },
  { version: 1, runtime: "workerd", profile: "module-worker" },
  { version: 1, runtime: "bun", profile: "elysia" },
  { version: 1, runtime: "bun", profile: "hono" },
] as const satisfies readonly ProductionTargetV1[];

const declarationCases: ProductionTargetV1[] = [...declarations];

async function targetedFixture(
  output: string,
  declaration: ProductionTargetV1 = declarations[0],
  publicMode: "absent" | "empty" | "binary" = "absent",
  revision = "old",
  server = false,
) {
  const captureId =
    revision === "old"
      ? "55555555-5555-5555-5555-555555555555"
      : "66666666-6666-6666-6666-666666666666";
  const assetDirectory = `.captures/${captureId}/assets`;
  const publicDirectory = `.captures/${captureId}/public`;
  const serverDirectory = `.captures/${captureId}/server`;
  const startup = `globalThis.q2ReaderEntryEvaluated = true; throw new Error("must not evaluate ${revision}");`;
  const binary = new Uint8Array([0, 255, 13, 10, 128, revision.length]);
  const assetsRoot = join(output, assetDirectory);
  const assets = [
    { path: "/assets/startup.mjs", sha256: digest(startup), contentType: "text/javascript" },
    { path: "/assets/data.bin", sha256: digest(binary), contentType: "application/octet-stream" },
  ];
  const publicFiles =
    publicMode === "binary"
      ? [
          {
            relativePath: "raw/café #%.bin",
            urlPath: "/raw/caf%C3%A9%20%23%25.bin",
            sha256: digest(binary),
            contentType: "application/octet-stream",
          },
        ]
      : [];
  const base = {
    mode: "production" as const,
    standaloneMountURL: "/dashboard",
    startupAsset: assets[0]!.path,
    assets,
  };
  const hosting = server
    ? {
        version: 3 as const,
        ...base,
        publicFiles,
        serverPages: [
          {
            version: 1,
            routeId: "home",
            buildIdentity: `retained-${revision}`,
            format: "document",
            serverEntry: { path: "entry.mjs", exportName: "entry" },
            projection: {
              producer: "ssr",
              activation: "none",
              delivery: "complete",
              hydrationMismatch: "fatal",
            },
          },
        ],
        serverArtifacts: [{ path: "entry.mjs", sha256: digest(startup) }],
      }
    : publicMode === "absent"
      ? { version: 1 as const, ...base }
      : { version: 2 as const, ...base, publicFiles };
  const control = server
    ? snapshotTargetedControl({
        version: 3,
        kind: "server",
        productionTarget: resolveProductionTarget(declaration).binding,
        hosting,
      })
    : snapshotTargetedControl({
        version: 3,
        kind: "browser",
        productionTarget: resolveProductionTarget(declaration).binding,
        hosting,
        target: "browser",
        resolution: {
          mode: "production",
          activeConditions: ["browser", "production"],
          overrides: { browser: {} },
          runtimeKeyRegistry: {
            source: "fixture-registry.ts",
            revision: "fixture",
            digest: digest("fixture"),
          },
          capturedSources: [
            { filename: "C:/external/fixture.ts", digest: "sha256-" + digest(startup) },
          ],
          capturedManifests: [],
          edges: [],
          generatedSources: [
            {
              filename: "generated/startup.js",
              semantic: "startup",
              semanticHash: digest(startup),
            },
          ],
        },
        checkingInputs: [],
        configuration: { target: declaration, plugins: ["fixture"] },
        modules: [{ filename: "app.tsx", digest: "sha256-" + digest(startup) }],
        routeGuards: {},
        routeTable: "/assets/startup.mjs",
      });
  const record: Record<string, unknown> = {
    ...control,
    assetDirectory,
    ...(publicMode !== "absent" ? { publicDirectory } : {}),
    ...(server ? { serverDirectory } : {}),
  };

  await filesystem.mkdir(assetsRoot, { recursive: true });
  await filesystem.writeFile(join(assetsRoot, "startup.mjs"), startup);
  await filesystem.writeFile(join(assetsRoot, "data.bin"), binary);

  if (publicMode !== "absent")
    await filesystem.mkdir(join(output, publicDirectory, "raw"), { recursive: true });

  if (publicMode === "binary")
    await filesystem.writeFile(join(output, publicDirectory, "raw/café #%.bin"), binary);

  if (server) {
    await filesystem.mkdir(join(output, serverDirectory), { recursive: true });
    await filesystem.writeFile(join(output, serverDirectory, "entry.mjs"), startup);
  }

  const recordPath = join(output, "hesperia-build.json");
  const source = JSON.stringify(record, null, 2) + "\n";

  await filesystem.writeFile(recordPath, source);

  return {
    control,
    record,
    source,
    recordPath,
    assetsRoot,
    publicDirectory,
    serverDirectory,
    startup,
    binary,
    captureId,
  };
}

function digest(value: string | Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

async function writeTargetedRouting(
  written: Awaited<ReturnType<typeof targetedFixture>>,
  policy: unknown,
): Promise<void> {
  const routing = JSON.stringify(policy, null, 2) + "\n";
  const record = JSON.parse(written.source);

  record.hosting.assets.push({
    path: "/assets/static-routing.json",
    sha256: digest(routing),
    contentType: "application/json",
  });

  await filesystem.writeFile(join(written.assetsRoot, "static-routing.json"), routing);
  await filesystem.writeFile(written.recordPath, JSON.stringify(record, null, 2) + "\n");
}

function browserRouting(publicFiles: string[] = []) {
  return {
    version: 1,
    kind: "browser-static-routing",
    mountURL: "/dashboard",
    pages: [{ id: "", pattern: "/", segments: [] }],
    publicFiles,
    outcomes: { page: 200, missingPage: 404, missingManaged: 404 },
  };
}

test("a targeted browser capture serves its recorded route and drains on close", async () => {
  const root = await filesystem.mkdtemp(join(tmpdir(), "hesperia-targeted-host-"));

  try {
    const written = await targetedFixture(root, declarations[0], "binary");
    await writeTargetedRouting(written, browserRouting(["/raw/caf%C3%A9%20%23%25.bin"]));

    const resource = await createTargetedHost(await readTargetedBuild(root));

    if (resource.kind !== "browser") throw new Error("Expected the browser host");

    const publicResponse = resource.host.handle(
      new Request("http://localhost/dashboard/raw/caf%C3%A9%20%23%25.bin"),
    );

    expect(publicResponse?.status).toBe(200);
    expect(new Uint8Array(await publicResponse!.arrayBuffer())).toEqual(written.binary);

    const missing = resource.host.handle(
      new Request("http://localhost/dashboard/missing", { headers: { accept: "text/html" } }),
    );

    expect(missing?.status).toBe(404);
    await missing!.body!.cancel();
    expect(resource.host.handle(new Request("http://localhost/outside"))).toBeUndefined();
    expect(
      resource.host.handle(new Request("http://localhost/dashboard", { method: "POST" })),
    ).toBeUndefined();

    const missingAsset = resource.host.handle(
      new Request("http://localhost/dashboard/_hesperia/assets/missing.js"),
    );

    expect(missingAsset?.status).toBe(404);

    const response = resource.host.handle(
      new Request("http://localhost/dashboard", { headers: { accept: "text/html" } }),
    );

    expect(response?.status).toBe(200);
    expect(response?.body).not.toBeNull();

    let closed = false;
    const closing = resource.close().then(() => {
      closed = true;
    });

    expect(() => resource.host.handle(new Request("http://localhost/dashboard"))).toThrow("closed");

    await Promise.resolve();
    expect(closed).toBe(false);
    await response!.body!.cancel();
    await closing;
    expect(closed).toBe(true);
  } finally {
    await filesystem.rm(root, { recursive: true, force: true });
  }
});

test.each([
  { policy: { ...browserRouting(), mountURL: "/other" }, error: "mount does not match" },
  { policy: { ...browserRouting(), mountURL: "/dashboard/" }, error: "must already be canonical" },
  {
    policy: { ...browserRouting(), publicFiles: ["/unexpected"] },
    error: "public URLs do not match",
  },
  {
    policy: { ...browserRouting(), publicFiles: ["/same", "/same"] },
    error: "routing public URLs must be unique",
  },
  { policy: { ...browserRouting(), pages: [] }, error: "requires at least one captured page" },
  {
    policy: { ...browserRouting(), pages: [browserRouting().pages[0], browserRouting().pages[0]] },
    error: "routing page identities must be unique",
  },
  {
    policy: {
      ...browserRouting(),
      pages: [{ id: "broken", pattern: "/broken", segments: [{ kind: "unknown", value: "x" }] }],
    },
    error: "unsupported routing segment kind",
  },
  {
    policy: { ...browserRouting(), outcomes: { page: 201, missingPage: 404, missingManaged: 404 } },
    error: "unsupported browser/static HTTP outcomes",
  },
  { policy: { ...browserRouting(), extra: true }, error: "unexpected or missing fields" },
])("targeted host rejects a mismatched or malformed routing capture", async ({ policy, error }) => {
  const root = await filesystem.mkdtemp(join(tmpdir(), "hesperia-targeted-invalid-"));

  try {
    const written = await targetedFixture(root);
    await writeTargetedRouting(written, policy);
    await expect(createTargetedHost(await readTargetedBuild(root))).rejects.toThrow(error);
  } finally {
    await filesystem.rm(root, { recursive: true, force: true });
  }
});

test("targeted host refuses a capture without its routing policy", async () => {
  const root = await filesystem.mkdtemp(join(tmpdir(), "hesperia-targeted-no-routing-"));

  try {
    await targetedFixture(root);
    await expect(createTargetedHost(await readTargetedBuild(root))).rejects.toThrow(
      "missing its static routing asset",
    );
  } finally {
    await filesystem.rm(root, { recursive: true, force: true });
  }
});

test.each([declarations[1], declarations[3], declarations[4]])(
  "targeted host refuses the unavailable $runtime/$profile server profile",
  async (declaration) => {
    const root = await filesystem.mkdtemp(join(tmpdir(), "hesperia-targeted-unavailable-"));

    try {
      await targetedFixture(root, declaration, "empty", "old", true);
      await expect(createTargetedHost(await readTargetedBuild(root))).rejects.toThrow(
        "production-target-unavailable",
      );
    } finally {
      await filesystem.rm(root, { recursive: true, force: true });
    }
  },
);

function hasProductionMode<Hosting extends { readonly mode: "development" | "production" }>(
  hosting: Hosting,
): hosting is Hosting & { readonly mode: "production" } {
  return hosting.mode === "production";
}

test.each(declarationCases)(
  "completed V3 reading retains unavailable $runtime/$profile declarations",
  async (declaration) => {
    const root = await filesystem.mkdtemp(join(tmpdir(), "hesperia-targeted-read-"));
    const original = join(root, "original");
    const relocated = join(root, "relocated");
    const publicMode =
      declaration.runtime === "browser"
        ? "absent"
        : declaration.runtime === "node"
          ? "empty"
          : "binary";

    try {
      const written = await targetedFixture(original, declaration, publicMode);

      await filesystem.rename(original, relocated);

      const captured =
        declaration.runtime === "workerd"
          ? await readCompletedBuildDirectory(relocated)
          : await readTargetedBuild(relocated);

      if (!("control" in captured)) throw new Error("Expected the targeted wrapper");

      expect(captured.control.productionTarget.declaration).toStrictEqual(declaration);

      if (!hasProductionMode(captured.inventory.hosting))
        throw new Error("Expected production hosting inventory");

      expect(captured.control.hosting).toBe(captured.inventory.hosting);
      expect(Object.isFrozen(captured.control)).toBe(true);
      expect(await captured.inventory.files.get("/assets/startup.mjs")!.text()).toBe(
        written.startup,
      );
      expect(
        new Uint8Array(await captured.inventory.files.get("/assets/data.bin")!.arrayBuffer()),
      ).toEqual(written.binary);
      expect("set" in captured.inventory.files).toBe(false);
      expect(Object.hasOwn(globalThis, "q2ReaderEntryEvaluated")).toBe(false);

      if (captured.control.kind !== "browser")
        throw new Error("Expected retained browser provenance");

      expect(captured.control.resolution.capturedSources[0]!.filename).toBe(
        "C:/external/fixture.ts",
      );
      expect(captured.control.resolution.generatedSources[0]).not.toHaveProperty("digest");

      if (declaration.runtime === "workerd")
        await expect(readTargetedBuild(relocated)).rejects.toThrow("workerd captures");

      if (publicMode === "absent") expect("publicFiles" in captured.inventory).toBe(false);
      else {
        if (!("publicFiles" in captured.inventory))
          throw new Error("Expected the actual public map");

        expect(captured.inventory.publicFiles.size).toBe(publicMode === "empty" ? 0 : 1);

        if (publicMode === "binary")
          expect(
            new Uint8Array(
              await captured.inventory.publicFiles
                .get("/raw/caf%C3%A9%20%23%25.bin")!
                .arrayBuffer(),
            ),
          ).toEqual(written.binary);
      }

      await expect(readBuild(relocated)).rejects.toThrow("outer version 1");
    } finally {
      await filesystem.rm(root, { recursive: true, force: true });
    }
  },
);

test("readTargetedBuild rejects a server capture admitted by readServerBuild", async () => {
  const output = await filesystem.mkdtemp(join(tmpdir(), "hesperia-targeted-read-server-v2-"));

  try {
    const written = await targetedFixture(output, declarations[1], "empty", "old", true);
    const targeted = await readTargetedBuild(output);

    if (targeted.control.kind !== "server" || !("serverFiles" in targeted.inventory))
      throw new Error("Expected the targeted server wrapper");

    expect(Object.is(targeted.control.hosting, targeted.inventory.hosting)).toBe(true);
    expect(await targeted.inventory.serverFiles.get("entry.mjs")!.text()).toBe(written.startup);

    const serverRecord = {
      version: 2,
      hosting: written.record.hosting,
      assetDirectory: written.record.assetDirectory,
      publicDirectory: written.record.publicDirectory,
      serverDirectory: written.record.serverDirectory,
    };

    await filesystem.writeFile(written.recordPath, JSON.stringify(serverRecord));

    const captured = await readServerBuild(output);

    expect(captured.hosting.version).toBe(3);
    expect(await captured.serverFiles.get("entry.mjs")!.text()).toBe(written.startup);
    await expect(readTargetedBuild(output)).rejects.toThrow("outer version 3 targeted capture");
  } finally {
    await filesystem.rm(output, { recursive: true, force: true });
  }
});

test.each([1, 2, 3] as const)(
  "supplied hosting V%s record reads managed bytes before any archive exists",
  async (version) => {
    const output = await filesystem.mkdtemp(join(tmpdir(), "hesperia-managed-record-"));

    try {
      const written = await targetedFixture(
        output,
        version === 3 ? declarations[1] : declarations[0],
        version === 1 ? "absent" : "binary",
        "old",
        version === 3,
      );

      await filesystem.rm(written.recordPath);

      if (version !== 1)
        await filesystem.rm(join(output, written.publicDirectory), { recursive: true });

      if (version === 3)
        await filesystem.rm(join(output, written.serverDirectory), { recursive: true });

      const { captureId, inventory } = await readManagedBuildRecord(output, written.source);

      expect(captureId).toBe("55555555-5555-5555-5555-555555555555");
      expect(inventory.hosting.version).toBe(1);
      expect(inventory.hosting.standaloneMountURL).toBe("/dashboard");
      expect([...inventory.files.keys()]).toStrictEqual([
        "/assets/startup.mjs",
        "/assets/data.bin",
      ]);
      expect(new Uint8Array(await inventory.files.get("/assets/data.bin")!.arrayBuffer())).toEqual(
        written.binary,
      );
      expect("control" in inventory).toBe(false);
      expect("publicFiles" in inventory).toBe(false);
      expect("serverFiles" in inventory).toBe(false);
      expect(Object.hasOwn(globalThis, "q2ReaderEntryEvaluated")).toBe(false);

      await filesystem.writeFile(join(written.assetsRoot, "data.bin"), "changed managed bytes");

      await expect(readManagedBuildRecord(output, written.source)).rejects.toThrow(
        "digest mismatch",
      );
      expect(new Uint8Array(await inventory.files.get("/assets/data.bin")!.arrayBuffer())).toEqual(
        written.binary,
      );
    } finally {
      await filesystem.rm(output, { recursive: true, force: true });
    }
  },
);

test("supplied managed records require a canonical capture ID before reading assets", async () => {
  const output = await filesystem.mkdtemp(join(tmpdir(), "hesperia-managed-record-id-"));

  try {
    const written = await targetedFixture(output);
    const record = { ...written.record, assetDirectory: `.captures/${"a".repeat(36)}/assets` };

    await expect(
      readManagedBuildRecord(output, JSON.stringify(record, null, 2) + "\n"),
    ).rejects.toThrow("canonical UUID");
  } finally {
    await filesystem.rm(output, { recursive: true, force: true });
  }
});

test.each([1, 2, 3] as const)(
  "retained hosting V%s reads only its archived managed bytes after publication and relocation",
  async (version) => {
    const root = await filesystem.mkdtemp(join(tmpdir(), "hesperia-retained-managed-"));
    const output = join(root, "build");
    const relocated = join(root, "relocated");

    try {
      const old = await targetedFixture(
        output,
        version === 3 ? declarations[1] : declarations[0],
        version === 1 ? "absent" : "binary",
        "old",
        version === 3,
      );

      await readCompletedBuildDirectory(output);
      await filesystem.copyFile(
        old.recordPath,
        join(output, ".captures", old.captureId, "hesperia-build.json"),
      );
      await targetedFixture(output, declarations[0], "absent", "new");

      if (version !== 1)
        await filesystem.rm(join(output, old.publicDirectory), { recursive: true });

      if (version === 3)
        await filesystem.rm(join(output, old.serverDirectory), { recursive: true });

      await filesystem.rename(output, relocated);
      await filesystem.writeFile(join(relocated, "hesperia-build.json"), "invalid current pointer");

      const retained = await readRetainedManagedBuild(relocated, old.captureId);

      expect(retained.hosting.version).toBe(1);
      expect(retained.hosting.standaloneMountURL).toBe("/dashboard");
      expect([...retained.files.keys()]).toStrictEqual(["/assets/startup.mjs", "/assets/data.bin"]);
      expect(await retained.files.get("/assets/startup.mjs")!.text()).toBe(old.startup);
      expect(retained.files.get("/assets/data.bin")!.type).toBe("application/octet-stream");
      expect(new Uint8Array(await retained.files.get("/assets/data.bin")!.arrayBuffer())).toEqual(
        old.binary,
      );
      expect("control" in retained).toBe(false);
      expect("publicFiles" in retained).toBe(false);
      expect("serverFiles" in retained).toBe(false);
      expect(Object.hasOwn(globalThis, "q2ReaderEntryEvaluated")).toBe(false);
    } finally {
      await filesystem.rm(root, { recursive: true, force: true });
    }
  },
);

test("retained managed reads reject invalid archives and damaged bytes", async () => {
  const output = await filesystem.mkdtemp(join(tmpdir(), "hesperia-retained-invalid-"));

  try {
    const old = await targetedFixture(output);
    const archivePath = join(output, ".captures", old.captureId, "hesperia-build.json");

    await filesystem.copyFile(old.recordPath, archivePath);

    const current = await targetedFixture(output, declarations[0], "absent", "new");

    await filesystem.rm(current.assetsRoot, { recursive: true });

    for (const captureId of ["../outside", "a".repeat(36), "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA"])
      await expect(readRetainedManagedBuild(output, captureId)).rejects.toThrow("canonical UUID");

    const malformed = [
      { record: { ...old.record, version: 1 }, message: "outer version 3" },
      { record: { ...old.record, extra: true }, message: "unexpected fields" },
      {
        record: { ...old.record, assetDirectory: current.record.assetDirectory },
        message: "name its own capture",
      },
      {
        record: {
          ...old.record,
          productionTarget: {
            ...old.control.productionTarget,
            descriptorIdentity: "hesperia.target/node-fetch/1",
          },
        },
        message: "descriptor does not match",
      },
    ];

    for (const { record, message } of malformed) {
      await filesystem.writeFile(archivePath, JSON.stringify(record, null, 2) + "\n");

      await expect(readRetainedManagedBuild(output, old.captureId)).rejects.toThrow(message);
    }

    for (const source of [
      old.source.trimEnd(),
      old.source.replace('"version": 3,', '"version": 3,\n  "version": 3,'),
    ]) {
      await filesystem.writeFile(archivePath, source);

      await expect(readRetainedManagedBuild(output, old.captureId)).rejects.toThrow(
        "canonical JSON",
      );
    }

    await filesystem.writeFile(archivePath, old.source);
    await filesystem.writeFile(join(old.assetsRoot, "data.bin"), "damaged retained bytes");

    await expect(readRetainedManagedBuild(output, old.captureId)).rejects.toThrow(
      "digest mismatch",
    );

    await filesystem.rm(join(old.assetsRoot, "data.bin"));

    await expect(readRetainedManagedBuild(output, old.captureId)).rejects.toThrow(
      "asset is missing",
    );

    await filesystem.rm(archivePath);

    await expect(readRetainedManagedBuild(output, old.captureId)).rejects.toThrow("No completed");

    await filesystem.mkdir(archivePath);

    await expect(readRetainedManagedBuild(output, old.captureId)).rejects.toThrow("regular file");
  } finally {
    await filesystem.rm(output, { recursive: true, force: true });
  }
});

test.each(["capture", "assets"] as const)(
  "retained managed reads reject a linked %s directory",
  async (linkedDirectory) => {
    const root = await filesystem.mkdtemp(join(tmpdir(), "hesperia-retained-link-"));
    const output = join(root, "build");
    const outside = join(root, "outside");
    let linkedPath: string | undefined;

    try {
      const written = await targetedFixture(output);
      const captureRoot = join(output, ".captures", written.captureId);

      await filesystem.copyFile(written.recordPath, join(captureRoot, "hesperia-build.json"));

      const directory = linkedDirectory === "capture" ? captureRoot : written.assetsRoot;

      await filesystem.rename(directory, outside);
      await filesystem.symlink(
        outside,
        directory,
        process.platform === "win32" ? "junction" : "dir",
      );

      linkedPath = directory;

      await expect(readRetainedManagedBuild(output, written.captureId)).rejects.toThrow(
        "real directory",
      );
    } finally {
      if (linkedPath) await filesystem.unlink(linkedPath);

      await filesystem.rm(root, { recursive: true, force: true });
    }
  },
);

test("readTargetedBuild rejects malformed selected records without dropping their target or directories", async () => {
  const root = await filesystem.mkdtemp(join(tmpdir(), "hesperia-targeted-record-"));

  try {
    const written = await targetedFixture(root);
    const malformed = [
      { ...written.record, version: 1 },
      { ...written.record, version: 4 },
      { ...written.record, kind: "unknown" },
      { ...written.record, extra: true },
      { ...written.record, publicDirectory: `.captures/${written.captureId}/public` },
      { ...written.record, serverDirectory: `.captures/${written.captureId}/server` },
      { ...written.record, assetDirectory: "../outside/assets" },
      {
        ...written.record,
        productionTarget: {
          ...written.control.productionTarget,
          descriptorIdentity: "hesperia.target/node-fetch/1",
        },
      },
    ];

    for (const record of malformed) {
      await filesystem.writeFile(written.recordPath, JSON.stringify(record, null, 2) + "\n");

      await expect(readTargetedBuild(root)).rejects.toBeInstanceOf(TypeError);
    }

    for (const source of [
      written.source.trimEnd(),
      written.source.replace('"version": 3,', '"version": 3,\n  "version": 3,'),
    ]) {
      await filesystem.writeFile(written.recordPath, source);

      await expect(readTargetedBuild(root)).rejects.toThrow("canonical JSON");
    }
  } finally {
    await filesystem.rm(root, { recursive: true, force: true });
  }
});

test("readTargetedBuild verifies disk bytes and rejects public directory links", async () => {
  const root = await filesystem.mkdtemp(join(tmpdir(), "hesperia-targeted-bytes-"));
  const output = join(root, "build");
  const outside = join(root, "outside");
  let linkedPath: string | undefined;

  try {
    const written = await targetedFixture(output, declarations[2]!, "binary");

    await filesystem.writeFile(
      written.recordPath,
      JSON.stringify(
        {
          ...written.record,
          publicDirectory: ".captures/99999999-9999-9999-9999-999999999999/public",
        },
        null,
        2,
      ) + "\n",
    );
    await expect(readTargetedBuild(output)).rejects.toThrow("share one capture");
    await filesystem.writeFile(written.recordPath, written.source);

    await filesystem.writeFile(join(written.assetsRoot, "data.bin"), "corrupt");
    await expect(readTargetedBuild(output)).rejects.toThrow("digest mismatch");
    await filesystem.writeFile(join(written.assetsRoot, "data.bin"), written.binary);

    const publicRoot = join(output, written.publicDirectory);
    const publicPath = join(publicRoot, "raw/café #%.bin");

    await filesystem.writeFile(publicPath, "corrupt public bytes");
    await expect(readTargetedBuild(output)).rejects.toThrow("public file digest mismatch");
    await filesystem.writeFile(publicPath, written.binary);
    await filesystem.rename(publicRoot, outside);
    await filesystem.symlink(
      outside,
      publicRoot,
      process.platform === "win32" ? "junction" : "dir",
    );
    linkedPath = publicRoot;

    await expect(readTargetedBuild(output)).rejects.toThrow("real directory");
  } finally {
    if (linkedPath) await filesystem.unlink(linkedPath);

    await filesystem.rm(root, { recursive: true, force: true });
  }
});

test("readTargetedBuild retries publication as one target, control and byte cohort", async () => {
  const output = await filesystem.mkdtemp(join(tmpdir(), "hesperia-targeted-retry-"));
  const old = await targetedFixture(output);
  const next = await targetedFixture(output, declarations[1]!, "empty", "new");

  await filesystem.writeFile(old.recordPath, old.source);

  const original = filesystem.readFile;
  let retired = false;
  const interception = spyOn(filesystem, "readFile").mockImplementation((async (
    ...arguments_: Parameters<typeof filesystem.readFile>
  ) => {
    const bytes = await original(...arguments_);

    if (!retired && String(arguments_[0]) === join(old.assetsRoot, "startup.mjs")) {
      retired = true;

      await filesystem.writeFile(old.recordPath, next.source);
      await filesystem.rm(join(output, ".captures", old.captureId), {
        recursive: true,
        force: true,
      });
    }

    return bytes;
  }) as typeof filesystem.readFile);

  try {
    const captured = await readTargetedBuild(output);

    if (!("control" in captured)) throw new Error("Expected the replacement targeted wrapper");

    expect(retired).toBe(true);
    expect(captured.control.productionTarget.declaration).toStrictEqual(declarations[1]);
    expect(await captured.inventory.files.get("/assets/startup.mjs")!.text()).toBe(next.startup);
    expect("publicFiles" in captured.inventory).toBe(true);
  } finally {
    interception.mockRestore();

    await filesystem.rm(output, { recursive: true, force: true });
  }
});

test("readBuild retries a capture removed during publication only when the record changes", async () => {
  const { output, write } = await fixture();
  const original = filesystem.readFile;
  let retired = false;
  const old = await write("old");
  const interception = spyOn(filesystem, "readFile").mockImplementation((async (
    ...arguments_: Parameters<typeof filesystem.readFile>
  ) => {
    const result = await original(...arguments_);

    if (!retired && String(arguments_[0]) === join(old, "@team", "main+a.js")) {
      retired = true;

      await write("new");

      await filesystem.rm(join(output, ".captures", "11111111-1111-1111-1111-111111111111"), {
        recursive: true,
        force: true,
      });
    }

    return result;
  }) as typeof filesystem.readFile);

  try {
    const captured = await readBuild(output);

    expect(retired).toBe(true);

    expect(await captured.files.get("/assets/lazy.js")!.text()).toBe("new");
  } finally {
    interception.mockRestore();

    await filesystem.rm(output, { recursive: true, force: true });
  }
});

test("readBuild bounds retries when publication keeps retiring captures", async () => {
  const { output, write } = await fixture();

  await write("old");

  const original = filesystem.readFile;
  let retirements = 0;
  const interception = spyOn(filesystem, "readFile").mockImplementation((async (
    ...arguments_: Parameters<typeof filesystem.readFile>
  ) => {
    const result = await original(...arguments_);
    const path = String(arguments_[0]);

    if (path.endsWith(join("@team", "main+a.js"))) {
      retirements++;
      const current = path.includes("11111111-1111") ? "old" : "new";

      await write(current === "old" ? "new" : "old");

      const retired = resolve(path, "..", "..", "..");

      expect(retired.startsWith(`${join(output, ".captures")}${sep}`)).toBe(true);

      await filesystem.rm(retired, { recursive: true, force: true });
    }

    return result;
  }) as typeof filesystem.readFile);

  try {
    await expect(readBuild(output)).rejects.toThrow("asset is missing");

    expect(retirements).toBe(3);
  } finally {
    interception.mockRestore();

    await filesystem.rm(output, { recursive: true, force: true });
  }
});

test("readBuild loads V2 public bytes from raw storage paths and rejects disk corruption", async () => {
  const output = await filesystem.mkdtemp(join(tmpdir(), "hesperia-read-public-build-"));

  try {
    const written = await writePublicBuild(output);
    const captured = await readBuild(output);

    expect(captured.hosting.version).toBe(2);

    if (!("publicFiles" in captured) || captured.hosting.version !== 2)
      throw new Error("Expected a V2 captured build");

    const publicFile = captured.publicFiles.get(written.urlPath);

    expect(publicFile).toBeInstanceOf(Blob);
    expect(publicFile?.type).toBe("text/plain; charset=utf-8");
    expect(await publicFile?.text()).toBe("captured public bytes");

    await filesystem.writeFile(written.publicFilePath, "changed on disk");

    await expect(readBuild(output)).rejects.toThrow("public file digest mismatch");

    expect(await publicFile?.text()).toBe("captured public bytes");

    await filesystem.rm(written.publicFilePath);

    await expect(readBuild(output)).rejects.toThrow("public file is missing");
  } finally {
    await filesystem.rm(output, { recursive: true, force: true });
  }
});

test("readBuild retains an explicitly persisted empty V2 public inventory", async () => {
  const { output, write } = await fixture();

  try {
    await write("old");

    const recordPath = join(output, "hesperia-build.json");
    const record = JSON.parse(await filesystem.readFile(recordPath, "utf8")) as {
      hosting: Record<string, unknown>;
      assetDirectory: string;
      publicDirectory?: string;
    };
    const captureId = "11111111-1111-1111-1111-111111111111";
    const publicDirectory = `.captures/${captureId}/public`;

    record.hosting.version = 2;
    record.hosting.publicFiles = [];
    record.publicDirectory = publicDirectory;

    await filesystem.mkdir(join(output, publicDirectory), { recursive: true });
    await filesystem.writeFile(recordPath, JSON.stringify(record));

    const captured = await readBuild(output);

    if (!("publicFiles" in captured))
      throw new Error("Expected readBuild to retain the V2 public file map");

    expect(captured.hosting.version).toBe(2);
    expect(captured.publicFiles).toBeInstanceOf(Map);
    expect(captured.publicFiles.size).toBe(0);
    expect(await captured.files.get("/assets/@team/main+a.js")!.text()).toBe("old");
  } finally {
    await filesystem.rm(output, { recursive: true, force: true });
  }
});

test("readBuild requires V2 public files to use the matching capture directory", async () => {
  const output = await filesystem.mkdtemp(join(tmpdir(), "hesperia-read-public-directory-"));

  try {
    await writePublicBuild(output);

    const recordPath = join(output, "hesperia-build.json");
    const record = JSON.parse(await filesystem.readFile(recordPath, "utf8")) as Record<
      string,
      unknown
    >;

    delete record.publicDirectory;
    await filesystem.writeFile(recordPath, JSON.stringify(record));

    await expect(readBuild(output)).rejects.toThrow("share the asset capture");

    record.publicDirectory = ".captures/44444444-4444-4444-4444-444444444444/public";
    await filesystem.writeFile(recordPath, JSON.stringify(record));

    await expect(readBuild(output)).rejects.toThrow("share the asset capture");
  } finally {
    await filesystem.rm(output, { recursive: true, force: true });
  }
});

test("readBuild rejects symlinks in a V2 public storage path", async () => {
  const output = await filesystem.mkdtemp(join(tmpdir(), "hesperia-read-public-link-"));
  const outside = await filesystem.mkdtemp(join(tmpdir(), "hesperia-public-target-"));

  try {
    const written = await writePublicBuild(output);
    const publicRoot = join(output, written.publicDirectory);
    const pagesPath = join(publicRoot, "pages");

    await filesystem.writeFile(join(outside, "café #%.txt"), "captured public bytes");
    await filesystem.rm(pagesPath, { recursive: true });
    await filesystem.symlink(outside, pagesPath, process.platform === "win32" ? "junction" : "dir");

    await expect(readBuild(output)).rejects.toThrow("symlinked public file path");
  } finally {
    await filesystem.rm(output, { recursive: true, force: true });
    await filesystem.rm(outside, { recursive: true, force: true });
  }
});
