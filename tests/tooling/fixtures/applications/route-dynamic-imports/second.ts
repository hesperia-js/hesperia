import "./effect.ts";

Object.assign(globalThis, { secondLoaded: true });

export const allow = () => false;
