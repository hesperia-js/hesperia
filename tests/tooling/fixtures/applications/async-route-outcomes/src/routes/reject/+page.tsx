import { api } from "../../../api";

export default async function Reject() {
  const message = await api.message("reject");

  return <main id="reject">{message().message}</main>;
}
