import type { PluginProjectInput, ProjectTypeQueries } from "@hesperia/tooling";

declare const input: PluginProjectInput;

const queries: ProjectTypeQueries = input.types;

const checker: ProjectTypeQueries["checker"] = queries.checker;

const sourceFile = queries.sourceFile("src/routes/+page.tsx");

const resolveDeclaration: ProjectTypeQueries["resolveDeclaration"] = queries.resolveDeclaration;

void [checker, sourceFile, resolveDeclaration];
