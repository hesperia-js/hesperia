import { route } from "hesperia/routing";
import { switchGuard } from "../../shared.ts";

export default route({ guard: switchGuard });
