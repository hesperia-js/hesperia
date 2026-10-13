import { route } from "hesperia/routing";

const guard = () => false;

export default route({ guard, load: () => "SERVER_BLOCKED_LOAD" });
