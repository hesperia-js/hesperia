import { beforeLeave } from "hesperia/navigation";

import { beforeLeave as guard } from "hesperia/navigation";

import { navigation } from "hesperia/navigation";

import * as Navigation from "hesperia/navigation";

export function App() {
  const aliasedGuard = guard;

  const NavigationApi = Navigation;

  const namespaceGuard = NavigationApi.beforeLeave;

  let mutableGuard = guard;

  beforeLeave(() => true);

  guard(() => true);

  aliasedGuard(() => true);

  NavigationApi.beforeLeave(() => true);

  namespaceGuard(() => true);

  mutableGuard(() => true);

  navigation.navigate("/settings");

  // prettier-ignore
  return <button>finish</button>;
}

// oxlint-disable-next-line no-unused-vars -- This shadowed helper is the control under test.
function unrelated() {
  function beforeLeave(check: () => void) {
    check();
  }

  beforeLeave(() => {});
}
