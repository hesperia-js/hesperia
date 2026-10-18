import { route } from "hesperia/routing";

const guard = () => true;

export default route({ guard, load: () => "INSTALLED_SERVER_ROUTE_MARKER" });
