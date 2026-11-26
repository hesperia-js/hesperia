// This fixture runs inside the installed application.
// @ts-nocheck
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readTargetedBuild } from "@hesperia/hosting";

const output = join(process.cwd(), ".hesperia", "build");
const persisted = await readTargetedBuild(output);

assert.equal(persisted.control.kind, "browser");
assert.equal(
  persisted.control.productionTarget.descriptorIdentity,
  "hesperia.target/browser-static/1",
);
assert.equal(persisted.inventory.hosting.standaloneMountURL, "/dashboard");

const record = JSON.parse(await readFile(join(output, "hesperia-build.json"), "utf8"));
const startup = record.control.hosting.startupAsset;
const publishedAsset = record.control.hosting.assets.find((asset) => asset.path === startup);
const reopenedAsset = persisted.inventory.files.get(startup);

assert.equal(persisted.inventory.hosting.startupAsset, startup);
assert(
  publishedAsset && reopenedAsset,
  "The installed reader did not reopen the emitted startup asset",
);
assert.equal(
  createHash("sha256")
    .update(new Uint8Array(await reopenedAsset.arrayBuffer()))
    .digest("hex"),
  publishedAsset.sha256,
);
