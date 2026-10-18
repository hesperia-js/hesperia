import {
  affects,
  createGraph,
  createMutation,
  createQuery,
  defineContract,
  type Contract,
  type MutationDefinition,
  type MutationOptions,
  type OperationDefinition,
  type QueryDefinition,
  type StoreOptions,
} from "aeolia";
import type { ImportedApi } from "hesperia/aeolia";
import { markImportedApi } from "hesperia/runtime";
import { isNonArrayObject, isNonNullObject } from "./utils.ts";
import type { AppRouteFact } from "./route-facts.ts";
import type { AppEffectFact, EffectRequest } from "./effect-facts.ts";

interface RouteInvocation {
  readonly params: readonly PathCapture[];
  readonly request: unknown;
}

interface RequestOptions {
  readonly query?: unknown;
  readonly headers?: unknown;
  readonly fetch?: { readonly signal: AbortSignal };
}

type RequestFields<Options> = Options extends object
  ? {
      [Key in keyof Options as Key extends "query" | "headers" ? Key : never]: Options[Key];
    }
  : {};

type MethodArguments<Method> = Method extends (...args: infer Args) => unknown ? Args : [];

type MethodOptions<MethodName extends string, Method> =
  MethodArguments<Method> extends infer Args extends readonly unknown[]
    ? MethodName extends "get" | "head"
      ? "0" extends keyof Args
        ? NonNullable<Args["0"]>
        : {}
      : "1" extends keyof Args
        ? NonNullable<Args["1"]>
        : {}
    : {};

type MethodBody<Method> =
  MethodArguments<Method> extends infer Args extends readonly unknown[]
    ? "0" extends keyof Args
      ? Args["0"]
      : never
    : never;

type BodyField<Body> = [Body] extends [never]
  ? {}
  : undefined extends Body
    ? { readonly body?: Exclude<Body, undefined> }
    : { readonly body: Body };

type RequestInput<MethodName extends string, Method> = EmptyToVoid<
  MethodName extends "get" | "head"
    ? RequestFields<MethodOptions<MethodName, Method>>
    : BodyField<MethodBody<Method>> & RequestFields<MethodOptions<MethodName, Method>>
>;

type RequiredKeys<Value extends object> = {
  [Key in keyof Value]-?: {} extends Pick<Value, Key> ? never : Key;
}[keyof Value];

type RequestArguments<Input> = Input extends void
  ? [request?: void]
  : Input extends object
    ? RequiredKeys<Input> extends never
      ? [request?: Input]
      : [request: Input]
    : [request: Input];

type MethodResponse<Method> = Method extends (...args: infer _Args) => infer Result
  ? Awaited<Result>
  : never;

type MethodData<Method> =
  Extract<MethodResponse<Method>, { readonly error: null }> extends {
    readonly data: infer Data;
  }
    ? Data
    : never;

type QueryContract<Input, Output> = Contract<{
  readonly value: QueryDefinition<Input, Output, string>;
}>;

type QueryMember<Input, Output> = ImportedApi<QueryContract<Input, Output>>["value"];

type QueryView<Input, Output> = ReturnType<QueryMember<Input, Output>>;

type MutationContract<Input, Output> = Contract<{
  readonly value: MutationDefinition<Input, Output>;
}>;

type MutationMember<Input, Output> = ImportedApi<MutationContract<Input, Output>>["value"];

type MutationTask<Input, Output> = ReturnType<MutationMember<Input, Output>>;

type MutationTaskView<Input, Output> = Omit<MutationTask<Input, Output>, "run"> & {
  readonly run: ((
    ...args: [...RequestArguments<Input>, options?: MutationOptions]
  ) => ReturnType<MutationTask<Input, Output>["run"]>) &
    ([Input] extends [void | undefined] ? MutationTask<Input, Output>["run"] : {});
};

type QueryMethod<Method> = ((
  ...args: [
    ...RequestArguments<RequestInput<"get", Method>>,
    options?: StoreOptions<MethodData<Method>>,
  ]
) => QueryView<RequestInput<"get", Method>, MethodData<Method>>) &
  ([RequestInput<"get", Method>] extends [void | undefined]
    ? QueryMember<RequestInput<"get", Method>, MethodData<Method>>
    : {});

type MutationMethod<Method> = () => MutationTaskView<
  RequestInput<"mutation", Method>,
  MethodData<Method>
>;

