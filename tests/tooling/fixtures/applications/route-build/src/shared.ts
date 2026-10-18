import { redirect } from "hesperia/routing";
import { switchHelper } from "./switch-helper.ts";

export const guard = ({ params }: { params: { id: string } }) => params.id === "a";

export const otherGuard = ({ params }: { params: { id: string } }) => params.id === "b";

export const redirectGuard = () => redirect("/login");

export const switchGuard = ({ params }: { params: { id: string } }) => {
  switch (params.id) {
    case "switch":
      return switchHelper(params.id);
    default:
      return false;
  }
};

export const unrelated = () => "SERVER_SHARED";
