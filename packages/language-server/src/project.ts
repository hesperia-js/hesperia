import { resolve } from "node:path";
import {
  SymbolFlags,
  type Project,
  type Type,
  type CompletionInfo,
} from "typescript/unstable/async";
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
} from "@hesperia/compiler/editor";
import { eventCompletions } from "./events.ts";
import { scopeCompletions } from "./scope-completions.ts";
import { normalizeFilename as normalize } from "./utils.ts";

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
 * Create it with {@link EditorProject.create} after edits and await disposal when
 * replacing it. Diagnostics are captured plain data and remain readable after
 * disposal; semantic requests already in progress finish before the native
 * TypeScript snapshot closes.
 */
export class EditorProject {
  readonly diagnostics: ProjectCheckingResult;
  readonly #session: CheckingSession;
  readonly #root: string;
  readonly #sources: ReadonlyMap<string, string>;
  #activeRequests = 0;
  #resolveDrained: (() => void) | undefined;
  #disposePromise: Promise<void> | undefined;

  /** Open and check all supplied modules together, resolving imports from the project root. */
  static async create(
    modules: readonly VirtualModule[],
    options: ProjectCheckingOptions = {},
  ): Promise<EditorProject> {
    const session = await openCheckingProject(modules, options);

    try {
      return new EditorProject(session, modules, options);
    } catch (error) {
      await session.dispose();

      throw error;
    }
  }

  private constructor(
    session: CheckingSession,
    modules: readonly VirtualModule[],
    options: ProjectCheckingOptions,
  ) {
    this.#session = session;
    this.diagnostics = session.result;
    this.#root = resolve(options.root ?? process.cwd());
    this.#sources = new Map(
      modules.map(({ filename, source }) => [normalize(resolve(this.#root, filename)), source]),
    );
  }

  /**
   * Return type information at an authored offset, or undefined outside a known symbol.
   * Native JSX tag names show the created DOM object's type and documentation.
   */
  async hover(filename: string, offset: number): Promise<Hover | undefined> {
    return this.#withRequest(async () => {
      const position = this.#position(filename, offset);
      const project = this.#session.project;

      if (!position || !project) return undefined;

      const checker = project.checker;
      const file = await project.program.getSourceFile(position.filename);
      const token = file && getTokenAtPosition(file, position.offset);
      const native = await nativeElementType(project, token);
      const type = native ?? (await checker.getTypeAtPosition(position.filename, position.offset));

      if (!type) return undefined;

      const symbol = native
        ? await native.getSymbol()
        : await checker.getSymbolAtPosition(position.filename, position.offset);
      return {
        type: await checker.typeToString(type),
        documentation: symbol ? await symbol.getDocumentationComment(checker) : "",
      };
    });
  }

  /** Complete authored expressions or native `on:` names, including unfinished JSX. */
  async completions(filename: string, offset: number): Promise<readonly Completion[]> {
    return this.#withRequest(async () => {
      const position = this.#position(filename, offset);
      const project = this.#session.project;

      if (!position || !project) return [];

      const checker = project.checker;
      const source = this.#sources.get(normalize(position.filename));
      const view = this.#session.views.get(normalize(position.filename));
      const events =
        source !== undefined && view
          ? await eventCompletions(project, position.filename, source, offset, view)
          : undefined;

      if (events) return events;

      let completions: CompletionInfo | undefined;

      try {
        completions = await checker.getCompletionsAtPosition(position.filename, position.offset);
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "completion list needs auto imports")
          throw error;

        return await scopeCompletions(project, position.filename, position.offset);
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
    });
  }

  /**
   * Follow imports and JSX prop types to declarations in authored source or dependencies.
   * Native event attributes navigate to their DOM handler declaration when one exists.
   * Unknown attributes and compiler-only helpers have no definition target.
   */
  async definitions(filename: string, offset: number): Promise<readonly SourceLocation[]> {
    return this.#withRequest(async () => {
      const position = this.#position(filename, offset);
      const project = this.#session.project;

      if (!position || !project) return [];

      const checker = project.checker;
      let symbol = await checker.getSymbolAtPosition(position.filename, position.offset);
      const file = await project.program.getSourceFile(position.filename);
      const token = file && getTokenAtPosition(file, position.offset);
      const native = await nativeElementType(project, token);

      if (native) symbol = await native.getSymbol();

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
          const contextual = await checker.getContextualType(object);
          symbol = contextual ? await checker.getPropertyOfType(contextual, token.text) : undefined;

          if (
            (!symbol || symbol.declarations.length === 0) &&
            contextual &&
            call.expression.text === "__hesperia_element" &&
            token.text.startsWith("on:")
          )
            symbol = await checker.getPropertyOfType(contextual, `on${token.text.slice(3)}`);
        }
      }

      if (!symbol) return [];

      if (symbol.flags & SymbolFlags.Alias) symbol = await checker.getAliasedSymbol(symbol);

      const locations: SourceLocation[] = [];

      for (const handle of symbol.declarations) {
        const declaration = await handle.resolve(project);

        if (!declaration) continue;

        const name = "name" in declaration ? (declaration.name as Node | undefined) : undefined;
        const node = name ?? declaration;
        const sourceFile = node.getSourceFile();
        const view = this.#session.views.get(normalize(sourceFile.fileName));

        if (sourceFile.fileName.replaceAll("\\", "/").endsWith("/.hesperia/jsx.d.ts")) continue;

        locations.push({
          filename: sourceFile.fileName,
          start: view?.mapOffset(node.getStart(sourceFile)) ?? node.getStart(sourceFile),
          end: view?.mapOffset(node.end) ?? node.end,
        });
      }

      return locations;
    });
  }

  /**
   * Stop accepting requests, wait for requests already using this snapshot, then close it.
   * Repeated calls return the same in-flight cleanup operation.
   */
  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;

    const drained =
      this.#activeRequests === 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            this.#resolveDrained = resolve;
          });
    this.#disposePromise = (async () => {
      await drained;

      await this.#session.dispose();
    })();
    return this.#disposePromise;
  }

  #position(filename: string, offset: number): { filename: string; offset: number } | undefined {
    const absolute = resolve(this.#root, filename);
    const view = this.#session.views.get(normalize(absolute));

    if (!view || !Number.isInteger(offset) || offset < 0) return undefined;

    return { filename: absolute, offset: view.generatedOffset(offset) };
  }

  async #withRequest<T>(work: () => Promise<T>): Promise<T> {
    if (this.#disposePromise) throw new Error("The Hesperia editor project has been disposed.");

    this.#activeRequests++;

    try {
      return await work();
    } finally {
      this.#activeRequests--;

      if (this.#activeRequests === 0) this.#resolveDrained?.();
    }
  }
}

async function nativeElementType(
  project: Project,
  token: Node | undefined,
): Promise<Type | undefined> {
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
