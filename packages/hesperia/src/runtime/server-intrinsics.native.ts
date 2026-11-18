import { isPromise } from "node:util/types";

const capturedNativePromiseBrand: (value: unknown) => boolean = isPromise;

/** @internal The native server's genuine Promise brand classifier. */
export const nativePromiseBrand: ((value: unknown) => boolean) | undefined =
  capturedNativePromiseBrand;
