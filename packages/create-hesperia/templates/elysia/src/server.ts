import { Elysia, t } from "elysia";
import { handleHesperiaRequest } from "./server-internals.ts";

const notes: { id: number; text: string }[] = [];
let nextNoteId = 1;

export const app = new Elysia()
  .onRequest(({ request }) => handleHesperiaRequest(request))
  .get("/api/notes", () => notes)
  .post(
    "/api/notes",
    ({ body }) => {
      const note = { id: nextNoteId++, text: body.text };

      notes.push(note);

      return note;
    },
    { body: t.Object({ text: t.String({ minLength: 1 }) }) },
  );

export type App = typeof app;
