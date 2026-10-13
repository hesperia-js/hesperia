// oxlint-disable-next-line no-class-assign -- Reassigning this declaration is under test.
class Alpha {
  #value = 1;

  read() {
    return this.#value;
  }

  static self() {
    return Alpha;
  }
}

export { Alpha as Value };

export function evaluate() {
  const original = Alpha;

  Alpha = class Replacement {};

  return [original.self() === original, original.name, new original().read()];
}
