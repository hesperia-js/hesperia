import { route } from "hesperia/routing";
import { guard } from "../../shared.ts";

const serverA = "SERVER_A";

export default route({ guard, load: () => serverA });
