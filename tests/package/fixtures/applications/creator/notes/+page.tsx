import * as client from "hesperia/client";
import { api } from "../../client.ts";

type IsAssignable<From, To> = [From] extends [To] ? true : false;

type Equal<Left, Right> =
  IsAssignable<Left, Right> extends true ? IsAssignable<Right, Left> : false;

type IsAny<Value> = 0 extends 1 & Value ? true : false;

type Assert<Condition extends true> = Condition;

type AssertFalse<Condition extends false> = Condition;

type NotesQuery = ReturnType<typeof api.api.notes.get>;

type CreateNote = ReturnType<typeof api.api.notes.post>;

type NotesValue = ReturnType<NotesQuery["value"]>;

type MutationResult = Awaited<ReturnType<CreateNote["run"]>>;

type ExpectedNote = { id: number; text: string };

type NoteList = Exclude<NotesValue, Response | undefined>;

type Note = NoteList extends readonly (infer Item)[] ? Item : never;

type CreatedNote = Exclude<MutationResult, Response>;

type NoteRequest = Parameters<CreateNote["run"]>[0];

type WrongPayload = { id: string; text: number };

type _NotesValueIsNotAny = AssertFalse<IsAny<NotesValue>>;

type _MutationResultIsNotAny = AssertFalse<IsAny<MutationResult>>;

type _NotesValueRetainsHostResponse = Assert<
  Equal<NotesValue, ExpectedNote[] | Response | undefined>
>;

type _MutationResultRetainsHostResponse = Assert<Equal<MutationResult, ExpectedNote | Response>>;

type _NotePayloadIsExact = Assert<Equal<Note, ExpectedNote>>;

type _CreatedPayloadIsExact = Assert<Equal<CreatedNote, ExpectedNote>>;

type _WrongQueryPayloadIsRejected = AssertFalse<IsAssignable<WrongPayload, Note>>;

type _WrongMutationPayloadIsRejected = AssertFalse<IsAssignable<WrongPayload, CreatedNote>>;

type _RequestAcceptsText = Assert<
  IsAssignable<{ readonly body: { readonly text: string } }, NoteRequest>
>;

type _RequestRequiresBody = AssertFalse<IsAssignable<{}, NoteRequest>>;

type _RequestRejectsNumber = AssertFalse<
  IsAssignable<{ readonly body: { readonly text: number } }, NoteRequest>
>;

function formatNotes(value: NotesValue): string {
  if (value === undefined) return "pending";

  if (value instanceof Response) return "hosting-response";

  return value.map((note) => note.id + ":" + note.text).join("|") || "empty";
}

export default function NotesPage() {
  const notes = api.api.notes.get();

  const createNote = api.api.notes.post();

  const created = client.state("pending");

  return (
    <main>
      <h1>Installed Eden client</h1>
      <output id="notes">{formatNotes(notes.value())}</output>
      <output id="created-note">{created()}</output>
      <button
        id="create-note"
        type="button"
        on:click={() => {
          void createNote
            .run({ body: { text: "created through installed browser adapter" } })
            .then((result) => {
              if (result instanceof Response) {
                created.update(() => "hosting-response");

                return;
              }

              created.update(() => result.id + ":" + result.text);

              return notes.revalidate();
            });
        }}
      >
        Create note
      </button>
    </main>
  );
}