type IsTreatyMethod<Value> = Value extends (...args: infer _Args) => infer Result
  ? [Extract<Awaited<Result>, { readonly error: null }>] extends [never]
    ? false
    : true
  : false;

type IsPathBuilder<Value> = Value extends { readonly "~path": string }
  ? true
  : Value extends (...args: infer _Args) => infer Result
    ? Result extends { readonly "~path": string }
      ? true
      : false
    : false;

type RouteProperties<Value> = {
  readonly [
    Key in keyof Value as Key extends "~path"
      ? never
      : Key extends "subscribe"
        ? IsTreatyMethod<Value[Key]> extends true
          ? Key
          : IsPathBuilder<Value[Key]> extends true
            ? Key
            : never
        : Key
  ]: IsTreatyMethod<Value[Key]> extends true
    ? Key extends string
      ? Key extends "get" | "head"
        ? QueryMethod<Value[Key]>
        : MutationMethod<Value[Key]>
      : never
    : RouteFacade<Value[Key]>;
};

type RouteFacade<Value> = Value extends (...args: infer Args) => infer Result
  ? Result extends { readonly "~path": string }
    ? ((...args: Args) => RouteFacade<Result>) & RouteProperties<Value>
    : RouteProperties<Value>
  : RouteProperties<Value>;

type RootRouteProperties<Value> = Omit<RouteProperties<Value>, "then" | "catch" | "finally">;

/** Treaty-shaped owner-bound facade preserving the native Eden client surface. */
export type ElysiaHttpApi<Client> = Client extends (...args: infer Args) => infer Result
  ? ((...args: Args) => RouteFacade<Result>) & RootRouteProperties<Client>
  : RootRouteProperties<Client>;

type EmptyToVoid<Value> = keyof Value extends never ? void : Value;

interface RouteEntry extends AppRouteFact {
  readonly operation: string;
}

interface PathCapture {
  readonly pathIndex: number;
  readonly name: string;
  readonly value: string | number;
}

interface QueryRequestVariant {
  readonly id: string;
  readonly equalitySnapshot: string;
  readonly params: readonly PathCapture[];
  readonly query: Readonly<Record<string, string | readonly string[]>>;
  readonly headers: Readonly<Record<string, string>>;
}

interface QueryVariantRegistration {
  readonly routeId: string;
  readonly reference: WeakRef<QueryRequestVariant>;
}

interface QueryVariantRegistry {
  readonly byRoute: Map<string, Set<WeakRef<QueryRequestVariant>>>;
  readonly byInvocation: WeakMap<RouteInvocation, Map<string, QueryRequestVariant>>;
  readonly finalizer: FinalizationRegistry<QueryVariantRegistration>;
  nextId: bigint;
}

/**
 * Adapt a real Eden Treaty client and its checker-produced Elysia route facts
 * into owner-bound Hesperia query and mutation handles.
 *
 * The graph is shared by every component importing this adapted API instance.
 * Component owners receive projections of that graph; unmounting a component
 * does not dispose shared query or mutation state.
 *
 * @param client - Treaty client already configured for the Elysia App.
 * @param routeFacts - Browser-safe method and path facts emitted by the
 * configured Elysia project plugin.
 * @param effectFacts - Checked selector declarations published by that plugin.
 *   Their targets refer to the same query definitions used by route calls.
 * @returns A Treaty-shaped facade whose query and mutation handles belong to
 * the consuming component owner after compilation.
 * @throws {TypeError} If route metadata contains duplicate routes or an HTTP
 * `SUBSCRIBE` method, which Eden reserves for WebSocket transport, or effect
 * metadata does not refer to configured mutation/query routes.
 */
