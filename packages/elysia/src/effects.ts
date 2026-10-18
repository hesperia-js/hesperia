type NativeApp = {
  readonly "~Routes": Record<string, unknown>;
};

type NativeRoute = {
  readonly body: unknown;
  readonly params: unknown;
  readonly query: unknown;
  readonly headers: unknown;
  readonly response: unknown;
};

type Simplify<Value> = { [Key in keyof Value]: Value[Key] } & {};

type JoinPath<Prefix extends string, Segment extends string> = Prefix extends ""
  ? `/${Segment}`
  : `${Prefix}/${Segment}`;

type RouteReferences<Routes, Prefix extends string = ""> = Routes extends object
  ? {
      [Key in keyof Routes & string]: Routes[Key] extends NativeRoute
        ? {
            readonly method: Uppercase<Key>;
            readonly path: Prefix extends "" ? "/" : Prefix;
          }
        : RouteReferences<Routes[Key], JoinPath<Prefix, Key>>;
    }[keyof Routes & string]
  : never;

type AppRoutes<App> = App extends { readonly "~Routes": infer Routes } ? Routes : never;

type AllRouteReferences<App> = RouteReferences<AppRoutes<App>>;

type ReadMethod = "GET" | "HEAD";

type MutationReference<App> =
  AllRouteReferences<App> extends infer Reference
    ? Reference extends { readonly method: infer Method }
      ? Method extends ReadMethod
        ? never
        : Reference
      : never
    : never;

type QueryReference<App> =
  AllRouteReferences<App> extends infer Reference
    ? Reference extends { readonly method: infer Method }
      ? Method extends ReadMethod
        ? Reference
        : never
      : never
    : never;

type PathNode<Routes, Path extends string> = Path extends "/"
  ? Routes
  : Path extends `/${infer Rest}`
    ? PathNode<Routes, Rest>
    : Path extends `${infer Segment}/${infer Rest}`
      ? Segment extends keyof Routes
        ? PathNode<Routes[Segment], Rest>
        : never
      : Path extends keyof Routes
        ? Routes[Path]
        : never;

type RouteSchema<App, Reference> = Reference extends {
  readonly method: infer Method extends string;
  readonly path: infer Path extends string;
}
  ? PathNode<AppRoutes<App>, Path> extends infer Node
    ? Node extends object
      ? {
          [Key in keyof Node & string]: Uppercase<Key> extends Method
            ? Node[Key] extends NativeRoute
              ? Node[Key]
              : never
            : never;
        }[keyof Node & string]
      : never
    : never
  : never;

type IsAny<Value> = 0 extends 1 & Value ? true : false;

type IsUnknown<Value> =
  IsAny<Value> extends true
    ? false
    : unknown extends Value
      ? [keyof Value] extends [never]
        ? true
        : false
      : false;

type AcceptsEmptyObject<Value> = Value extends object ? ({} extends Value ? true : false) : false;

type SchemaField<Value, Name extends PropertyKey> = Name extends keyof Value
  ? IsUnknown<Value[Name]> extends true
    ? { readonly [Key in Name]?: Value[Name] }
    : AcceptsEmptyObject<Value[Name]> extends true
      ? { readonly [Key in Name]?: Value[Name] }
      : undefined extends Value[Name]
        ? { readonly [Key in Name]?: Value[Name] }
        : { readonly [Key in Name]: Value[Name] }
  : {};

type SourceInput<App, Reference> =
  RouteSchema<App, Reference> extends infer Schema
    ? Simplify<
        SchemaField<Schema, "params"> &
          SchemaField<Schema, "body"> &
          SchemaField<Schema, "query"> &
          SchemaField<Schema, "headers">
      >
    : never;

type TargetInput<App, Reference> =
  RouteSchema<App, Reference> extends infer Schema
    ? Simplify<
        SchemaField<Schema, "params"> &
          SchemaField<Schema, "query"> &
          SchemaField<Schema, "headers">
      >
    : never;

type EffectMode = "invalidate" | "revalidate";

interface EdenEffectDefinition<Source, Target, Selector> {
  /** Native mutation route whose successful run triggers the effect. */
  readonly source: Source;
  /** Native query route selected by the source input. */
  readonly target: Target;
  /** Selector retained by identity and evaluated before invocation and after success. */
  readonly select: Selector;
  /** Aeolia effect applied after the native mutation settles successfully. */
  readonly on: EffectMode;
}

interface DefineEdenEffectForApp<App> {
  /**
   * Declare a typed relationship between one native mutation and one native
   * query. The selector receives the mutation's checked `params`, `body`,
   * `query`, and explicit `headers` fields, then returns the selected query's
   * checked `params`, `query`, and explicit `headers` fields. Required and
   * optional fields follow the schemas inferred from `App["~Routes"]`.
   *
   * This constructor is inert: it does not execute the server App, the
   * selector, or any business effect. Aeolia evaluates the selector before
   * invoking the mutation and again when applying the selected-query effect
   * after a successful native mutation response. The selector function is
   * retained by identity. Compilation checks its used browser dependencies
   * and rejects host/private-capability access or captures whose browser-safe
   * provenance cannot be established.
   *
   * @param source - A non-GET/HEAD route reference from the configured App.
   * @param target - A GET/HEAD query route reference from the configured App.
   * @param select - A synchronous mapping from source request fields to
   *   target request fields.
   * @param on - Whether the selected query is invalidated or revalidated after
   *   the source mutation succeeds.
   * @returns An inert effect definition consumed by the configured Elysia
   *   project plugin.
   */
  <
    const Source extends MutationReference<App>,
    const Target extends QueryReference<App>,
    Selector extends (source: SourceInput<App, Source>) => TargetInput<App, Target>,
  >(
    source: Source,
    target: Target,
    select: Selector &
      (Extract<ReturnType<Selector>, PromiseLike<unknown>> extends never ? unknown : never),
    on: EffectMode,
  ): EdenEffectDefinition<Source, Target, Selector>;
}

/**
 * Create the App-specific declaration function for browser-safe Eden query
 * effects. Supply the configured server App as a type argument; the helper
 * does not import or execute that App at runtime.
 *
 * @returns A declaration function whose route references and selector fields
 *   are inferred from the App's native `~Routes` type.
 */
export function defineEdenEffect<App extends NativeApp>(): DefineEdenEffectForApp<App> {
  return (<Source, Target, Selector>(
    source: Source,
    target: Target,
    select: Selector,
    on: EffectMode,
  ) =>
    Object.freeze({
      source: Object.freeze({ ...source }),
      target: Object.freeze({ ...target }),
      select,
      on,
    })) as DefineEdenEffectForApp<App>;
}
