import { resolve } from "node:path";
import {
  SymbolFlags,
  type Project,
  type Type,
  type CompletionInfo,
} from "typescript/unstable/sync";
import {
  getTokenAtPosition,
  isCallExpression,
  isIdentifier,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isStringLiteral,
  type Node,
} from "typescript/unstable/ast";
import {
  openCheckingProject,
  type CheckingSession,
  type ProjectCheckingOptions,
  type ProjectCheckingResult,
  type VirtualModule,
} from "../compiler/checking.ts";
import { eventCompletions } from "./events.ts";
import { scopeCompletions } from "./scope-completions.ts";

/** An editor location uses UTF-16 offsets into the author's source. */
export interface SourceLocation {
  /** Absolute source filename, including dependency declarations when applicable. */
  readonly filename: string;
  /** Inclusive starting offset. */
  readonly start: number;
  /** Exclusive ending offset. */
  readonly end: number;
}

/** Type and documentation for the symbol under the cursor. */
export interface Hover {
  /** Human-readable TypeScript type. */
  readonly type: string;
  /** Declaration documentation, or an empty string when none exists. */
  readonly documentation: string;
}

/** A completion provided by the same TypeScript project as command-line checking. */
export interface Completion {
  /** Name displayed in the completion menu. */
  readonly label: string;
  /** Text inserted when this entry is accepted. */
  readonly insertText: string;
  /** TypeScript's stable ordering key, when supplied. */
  readonly sortText?: string;
  /** Additional type information, when supplied. */
  readonly detail?: string;
  /** Authored event-name span to replace, excluding the existing `on:` prefix. */
  readonly replacement?: { readonly start: number; readonly end: number };
}

/**
 * Immutable authored-source checking and navigation snapshot.
 *
 * Create a new instance after edits and dispose the old one. No method can use
 * the native TypeScript process after disposal; disposal itself is idempotent.
 */
export class EditorProject {
  readonly #session: CheckingSession;
  readonly #root: string;
  readonly #sources: ReadonlyMap<string, string>;
  #disposed = false;