export function createElysiaHttpApi<Client extends object>(
  client: Client,
  routeFacts: readonly AppRouteFact[],
  effectFacts: readonly AppEffectFact[] = [],
): ElysiaHttpApi<Client> {
  const routes = makeRouteEntries(routeFacts);
  const effects = checkedRouteEffects(routes, effectFacts);
  const variants = createQueryVariantRegistry();
  const operations: Record<string, OperationDefinition> = Object.create(null);
  const queries = new Map<string, QueryDefinition<RouteInvocation, unknown, string>>();

  for (const route of routes) {
    if (!isReadMethod(route.method)) continue;

    const definition = createQuery<RouteInvocation, unknown, string>({
      name: `elysia.${route.method.toLowerCase()}.${route.path}`,
      key: (input) => queryKey(route, input, variants),
      fetch: (input, { abortSignal }) =>
        requestEden(client, route, input, abortSignal, internQueryVariant(route, input, variants)),
    });

    queries.set(route.operation, definition);

    operations[route.operation] = definition;
  }

  for (const route of routes) {
    if (isReadMethod(route.method)) continue;

    operations[route.operation] = createMutation<RouteInvocation, unknown>({
      name: `elysia.${route.method.toLowerCase()}.${route.path}`,
      affects: (effects.get(route.operation) ?? []).map(({ fact, target }) =>
        affects(queries.get(target.operation)!, {
          on: fact.on,
          select: (input: RouteInvocation) =>
            selectedEffectInvocation(target, fact.select(effectRequest(input))),
        }),
      ),
      run: (input, { abortSignal }) => requestEden(client, route, input, abortSignal),
    });
  }

  const contract = defineContract({
    namespace: "hesperia.elysia.http",
    operations,
  });
  const graph = createGraph({ contract });
  return markImportedApi(
    graph,
    contract,
    (bound) => createRouteFacade(bound, routes, [], []) as unknown as ElysiaHttpApi<Client>,
  );
}

function checkedRouteEffects(
  routes: readonly RouteEntry[],
  facts: readonly AppEffectFact[],
): ReadonlyMap<string, readonly { readonly fact: AppEffectFact; readonly target: RouteEntry }[]> {
  const byRoute = new Map(routes.map((route) => [routeKey(route.path, route.method), route]));
  const effects = new Map<
    string,
    { readonly fact: AppEffectFact; readonly target: RouteEntry }[]
  >();

  for (const fact of facts) {
    const source = byRoute.get(routeKey(normalizeRoutePath(fact.source.path), fact.source.method));
    const target = byRoute.get(routeKey(normalizeRoutePath(fact.target.path), fact.target.method));

    if (!source || isReadMethod(source.method) || !target || !isReadMethod(target.method))
      throw new TypeError("An Elysia effect must refer to a configured mutation and query route.");

    if (typeof fact.select !== "function" || (fact.on !== "invalidate" && fact.on !== "revalidate"))
      throw new TypeError("An Elysia effect must declare a selector and a supported effect mode.");

    const entries = effects.get(source.operation) ?? [];

    entries.push({ fact, target });

    effects.set(source.operation, entries);
  }

  return effects;
}

function effectRequest(input: RouteInvocation): EffectRequest {
  const request = normalizeRequest(input.request);
  return {
    params: Object.fromEntries(input.params.map(({ name, value }) => [name, value])),
    body: readProperty(request, "body"),
    query: readProperty(request, "query"),
    headers: readProperty(request, "headers"),
  };
}

function selectedEffectInvocation(route: RouteEntry, value: unknown): RouteInvocation {
  if (!isNonArrayObject(value))
    throw new TypeError("An Elysia effect selector must return query request fields.");

  const selected = readPathParams(readProperty(value, "params"));
  const params: PathCapture[] = [];
  let pathIndex = 0;

  for (const segment of route.path.split("/").filter(Boolean)) {
    if (segment.startsWith(":")) {
      const name = pathParameterName(segment);
      const captured = selected[name];

      if (captured === undefined) {
        if (isOptionalPathParameter(segment)) continue;

        throw new TypeError(`Missing selected Eden path parameter ${name} for ${route.path}.`);
      }

      params.push({ pathIndex, name, value: captured });
    }

    pathIndex++;
  }

  return {
    params,
    request: {
      query: readProperty(value, "query"),
      headers: readProperty(value, "headers"),
    },
  };
}

function makeRouteEntries(routeFacts: readonly AppRouteFact[]): readonly RouteEntry[] {
  const seen = new Set<string>();
  return routeFacts.map((fact, index) => {
    const method = fact.method.toUpperCase();
    const path = normalizeRoutePath(fact.path);

    if (method === "SUBSCRIBE")
      throw new TypeError(
        `HTTP SUBSCRIBE route ${path} cannot be adapted through @elysia/eden: Treaty reserves ".subscribe()" for WebSocket transport.`,
      );

    const key = routeKey(path, method);

    if (seen.has(key))
      throw new TypeError(`Duplicate Elysia route metadata for ${method} ${path}.`);

    seen.add(key);

    return Object.freeze({ method, path, operation: `route${index}` });
  });
}

