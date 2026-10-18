import { route } from "hesperia/routing";
import { otherGuard } from "../../shared.ts";

const serverB = "SERVER_B";

export default route({ guard: otherGuard, load: () => serverB });
