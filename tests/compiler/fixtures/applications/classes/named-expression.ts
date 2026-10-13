export function make(value: string) {
  return class Named {
    read() {
      return Named.name + ":" + value;
    }
  };
}
