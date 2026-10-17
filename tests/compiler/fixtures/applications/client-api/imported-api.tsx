import api, { helper as named } from "./api";

import * as tools from "./tools";

export function App() {
  const user = api.users.get("ada");

  // prettier-ignore
  return <main>{user.value()}:{named()}:{tools.value}</main>;
}
