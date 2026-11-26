import type { CompileOptions, ModuleAnalysis } from "./compilation.ts";
import type {
  CheckingSession,
  ProjectCheckingOptions,
  ProjectCheckingResult,
  VirtualModule,
} from "./checking.ts";
import type { ProjectCompilation } from "./project-compilation.ts";
import { normalizeChannelProjectDefaults, snapshotChannelProjectDefaults } from "hesperia/runtime";
import {
  isComponentArrow,
  isComponentBody,
  isComponentFunctionExpression,
} from "./component-analysis.ts";
import type {
  CanonicalAttribute,
  CanonicalChild,
  CanonicalElement,
  CanonicalExpression,
  CanonicalModule,
  CanonicalStatement,
  CanonicalStatementBlock,
  CompilerDiagnostic,
  SourceSpan,
} from "./ir.ts";

const TERMINAL_INTRINSIC_SCHEMA = "hesperia:creator-terminal-intrinsics:v1";
const TERMINAL_HELPER_ABI = "hesperia:render-host:terminal-cli:v1";
const TERMINAL_RUNTIME_MODULE = "hesperia:creator-terminal-runtime:v1";
const TERMINAL_ROOT_TYPES_MODULE = "hesperia:terminal-root-types:v1";
const TERMINAL_CLIENT_TYPES_MODULE = "hesperia:terminal-client-types:v1";

/** Exact authored module specifiers replaced by the private terminal checking declarations. */
export const TERMINAL_CHECKING_IMPORT_REPLACEMENTS = Object.freeze({
  "hesperia/client": TERMINAL_CLIENT_TYPES_MODULE,
  hesperia: TERMINAL_ROOT_TYPES_MODULE,
});

const BROWSER_TARGET = Object.freeze({ kind: "browser" } as const);
const TERMINAL_CLI_TARGET = Object.freeze({
  kind: "terminal-cli",
  version: 1,
  intrinsicSchema: TERMINAL_INTRINSIC_SCHEMA,
  helperAbi: TERMINAL_HELPER_ABI,
  runtimeModule: TERMINAL_RUNTIME_MODULE,
} as const);

const targets = new WeakMap<object, InternalTarget>();

/** A compiler-owned profile pinned to private compiler objects. */
export type InternalTarget =
  | {
      /** Preserve the existing DOM browser and server/resume compilation profile. */
      readonly kind: "browser";
    }
  | {
      /** Select the creator's fixed OpenTUI host profile. */
      readonly kind: "terminal-cli";
      /** Version of the compiler-owned terminal profile. */
      readonly version: 1;
      /** Fixed intrinsic and property schema used for terminal checking. */
      readonly intrinsicSchema: typeof TERMINAL_INTRINSIC_SCHEMA;
      /** Fixed runtime helper contract used by generated terminal code. */
      readonly helperAbi: typeof TERMINAL_HELPER_ABI;
      /** Private virtual module imported by generated terminal code. */
      readonly runtimeModule: typeof TERMINAL_RUNTIME_MODULE;
    };

/**
 * Read an object's compiler profile, defaulting unmarked objects to browser behavior.
 *
 * The WeakMap keeps profile selection outside exported compiler option shapes. A marked profile
 * is always one of the compiler-owned frozen values below.
 *
 * @param value Compiler option, analysis, or session object to inspect.
 * @returns The pinned internal target or the default browser target.
 */
export function targetFor(value: object): InternalTarget {
  assertObjectKey(value);
  return targets.get(value) ?? BROWSER_TARGET;
}

/**
 * Copy the internal target marker when compiler code derives a new options or analysis object.
 *
 * @param source Existing object whose profile should be inherited.
 * @param destination Newly derived object to mark with the same profile.
 */
export function inheritTarget(source: object, destination: object): void {
  pinTarget(destination, targetFor(source));
}

/**
 * Pin an internal compiler object to one exact compiler-owned target profile.
 *
 * Runtime validation rejects forged, malformed, or future profile objects instead of treating
 * them as a browser or terminal profile based on their `kind` alone.
 *
 * @param value Compiler option, analysis, or session object to mark.
 * @param target Requested internal profile.
 * @throws TypeError when either argument is not an object or the profile is not an exact
 * compiler-owned identity.
 */
export function pinTarget(value: object, target: InternalTarget): void {
  assertObjectKey(value);
  const pinned = canonicalTarget(target);

  if (!pinned) throw new TypeError("Unsupported Hesperia compiler target profile.");

  const existing = targets.get(value);

  if (existing && !sameTarget(existing, pinned))
    throw new TypeError("A Hesperia compiler profile cannot be changed after it is pinned.");

  targets.set(value, pinned);
}

/**
 * Diagnose options that cannot be used with the compiler-owned terminal profile.
 *
 * Browser-profile options are left untouched. This allows ordinary browser callers to retain
 * custom runtime modules and the existing server/resume settings.
 *
 * @param options Compiler or project-checking options carrying the internal target marker.
 * @returns Terminal option errors, or an empty array for browser options and valid terminal
 * options.
 */
export function terminalOptionDiagnostics(
  options: CompileOptions | ProjectCheckingOptions,
): CompilerDiagnostic[] {
  assertObjectKey(options);

  if (targetFor(options).kind !== "terminal-cli") return [];

  const diagnostics: CompilerDiagnostic[] = [];

  if (hasDefinedOption(options, "renderTarget"))
    diagnostics.push(
      optionError("The terminal profile cannot select a server or resume render target."),
    );

  if (hasDefinedOption(options, "renderIdentity"))
    diagnostics.push(
      optionError("The terminal profile cannot use a server/resume render identity."),
    );

  if (options.browserTarget === true)
    diagnostics.push(optionError("The terminal profile cannot enable browser-target analysis."));

  if (options.runtimeModule !== undefined && options.runtimeModule !== TERMINAL_RUNTIME_MODULE)
    diagnostics.push(
      optionError("The terminal profile requires its fixed private runtime module."),
    );

  if (hasDefinedOption(options, "nativeGraphBridgeSpecifier"))
    diagnostics.push(
      optionError("The terminal profile cannot use the server-only native Graph bridge."),
    );

  if (hasDefinedOption(options, "compatible"))
    diagnostics.push(
      optionError("The terminal profile does not support compatible-update metadata."),
    );

  if (
    options.styleRuntimeModule !== undefined ||
    hasDefinedOption(options, "styleEntryId") ||
    hasDefinedOption(options, "styleIdentity")
  )
    diagnostics.push(
      optionError("The terminal profile does not support a CSS or style runtime plan."),
    );

  if (hasDefinedOption(options, "stylePreloadEntry"))
    diagnostics.push(optionError("The terminal profile does not support style preloading."));

  if (
    hasDefinedOption(options, "styledEntryIds") ||
    hasDefinedOption(options, "styleShellEntryId") ||
    hasDefinedOption(options, "styleIdentityRoot")
  )
    diagnostics.push(
      optionError("The terminal profile does not support project CSS entry metadata."),
    );

  if (options.documentShell === true)
    diagnostics.push(optionError("The terminal profile does not support a DOM document shell."));

  if (options.allowUnsafeHTML === true || options.allowUnsafeEmbed === true)
    diagnostics.push(optionError("The terminal profile does not support unsafe DOM capabilities."));

  return diagnostics;
}

