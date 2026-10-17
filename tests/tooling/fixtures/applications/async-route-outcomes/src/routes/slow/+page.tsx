import { api } from "../../../api";

export default async function Slow() {
  const message = await api.message("slow");

  return <main id="slow">{message().message}</main>;
}
