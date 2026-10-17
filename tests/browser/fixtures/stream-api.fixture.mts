import { createGraph, createStream, defineContract } from "aeolia";
import { withAeolia } from "hesperia/aeolia";

let opens = 0;
let aborts = 0;
let publish: ((value: number) => void) | undefined;

const numbers = createStream({
  name: "browser.numbers",
  key: (channel: string) => channel,
  open: (_channel, { abortSignal }): AsyncIterable<number> => {
    opens++;
    const queue: number[] = [];
    let waiting: ((result: IteratorResult<number>) => void) | undefined;
    let ended = false;

    const stop = () => {
      ended = true;

      waiting?.({ done: true, value: undefined });

      waiting = undefined;
    };

    abortSignal.addEventListener(
      "abort",
      () => {
        aborts++;

        stop();
      },
      { once: true },
    );

    publish = (value) => {
      if (ended) return;

      if (waiting) {
        const resolve = waiting;
        waiting = undefined;

        resolve({ done: false, value });
      } else queue.push(value);
    };
    return {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<number>> {
            if (ended) return Promise.resolve({ done: true, value: undefined });

            if (queue.length) return Promise.resolve({ done: false, value: queue.shift()! });

            return new Promise((resolve) => {
              waiting = resolve;
            });
          },

          return(): Promise<IteratorResult<number>> {
            stop();

            return Promise.resolve({ done: true, value: undefined });
          },
        };
      },
    };
  },
});

const contract = defineContract({ namespace: "browser-stream", operations: { numbers } });
const graph = createGraph({ contract, idleMs: 1000 });
export const api = withAeolia(graph, contract);

export const streamStats = () => ({ opens, aborts });

export const emitNumber = (value: number) => publish?.(value);

export const disposeGraph = () => graph.dispose();