/**
 * Build the private ambient JSX declarations for the terminal compiler profile.
 *
 * The declarations admit only the four version-1 intrinsics and the native values in the
 * accepted profile. OpenTUI references are TypeScript import types, so the generated checking
 * declarations introduce no runtime dependency. Finite numeric bounds, select option
 * nonemptiness/uniqueness, and dynamic value constraints remain host checks.
 *
 * @returns A global declaration source for terminal-profile checking.
 */
export function terminalJsxDeclarations(): string {
  return `
import type {
  InputRenderable as HesperiaTerminalInputRenderable,
  KeyEvent as HesperiaTerminalKeyEvent,
  SelectRenderable as HesperiaTerminalSelectRenderable,
} from "@opentui/core";
export {};
declare const HesperiaTerminalOutputBrand: unique symbol;
declare const HesperiaTerminalInvalidChildBrand: unique symbol;
declare global {
  type HesperiaTerminalOutput = { readonly [HesperiaTerminalOutputBrand]: "output" };
  type HesperiaTerminalInvalidChild = { readonly [HesperiaTerminalInvalidChildBrand]: "invalid-child" };
  type HesperiaTerminalScalar = string | number | boolean | null | undefined;
  type HesperiaTerminalNormalizeValue<Value> = Value extends void ? undefined : Value;
  type HesperiaTerminalChildValue<Value> =
    [HesperiaTerminalNormalizeValue<Value>] extends [HesperiaTerminalScalarChild] ? HesperiaTerminalNormalizeValue<Value> :
    [HesperiaTerminalNormalizeValue<Value>] extends [HesperiaTerminalSceneChild] ? HesperiaTerminalOutput : HesperiaTerminalInvalidChild;
  type HesperiaTerminalComponentValue<Value> = HesperiaTerminalChildValue<Value>;
  type HesperiaTerminalScalarChild = HesperiaTerminalScalar | readonly HesperiaTerminalScalarChild[];
  type HesperiaTerminalSceneChild = HesperiaTerminalScalar | HesperiaTerminalOutput | readonly HesperiaTerminalSceneChild[];
  type HesperiaTerminalFragmentValue<Children extends readonly unknown[]> =
    [Children[number]] extends [never] ? undefined :
    [Children[number]] extends [HesperiaTerminalScalarChild] ? Children[number] :
    [Children[number]] extends [HesperiaTerminalSceneChild] ? HesperiaTerminalOutput :
    HesperiaTerminalInvalidChild;
  type HesperiaTerminalDimension = number | "auto" | \`\u0024{number}%\`;
  type HesperiaTerminalGap = number | \`\u0024{number}%\`;
  type HesperiaTerminalFlexDirection = "column" | "column-reverse" | "row" | "row-reverse";
  interface HesperiaTerminalCommonProps { readonly key?: string | number; }
  interface HesperiaTerminalBoxProps extends HesperiaTerminalCommonProps {
    readonly width?: HesperiaTerminalDimension;
    readonly height?: HesperiaTerminalDimension;
    readonly flexDirection?: HesperiaTerminalFlexDirection;
    readonly gap?: HesperiaTerminalGap;
    readonly focusable?: boolean;
    readonly children?: HesperiaTerminalSceneChild | readonly HesperiaTerminalSceneChild[];
    readonly "on:keydown"?: (event: HesperiaTerminalKeyEvent) => unknown;
  }
  type HesperiaTerminalTextProps = HesperiaTerminalCommonProps & {
    readonly width?: HesperiaTerminalDimension;
    readonly height?: HesperiaTerminalDimension;
  } & (
    { readonly content: string; readonly children?: never } |
    { readonly content?: undefined; readonly children?: HesperiaTerminalScalarChild | readonly HesperiaTerminalScalarChild[] }
  );
  interface HesperiaTerminalInputProps extends HesperiaTerminalCommonProps {
    readonly value: string;
    readonly maxLength: number;
    readonly placeholder?: string;
    readonly width?: HesperiaTerminalDimension;
    readonly height?: never;
    readonly children?: never;
    readonly bind?: import("hesperia/runtime").Binding<HesperiaTerminalInputRenderable | undefined>;
    readonly "on:input"?: (value: string) => unknown;
    readonly "on:change"?: (value: string) => unknown;
    readonly "on:enter"?: (value: string) => unknown;
  }
  interface HesperiaTerminalOption {
    readonly key: string;
    readonly label: string;
    readonly description?: string;
  }
  interface HesperiaTerminalSelectionChanged {
    readonly key: string | null;
    readonly index: number;
  }
  interface HesperiaTerminalItemSelected {
    readonly key: string;
    readonly index: number;
  }
  interface HesperiaTerminalSelectProps extends HesperiaTerminalCommonProps {
    readonly height: number;
    readonly width?: HesperiaTerminalDimension;
    readonly options: readonly HesperiaTerminalOption[];
    readonly selectedIndex?: number;
    readonly children?: never;
    readonly bind?: import("hesperia/runtime").Binding<HesperiaTerminalSelectRenderable | undefined>;
    readonly "on:selectionChanged"?: (event: HesperiaTerminalSelectionChanged) => unknown;
    readonly "on:itemSelected"?: (event: HesperiaTerminalItemSelected) => unknown;
  }
  type HesperiaTerminalElementProps<K extends "box" | "input" | "select"> =
    K extends "box" ? HesperiaTerminalBoxProps :
    K extends "input" ? HesperiaTerminalInputProps : HesperiaTerminalSelectProps;
  type HesperiaTerminalElementChildren<K extends "box" | "input" | "select"> =
    K extends "box" ? readonly HesperiaTerminalSceneChild[] : readonly [];
  type HesperiaTerminalRendered = HesperiaTerminalOutput | HesperiaTerminalScalar | readonly HesperiaTerminalRendered[];
  interface HesperiaTerminalState<Value> {
    (): Value;
    set(value: Value): void;
    update(next: (current: Value) => Value): void;
    readonly source: import("aeolia").WritableSignal<Value>;
  }
  interface HesperiaTerminalDerived<Value> {
    (): Value;
    readonly source: import("aeolia").Computed<Value>;
  }
  type HesperiaTerminalEffect = () => void | (() => void);
  interface HesperiaTerminalClient {
    state<Value>(initial: Value, options?: import("aeolia").SignalOptions<Value>): HesperiaTerminalState<Value>;
    derived<Value>(compute: () => Value, options?: import("aeolia").SignalOptions<Value>): HesperiaTerminalDerived<Value>;
    effect(run: HesperiaTerminalEffect): void;
    cleanup(run: () => void): void;
    bind<Value>(): import("hesperia/runtime").Binding<Value>;
    unsafeBind<Value>(): import("hesperia/runtime").Binding<Value | undefined>;
  }
  interface HesperiaTerminalComponent<P = Record<string, never>> {
    (props: import("hesperia/runtime").ComponentProps<P>): HesperiaTerminalRendered;
  }
  function __hesperia_fragment<const Children extends readonly unknown[]>(children: Children): HesperiaTerminalFragmentValue<Children>;
  function __hesperia_child<Value>(read: () => Value): HesperiaTerminalChildValue<Value>;
  function __hesperia_component<R>(definition: () => R, props: import("hesperia/runtime").CallerProps<{}> & HesperiaTerminalCommonProps): HesperiaTerminalComponentValue<R>;
  function __hesperia_component<P>(definition: import("hesperia/runtime").Component<P>, props: import("hesperia/runtime").CallerProps<P> & HesperiaTerminalCommonProps): HesperiaTerminalOutput;
  function __hesperia_component<P, R>(definition: (props: import("hesperia/runtime").ComponentProps<P>) => R, props: import("hesperia/runtime").CallerProps<P> & HesperiaTerminalCommonProps): HesperiaTerminalComponentValue<R>;
  function __hesperia_component<B, R>(definition: (props: B) => R, props: HesperiaCallerProps<B>): HesperiaTerminalComponentValue<R>;
  function __hesperia_element<K extends "box" | "input" | "select", N extends "terminal">(tag: K, namespace: N, props: HesperiaTerminalElementProps<K>, children: HesperiaTerminalElementChildren<K>): HesperiaTerminalOutput;
  function __hesperia_element<K extends "text", N extends "terminal">(tag: K, namespace: N, props: HesperiaTerminalTextProps & { readonly content: string }, children: readonly []): HesperiaTerminalOutput;
  function __hesperia_element<K extends "text", N extends "terminal">(tag: K, namespace: N, props: HesperiaTerminalTextProps & { readonly content?: undefined }, children: readonly HesperiaTerminalScalarChild[]): HesperiaTerminalOutput;
  namespace JSX {
    type Element = HesperiaTerminalOutput;
    interface ElementClass {}
    interface ElementChildrenAttribute { children: {}; }
    interface IntrinsicElements {
      box: HesperiaTerminalBoxProps;
      text: HesperiaTerminalTextProps;
      input: HesperiaTerminalInputProps;
      select: HesperiaTerminalSelectProps;
    }
  }
}
type HesperiaCallerProps<B> = B extends import("hesperia/runtime").ComponentProps<infer P> ? import("hesperia/runtime").CallerProps<P> & { readonly key?: string | number } : never;
type HesperiaPagePropsBrand<P> = import("hesperia/runtime").PagePropsBrand<P>;
type HesperiaCheckedContractApi<C extends import("aeolia").Contract> = import("hesperia/aeolia").ImportedApi<C>;
type HesperiaCheckedAeoliaApi<C extends import("aeolia").Contract> = import("aeolia").ContractApi<C>;
type HesperiaCheckedStoreOptions<T> = import("aeolia").StoreOptions<T>;
type HesperiaCheckedMutationOptions = import("aeolia").MutationOptions;
type HesperiaCheckedQueryOptions = typeof import("aeolia").queryOptions;
`;
}

