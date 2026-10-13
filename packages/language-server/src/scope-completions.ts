import { isIdentifier, type Node } from "typescript/unstable/ast";
import { SymbolFlags, type Project, type Symbol } from "typescript/unstable/async";
import type { Completion } from "./project.ts";

/**
 * Suggest existing names when the standalone TypeScript completion API requests
 * unavailable auto-import state. Uses checking-source offsets and TypeScript's
 * name resolution for scope and shadowing. Does not generate import edits,
 * keywords, or context-specific snippets.
 */
export async function scopeCompletions(
  project: Project,
  filename: string,
  offset: number,
): Promise<readonly Completion[]> {
  const file = await project.program.getSourceFile(filename);

  if (!file) return [];

  const location = { document: filename, position: Math.max(0, offset - 1) };
  const meaning = SymbolFlags.Value | SymbolFlags.Type | SymbolFlags.Namespace;
  const globals = await project.checker.resolveName("globalThis", SymbolFlags.Value);
  const exports = globals ? await globals.getExports() : undefined;
  const symbols = new Map<string, Symbol>();

  for (const symbol of exports?.values() ?? []) symbols.set(symbol.name, symbol);

  const names = new Set<string>();

  function collect(node: Node): void {
    if (isIdentifier(node)) names.add(node.text);

    node.forEachChild(collect);
  }

  collect(file);

  for (const name of names) {
    const symbol = await project.checker.resolveName(name, meaning, location);

    if (symbol) symbols.set(name, symbol);
  }

  const results: Completion[] = [];

  for (const symbol of symbols.values()) {
    if (await checkingSymbol(project, symbol)) continue;

    results.push({
      label: symbol.name,
      insertText: symbol.name,
      sortText: names.has(symbol.name) ? "11" : "15",
    });
  }

  return results;
}

async function checkingSymbol(project: Project, symbol: Symbol): Promise<boolean> {
  if (!symbol.name.startsWith("Hesperia") && !symbol.name.startsWith("__hesperia_")) return false;

  for (const handle of symbol.declarations) {
    const declaration = await handle.resolve(project);

    if (declaration?.getSourceFile().fileName.replaceAll("\\", "/").endsWith("/.hesperia/jsx.d.ts"))
      return true;
  }

  return false;
}
