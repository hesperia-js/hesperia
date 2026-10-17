export const object = {
  value: 4,

  method(first, second) {
    return this.value + first + second + arguments.length;
  },

  get doubled() {
    return this.value * 2;
  },

  set doubled(value) {
    // eslint-disable-next-line no-setter-return -- The fixture checks that a setter return is discarded.
    return value;
  },
};

export const make = function local(value) {
  return local.name + value;
};
