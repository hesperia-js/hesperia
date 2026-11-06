import assert from "node:assert/strict";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

if (process.versions.node !== "22.23.2")
  throw new Error(`Expected Node 22.23.2; received ${process.versions.node}`);

const [graphqlUrl, controlUrl, checkoutRoot, expectedInstanceId, expectedVersionsJson] =
  process.argv.slice(2);

if (!graphqlUrl || !controlUrl || !checkoutRoot || !expectedInstanceId || !expectedVersionsJson)
  throw new Error(
    "Expected GraphQL URL, control URL, checkout root, fixture id, and direct package pins",
  );

if (!isAbsolute(checkoutRoot)) throw new Error("Expected an absolute source checkout root");

/** @typedef {{ entry: string, root: string, version: string }} InstalledPackage */
/** @typedef {{ instanceId: string, revision: number, writes: string[], resolverCalls: { state: number } }} FixtureState */
/** @typedef {{ partial: { ok: string, broken: string | null } }} PartialData */
/** @typedef {{ state: { revision: number, writes: string[] } }} StateData */
/** @typedef {{ writeThenFail: { value: string, failure: string | null } | null }} FailedWriteData */
/** @typedef {{ value: string }} FailedWriteVariables */
/** @typedef {import("@apollo/client").TypedDocumentNode<PartialData, Record<string, never>>} PartialDocument */
/** @typedef {import("@apollo/client").TypedDocumentNode<StateData, Record<string, never>>} StateDocument */
/** @typedef {import("@apollo/client").TypedDocumentNode<FailedWriteData, FailedWriteVariables>} FailedWriteDocument */
/** @typedef {import("@hesperia/graphql").GraphQLResultError<FailedWriteData>} FailedWriteError */

/** @type {Record<string, string>} */
const expectedVersions = JSON.parse(expectedVersionsJson);
const appRoot = await realpath(process.cwd());
const checkoutPath = await realpath(checkoutRoot);
const nodeModulesRoot = await realpath(join(appRoot, "node_modules"));

/** @param {string} parent @param {string} child */
function isInside(parent, child) {
  const path = relative(parent, child);

  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

if (!isInside(appRoot, nodeModulesRoot))
  throw new Error(`Installed node_modules escaped the consumer app: ${nodeModulesRoot}`);

let ancestor = dirname(appRoot);

while (true) {
  const ancestorNodeModules = join(ancestor, "node_modules");
  let exists = false;

  try {
    await stat(ancestorNodeModules);
    exists = true;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }

  if (exists)
    throw new Error(
      `Found an ancestor node_modules outside the isolated consumer app: ${ancestorNodeModules}`,
    );

  const parent = dirname(ancestor);

  if (parent === ancestor) break;

  ancestor = parent;
}

/**
 * @param {string} packageName
 * @param {string} [specifier]
 * @returns {Promise<InstalledPackage>}
 */
async function resolveInstalledPackage(packageName, specifier = packageName) {
  const entry = await realpath(fileURLToPath(import.meta.resolve(specifier)));

  if (!isInside(nodeModulesRoot, entry))
    throw new Error(
      `${specifier} did not resolve inside the consumer's installed node_modules: ${entry}`,
    );

  if (isInside(checkoutPath, entry))
    throw new Error(`${specifier} resolved back into the source checkout: ${entry}`);

  let directory = dirname(entry);

  while (directory !== nodeModulesRoot && isInside(nodeModulesRoot, directory)) {
    try {
      /** @type {{ name?: string, version?: string }} */
      const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));

      if (manifest.name === packageName && typeof manifest.version === "string")
        return { entry, root: directory, version: manifest.version };
    } catch {
      // This directory is not a package root; continue toward node_modules.
    }

    directory = dirname(directory);
  }

  throw new Error(`Could not find installed package metadata for ${packageName} from ${entry}`);
}

/** @type {Record<string, InstalledPackage>} */
const entrypoints = {};

for (const packageName of Object.keys(expectedVersions))
  entrypoints[packageName] = await resolveInstalledPackage(packageName);

