class Base {
  #value = 2;

  readBase() {
    return this.#value;
  }
}

class Child extends Base {
  #value = 3;

  read() {
    return super.readBase() + this.#value;
  }
}

export function evaluate() {
  return new Child().read();
}
