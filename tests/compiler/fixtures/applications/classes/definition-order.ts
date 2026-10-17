const events: string[] = [];

const key = () => {
  events.push("key");

  return "computed";
};

const mark = (label: string, value: number) => {
  events.push(label);

  return value;
};

class Example {
  static [key()] = mark("static", 7);

  #secret = 3;

  value = mark("field", 4);

  [key()]() {
    events.push("method");
  }

  get secret() {
    return this.#secret;
  }

  set secret(value: number) {
    this.#secret = value;
  }
}

export function evaluate() {
  const defined = events.join(",");

  const item = new Example();

  const constructed = events.join(",");

  item.secret = 9;

  item.computed();

  return [defined, constructed, item.value, item.secret, Example.computed];
}