function routeKey(path: string, method: string): string {
  return `${path}\u0000${method.toUpperCase()}`;
}

function normalizeRoutePath(path: string): string {
  const segments = path.split("/").filter(Boolean);
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

function isReadMethod(method: string): boolean {
  return method === "GET" || method === "HEAD";
}

const treatyLowercaseMethods = new Set([
  "GET",
  "HEAD",
  "OPTIONS",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

function createQueryVariantRegistry(): QueryVariantRegistry {
  const byRoute = new Map<string, Set<WeakRef<QueryRequestVariant>>>();
  const finalizer = new FinalizationRegistry<QueryVariantRegistration>(({ routeId, reference }) => {
    const variants = byRoute.get(routeId);

    if (!variants) return;

    variants.delete(reference);

    if (variants.size === 0) byRoute.delete(routeId);
  });
  return {
    byRoute,
    byInvocation: new WeakMap(),
    finalizer,
    nextId: 0n,
  };
}

function queryKey(
  route: RouteEntry,
  input: RouteInvocation,
  registry: QueryVariantRegistry,
): string {
  const variant = internQueryVariant(route, input, registry);
  return `elysia:${route.operation}:${variant.id}`;
}

function internQueryVariant(
  route: RouteEntry,
  input: RouteInvocation,
  registry: QueryVariantRegistry,
): QueryRequestVariant {
  const invocationVariants = registry.byInvocation.get(input);
  const retained = invocationVariants?.get(route.operation);

  if (retained) return retained;

  const request = normalizeRequest(input.request);
  const params = snapshotPathParams(input.params);
  const query = snapshotQuery(readProperty(request, "query"));
  const headers = snapshotExplicitHeaders(readProperty(request, "headers"));
  const equalitySnapshot = requireSnapshotSignature(
    JSON.stringify([params.signature, query.signature, headers.signature]),
  );
  let routeVariants = registry.byRoute.get(route.operation);

  if (routeVariants) {
    for (const reference of routeVariants) {
      const variant = reference.deref();

      if (!variant) {
        routeVariants.delete(reference);

        continue;
      }

      if (variant.equalitySnapshot !== equalitySnapshot) continue;

      rememberInvocationVariant(registry, input, route.operation, variant);

      return variant;
    }

    if (routeVariants.size === 0) {
      registry.byRoute.delete(route.operation);

      routeVariants = undefined;
    }
  }

  registry.nextId += 1n;
  const variant = Object.freeze({
    id: registry.nextId.toString(36),
    equalitySnapshot,
    params: params.value,
    query: query.value,
    headers: headers.value,
  });
  const reference = new WeakRef(variant);
  const variants = routeVariants ?? new Set<WeakRef<QueryRequestVariant>>();

  variants.add(reference);

  registry.byRoute.set(route.operation, variants);

  registry.finalizer.register(variant, { routeId: route.operation, reference }, reference);

  rememberInvocationVariant(registry, input, route.operation, variant);

  return variant;
}

interface RequestValueSnapshot {
  readonly value: Readonly<Record<string, string | readonly string[]>>;
  readonly signature: string;
}

function rememberInvocationVariant(
  registry: QueryVariantRegistry,
  input: RouteInvocation,
  routeId: string,
  variant: QueryRequestVariant,
): void {
  let variants = registry.byInvocation.get(input);

  if (!variants) {
    variants = new Map();

    registry.byInvocation.set(input, variants);
  }

  variants.set(routeId, variant);
}

function snapshotPathParams(value: readonly PathCapture[]): {
  readonly value: readonly PathCapture[];
  readonly signature: string;
} {
  const snapshot = Object.freeze(
    value.map((capture) => Object.freeze({ ...capture, value: String(capture.value) })),
  );
  return {
    value: snapshot,
    signature: requireSnapshotSignature(JSON.stringify(snapshot)),
  };
}

function snapshotQuery(value: unknown): RequestValueSnapshot {
  const snapshot: Record<string, string | readonly string[]> = Object.create(null);

  if (value !== null && value !== undefined) {
    for (const [name, entry] of Object.entries(Object(value))) {
      if (entry === null || entry === undefined) continue;

      if (Array.isArray(entry)) {
        const values = entry
          .filter((item) => item !== null && item !== undefined)
          .map(serializeTreatyQueryValue);

        if (values.length > 0) snapshot[name] = Object.freeze(values);
      } else {
        snapshot[name] = serializeTreatyQueryValue(entry);
      }
    }
  }

  return {
    value: Object.freeze(snapshot),
    signature: requireSnapshotSignature(JSON.stringify(snapshot)),
  };
}

function serializeTreatyQueryValue(value: unknown): string {
  if (value instanceof Date) return value.toISOString();

  if (isNonNullObject(value)) return String(JSON.stringify(value));

  if (typeof value === "symbol") throw new TypeError("Cannot convert a Symbol value to a string.");

  return (value as string) + "";
}

function snapshotExplicitHeaders(value: unknown): {
  readonly value: Readonly<Record<string, string>>;
  readonly signature: string;
} {
  const snapshot: Record<string, string> = Object.create(null);

  appendExplicitHeaders(value, snapshot);

  return {
    value: Object.freeze(snapshot),
    signature: requireSnapshotSignature(JSON.stringify(snapshot)),
  };
}

function appendExplicitHeaders(value: unknown, snapshot: Record<string, string>): void {
  if (!value) return;

  if (value instanceof Headers) {
    value.forEach((entry, name) => {
      snapshot[name.toLowerCase()] = entry;
    });

    return;
  }

  if (typeof value === "function")
    throw new TypeError(
      "Elysia per-request header callbacks cannot be snapshotted for a query key.",
    );

  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!Array.isArray(entry)) {
        appendExplicitHeaders(entry, snapshot);

        continue;
      }

      const [first, second] = entry;

      if (typeof first === "string") {
        snapshot[first.toLowerCase()] = String(second);
        continue;
      }

      if (first !== null && typeof first === "object" && Symbol.iterator in first) {
        for (const [name, headerValue] of first as Iterable<readonly [string, unknown]>)
          snapshot[name.toLowerCase()] = String(headerValue);
      }
    }

    return;
  }

  if (typeof value === "object") {
    for (const [name, entry] of Object.entries(value)) snapshot[name.toLowerCase()] = String(entry);
  }
}

