/** Native listener options supported by compiled `on:` attributes. */
type ListenerOptions = Readonly<{
  capture?: boolean;
  once?: boolean;
  passive?: boolean;
}>;

type NativeHandler = { handle(this: Element, event: Event): unknown }["handle"];

/** Each modifier accepts a callback or prior pair and retains the callback's identity. */
type EventInput = NativeHandler | readonly [NativeHandler, ListenerOptions];

type HandlerOf<Value> = Value extends readonly [infer Handler, ListenerOptions] ? Handler : Value;

type OptionsOf<Value> = Value extends readonly [unknown, infer Options extends ListenerOptions]
  ? Options
  : {};

type WithOption<Value, Option extends keyof ListenerOptions> = readonly [
  HandlerOf<Value>,
  Readonly<Omit<OptionsOf<Value>, Option> & { readonly [Key in Option]: true }>,
];

function withOption<Value extends EventInput, Option extends keyof ListenerOptions>(
  value: Value,
  option: Option,
): WithOption<Value, Option> {
  const handler = Array.isArray(value) ? value[0] : value;
  const options = Array.isArray(value) ? value[1] : undefined;
  return Object.freeze([
    handler,
    Object.freeze({ ...options, [option]: true }),
  ]) as unknown as WithOption<Value, Option>;
}

/**
 * Return a fresh frozen pair with `once: true`, preserving the handler and other options.
 * Calling this does not attach a listener; once attached, the browser consumes it per element.
 */
export function once<Value extends EventInput>(value: Value): WithOption<Value, "once"> {
  return withOption(value, "once");
}

/**
 * Return a fresh frozen pair with `capture: true`, preserving the handler and other options.
 * Calling this does not attach a listener.
 */
export function capture<Value extends EventInput>(value: Value): WithOption<Value, "capture"> {
  return withOption(value, "capture");
}

/**
 * Return a fresh frozen pair with `passive: true`, preserving the handler and other options.
 * Calling this does not attach a listener; once attached, `preventDefault()` has no effect.
 */
export function passive<Value extends EventInput>(value: Value): WithOption<Value, "passive"> {
  return withOption(value, "passive");
}
