export const events: string[] = [];

function* delegated(): Generator<number, number, number> {
  try {
    return (yield 2) + 1;
  } finally {
    events.push("delegated:cleanup");
  }
}

export function* values(): Generator<number, number, number> {
  events.push("start");

  try {
    const input = yield 1;

    events.push("input:" + input);

    return yield* delegated();
  } finally {
    events.push("cleanup");
  }
}

export async function* asyncValues() {
  events.push("async:start");

  try {
    yield await Promise.resolve(4);

    return 5;
  } finally {
    events.push("async:cleanup");
  }
}

export function* bare(): Generator<undefined, number, number> {
  return yield;
}