function requireSnapshotSignature(signature: string | undefined): string {
  if (signature === undefined)
    throw new TypeError("Eden query request variant could not be identified.");

  return signature;
}

function createRouteFacade(
  bound: object,
  routes: readonly RouteEntry[],
  pathSegments: readonly string[],
  captures: readonly PathCapture[],
): object {
  const pathBuilder = (..._args: readonly unknown[]): unknown => undefined;

  return new Proxy(pathBuilder, {
    get(_target, property) {
      if (typeof property !== "string" || isReservedRouteProperty(property, pathSegments.length))
        return undefined;

      const route = findRouteForFacade(routes, pathSegments, property, captures);

      if (route) return makeRouteMember(bound, route, captures);

      return createRouteFacade(bound, routes, [...pathSegments, property], captures);
    },

    apply(_target, _thisArgument, args) {
      const provided = readPathParams(args[0]);
      const additions = nextDynamicCaptures(pathSegments, captures, provided, routes);
      return createRouteFacade(
        bound,
        routes,
        [...pathSegments, ...additions.map(({ name }) => `:${name}`)],
        [...captures, ...additions],
      );
    },
  });
}

function findRouteForFacade(
  routes: readonly RouteEntry[],
  pathSegments: readonly string[],
  method: string,
  captures: readonly PathCapture[],
): RouteEntry | undefined {
  const matches = routes.filter(
    (route) =>
      route.method === method.toUpperCase() && routePathMatches(route.path, pathSegments, captures),
  );

  if (matches.length > 1)
    throw new TypeError(
      `Eden route access is ambiguous for ${method.toUpperCase()} ${pathFromSegments(pathSegments)}.`,
    );

  return matches[0];
}

function routePathMatches(
  routePath: string,
  pathSegments: readonly string[],
  captures: readonly PathCapture[],
): boolean {
  const routeSegments = routePath.split("/").filter(Boolean);
  const matchedPrefix = routePathPrefixPosition(routeSegments, pathSegments, captures);

  if (matchedPrefix === undefined) return false;

  for (let routeIndex = matchedPrefix; routeIndex < routeSegments.length; routeIndex++) {
    if (!isOptionalPathParameter(routeSegments[routeIndex]!)) return false;
  }

  return captures.length === pathSegments.filter((segment) => segment.startsWith(":")).length;
}

