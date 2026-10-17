import { beforeLeave } from "hesperia/navigation";

import * as Navigation from "hesperia/navigation";

const reassignedChecks: (() => boolean)[] = [];

export function App() {
  let guard = beforeLeave;

  guard(() => true);

  let namespaceGuard = Navigation.beforeLeave;

  namespaceGuard(() => false);

  guard = (check) => {
    reassignedChecks.push(check);
  };

  guard(() => false);

  // prettier-ignore
  return <button />;
}
