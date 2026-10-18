import { redirect, route } from "hesperia/routing";

const guard = () => redirect("/after");

export default route({ guard, load: () => "SERVER_REDIRECT_LOAD" });
