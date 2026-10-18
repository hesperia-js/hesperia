const [action, entry, textKey, numberKey, booleanKey] = process.argv.slice(2);

if (!action || !entry || !textKey || !numberKey || !booleanKey) {
  throw new Error("Expected an action, the env module URL, and three environment keys");
}

/** @type {typeof import("hesperia/env")} */
const { env } = await import(entry);

const key = { textKey, numberKey, booleanKey };

let value;

try {
  switch (action) {
    case "string":
      value = env(key.textKey, "fallback");

      break;
    case "required":
      value = env(key.textKey);

      break;
    case "optional":
      value = env(key.textKey, undefined, true);

      break;
    case "number":
      value = env.num(key.numberKey, 3000);

      break;
    case "optional-number":
      value = env.num(key.numberKey, undefined, true);

      break;
    case "boolean":
      value = env.bool(key.booleanKey);

      break;
    case "boolean-default":
      value = env.bool(key.booleanKey, true);

      break;
    default:
      throw new Error("Unknown probe action");
  }

  console.log(
    JSON.stringify({
      value: value === undefined ? "<undefined>" : String(value),
      type: typeof value,
    }),
  );
} catch (error) {
  console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
}
