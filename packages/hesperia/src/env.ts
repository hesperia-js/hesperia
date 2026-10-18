/**
 * Read a server-side environment variable. An empty value uses the supplied default;
 * a missing value without a default throws unless `allowUndefined` is true.
 * This entry is unavailable to browser code and never exposes a value publicly.
 */
export function env(
  name: string,
  defaultVal: string | undefined,
  allowUndefined: true,
): string | undefined;

export function env(name: string, defaultVal?: string, allowUndefined?: false): string;

export function env(
  name: string,
  defaultVal?: string,
  allowUndefined?: boolean,
): string | undefined;

export function env(
  name: string,
  defaultVal?: string,
  allowUndefined?: boolean,
): string | undefined {
  let val = process.env[name];

  if (!val && defaultVal !== undefined) val = defaultVal;

  if (val === undefined && !allowUndefined) {
    throw new Error(`${name} env variable must be defined`);
  }

  return val;
}

/** Typed environment readers attached to the callable {@link env} function. */
export namespace env {
  /**
   * Parse an environment value with `Number()`. Missing required values and `NaN`
   * throw synchronously; `allowUndefined` permits only a missing value.
   */
  export function num(name: string, defaultVal: number, allowUndefined?: false): number;

  export function num(
    name: string,
    defaultVal: number | undefined,
    allowUndefined: true,
  ): number | undefined;

  export function num(
    name: string,
    defaultVal: number | undefined,
    allowUndefined?: boolean,
  ): number | undefined {
    let stringDefaultVal: string | undefined;

    if (defaultVal !== undefined) stringDefaultVal = String(defaultVal);

    const val = env(name, stringDefaultVal, allowUndefined);

    if (val === undefined && allowUndefined) return val;

    const num = Number(val);

    if (isNaN(num)) {
      throw new Error(`${name} env variable must be a number got ${val}`);
    }

    return num;
  }

  /**
   * Parse case-insensitive `true` or `false`. A missing or empty value uses the
   * supplied default, which is `false` when omitted; other values throw synchronously.
   */
  export function bool(name: string, defaultVal?: boolean): boolean {
    let defaultValStr = "false";

    if (defaultVal) defaultValStr = "true";

    const val = env(name, defaultValStr).toLowerCase();

    if (val !== "true" && val !== "false") {
      throw new Error(`${name} env variable must be 'true' or 'false' got ${val}`);
    }

    return val === "true";
  }
}