/**
 * Build private ambient modules used only by the terminal checking snapshot.
 *
 * This source must remain a script declaration file. Top-level imports or exports would turn the
 * declarations into augmentations of modules that do not exist.
 *
 * @returns Ambient declarations for the two rewritten Hesperia runtime imports.
 */
export function terminalCheckingModuleDeclarations(): string {
  return `
declare module "${TERMINAL_CLIENT_TYPES_MODULE}" {
  export const client: HesperiaTerminalClient;
  export const state: HesperiaTerminalClient["state"];
  export const derived: HesperiaTerminalClient["derived"];
  export const effect: HesperiaTerminalClient["effect"];
  export const cleanup: HesperiaTerminalClient["cleanup"];
  export const bind: HesperiaTerminalClient["bind"];
  export const unsafeBind: HesperiaTerminalClient["unsafeBind"];
  export type Accessor<Value> = () => Value;
  export type Client = HesperiaTerminalClient;
  export type Derived<Value> = HesperiaTerminalDerived<Value>;
  export type Effect = HesperiaTerminalEffect;
  export type State<Value> = HesperiaTerminalState<Value>;
  export type Binding<Value> = import("hesperia/runtime").Binding<Value>;
  export type WritableBinding<Value> = import("hesperia/runtime").WritableBinding<Value>;
}

declare module "${TERMINAL_ROOT_TYPES_MODULE}" {
  export const client: HesperiaTerminalClient;
  export interface Component<P = Record<string, never>> extends HesperiaTerminalComponent<P> {}
  export namespace Component {
    export type Props<P = Record<string, never>> = import("hesperia/runtime").ComponentProps<P>;
  }
  export type Accessor<Value> = () => Value;
  export type Client = HesperiaTerminalClient;
  export type ComponentProps<P> = import("hesperia/runtime").ComponentProps<P>;
  export type CallerProps<P> = import("hesperia/runtime").CallerProps<P>;
  export type Derived<Value> = HesperiaTerminalDerived<Value>;
  export type Effect = HesperiaTerminalEffect;
  export type State<Value> = HesperiaTerminalState<Value>;
  export type Binding<Value> = import("hesperia/runtime").Binding<Value>;
  export type WritableBinding<Value> = import("hesperia/runtime").WritableBinding<Value>;
  export type Rendered = HesperiaTerminalRendered;
  export type RenderFault = import("hesperia/runtime").RenderFault;
}
`;
}

/**
 * Check one canonical terminal intrinsic against the fixed version-1 property and tree profile.
 *
 * This helper checks known literals and authored tree structure. Values that are dynamic at
 * checking time still need validation at the host mutation boundary; a TypeScript `number` type
 * does not prove finiteness, nonnegativity, integer bounds, or select-option uniqueness.
 *
 * @param element Canonical intrinsic element to admit.
 * @returns Diagnostics at the element, attribute, or child span for unsupported terminal input.
 */
export function terminalElementDiagnostics(element: CanonicalElement): CompilerDiagnostic[] {
  const diagnostics: CompilerDiagnostic[] = [];
  const tag = element.tag;

  if (element.namespace !== "terminal")
    diagnostics.push(
      terminalElementError(
        "Terminal intrinsics must use the compiler-owned terminal namespace.",
        element.span,
      ),
    );

  if (tag !== "box" && tag !== "text" && tag !== "input" && tag !== "select") {
    diagnostics.push(
      terminalElementError(`Unsupported terminal intrinsic <${tag}>.`, element.span),
    );

    return diagnostics;
  }

  const allowedProperties = terminalProperties[tag];
  const allowedEvents = terminalEvents[tag];
  const optionsLength = terminalStaticOptionsLength(element);

  for (const attribute of element.attributes) {
    if (attribute.kind === "event") {
      if (!allowedEvents.has(attribute.name))
        diagnostics.push(
          terminalElementError(
            `Event on:${attribute.name} is not supported on <${tag}>.`,
            attribute.span,
          ),
        );

      continue;
    }

    if (!allowedProperties.has(attribute.name)) {
      diagnostics.push(
        terminalElementError(
          `Property ${attribute.name} is not supported on <${tag}>.`,
          attribute.span,
        ),
      );

      continue;
    }

    if (attribute.name === "bind") {
      if (
        (tag !== "input" && tag !== "select") ||
        attribute.kind !== "dynamic" ||
        attribute.mode !== "binding"
      )
        diagnostics.push(
          terminalElementError(
            "bind must be a typed binding on an input or select intrinsic.",
            attribute.span,
          ),
        );

      continue;
    }

    if (attribute.kind === "dynamic" && attribute.mode !== "property")
      diagnostics.push(
        terminalElementError(
          `Property ${attribute.name} must use a checked property value.`,
          attribute.span,
        ),
      );

    const value = terminalAttributeValue(attribute);

    if (value === UNKNOWN_STATIC) continue;

    diagnostics.push(
      ...terminalPropertyValueDiagnostics(
        tag,
        attribute.name,
        value,
        attribute.span,
        optionsLength,
      ),
    );
  }

  for (const required of terminalRequiredProperties[tag])
    if (
      !element.attributes.some(
        (attribute) => attribute.kind !== "event" && attribute.name === required,
      )
    )
      diagnostics.push(
        terminalElementError(`The <${tag}> intrinsic requires ${required}.`, element.span),
      );

  if (tag === "text") {
    const content = element.attributes.some(
      (attribute) => attribute.kind !== "event" && attribute.name === "content",
    );

    if (content && element.children.length > 0)
      diagnostics.push(
        terminalElementError(
          "A text intrinsic with content cannot also have children.",
          element.span,
        ),
      );

    if (!content)
      for (const child of element.children)
        diagnostics.push(...terminalTextChildDiagnostics(child));
  }

  if ((tag === "input" || tag === "select") && element.children.length > 0)
    diagnostics.push(
      terminalElementError(`The <${tag}> intrinsic cannot have children.`, element.span),
    );

  return diagnostics;
}

