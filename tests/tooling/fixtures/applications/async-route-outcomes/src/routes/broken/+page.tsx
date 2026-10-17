import { api } from "../../../api";

export default async function Broken() {
  const message = await api.message("broken");

  return <main id="broken">{message().message}</main>;
}
