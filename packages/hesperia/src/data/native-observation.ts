import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { QueryDefinition } from "aeolia";
import { internValidationProfile, type ValidationProfile } from "../validation/profiles.ts";

declare const queryProfile: unique symbol;

/** Type-only authored-input, completed-value, and raw progress identities. */
export interface NativeQueryProfile<Raw, Completed, P = never> {
  readonly [queryProfile]: (input: Raw) => readonly [Completed, P];
}

/**
 * A native definition with Hesperia's authored, completed, and progress types.
 *
 * @typeParam P - Raw per-execution progress; `never` keeps finite queries unchanged.
 */
export type NativeQueryDefinition<
  I,
  V,
  K extends string,
  Raw = I,
  Completed = V,
  P = never,
> = QueryDefinition<I, V, K, P> & NativeQueryProfile<Raw, Completed, P>;

/** Exact operation schemas retained for input preparation and every observed output. */
export interface NativeQuerySchemas<I, V, Raw = I, Completed = V> {
  /** Transform authored input into the native input before its key is evaluated. */
  readonly input?: StandardSchemaV1<Raw, I>;
  /** Validate and transform the whole native result, including cache candidates. */
  readonly output?: StandardSchemaV1<V, Completed>;
}

/** A native candidate or a notification that supersedes older work without publishing. */
export type MappedObservation =
  | { readonly kind: "complete"; readonly value: unknown }
  | { readonly kind: "incomplete" };

/** Receiver owned by the shared query resource; callbacks contain processing failures. */
export interface NativeObservationReceiver<Event> {
  /** Deliver one native event; even incomplete events supersede older processing. */
  readonly notify: (event: Event) => void;
  /** End this provider without replacing the retained observation issue. */
  readonly terminate: (cause: unknown) => void;
}

/** Native watch knowledge supplied by an optional adapter, with no component ownership. */
export interface NativeQueryObservation<Input, Event> {
  /** Exact native cache or provider identity. */
  readonly provider: object;
  /** Exact document, fixed context and representation identity. */
  readonly representation: object;
  /** Map a native event without borrowing metadata from an earlier execution. */
  readonly map: (event: Event) => MappedObservation | PromiseLike<MappedObservation>;
  /** Start a watch for validated input and return its actual idempotent release. A returned
   * cleanup Promise is joined as part of that release.
   */
  readonly start: (
    input: Input,
    receiver: NativeObservationReceiver<Event>,
  ) => () => void | Promise<void>;
}

/** Captured core metadata; registration itself never prepares input or starts a watch. */
export interface RegisteredNativeQuery {
  readonly profile: ValidationProfile;
  readonly observation?: NativeQueryObservation<unknown, unknown>;
  readonly mapIdentity?: object;
  readonly startIdentity?: object;
}

const queries = new WeakMap<object, RegisteredNativeQuery>();

/**
 * Attach exact schema references to an existing definition without changing raw Aeolia use.
 * @param definition - Original query in the graph's contract.
 * @param schemas - Once-selected schema instances, retained by identity.
 * @returns The identical definition with Hesperia's authored and completed types.
 * @throws TypeError when the definition already has incompatible registration.
 */
export function registerNativeQueryProfile<
  I,
  V,
  K extends string,
  Raw = I,
  Completed = V,
  P = never,
>(
  definition: QueryDefinition<I, V, K, P>,
  schemas: NativeQuerySchemas<I, V, Raw, Completed>,
): NativeQueryDefinition<I, V, K, Raw, Completed, P> {
  register(definition, schemas);

  return definition as NativeQueryDefinition<I, V, K, Raw, Completed, P>;
}

/**
 * Register the real provider used by an ordinary query definition.
 * @param definition - Exact original definition; registration performs no I/O.
 * @param observation - Captured provider, representation, callbacks and optional schemas.
 * @returns The identical definition, preserving native input, result and key types.
 * @throws TypeError for malformed or incompatible repeated registration.
 */
export function registerNativeQueryObservation<
  I,
  V,
  K extends string,
  Event,
  Raw = I,
  Completed = V,
  P = never,
>(
  definition: QueryDefinition<I, V, K, P>,
  observation: NativeQueryObservation<I, Event> & {
    readonly schemas?: NativeQuerySchemas<I, V, Raw, Completed>;
  },
): NativeQueryDefinition<I, V, K, Raw, Completed, P> {
  const { provider, representation, map, start, schemas } = observation;

  if (
    !object(provider) ||
    !object(representation) ||
    typeof map !== "function" ||
    typeof start !== "function"
  )
    throw new TypeError("Native query observation requires provider identities and callbacks");

  register(
    definition,
    schemas,
    Object.freeze({
      provider,
      representation,
      map: (event: unknown) => map(event as Event),
      start: (input: unknown, receiver: NativeObservationReceiver<unknown>) =>
        start(input as I, receiver),
    }),
    map,
    start,
  );

  return definition as NativeQueryDefinition<I, V, K, Raw, Completed, P>;
}

function register<I, V, K extends string, Raw, Completed, P>(
  definition: QueryDefinition<I, V, K, P>,
  schemas: NativeQuerySchemas<I, V, Raw, Completed> | undefined,
  observation?: NativeQueryObservation<unknown, unknown>,
  mapIdentity?: object,
  startIdentity?: object,
): void {
  if (!object(definition) || definition.kind !== "query")
    throw new TypeError("Native query registration requires a query definition");

  const profile = internValidationProfile(schemas?.input, schemas?.output);
  const existing = queries.get(definition);

  if (existing) {
    if (
      existing.profile !== profile ||
      existing.observation?.provider !== observation?.provider ||
      existing.observation?.representation !== observation?.representation ||
      existing.mapIdentity !== mapIdentity ||
      existing.startIdentity !== startIdentity
    )
      throw new TypeError("Native query already has an incompatible registration");

    return;
  }

  const registered = Object.freeze({ profile, observation, mapIdentity, startIdentity });
  queries.set(definition, registered);
}

/** Look up the exact full-profile registration without acquiring a resource. @internal */
export function nativeQueryRegistration(definition: object): RegisteredNativeQuery | undefined {
  return queries.get(definition);
}

function object(value: unknown): value is object {
  return value !== null && (typeof value === "object" || typeof value === "function");
}
