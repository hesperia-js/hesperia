import * as client from "hesperia/client";

let initialFile: File | undefined;
let replaceSource: ((file: File) => void) | undefined;

export function setInitialForeignFile(file: File): void {
  initialFile = file;
}

export function replaceForeignFile(file: File): void {
  if (!replaceSource) throw new Error("The foreign File image has not mounted");

  replaceSource(file);
}

export function ForeignFileImage() {
  if (!initialFile) throw new Error("The parent document File was not supplied");

  const source = client.state<Blob | string>(initialFile);
  replaceSource = (file) => source.set(file);
  return <img id="foreign-file-image" src={source()} />;
}