/**
 * Admit the finite render-time capabilities available to one terminal-profile module.
 *
 * Type-only imports have already been erased from canonical imports. Runtime imports are limited
 * to the compiler-bound client operations. Supported client values retain ordinary JavaScript
 * alias and callback semantics; unsupported client members and direct host-package imports are
 * diagnosed. Ordinary statically targeted dynamic imports remain available.
 *
 * @param module Canonical module produced from the checked source snapshot.
 * @param checkedComponentRoles Whether checked prop metadata has been attached to component
 * factories before verifying owner-bound client references.
 * @returns Intrinsic, import, client-capability, and unsupported rendering diagnostics.
 */
export function terminalModuleDiagnostics(
  module: CanonicalModule,
  checkedComponentRoles = false,
): CompilerDiagnostic[] {
  const diagnostics: CompilerDiagnostic[] = [];
  const capabilities = new Map<string, TerminalCapability>();

  for (const statement of module.body) {
    if (statement.kind === "import") {
      terminalImportDiagnostics(statement, capabilities, diagnostics);
      continue;
    }

    if (
      (statement.kind === "export-list" || statement.kind === "export-all") &&
      statement.source !== null &&
      isTerminalRuntimeSpecifier(statement.source)
    )
      diagnostics.push(
        terminalModuleError(
          `Runtime re-exports from ${statement.source} are not supported by the terminal profile.`,
          statement.span,
        ),
      );
  }

  addTerminalCapabilityAliases(module.body, capabilities);
  const requireBindings = terminalRequireBindings(module.body);

  const visited = new Set<object>();
  const visit = (value: unknown, ownerAvailable: boolean): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, ownerAvailable);

      return;
    }

    if (typeof value !== "object" || value === null || visited.has(value)) return;

    visited.add(value);

    const record = value as Record<string, unknown>;
    const kind = record.kind;
    const childOwnerAvailable =
      ownerAvailable || (checkedComponentRoles && isTerminalComponentFactory(value));

    if (kind === "element")
      diagnostics.push(...terminalElementDiagnostics(value as unknown as CanonicalElement));

    if (kind === "await-child")
      diagnostics.push(
        terminalModuleError(
          "Awaited component rendering is not supported by the terminal profile.",
          sourceSpan(record.span),
        ),
      );

    if (kind === "raw-html")
      diagnostics.push(
        terminalModuleError(
          "Raw HTML rendering is not supported by the terminal profile.",
          sourceSpan(record.span),
        ),
      );

    if (
      kind === "component" &&
      typeof record.reference === "object" &&
      record.reference !== null &&
      (record.reference as Record<string, unknown>).kind === "identifier" &&
      (record.reference as Record<string, unknown>).name === "AsyncBoundary"
    )
      diagnostics.push(
        terminalModuleError(
          "AsyncBoundary rendering is not supported by the terminal profile.",
          sourceSpan(record.span),
        ),
      );

    if (isTerminalAsyncComponent(value))
      diagnostics.push(
        terminalModuleError(
          "Async render components are not supported by the terminal profile.",
          sourceSpan(record.span),
        ),
      );

    if (kind === "import-expression") {
      const importedSource = terminalStaticValue(record.source as CanonicalExpression);

      if (typeof importedSource !== "string" || isTerminalRuntimeSpecifier(importedSource))
        diagnostics.push(
          terminalModuleError(
            "A terminal dynamic import must have a static target outside the Hesperia and OpenTUI runtime packages.",
            sourceSpan(record.span),
          ),
        );
    }

    if (
      kind === "call" &&
      isTerminalRequireReference(record.callee, requireBindings) &&
      terminalRequireTargetIsUnsupported(record.arguments)
    )
      diagnostics.push(
        terminalModuleError(
          "CommonJS require cannot load Hesperia or OpenTUI runtime packages in the terminal profile.",
          sourceSpan(record.span),
        ),
      );

    if (
      kind === "identifier" &&
      typeof record.name === "string" &&
      isUnresolvedIdentifier(value, record.name)
    )
      terminalBrowserGlobalDiagnostics(record, diagnostics);

    if (
      checkedComponentRoles &&
      !ownerAvailable &&
      kind === "identifier" &&
      typeof record.referenceId === "string" &&
      capabilities.has(record.referenceId)
    )
      diagnostics.push(
        terminalModuleError(
          "Owner-bound terminal client values cannot be referenced outside a checked component factory.",
          sourceSpan(record.span),
        ),
      );

    if (kind === "member") {
      const capability = terminalCapabilityForExpression(record.object, capabilities);

      if (capability) terminalMemberDiagnostics(record, capability, diagnostics);

      terminalGlobalThisMemberDiagnostics(record, diagnostics);
    }

    if (
      checkedComponentRoles &&
      !ownerAvailable &&
      kind === "export-list" &&
      record.source === null &&
      Array.isArray(record.specifiers)
    )
      for (const specifier of record.specifiers) {
        if (typeof specifier !== "object" || specifier === null) continue;

        const referenceId = (specifier as Record<string, unknown>).referenceId;

        if (typeof referenceId === "string" && capabilities.has(referenceId))
          diagnostics.push(
            terminalModuleError(
              "Owner-bound terminal client values cannot be exported from module scope.",
              sourceSpan(record.span),
            ),
          );
      }

    for (const nested of Object.values(record))
      if (nested !== record.span && nested !== record.diagnostics)
        visit(nested, childOwnerAvailable);
  };

  visit(module.body, false);

  return uniqueDiagnostics(diagnostics);
}

type TerminalClientOperation = "state" | "derived" | "effect" | "cleanup" | "bind" | "unsafeBind";

type TerminalCapability =
  | { readonly kind: "client" }
  | { readonly kind: "namespace" }
  | { readonly kind: "operation"; readonly operation: TerminalClientOperation };

const terminalClientOperations = new Set<TerminalClientOperation>([
  "state",
  "derived",
  "effect",
  "cleanup",
  "bind",
  "unsafeBind",
]);

const terminalBrowserGlobals = new Set([
  "window",
  "self",
  "document",
  "navigator",
  "location",
  "history",
  "localStorage",
  "sessionStorage",
  "customElements",
  "Node",
  "Element",
  "HTMLElement",
  "SVGElement",
  "Document",
  "DocumentFragment",
  "Text",
  "Comment",
  "Event",
  "EventTarget",
  "CustomEvent",
  "MouseEvent",
  "KeyboardEvent",
  "PointerEvent",
  "InputEvent",
  "FocusEvent",
  "UIEvent",
  "WheelEvent",
  "DragEvent",
  "ClipboardEvent",
  "MessageEvent",
  "ProgressEvent",
  "StorageEvent",
  "AnimationEvent",
  "TransitionEvent",
  "ErrorEvent",
  "HTMLInputElement",
  "HTMLSelectElement",
  "HTMLTextAreaElement",
  "HTMLButtonElement",
  "HTMLFormElement",
  "HTMLDivElement",
  "HTMLCanvasElement",
  "HTMLCollection",
  "NodeList",
  "DOMParser",
  "Range",
  "ShadowRoot",
  "CSSStyleDeclaration",
  "CSSStyleSheet",
  "DOMRect",
  "DOMTokenList",
  "MutationObserver",
  "ResizeObserver",
  "IntersectionObserver",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "requestIdleCallback",
  "cancelIdleCallback",
  "getComputedStyle",
  "matchMedia",
]);

