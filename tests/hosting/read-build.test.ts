import { expect, spyOn, test } from "bun:test";
import * as filesystem from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { readBuild } from "../../packages/hosting/src/index.ts";

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

test("readBuild validates a copied deployment without an application source tree", async () => {
  const { output, write } = await fixture();

  try {
    const assets = await write("old");
    const captured = await readBuild(output);

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