function nextDynamicCaptures(
  current: readonly string[],
  captures: readonly PathCapture[],
  provided: Readonly<Record<string, string | number>>,
  routes: readonly RouteEntry[],
): readonly PathCapture[] {
  const candidates: PathCapture[][] = [];

  for (const route of routes) {
    const routeSegments = route.path.split("/").filter(Boolean);
    const nextRouteIndex = routePathPrefixPosition(routeSegments, current, captures);

    if (nextRouteIndex === undefined) continue;

    const additions: PathCapture[] = [];
    const usedNames = new Set<string>();
    let pathIndex = current.length;

    for (let routeIndex = nextRouteIndex; routeIndex < routeSegments.length; routeIndex++) {
      const segment = routeSegments[routeIndex]!;

      if (!segment.startsWith(":")) break;

      const name = pathParameterName(segment);

      if (Object.hasOwn(provided, name) && !usedNames.has(name)) {
        additions.push({ pathIndex, name, value: provided[name]! });

        usedNames.add(name);

        pathIndex++;
        continue;
      }

      if (isOptionalPathParameter(segment)) continue;

      break;
    }

    if (!Object.keys(provided).every((name) => usedNames.has(name))) continue;

    if (additions.length > 0) candidates.push(additions);
  }

  if (candidates.length === 0) {
    if (Object.keys(provided).length > 0)
      throw new TypeError(
        `Eden path parameters do not match a route after ${pathFromSegments(current)}.`,
      );

    return [];
  }

  const byShape = new Map<string, readonly PathCapture[]>();

  for (const candidate of candidates) {
    const shape = JSON.stringify(candidate.map(({ pathIndex, name }) => [pathIndex, name]));

    byShape.set(shape, candidate);
  }

  if (byShape.size > 1)
    throw new TypeError(
      `Eden path parameter position is ambiguous after ${pathFromSegments(current)}.`,
    );

  return byShape.values().next().value ?? [];
}

function routePathPrefixPosition(
  routeSegments: readonly string[],
  pathSegments: readonly string[],
  captures: readonly PathCapture[],
): number | undefined {
  let routeIndex = 0;

  for (let pathIndex = 0; pathIndex < pathSegments.length; pathIndex++) {
    const actual = pathSegments[pathIndex]!;
    let expected = routeSegments[routeIndex];

    while (
      expected !== undefined &&
      isOptionalPathParameter(expected) &&
      !pathSegmentMatches(expected, actual, pathIndex, captures)
    ) {
      routeIndex++;
      expected = routeSegments[routeIndex];
    }

    if (expected === undefined || !pathSegmentMatches(expected, actual, pathIndex, captures))
      return undefined;

    routeIndex++;
  }

  return routeIndex;
}

function pathSegmentMatches(
  routeSegment: string,
  pathSegment: string,
  pathIndex: number,
  captures: readonly PathCapture[],
): boolean {
  if (!routeSegment.startsWith(":"))
    return (
      routeSegment === pathSegment && !captures.some((capture) => capture.pathIndex === pathIndex)
    );

  const name = pathParameterName(routeSegment);
  return (
    pathSegment === `:${name}` &&
    captures.some((capture) => capture.pathIndex === pathIndex && capture.name === name)
  );
}

function pathParameterName(segment: string): string {
  return segment.slice(1).replace(/\?$/u, "");
}

function isOptionalPathParameter(segment: string): boolean {
  return segment.startsWith(":") && segment.endsWith("?");
}

function isReservedRouteProperty(property: string, pathDepth: number): boolean {
  return (
    property === "~path" ||
    (pathDepth === 0 && (property === "then" || property === "catch" || property === "finally"))
  );
}

function pathFromSegments(segments: readonly string[]): string {
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

function readPathParams(value: unknown): Readonly<Record<string, string | number>> {
  if (value === undefined) return {};

  if (!isNonArrayObject(value)) throw new TypeError("Eden path parameters must be an object.");

  const result: Record<string, string | number> = Object.create(null);

  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry !== "string" && typeof entry !== "number")
      throw new TypeError(`Eden path parameter ${name} must be a string or number.`);

    result[name] = entry;
  }

  return result;
}

