import { route } from "hesperia/routing";

const guard = () => true;

export default route({ guard, load: () => "SERVER_ROUTE_MARKER" });
