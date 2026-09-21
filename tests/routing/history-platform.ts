/**
 * happy-dom retains the object passed to History methods instead of applying
 * the browser's structured-clone step. Keep routing tests on the browser
 * contract by cloning their state in this test-only adapter.
 */
export function installHistoryCloneAdapter(window: Window): void {
  const history = window.history;
  const nativePush = history.pushState;
  const nativeReplace = history.replaceState;
  const cloneState = (native: History["pushState"]) =>
    function (this: History, ...args: unknown[]): void {
      const forwarded = [...args];
      if (forwarded.length > 0) forwarded[0] = structuredClone(forwarded[0]);
      return Reflect.apply(native, this, forwarded);
    } as History["pushState"];
  history.pushState = cloneState(nativePush);
  history.replaceState = cloneState(nativeReplace);
}
