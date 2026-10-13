class Base {
  constructor(value: number) {
    this.value = value;
  }

  read() {
    return this.value;
  }
}

class Child extends Base {
  constructor(value: number) {
    super(value + 1);

    this.kind = new.target.name;
  }

  read() {
    return super.read() + 1;
  }
}

export function evaluate() {
  const item = new Child(2);

  return [item.value, item.read(), item.kind, item instanceof Base, item.constructor === Child];
}
