const events: string[] = [];

const mark = (label: string, value: number) => {
  events.push(label);

  return value;
};

class Example {
  static {
    events.push("block");
  }

  static value = mark("static", 2);
}

export const value = [events.join(","), Example.value];
