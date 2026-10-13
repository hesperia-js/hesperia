import "./effect.ts";

Object.assign(globalThis, { firstLoaded: true });

export const allow = () => true;
