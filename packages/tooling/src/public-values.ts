/** Values explicitly copied from project configuration into browser code. */
export type PublicValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly PublicValue[]
  | { readonly [name: string]: PublicValue };

/** Tagged private wire form that preserves undefined and non-finite numbers. */
export type PublicWireValue =
  | readonly ["undefined" | "null"]
  | readonly ["string", string]
  | readonly ["number", string]
  | readonly ["boolean", boolean]
  | readonly ["array", readonly PublicWireValue[]]
  | readonly ["object", readonly (readonly [string, PublicWireValue])[]];

export function encodePublicValue(value: PublicValue): PublicWireValue {
  if (value === undefined) return ["undefined"];

  if (value === null) return ["null"];

  if (typeof value === "string") return ["string", value];

  if (typeof value === "number") return ["number", Object.is(value, -0) ? "-0" : String(value)];

  if (typeof value === "boolean") return ["boolean", value];

  if (Array.isArray(value)) return ["array", value.map(encodePublicValue)];

  return ["object", Object.entries(value).map(([name, item]) => [name, encodePublicValue(item)])];
}

export function decodePublicValue(value: PublicWireValue): PublicValue {
  switch (value[0]) {
    case "undefined":
      return undefined;
    case "null":
      return null;
    case "string":
      return value[1];
    case "number":
      return Number(value[1]);
    case "boolean":
      return value[1];
    case "array":
      return value[1].map(decodePublicValue);
    case "object":
      return Object.fromEntries(value[1].map(([name, item]) => [name, decodePublicValue(item)]));
  }
}

/** Frozen, validated public entries and their generated browser/type projections. */
export interface PublicProjection {
  /** Validated copy captured for this project revision. */
  readonly values: Readonly<Record<string, PublicValue>>;
  /** JavaScript module containing only the explicit entries. */
  readonly browser: string;
  /** Ambient module for command, editor and installed consumer checking. */
  readonly declaration: string;
}

/** Validate recursive plain data and create the fixed public module. */
export function projectPublicValues(input: unknown): PublicProjection {
  if (input === null || typeof input !== "object" || Array.isArray(input) || !plain(input))
    throw new TypeError("public must be a plain object of named exports");

  if (Object.getOwnPropertySymbols(input).length)
    throw new TypeError("public cannot contain symbol export names");

  if (Object.getOwnPropertyNames(input).length !== Object.keys(input).length)
    throw new TypeError("public cannot contain hidden properties");

  const values: Record<string, PublicValue> = Object.create(null);
  const names = Object.keys(input);

  for (const name of names) {
    if (
      !/^[$_\p{ID_Start}][$\p{ID_Continue}\u200C\u200D]*$/u.test(name) ||
      RESERVED_EXPORTS.has(name)
    )
      throw new TypeError(`Invalid public export name: ${name}`);

    values[name] = copyValue(readDataProperty(input, name), new Set(), `public.${name}`);
  }

  const browser =
    names
      .map(
        (name, index) =>
          `const __public_${index}=${expression(values[name])};\nexport {__public_${index} as ${name}};`,
      )
      .join("\n") + "\n";
  const declaration = `declare module "hesperia/config/public" {\n${names
    .map((name) => `  export const ${name}: ${typeExpression(values[name])};`)
    .join("\n")}\n}\n`;
  return { values: Object.freeze(values), browser, declaration };
}

const RESERVED_EXPORTS = new Set([
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "new",
  "null",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
  "implements",
  "interface",
  "let",
  "package",
  "private",
  "protected",
  "public",
  "static",
]);

function copyValue(value: unknown, parents: Set<object>, path: string): PublicValue {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  )
    return value;

  if (typeof value !== "object")
    throw new TypeError(`${path} must contain only public data values`);

  if (parents.has(value)) throw new TypeError(`${path} contains a cycle`);

  if (!Array.isArray(value) && !plain(value))
    throw new TypeError(`${path} must contain only arrays and plain objects`);

  if (Object.getOwnPropertySymbols(value).length)
    throw new TypeError(`${path} cannot contain symbol keys`);

  const ownNames = Object.getOwnPropertyNames(value).filter(
    (name) => !Array.isArray(value) || name !== "length",
  );

  if (ownNames.length !== Object.keys(value).length)
    throw new TypeError(`${path} cannot contain hidden properties`);

  parents.add(value);

  try {
    if (Array.isArray(value)) {
      if (
        Object.keys(value).some(
          (name) => !/^(0|[1-9]\d*)$/u.test(name) || Number(name) >= value.length,
        )
      )
        throw new TypeError(`${path} cannot contain named array properties`);

      const array = Array.from({ length: value.length }, (_, index) =>
        index in value
          ? copyValue(readDataProperty(value, String(index)), parents, `${path}[${index}]`)
          : undefined,
      );
      return Object.freeze(array);
    }

    const object: Record<string, PublicValue> = Object.create(null);

    for (const name of Object.keys(value))
      object[name] = copyValue(readDataProperty(value, name), parents, `${path}.${name}`);

    return Object.freeze(object);
  } finally {
    parents.delete(value);
  }
}

function readDataProperty(value: object, name: string): unknown {
  const property = Object.getOwnPropertyDescriptor(value, name);

  if (!property || !("value" in property))
    throw new TypeError(`Public value ${name} cannot use accessors`);

  return property.value;
}

function plain(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function expression(value: PublicValue): string {
  if (value === undefined) return "undefined";

  if (value === null) return "null";

  if (typeof value === "string") return JSON.stringify(value);

  if (typeof value === "boolean") return String(value);

  if (typeof value === "number") {
    if (Number.isNaN(value)) return "NaN";

    if (value === Infinity) return "Infinity";

    if (value === -Infinity) return "-Infinity";

    return Object.is(value, -0) ? "-0" : String(value);
  }

  if (Array.isArray(value)) return `Object.freeze([${value.map(expression).join(",")}])`;

  return `Object.freeze({${Object.entries(value)
    .map(([name, item]) => `[${JSON.stringify(name)}]:${expression(item)}`)
    .join(",")}})`;
}

function typeExpression(value: PublicValue): string {
  if (value === undefined) return "undefined";

  if (value === null) return "null";

  if (typeof value === "string") return JSON.stringify(value);

  if (typeof value === "boolean") return String(value);

  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "number";

  if (Array.isArray(value)) return `readonly [${value.map(typeExpression).join(", ")}]`;

  return `{ ${Object.entries(value)
    .map(([name, item]) => `readonly ${JSON.stringify(name)}: ${typeExpression(item)};`)
    .join(" ")} }`;
}
