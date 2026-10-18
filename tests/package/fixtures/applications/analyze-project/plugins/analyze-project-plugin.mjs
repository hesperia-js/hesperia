import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const moduleId = "hesperia:plugin/installed-analysis";

const capturedSource = 'export const capturedValue = "CAPTURED_VALUE_FROM_FIRST_READ";\n';

const capturedServerSource = 'export const serverSecret = "SERVER_ONLY_TEXT_MUST_NOT_SHIP_64A7";\n';

const mutatedSource = 'export const capturedValue = "MUTATED_DURING_ANALYZE_PROJECT";\n';

const mutatedServerSource = 'export const serverSecret = "MUTATED_DURING_ANALYZE_PROJECT";\n';

export function createAnalyzeProjectPlugin() {
  const origin = {
    filename: resolve(fileURLToPath(new URL("../hesperia.config.ts", import.meta.url))),
    start: 0,
    end: 0,
  };

  return {
    name: "installed-third-party-analysis",
    projectSources: ["src/server-only.ts"],
    projectDeclarations: [
      {
        id: moduleId,
        code: `declare module "${moduleId}" { export function generatedValue(): string; }`,
        origin,
      },
    ],

    async analyzeProject(input) {
      const sharedFilename = resolve(input.root, "src/shared-value.ts");

      const serverFilename = resolve(input.root, "src/server-only.ts");

      const sharedBefore = input.capturedSources.get(sharedFilename);

      const checkingSharedBefore = input.checkingSources.get(sharedFilename);

      const serverBefore = input.capturedSources.get(serverFilename);

      const checkingServerBefore = input.checkingSources.get(serverFilename);

      if (
        !sharedBefore ||
        !checkingSharedBefore ||
        !serverBefore ||
        !checkingServerBefore ||
        sharedBefore.source !== capturedSource ||
        checkingSharedBefore.authored !== capturedSource ||
        checkingSharedBefore.checking !== capturedSource ||
        serverBefore.source !== capturedServerSource ||
        checkingServerBefore.authored !== capturedServerSource ||
        checkingServerBefore.checking !== capturedServerSource
      ) {
        throw new Error("the plugin did not receive the first captured project inputs");
      }

      const serverAstBefore = await input.types.sourceFile("src/server-only.ts");

      if (!serverAstBefore || serverAstBefore.text !== capturedServerSource)
        throw new Error("the retained checker did not receive the captured server source");

      await writeFile(sharedFilename, mutatedSource);

      await writeFile(serverFilename, mutatedServerSource);

      const sharedAfter = input.capturedSources.get(sharedFilename);

      const checkingSharedAfter = input.checkingSources.get(sharedFilename);

      const checkingServerAfter = input.checkingSources.get(serverFilename);

      const serverAstAfter = await input.types.sourceFile("src/server-only.ts");

      if (
        sharedAfter?.source !== capturedSource ||
        sharedAfter.digest !== sharedBefore.digest ||
        checkingSharedAfter?.checking !== capturedSource ||
        checkingServerAfter?.checking !== capturedServerSource ||
        serverAstAfter?.text !== capturedServerSource
      ) {
        throw new Error("an on-disk mutation changed the active revision's captured inputs");
      }

      await writeFile(
        resolve(input.root, ".analyze-project-proof.json"),
        JSON.stringify(
          {
            capturedSharedBefore: sharedBefore.source,
            checkingSharedBefore: checkingSharedBefore.checking,
            capturedSharedAfter: sharedAfter.source,
            checkingSharedAfter: checkingSharedAfter.checking,
            capturedServerBefore: serverBefore.source,
            checkingServerAfter: checkingServerAfter.checking,
            serverAstAfter: serverAstAfter.text,
            diskSharedAfter: await readFile(sharedFilename, "utf8"),
            diskServerAfter: await readFile(serverFilename, "utf8"),
          },
          null,
          2,
        ),
      );

      return {
        browserModules: [
          {
            id: moduleId,
            code: 'export function generatedValue() { return "INSTALLED_THIRD_PARTY_BODY_EXECUTED"; }',
            origin,
          },
        ],
      };
    },
  };
}
