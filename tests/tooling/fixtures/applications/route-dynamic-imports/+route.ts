import { route } from "hesperia/routing";

const guard = async (first: boolean) => {
  const target = first ? "./first.ts" : "./second.ts";

  return (await import(target)).allow();
};

export default route({ guard });
