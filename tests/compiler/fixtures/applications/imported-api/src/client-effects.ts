import { defineEdenEffect } from "@hesperia/elysia/effects";

type App = typeof import("./server").app;

export const effects = [
  defineEdenEffect<App>()(
    { method: "POST", path: "/preview-refresh" },
    { method: "GET", path: "/files/:version?/preview/:fileId" },
    ({ body }) => ({ params: { fileId: body.fileId } }),
    "revalidate",
  ),
] as const;