  /** Check all supplied modules together, resolving imports from the project root. */
  constructor(modules: readonly VirtualModule[], options: ProjectCheckingOptions = {}) {
    this.#root = resolve(options.root ?? process.cwd());
    this.#sources = new Map(
      modules.map(({ filename, source }) => [normalize(resolve(this.#root, filename)), source]),
    );
    this.#session = openCheckingProject(modules, options);
  }

  /** Diagnostics shared with the command-line checker, grouped by authored filename. */
  get diagnostics(): ProjectCheckingResult {
    this.#assertLive();
    return this.#session.result;
  }

  /**
   * Return type information at an authored offset, or undefined outside a known symbol.
   * Native JSX tag names show the created DOM object's type and documentation.
   */
  hover(filename: string, offset: number): Hover | undefined {
    this.#assertLive();
    const position = this.#position(filename, offset);
    const project = this.#session.project;
    if (!position || !project) return undefined;
    const checker = project.checker;
    const file = project.program.getSourceFile(position.filename);
    const token = file && getTokenAtPosition(file, position.offset);
    const native = nativeElementType(project, token);
    const type = native ?? checker.getTypeAtPosition(position.filename, position.offset);
    if (!type) return undefined;
    const symbol = native
      ? native.getSymbol()
      : checker.getSymbolAtPosition(position.filename, position.offset);
    return {
      type: checker.typeToString(type),
      documentation: symbol?.getDocumentationComment(checker) ?? "",
    };
  }

  /** Complete authored expressions or native `on:` names, including unfinished JSX. */
  completions(filename: string, offset: number): readonly Completion[] {
    this.#assertLive();
    const position = this.#position(filename, offset);
    const project = this.#session.project;
    if (!position || !project) return [];
    const checker = project.checker;
    const source = this.#sources.get(normalize(position.filename));
    const view = this.#session.views.get(normalize(position.filename));
    const events =
      source !== undefined && view
        ? eventCompletions(project, position.filename, source, offset, view)
        : undefined;
    if (events) return events;
    let completions: CompletionInfo | undefined;
    try {
      completions = checker.getCompletionsAtPosition(position.filename, position.offset);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "completion list needs auto imports")
        throw error;
      return scopeCompletions(project, position.filename, position.offset);
    }
    return (completions?.entries ?? [])
      .filter(
        (entry) =>
          !entry.name.startsWith("__hesperia_") && !entry.name.startsWith("HesperiaNative"),
      )
      .map((entry) => ({
        label: entry.name,
        insertText: entry.insertText ?? entry.name,
        ...(entry.sortText !== undefined ? { sortText: entry.sortText } : {}),
        ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
      }));
  }

  /**
   * Follow imports and JSX prop types to declarations in authored source or dependencies.
   * Native event attributes navigate to their DOM handler declaration when one exists.
   * Unknown attributes and compiler-only helpers have no definition target.
   */
  definitions(filename: string, offset: number): readonly SourceLocation[] {
    this.#assertLive();
    const position = this.#position(filename, offset);
    const project = this.#session.project;
    if (!position || !project) return [];
    let symbol = project.checker.getSymbolAtPosition(position.filename, position.offset);
    const file = project.program.getSourceFile(position.filename);
    const token = file && getTokenAtPosition(file, position.offset);
    const native = nativeElementType(project, token);
    if (native) symbol = native.getSymbol();
    if (
      token &&
      isStringLiteral(token) &&
      isPropertyAssignment(token.parent) &&
      token.parent.name === token
    ) {
      const object = token.parent.parent;
      const call = object.parent;
      if (
        isObjectLiteralExpression(object) &&
        isCallExpression(call) &&
        isIdentifier(call.expression) &&
        ["__hesperia_element", "__hesperia_component"].includes(call.expression.text)
      ) {
        const contextual = project.checker.getContextualType(object);
        symbol = contextual && project.checker.getPropertyOfType(contextual, token.text);
        if (
          !symbol?.declarations.length &&
          contextual &&
          call.expression.text === "__hesperia_element" &&
          token.text.startsWith("on:")
        )
          symbol = project.checker.getPropertyOfType(contextual, `on${token.text.slice(3)}`);
      }
    }
    if (!symbol) return [];
    if (symbol.flags & SymbolFlags.Alias) symbol = project.checker.getAliasedSymbol(symbol);
    return symbol.declarations.flatMap((handle) => {
      const declaration = handle.resolve(project);
      if (!declaration) return [];
      const name = "name" in declaration ? (declaration.name as Node | undefined) : undefined;
      const node = name ?? declaration;
      const file = node.getSourceFile();
      const view = this.#session.views.get(normalize(file.fileName));
      if (file.fileName.replaceAll("\\", "/").endsWith("/.hesperia/jsx.d.ts")) return [];
      return [
        {
          filename: file.fileName,
          start: view?.mapOffset(node.getStart(file)) ?? node.getStart(file),
          end: view?.mapOffset(node.end) ?? node.end,
        },
      ];
    });
  }

  /** Release the native checking snapshot and its process. Safe to call more than once. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#session.dispose();
  }

  #position(filename: string, offset: number): { filename: string; offset: number } | undefined {
    const absolute = resolve(this.#root, filename);
    const view = this.#session.views.get(normalize(absolute));
    if (!view || !Number.isInteger(offset) || offset < 0) return undefined;
    return { filename: absolute, offset: view.generatedOffset(offset) };
  }

  #assertLive(): void {
    if (this.#disposed) throw new Error("The Hesperia editor project has been disposed.");
  }
}

function nativeElementType(project: Project, token: Node | undefined): Type | undefined {
  if (!token || !isStringLiteral(token)) return undefined;
  const call = token.parent;
  if (
    !isCallExpression(call) ||
    !isIdentifier(call.expression) ||
    call.expression.text !== "__hesperia_element" ||
    call.arguments[0] !== token
  )
    return undefined;
  return project.checker.getTypeAtLocation(call);
}

function normalize(filename: string): string {
  return filename.replaceAll("\\", "/").toLowerCase();
}