Object.assign(entrypoints, {
  "@hesperia/graphql/client": await resolveInstalledPackage(
    "@hesperia/graphql",
    "@hesperia/graphql/client",
  ),
  "@apollo/client/link/http": await resolveInstalledPackage(
    "@apollo/client",
    "@apollo/client/link/http",
  ),
  "@apollo/client/errors": await resolveInstalledPackage("@apollo/client", "@apollo/client/errors"),
  aeolia: await resolveInstalledPackage("aeolia"),
  graphql: await resolveInstalledPackage("graphql"),
  rxjs: await resolveInstalledPackage("rxjs"),
});

assert.equal(entrypoints["@hesperia/graphql"].root, entrypoints["@hesperia/graphql/client"].root);
assert.equal(
  entrypoints["@apollo/client/link/http"].root,
  entrypoints["@apollo/client/errors"].root,
);
assert.equal(entrypoints["@hesperia/graphql"].version, expectedVersions["@hesperia/graphql"]);

const [graphqlRoot, graphqlClient, http, apolloErrors, graphqlLanguage, aeolia] = await Promise.all(
  [
    import("@hesperia/graphql"),
    import("@hesperia/graphql/client"),
    import("@apollo/client/link/http"),
    import("@apollo/client/errors"),
    import("graphql"),
    import("aeolia"),
  ],
);

assert.equal(graphqlRoot.createGraphQLClient, graphqlClient.createGraphQLClient);

const installedVersions = Object.fromEntries(
  Object.keys(expectedVersions).map((packageName) => [
    packageName,
    entrypoints[packageName].version,
  ]),
);

assert.deepEqual(installedVersions, expectedVersions);

const { createGraphQLClient } = graphqlClient;
const { HttpLink } = http;
const { CombinedGraphQLErrors } = apolloErrors;
const { parse } = graphqlLanguage;
const { affects, createGraph, defineContract, subscribe } = aeolia;

/** @param {unknown} error @returns {error is FailedWriteError} */
function isFailedWriteError(error) {
  return error instanceof Error && Object.hasOwn(error, "result");
}

const graphql = createGraphQLClient({ link: new HttpLink({ uri: graphqlUrl }) });
const partialDocument = /** @type {PartialDocument} */ (
  parse(`query InstalledPartial { partial { ok broken } }`)
);
const partial = graphql.query({
  name: "installed-runtime.partial",
  document: partialDocument,
  key: () => "partial",
});
const stateDocument = /** @type {StateDocument} */ (
  parse(`query InstalledState { state { revision writes } }`)
);
const state = graphql.query({
  name: "installed-runtime.state",
  document: stateDocument,
  key: () => "state",
});
const failedWriteDocument = /** @type {FailedWriteDocument} */ (
  parse(`
    mutation InstalledFailedWrite($value: String!) {
      writeThenFail(value: $value) {
        value
        failure
      }
    }
  `)
);
const failedWrite = graphql.mutation({
  name: "installed-runtime.failed-write",
  document: failedWriteDocument,
  affects: [
    affects(state, {
      select: () => ({}),
      on: "revalidate",
      optimistic: () => ({
        data: { state: { revision: 1, writes: ["predicted-installed-write"] } },
      }),
    }),
  ],
});
const contract = defineContract({
  namespace: "installed-runtime",
  operations: { partial, state, failedWrite },
});
const graph = createGraph({ contract });
const partialStore = graph.api.partial({}, {});
const stateStore = graph.api.state({}, {});
/** @type {(() => void) | undefined} */
let stopStateObservation;

/** @returns {Promise<FixtureState>} */
async function readFixtureState() {
  const response = await fetch(`${controlUrl}/state`, {
    signal: AbortSignal.timeout(5_000),
  });

  assert.equal(response.status, 200);

  return /** @type {FixtureState} */ (await response.json());
}

/** @param {Record<string, unknown> | undefined} extensions */
function readFixtureInstanceId(extensions) {
  const fixture = extensions?.fixture;

  if (typeof fixture !== "object" || fixture === null || !("instanceId" in fixture))
    return undefined;

  return typeof fixture.instanceId === "string" ? fixture.instanceId : undefined;
}