function terminalRequireBindings(statements: readonly CanonicalStatement[]): ReadonlySet<string> {
  const bindings = new Set(["unresolved/require"]);
  const aliases: { bindingId: string; referenceId: string }[] = [];
  const visited = new Set<object>();
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) collect(item);

      return;
    }

    if (typeof value !== "object" || value === null || visited.has(value)) return;

    visited.add(value);

    const record = value as Record<string, unknown>;

    if (
      record.kind === "variable" &&
      record.declarationKind === "const" &&
      Array.isArray(record.declarations)
    )
      for (const declaration of record.declarations) {
        if (typeof declaration !== "object" || declaration === null) continue;

        const entry = declaration as Record<string, unknown>;
        const pattern = entry.pattern;
        const initializer = entry.initializer;

        if (
          typeof pattern === "object" &&
          pattern !== null &&
          (pattern as Record<string, unknown>).kind === "identifier" &&
          typeof (pattern as Record<string, unknown>).bindingId === "string" &&
          typeof initializer === "object" &&
          initializer !== null &&
          (initializer as Record<string, unknown>).kind === "identifier" &&
          typeof (initializer as Record<string, unknown>).referenceId === "string"
        )
          aliases.push({
            bindingId: (pattern as Record<string, unknown>).bindingId as string,
            referenceId: (initializer as Record<string, unknown>).referenceId as string,
          });
      }

    for (const nested of Object.values(record))
      if (nested !== record.span && nested !== record.diagnostics) collect(nested);
  };

  collect(statements);

  for (let remaining = aliases.length; remaining > 0; remaining--) {
    let changed = false;

    for (const alias of aliases) {
      if (!bindings.has(alias.referenceId) || bindings.has(alias.bindingId)) continue;

      bindings.add(alias.bindingId);
      changed = true;
    }

    if (!changed) break;
  }

  return bindings;
}

function isTerminalRequireReference(value: unknown, bindings: ReadonlySet<string>): boolean {
  if (typeof value !== "object" || value === null) return false;

  const record = value as Record<string, unknown>;

  return (
    record.kind === "identifier" &&
    typeof record.referenceId === "string" &&
    bindings.has(record.referenceId)
  );
}

function addTerminalCapabilityAliases(
  statements: readonly CanonicalStatement[],
  capabilities: Map<string, TerminalCapability>,
): void {
  const aliases: { bindingId: string; initializer: CanonicalExpression }[] = [];
  const visited = new Set<object>();
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) collect(item);

      return;
    }

    if (typeof value !== "object" || value === null || visited.has(value)) return;

    visited.add(value);

    const record = value as Record<string, unknown>;

    if (
      record.kind === "variable" &&
      record.declarationKind === "const" &&
      Array.isArray(record.declarations)
    )
      for (const declaration of record.declarations) {
        if (typeof declaration !== "object" || declaration === null) continue;

        const entry = declaration as Record<string, unknown>;
        const pattern = entry.pattern;
        const initializer = entry.initializer;

        if (
          typeof pattern === "object" &&
          pattern !== null &&
          (pattern as Record<string, unknown>).kind === "identifier" &&
          typeof (pattern as Record<string, unknown>).bindingId === "string" &&
          typeof initializer === "object" &&
          initializer !== null &&
          typeof (initializer as Record<string, unknown>).kind === "string"
        )
          aliases.push({
            bindingId: (pattern as Record<string, unknown>).bindingId as string,
            initializer: initializer as CanonicalExpression,
          });
      }

    for (const nested of Object.values(record))
      if (nested !== record.span && nested !== record.diagnostics) collect(nested);
  };

  collect(statements);

  for (let remaining = aliases.length; remaining > 0; remaining--) {
    let changed = false;

    for (const alias of aliases) {
      if (capabilities.has(alias.bindingId)) continue;

      const capability = terminalCapabilityForExpression(alias.initializer, capabilities);

      if (!capability) continue;

      capabilities.set(alias.bindingId, capability);
      changed = true;
    }

    if (!changed) return;
  }
}

function terminalImportDiagnostics(
  statement: Extract<CanonicalStatement, { readonly kind: "import" }>,
  capabilities: Map<string, TerminalCapability>,
  diagnostics: CompilerDiagnostic[],
): void {
  const isClientModule = statement.source === "hesperia/client";
  const isRootModule = statement.source === "hesperia";

  if (!isClientModule && !isRootModule) {
    if (isTerminalRuntimeSpecifier(statement.source))
      diagnostics.push(
        terminalModuleError(
          `Runtime imports from ${statement.source} are not supported by the terminal profile.`,
          statement.span,
        ),
      );

    return;
  }

  if (statement.specifiers.length === 0) {
    diagnostics.push(
      terminalModuleError(
        `Side-effect imports from ${statement.source} are not supported by the terminal profile.`,
        statement.span,
      ),
    );

    return;
  }

  for (const specifier of statement.specifiers) {
    let capability: TerminalCapability | undefined;

    if (isClientModule && specifier.kind === "namespace") {
      capability = { kind: "namespace" };
    } else if (specifier.kind === "named" && specifier.imported === "client") {
      capability = { kind: "client" };
    } else if (
      isClientModule &&
      specifier.kind === "named" &&
      terminalClientOperations.has(specifier.imported as TerminalClientOperation)
    ) {
      capability = {
        kind: "operation",
        operation: specifier.imported as TerminalClientOperation,
      };
    }

    if (!capability) {
      const imported = specifier.kind === "named" ? specifier.imported : specifier.kind;
      diagnostics.push(
        terminalModuleError(
          isRootModule
            ? `The terminal profile only permits the hesperia root runtime value client, not ${imported}.`
            : `The hesperia/client runtime value ${imported} is not supported by the terminal profile.`,
          statement.span,
        ),
      );

      continue;
    }

    if (!specifier.bindingId) {
      diagnostics.push(
        terminalModuleError(
          `The terminal profile could not resolve imported runtime value ${specifier.local}.`,
          statement.span,
        ),
      );

      continue;
    }

    capabilities.set(specifier.bindingId, capability);
  }
}

function isTerminalRuntimeSpecifier(source: string): boolean {
  return (
    source === "hesperia" ||
    source.startsWith("hesperia/") ||
    source.startsWith("hesperia:") ||
    source === "@opentui/core" ||
    source.startsWith("@opentui/")
  );
}

function terminalCapabilityForExpression(
  value: unknown,
  capabilities: ReadonlyMap<string, TerminalCapability>,
): TerminalCapability | undefined {
  if (typeof value !== "object" || value === null) return undefined;

  const expression = value as Record<string, unknown>;

  if (expression.kind === "identifier" && typeof expression.referenceId === "string")
    return capabilities.get(expression.referenceId);

  if (expression.kind !== "member") return undefined;

  const parentCapability = terminalCapabilityForExpression(expression.object, capabilities);
  const operation = terminalMemberName(expression);

  return parentCapability &&
    parentCapability.kind !== "operation" &&
    operation !== undefined &&
    terminalClientOperations.has(operation as TerminalClientOperation)
    ? { kind: "operation", operation: operation as TerminalClientOperation }
    : undefined;
}