function makeRouteMember(
  bound: object,
  route: RouteEntry,
  captures: readonly PathCapture[],
): unknown {
  const factory = Reflect.get(bound, route.operation);

  if (typeof factory !== "function")
    throw new TypeError("Hesperia route operation is unavailable.");

  if (isReadMethod(route.method)) {
    return (request: unknown, options?: unknown): unknown => {
      const query = Reflect.apply(factory, bound, [
        { params: captures, request: normalizeRequest(request) } satisfies RouteInvocation,
        options,
      ]);
      return query;
    };
  }

  return () => {
    const task = Reflect.apply(factory, bound, []);

    if (task === null || typeof task !== "object")
      throw new TypeError("Hesperia mutation operation did not return a task.");

    const run = Reflect.get(task, "run");

    if (typeof run !== "function") throw new TypeError("Hesperia mutation task has no run method.");

    return Object.freeze({
      value: Reflect.get(task, "value"),
      pending: Reflect.get(task, "pending"),
      error: Reflect.get(task, "error"),
      status: Reflect.get(task, "status"),

      run(request: unknown = undefined, options?: unknown) {
        return Reflect.apply(run, task, [
          { params: captures, request: normalizeRequest(request) } satisfies RouteInvocation,
          options,
        ]);
      },
    });
  };
}

function normalizeRequest(request: unknown): unknown {
  return request === undefined ? {} : request;
}

async function requestEden<Client extends object>(
  client: Client,
  route: AppRouteFact,
  input: RouteInvocation,
  abortSignal: AbortSignal,
  queryVariant?: QueryRequestVariant,
): Promise<unknown> {
  const method = resolveTreatyMethod(client, route, queryVariant?.params ?? input.params);
  const request = normalizeRequest(input.request);
  const options: RequestOptions = {
    query: queryVariant ? queryVariant.query : readProperty(request, "query"),
    headers: queryVariant ? queryVariant.headers : readProperty(request, "headers"),
    fetch: { signal: abortSignal },
  };
  let result: unknown;

  if (isReadMethod(route.method)) {
    result = await (method as (options: RequestOptions) => Promise<unknown>)(options);
  } else {
    result = await (method as (body: unknown, options: RequestOptions) => Promise<unknown>)(
      readProperty(request, "body"),
      options,
    );
  }

  return readTreatySuccess(result);
}

function resolveTreatyMethod<Client extends object>(
  client: Client,
  route: AppRouteFact,
  captures: readonly PathCapture[],
): unknown {
  let current: unknown = client;
  let captureIndex = 0;
  let pathIndex = 0;
  const segments = route.path.split("/").filter(Boolean);

  for (const segment of segments) {
    if (segment.startsWith(":")) {
      const name = pathParameterName(segment);
      const capture = captures[captureIndex];
      const matchesCurrentPosition =
        capture !== undefined && capture.pathIndex === pathIndex && capture.name === name;

      if (!matchesCurrentPosition && isOptionalPathParameter(segment)) continue;

      if (capture === undefined)
        throw new TypeError(`Missing Eden path parameter ${name} for ${route.path}.`);

      if (!matchesCurrentPosition)
        throw new TypeError(`Unexpected Eden path parameter ${capture.name} for ${route.path}.`);

      if (typeof current !== "function")
        throw new TypeError(`Eden path parameter ${name} cannot be applied at ${route.path}.`);

      current = (current as (value: Readonly<Record<string, string | number>>) => unknown)({
        [name]: capture.value,
      });
      captureIndex++;
      pathIndex++;
      continue;
    }

    current = readProperty(current, segment);
    pathIndex++;
  }

  if (captureIndex !== captures.length)
    throw new TypeError(`Unexpected Eden path parameters for ${route.path}.`);

  const methodName = treatyLowercaseMethods.has(route.method)
    ? route.method.toLowerCase()
    : route.method;
  const method = readProperty(current, methodName);

  if (typeof method !== "function")
    throw new TypeError(`The Treaty client does not expose ${route.method} ${route.path}.`);

  return method;
}

function readTreatySuccess(result: unknown): unknown {
  if (!isNonNullObject(result) || !("error" in result))
    throw new TypeError("Eden Treaty returned an invalid HTTP response result.");

  if (Reflect.get(result, "error") !== null) throw Reflect.get(result, "error");

  if (!("data" in result)) throw new TypeError("Eden Treaty success result has no data field.");

  return Reflect.get(result, "data");
}

function readProperty(value: unknown, property: PropertyKey): unknown {
  if ((typeof value !== "object" && typeof value !== "function") || value === null)
    throw new TypeError(`Cannot read ${String(property)} from a non-object value.`);

  return Reflect.get(value, property);
}