/** @type {Record<string, unknown> | undefined} */
let report;

try {
  stopStateObservation = subscribe(stateStore.value, () => undefined);

  await Promise.all([partialStore.ready, stateStore.ready]);

  const partialEnvelope = partialStore.value.get();
  const partialData = partialEnvelope?.data?.partial;
  const partialError = partialEnvelope?.errors?.[0];
  const partialExtensionInstanceId = readFixtureInstanceId(partialEnvelope?.extensions);

  if (!partialData || !partialError || !partialExtensionInstanceId)
    throw new Error("The native partial query did not retain its data, error, and extension");

  assert.equal(partialData.ok, "partial-ok");
  assert.equal(partialData.broken, null);
  assert.equal(partialError.message, "fixture partial field failure");
  assert.deepEqual(partialError.path, ["partial", "broken"]);
  assert.equal(partialExtensionInstanceId, expectedInstanceId);

  const initialState = stateStore.value.get()?.data?.state;
  const serverBefore = await readFixtureState();

  if (!initialState) throw new Error("The native state query returned no data");

  assert.equal(initialState.revision, 0);
  assert.deepEqual(initialState.writes, []);
  assert.equal(serverBefore.instanceId, expectedInstanceId);
  assert.equal(serverBefore.resolverCalls.state, 1);

  /** @type {unknown} */
  let failure;

  try {
    await graph.api.failedWrite({ value: "installed-failed-write" });
  } catch (error) {
    failure = error;
  }

  if (!isFailedWriteError(failure))
    throw new Error("The default mutation policy did not return its captured result on rejection", {
      cause: failure,
    });

  if (!CombinedGraphQLErrors.is(failure.cause))
    throw new Error("The rejected mutation did not retain Apollo's native GraphQL error as cause");

  const failureEnvelope = failure.result;
  const failureData = failureEnvelope?.data?.writeThenFail;
  const failureError = failureEnvelope?.errors?.[0];
  const failureExtensionInstanceId = readFixtureInstanceId(failureEnvelope?.extensions);

  if (!failureData || !failureError || !failureExtensionInstanceId)
    throw new Error("The rejected mutation did not retain its partial envelope");

  assert.ok(failure.message.includes("fixture mutation field failure"));
  assert.equal(failure.constructor, Error);
  assert.equal(failureData.value, "installed-failed-write");
  assert.equal(failureData.failure, null);
  assert.equal(failureError.message, "fixture mutation field failure");
  assert.deepEqual(failureError.path, ["writeThenFail", "failure"]);
  assert.equal(failureExtensionInstanceId, expectedInstanceId);

  const stateAfterFailure = stateStore.value.get()?.data?.state;
  const serverAfter = await readFixtureState();

  if (!stateAfterFailure)
    throw new Error("The observed state query lost its result after mutation rejection");

  assert.equal(stateAfterFailure.revision, 0);
  assert.deepEqual(stateAfterFailure.writes, []);
  assert.equal(serverAfter.revision, 1);
  assert.deepEqual(serverAfter.writes, ["installed-failed-write"]);
  assert.equal(serverAfter.resolverCalls.state, 1);

  report = {
    nodeVersion: process.versions.node,
    fixtureInstanceId: expectedInstanceId,
    entrypoints: Object.fromEntries(
      Object.entries(entrypoints).map(([name, value]) => [name, value.entry]),
    ),
    installedVersions,
    partial: {
      ok: partialData.ok,
      broken: partialData.broken,
      errorMessage: partialError.message,
      errorPath: partialError.path,
      extensionInstanceId: partialExtensionInstanceId,
    },
    failure: {
      message: failure.message,
      errorName: failure.name,
      executionMessage: failureError.message,
      causeName: failure.cause.name,
      value: failureData.value,
      failedField: failureData.failure,
      errorPath: failureError.path,
      extensionInstanceId: failureExtensionInstanceId,
    },
    stateBefore: serverBefore,
    stateAfter: serverAfter,
  };
} finally {
  stopStateObservation?.();
  graph.dispose();
  graphql.stop();
}

console.log(JSON.stringify(report));
