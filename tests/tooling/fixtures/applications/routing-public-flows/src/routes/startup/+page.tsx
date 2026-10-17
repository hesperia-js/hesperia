import { api } from "../../../api";
import { beforeLeave } from "hesperia/navigation";

export default async function Startup() {
  const check = (
    globalThis as unknown as {
      routingPublicReloadCheck: (name: string) => boolean | Promise<boolean>;
    }
  ).routingPublicReloadCheck;

  beforeLeave(() => check("page"));

  const message = await api.message("startup");

  // prettier-ignore
  return <main id="startup">{message().message}</main>;
}