function terminalMemberDiagnostics(
  member: Record<string, unknown>,
  capability: TerminalCapability,
  diagnostics: CompilerDiagnostic[],
): void {
  if (capability.kind === "operation") return;

  const operation = terminalMemberName(member);

  if (!operation || !terminalClientOperations.has(operation as TerminalClientOperation)) {
    const requested = operation ?? "computed or dynamic";
    diagnostics.push(
      terminalModuleError(
        `Terminal client member ${requested} is not supported.`,
        sourceSpan(member.span),
      ),
    );

    return;
  }
}

function terminalMemberName(member: Record<string, unknown>): string | undefined {
  const property = member.property;

  if (typeof property !== "object" || property === null) return undefined;

  const propertyRecord = property as Record<string, unknown>;

  if (member.computed === true)
    return propertyRecord.kind === "literal" && typeof propertyRecord.value === "string"
      ? propertyRecord.value
      : undefined;

  return propertyRecord.kind === "identifier" && typeof propertyRecord.name === "string"
    ? propertyRecord.name
    : undefined;
}

function sourceSpan(value: unknown): SourceSpan {
  if (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).start === "number" &&
    typeof (value as Record<string, unknown>).end === "number"
  )
    return value as unknown as SourceSpan;

  return { start: 0, end: 0 };
}

function isTerminalComponentFactory(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;

  const record = value as Record<string, unknown>;

  if (record.kind === "function")
    return (
      record.generator !== true &&
      (record.component === true ||
        record.props !== undefined ||
        (typeof record.body === "object" &&
          record.body !== null &&
          isComponentBody(record.body as CanonicalStatementBlock)))
    );

  if (record.kind === "arrow") return isComponentArrow(value as CanonicalExpression);

  if (record.kind === "function-expression")
    return isComponentFunctionExpression(value as CanonicalExpression);

  return false;
}

function isTerminalAsyncComponent(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).async === true &&
    isTerminalComponentFactory(value)
  );
}

function terminalRequireTargetIsUnsupported(argumentsValue: unknown): boolean {
  if (!Array.isArray(argumentsValue) || argumentsValue.length === 0) return false;

  const argument = argumentsValue[0];

  if (typeof argument !== "object" || argument === null) return false;

  const record = argument as Record<string, unknown>;

  if (record.kind === "spread") return false;

  const target = terminalStaticValue(argument as CanonicalExpression);

  return typeof target === "string" && isTerminalRuntimeSpecifier(target);
}

function isUnresolvedIdentifier(value: unknown, name: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).kind === "identifier" &&
    (value as Record<string, unknown>).name === name &&
    (value as Record<string, unknown>).referenceId === `unresolved/${name}`
  );
}

function terminalBrowserGlobalDiagnostics(
  identifier: Record<string, unknown>,
  diagnostics: CompilerDiagnostic[],
): void {
  const name = identifier.name;

  if (typeof name === "string" && terminalBrowserGlobals.has(name))
    diagnostics.push(
      terminalModuleError(
        `Browser global ${name} is not available in the terminal profile.`,
        sourceSpan(identifier.span),
      ),
    );
}

function terminalGlobalThisMemberDiagnostics(
  member: Record<string, unknown>,
  diagnostics: CompilerDiagnostic[],
): void {
  if (!isUnresolvedIdentifier(member.object, "globalThis") || typeof member.computed !== "boolean")
    return;

  const property = terminalMemberName(member);

  if (property && terminalBrowserGlobals.has(property))
    diagnostics.push(
      terminalModuleError(
        `Browser global globalThis.${property} is not available in the terminal profile.`,
        sourceSpan(member.span),
      ),
    );
}

function terminalModuleError(message: string, span: SourceSpan): CompilerDiagnostic {
  return {
    code: "HES-TERMINAL-MODULE",
    severity: "error",
    message,
    span,
  };
}

type TerminalIntrinsicTag = "box" | "text" | "input" | "select";

const terminalProperties = {
  box: new Set(["key", "width", "height", "flexDirection", "gap", "focusable"]),
  text: new Set(["key", "width", "height", "content"]),
  input: new Set(["key", "value", "maxLength", "placeholder", "width", "bind"]),
  select: new Set(["key", "height", "width", "options", "selectedIndex", "bind"]),
} satisfies Readonly<Record<TerminalIntrinsicTag, ReadonlySet<string>>>;

const terminalEvents = {
  box: new Set(["keydown"]),
  text: new Set<string>(),
  input: new Set(["input", "change", "enter"]),
  select: new Set(["selectionChanged", "itemSelected"]),
} satisfies Readonly<Record<TerminalIntrinsicTag, ReadonlySet<string>>>;

const terminalRequiredProperties = {
  box: [],
  text: [],
  input: ["value", "maxLength"],
  select: ["height", "options"],
} satisfies Readonly<Record<TerminalIntrinsicTag, readonly string[]>>;

const UNKNOWN_STATIC = Symbol("unknown-terminal-static-value");

type UnknownStaticValue = typeof UNKNOWN_STATIC;

function terminalPropertyValueDiagnostics(
  tag: TerminalIntrinsicTag,
  name: string,
  value: unknown | UnknownStaticValue,
  span: SourceSpan,
  optionsLength: number | undefined,
): CompilerDiagnostic[] {
  if (value === UNKNOWN_STATIC) return [];

  const required: readonly string[] = terminalRequiredProperties[tag];

  if (value === undefined && !required.includes(name)) return [];

  if (name === "key")
    return typeof value === "string" || typeof value === "number"
      ? []
      : [terminalElementError("key must be a string or number.", span)];

  if (name === "width" || (name === "height" && tag !== "select"))
    return isTerminalDimension(value)
      ? []
      : [terminalElementError(`${name} must be a nonnegative number, percentage, or auto.`, span)];

  if (name === "height" && tag === "select")
    return isPositiveInteger(value)
      ? []
      : [terminalElementError("select height must be a positive integer row count.", span)];

  if (name === "gap")
    return isTerminalGap(value)
      ? []
      : [terminalElementError("gap must be a finite nonnegative number or percentage.", span)];

  if (name === "flexDirection")
    return value === "column" ||
      value === "column-reverse" ||
      value === "row" ||
      value === "row-reverse"
      ? []
      : [terminalElementError("flexDirection is not supported by the terminal profile.", span)];

  if (name === "focusable")
    return typeof value === "boolean"
      ? []
      : [terminalElementError("focusable must be a boolean.", span)];

  if (name === "content" || name === "value" || name === "placeholder")
    return typeof value === "string"
      ? []
      : [terminalElementError(`${name} must be a string.`, span)];

  if (name === "maxLength")
    return isNonnegativeInteger(value)
      ? []
      : [terminalElementError("maxLength must be a finite nonnegative integer.", span)];

  if (name === "selectedIndex") {
    if (!isNonnegativeInteger(value))
      return [terminalElementError("selectedIndex must be a finite nonnegative integer.", span)];

    return optionsLength === undefined || value < optionsLength
      ? []
      : [
          terminalElementError(
            "selectedIndex must be smaller than the select options length.",
            span,
          ),
        ];
  }

  if (name === "options") return terminalOptionsDiagnostics(value, span);

  return [];
}

