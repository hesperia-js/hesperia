import { isIdentifier, type Node } from "typescript/unstable/ast";
import { SymbolFlags, type Project, type Symbol } from "typescript/unstable/sync";
import type { Completion } from "./project.ts";

/**
 * Suggest existing names when the standalone TypeScript completion API requests
 * unavailable auto-import state. Uses checking-source offsets and TypeScript's
 * name resolution for scope and shadowing. Does not generate import edits,
 * keywords, or context-specific snippets.
 */
export function scopeCompletions(
  project: Project,
  filename: string,
  offset: number,
): readonly Completion[] {
  const file = project.program.getSourceFile(filename);
  if (!file) return [];
  const location = { document: filename, position: Math.max(0, offset - 1) };
  const meaning = SymbolFlags.Value | SymbolFlags.Type | SymbolFlags.Namespace;
  const globals = project.checker.resolveName("globalThis", SymbolFlags.Value)?.getExports();
  const symbols = new Map<string, Symbol>();
  for (const symbol of globals?.values() ?? []) symbols.set(symbol.name, symbol);
  const names = new Set<string>();
  function collect(node: Node): void {
    if (isIdentifier(node)) names.add(node.text);
    node.forEachChild(collect);
  }
  collect(file);
  for (const name of names) {
    const symbol = project.checker.resolveName(name, meaning, location);
    if (symbol) symbols.set(name, symbol);
  }
  return [...symbols.values()]
    .filter((symbol) => !checkingSymbol(project, symbol))
    .map((symbol) => ({
      label: symbol.name,
      insertText: symbol.name,
      sortText: names.has(symbol.name) ? "11" : "15",
    }));
}

function checkingSymbol(project: Project, symbol: Symbol): boolean {
  if (!symbol.name.startsWith("Hesperia") && !symbol.name.startsWith("__hesperia_")) return false;
  return symbol.declarations.some((handle) =>
    handle
      .resolve(project)
      ?.getSourceFile()
      .fileName.replaceAll("\\", "/")
      .endsWith("/.hesperia/jsx.d.ts"),
  );
}
