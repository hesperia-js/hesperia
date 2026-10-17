// oxlint-disable-next-line no-class-assign -- Reassigning this declaration is under test.
class Beta {
  #other = 1;

  read() {
    return this.#other;
  }

  static self() {
    return Beta;
  }
}

export { Beta as Value };

export function evaluate() {
  const original = Beta;

  Beta = class Replacement {};

  return [original.self() === original, original.name, new original().read()];
}