function terminalStaticOptionsLength(element: CanonicalElement): number | undefined {
  const attribute = [...element.attributes]
    .reverse()
    .find((item) => item.kind !== "event" && item.name === "options");

  if (!attribute || attribute.kind === "event") return undefined;

  const value = terminalAttributeValue(attribute);

  return Array.isArray(value) ? value.length : undefined;
}

function terminalOptionsDiagnostics(
  value: unknown | UnknownStaticValue,
  span: SourceSpan,
): CompilerDiagnostic[] {
  if (value === UNKNOWN_STATIC) return [];

  if (!Array.isArray(value))
    return [terminalElementError("select options must be an array of option records.", span)];

  if (value.length === 0)
    return [terminalElementError("select options must contain at least one option.", span)];

  const diagnostics: CompilerDiagnostic[] = [];
  const keys = new Set<string>();

  for (const option of value) {
    if (!isStaticRecord(option)) {
      diagnostics.push(terminalElementError("Each select option must be a static record.", span));

      continue;
    }

    const fields = Object.keys(option);

    for (const field of fields)
      if (field !== "key" && field !== "label" && field !== "description")
        diagnostics.push(
          terminalElementError(`Select option property ${field} is not supported.`, span),
        );

    if (typeof option.key !== "string")
      diagnostics.push(terminalElementError("Each select option requires a string key.", span));
    else if (keys.has(option.key))
      diagnostics.push(terminalElementError("Select option keys must be distinct.", span));
    else keys.add(option.key);

    if (typeof option.label !== "string")
      diagnostics.push(terminalElementError("Each select option requires a string label.", span));

    if (option.description !== undefined && typeof option.description !== "string")
      diagnostics.push(terminalElementError("Select option descriptions must be strings.", span));
  }

  return diagnostics;
}

function terminalTextChildDiagnostics(child: CanonicalChild): CompilerDiagnostic[] {
  if (child.kind === "text") return [];

  if (child.kind === "dynamic-child") {
    const value = terminalStaticValue(child.expression);

    return value !== UNKNOWN_STATIC && !isTerminalScalarStream(value)
      ? [terminalElementError("Text children must resolve to scalar values.", child.span)]
      : [];
  }

  if (child.kind === "fragment") return child.children.flatMap(terminalTextChildDiagnostics);

  if (child.kind === "conditional")
    return [
      ...(child.consequent ? terminalTextChildDiagnostics(child.consequent) : []),
      ...(child.alternate ? terminalTextChildDiagnostics(child.alternate) : []),
    ];

  if (child.kind === "component") return [];

  return [
    terminalElementError(
      child.kind === "list"
        ? "Keyed ranges are not supported inside a text intrinsic."
        : "Text children cannot contain scene or asynchronous output.",
      child.span,
    ),
  ];
}

function terminalAttributeValue(
  attribute: Exclude<CanonicalAttribute, { readonly kind: "event" }>,
): unknown | UnknownStaticValue {
  return attribute.kind === "static" ? attribute.value : terminalStaticValue(attribute.expression);
}

function terminalStaticValue(expression: CanonicalExpression): unknown | UnknownStaticValue {
  if (expression.kind === "literal") return expression.value;

  if (expression.kind === "undefined") return undefined;

  if (expression.kind === "unary") {
    const argument = terminalStaticValue(expression.argument);

    if (argument === UNKNOWN_STATIC) return UNKNOWN_STATIC;

    if (expression.operator === "-" && typeof argument === "number") return -argument;
    if (expression.operator === "+" && typeof argument === "number") return argument;
    if (expression.operator === "!" && isTerminalScalar(argument)) return !argument;

    return UNKNOWN_STATIC;
  }

  if (expression.kind === "template")
    return expression.expressions.length === 0 &&
      expression.quasis.length === 1 &&
      expression.quasis[0]?.cooked !== null
      ? (expression.quasis[0]?.cooked ?? UNKNOWN_STATIC)
      : UNKNOWN_STATIC;

  if (expression.kind === "conditional") {
    const test = terminalStaticValue(expression.test);

    if (test === UNKNOWN_STATIC) return UNKNOWN_STATIC;

    return terminalStaticValue(test ? expression.consequent : expression.alternate);
  }

  if (expression.kind === "array") {
    const values: unknown[] = [];

    for (const element of expression.elements) {
      if (element === null) {
        values.push(undefined);

        continue;
      }

      if ("kind" in element && element.kind === "spread") return UNKNOWN_STATIC;

      const value = terminalStaticValue(element);

      if (value === UNKNOWN_STATIC) return UNKNOWN_STATIC;

      values.push(value);
    }

    return values;
  }

  if (expression.kind === "object") {
    const value: Record<string, unknown> = Object.create(null);

    for (const property of expression.properties) {
      if (
        property.kind === "spread" ||
        property.method ||
        (property.propertyKind !== undefined && property.propertyKind !== "init")
      )
        return UNKNOWN_STATIC;

      const key = typeof property.key === "string" ? property.key : staticPropertyKey(property.key);
      const entry = terminalStaticValue(property.value);

      if (typeof key !== "string") return UNKNOWN_STATIC;

      if (entry === UNKNOWN_STATIC || key === "__proto__") return UNKNOWN_STATIC;

      value[key] = entry;
    }

    return value;
  }

  return UNKNOWN_STATIC;
}

function staticPropertyKey(expression: CanonicalExpression): string | UnknownStaticValue {
  const key = terminalStaticValue(expression);

  return typeof key === "string" || typeof key === "number" ? String(key) : UNKNOWN_STATIC;
}

function isStaticRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTerminalScalar(value: unknown): value is string | number | boolean | null | undefined {
  return (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function isTerminalScalarStream(value: unknown): boolean {
  return isTerminalScalar(value) || (Array.isArray(value) && value.every(isTerminalScalarStream));
}

function isTerminalDimension(value: unknown): boolean {
  return value === "auto" || isNonnegativeNumber(value) || isTerminalPercentage(value);
}

function isTerminalGap(value: unknown): boolean {
  return isNonnegativeNumber(value) || isTerminalPercentage(value);
}

function isNonnegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonnegativeInteger(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0
  );
}

function isPositiveInteger(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0
  );
}

function isTerminalPercentage(value: unknown): value is string {
  if (typeof value !== "string" || !/^(?:\d+(?:\.\d+)?|\.\d+)%$/u.test(value)) return false;

  return Number.isFinite(Number(value.slice(0, -1)));
}

function terminalElementError(message: string, span: SourceSpan): CompilerDiagnostic {
  return {
    code: "HES-TERMINAL-INTRINSIC",
    severity: "error",
    message,
    span,
  };
}

/**
 * Compare a checked session or analysis with options before a direct emission call.
 *
 * Use this helper at the `emitAnalysis` boundary, where no retained project session is available.
 * For a session it also checks every retained analysis, so a profile marker cannot be lost on one
 * derived analysis object without blocking emission.
 *
 * @param source Checked session or one checked module analysis.
 * @param options Emission options carrying the target marker.
 * @returns Profile mismatch and terminal option diagnostics.
 */
export function checkedObjectProfileDiagnostics(
  source: CheckingSession | ModuleAnalysis,
  options: CompileOptions | ProjectCheckingOptions,
): CompilerDiagnostic[] {
  assertObjectKey(source);
  assertObjectKey(options);

  const sourceTarget = targetFor(source);
  const diagnostics: CompilerDiagnostic[] = [];

  if (!sameTarget(sourceTarget, targetFor(options)))
    diagnostics.push(
      profileError("The checked source and emission options use different compiler profiles."),
    );

  if (isCheckingSession(source))
    for (const analysis of source.analyses.values())
      if (!sameTarget(sourceTarget, targetFor(analysis)))
        diagnostics.push(
          profileError("A checked analysis and its session use different compiler profiles."),
        );

  if (sourceTarget.kind === "terminal-cli") diagnostics.push(...terminalOptionDiagnostics(options));

  return uniqueDiagnostics(diagnostics);
}

