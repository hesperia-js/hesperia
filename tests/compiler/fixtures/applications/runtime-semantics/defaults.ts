let fallbackCalls = 0;

function fallback() {
  ++fallbackCalls;

  return 7;
}

const outer = 10;

// eslint-disable-next-line no-unused-vars -- The parameter shadows this outer binding in the fixture.
const later = "outer";

export function defaults(first = 2, second = first + 1) {
  return first + second;
}

export function sideEffect(value = fallback()) {
  return value;
}

export function calls() {
  return fallbackCalls;
}

export function shadow(value = outer) {
  const outer = 3;

  return value + outer;
}

export function nested({ value = 4 } = {}) {
  return value;
}

export function closure(first = () => later, later = "parameter") {
  const body = "body";

  return [body, first(), later];
}
