import { route } from "hesperia/routing";
import { redirectGuard } from "../../shared.ts";

export default route({ guard: redirectGuard });