/**
 * Open a retained checking session under the compiler-owned terminal profile.
 *
 * This entry marks fresh options before checking and verifies that the returned session and every
 * analysis retain the exact compiler-owned terminal profile.
 * Channel defaults are captured as a canonical immutable pair before checking starts.
 *
 * @param modules Authored modules captured for this checking snapshot.
 * @param options Existing project-checking options to retain where compatible.
 * @returns The real checking session, marked with the terminal profile and terminal option
 * diagnostics when supplied options conflict with that profile.
 * @throws RenderFault when supplied channel defaults fail canonical policy validation.
 */
export async function openTerminalCliProject(
  modules: readonly VirtualModule[],
  options: ProjectCheckingOptions = {},
): Promise<CheckingSession> {
  const terminalOptions = terminalOptionsFor(options);
  const checking = await import("./checking.ts");
  const opened = await checking.openCheckingProject(modules, terminalOptions);
  const profileDiagnostics: CompilerDiagnostic[] = [];
  const openedTarget = targetFor(opened);

  if (!sameTarget(openedTarget, TERMINAL_CLI_TARGET))
    profileDiagnostics.push(
      profileError("The checker did not retain the requested terminal compiler profile."),
    );

  for (const analysis of opened.analyses.values()) {
    const analysisTarget = targetFor(analysis);

    if (!sameTarget(analysisTarget, TERMINAL_CLI_TARGET))
      profileDiagnostics.push(
        profileError("The checker returned an analysis without the requested terminal profile."),
      );

    if (!sameTarget(analysisTarget, openedTarget))
      profileDiagnostics.push(
        profileError("The checked analysis and its session use different compiler profiles."),
      );
  }

  profileDiagnostics.push(...terminalOptionDiagnostics(terminalOptions));
  const diagnostics = uniqueDiagnostics(profileDiagnostics);
  const session: CheckingSession = diagnostics.length
    ? {
        ...opened,
        dispose: () => opened.dispose(),
        get result() {
          return appendProjectDiagnostics(opened.result, diagnostics);
        },
      }
    : opened;

  if (session !== opened) inheritTarget(opened, session);

  return session;
}

/**
 * Emit a retained session only when its terminal profile matches every checked analysis.
 *
 * The retained session, every analysis, and terminal options must carry the same exact compiler
 * profile. Valid sessions are emitted through the existing project emitter.
 * Channel defaults are captured as a canonical immutable pair before emission starts.
 *
 * @param session Retained checking session selected for terminal emission.
 * @param options Project-checking options compatible with the compiler-owned terminal profile.
 * @returns Emitted project results, or an empty module map with profile/option errors.
 * @throws RenderFault when supplied channel defaults fail canonical policy validation.
 */
export async function emitTerminalCliSession(
  session: CheckingSession,
  options: ProjectCheckingOptions = {},
): Promise<ProjectCompilation> {
  assertObjectKey(session);
  const terminalOptions = terminalOptionsFor(options);
  const diagnostics = checkedObjectProfileDiagnostics(session, terminalOptions);

  if (diagnostics.length)
    return {
      checking: appendProjectDiagnostics(session.result, diagnostics),
      modules: new Map(),
    };

  const emitter = await import("./project-compilation.ts");

  return emitter.emitCheckingSession(session, terminalOptions);
}

function terminalOptionsFor(options: ProjectCheckingOptions): ProjectCheckingOptions {
  const channelDefaults =
    options.channelDefaults === undefined
      ? normalizeChannelProjectDefaults()
      : snapshotChannelProjectDefaults(options.channelDefaults);

  const copied: ProjectCheckingOptions = {
    ...options,
    channelDefaults,
    runtimeModule:
      options.runtimeModule === undefined ? TERMINAL_RUNTIME_MODULE : options.runtimeModule,
  };

  pinTarget(copied, TERMINAL_CLI_TARGET);

  return copied;
}

function canonicalTarget(value: unknown): InternalTarget | undefined {
  if (!isObjectRecord(value)) return undefined;

  try {
    const keys = Reflect.ownKeys(value);

    if (keys.length === 1 && keys[0] === "kind" && dataProperty(value, "kind") === "browser")
      return BROWSER_TARGET;

    if (
      keys.length === 5 &&
      keys.every((key) => typeof key === "string") &&
      keys.includes("kind") &&
      keys.includes("version") &&
      keys.includes("intrinsicSchema") &&
      keys.includes("helperAbi") &&
      keys.includes("runtimeModule") &&
      dataProperty(value, "kind") === "terminal-cli" &&
      dataProperty(value, "version") === 1 &&
      dataProperty(value, "intrinsicSchema") === TERMINAL_INTRINSIC_SCHEMA &&
      dataProperty(value, "helperAbi") === TERMINAL_HELPER_ABI &&
      dataProperty(value, "runtimeModule") === TERMINAL_RUNTIME_MODULE
    )
      return TERMINAL_CLI_TARGET;
  } catch {
    return undefined;
  }

  return undefined;
}

function dataProperty(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);

  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function isObjectRecord(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function isCheckingSession(value: CheckingSession | ModuleAnalysis): value is CheckingSession {
  return "analyses" in value;
}

function assertObjectKey(value: unknown): asserts value is object {
  if ((typeof value !== "object" || value === null) && typeof value !== "function")
    throw new TypeError("A Hesperia compiler profile can only mark objects.");
}

function sameTarget(left: InternalTarget, right: InternalTarget): boolean {
  const canonicalLeft = canonicalTarget(left);
  const canonicalRight = canonicalTarget(right);

  return canonicalLeft !== undefined && canonicalLeft === canonicalRight;
}

function hasDefinedOption(options: CompileOptions | ProjectCheckingOptions, key: string): boolean {
  return key in options && Reflect.get(options, key) !== undefined;
}

function optionError(message: string): CompilerDiagnostic {
  return {
    code: "HES-TERMINAL-OPTION",
    severity: "error",
    message,
  };
}

function profileError(message: string): CompilerDiagnostic {
  return {
    code: "HES-TERMINAL-PROFILE",
    severity: "error",
    message,
  };
}

function appendProjectDiagnostics(
  result: ProjectCheckingResult,
  diagnostics: readonly CompilerDiagnostic[],
): ProjectCheckingResult {
  const additions = uniqueDiagnostics(diagnostics).filter(
    (diagnostic) => !result.diagnostics.some((existing) => sameDiagnostic(existing, diagnostic)),
  );

  return additions.length
    ? { ...result, diagnostics: [...result.diagnostics, ...additions] }
    : result;
}

function uniqueDiagnostics(diagnostics: readonly CompilerDiagnostic[]): CompilerDiagnostic[] {
  return diagnostics.filter(
    (diagnostic, index) =>
      diagnostics.findIndex((candidate) => sameDiagnostic(candidate, diagnostic)) === index,
  );
}

function sameDiagnostic(left: CompilerDiagnostic, right: CompilerDiagnostic): boolean {
  return (
    left.code === right.code &&
    left.severity === right.severity &&
    left.message === right.message &&
    left.span?.start === right.span?.start &&
    left.span?.end === right.span?.end
  );
}
