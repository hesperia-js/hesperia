import { mount } from "hesperia";
import { BlobAttributes, getBlobAttributesControl } from "./BlobAttributes.tsx";
import {
  ForeignFileImage,
  replaceForeignFile,
  setInitialForeignFile,
} from "./ForeignFileImage.tsx";

declare global {
  interface Window {
    blobAttributesFixture: {
      replaceSources(): void;

      useGenericString(): void;

      dispose(): Promise<{ created: string[]; revoked: string[] }>;

      snapshot(): { created: string[]; revoked: string[] };
    };
    foreignFileFixture: {
      mount(): Promise<{ created: string[]; revoked: string[]; parentCreated: number }>;

      replace(): void;

      snapshot(): { created: string[]; revoked: string[]; parentCreated: number };

      dispose(): { created: string[]; revoked: string[]; parentCreated: number };
    };
  }
}

const target = document.getElementById("app");

if (!(target instanceof HTMLElement)) throw new Error("Golden application host is missing");

const created: string[] = [];
const revoked: string[] = [];
const createObjectURL = window.URL.createObjectURL.bind(window.URL);
const revokeObjectURL = window.URL.revokeObjectURL.bind(window.URL);
window.URL.createObjectURL = (blob) => {
  const url = createObjectURL(blob);

  created.push(url);

  return url;
};
window.URL.revokeObjectURL = (url) => {
  revoked.push(url);

  revokeObjectURL(url);
};

const application = mount(target, BlobAttributes, {});

await application.settled();

function snapshot(): { created: string[]; revoked: string[] } {
  return { created: created.slice(), revoked: revoked.slice() };
}

let foreignApplication: ReturnType<typeof mount> | undefined;
let foreignFrame: HTMLIFrameElement | undefined;
const foreignCreated: string[] = [];
const foreignRevoked: string[] = [];

function foreignSnapshot() {
  return {
    created: foreignCreated.slice(),
    revoked: foreignRevoked.slice(),
    parentCreated: created.length,
  };
}

function imageFile(color: string): File {
  return new File(
    [
      `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="${color}" /></svg>`,
    ],
    `${color.slice(1)}.svg`,
    { type: "image/svg+xml" },
  );
}

Object.assign(window, {
  blobAttributesFixture: {
    replaceSources() {
      getBlobAttributesControl().replaceSources();
    },

    useGenericString() {
      getBlobAttributesControl().useGenericString();
    },

    async dispose() {
      application.dispose();

      return snapshot();
    },

    snapshot,
  },
  foreignFileFixture: {
    async mount() {
      if (foreignApplication) throw new Error("The foreign File fixture is already mounted");

      const frame = document.createElement("iframe");
      frame.id = "foreign-file-frame";
      frame.src = "about:blank";
      const loaded = new Promise<void>((resolve) =>
        frame.addEventListener("load", () => resolve(), { once: true }),
      );

      document.body.append(frame);

      await loaded;
      const foreignWindow = frame.contentWindow;
      const foreignDocument = frame.contentDocument;

      if (!foreignWindow || !foreignDocument)
        throw new Error("The same-origin iframe is unavailable");

      const create = foreignWindow.URL.createObjectURL.bind(foreignWindow.URL);
      const revoke = foreignWindow.URL.revokeObjectURL.bind(foreignWindow.URL);
      foreignWindow.URL.createObjectURL = (blob) => {
        const url = create(blob);

        foreignCreated.push(url);

        return url;
      };
      foreignWindow.URL.revokeObjectURL = (url) => {
        foreignRevoked.push(url);

        revoke(url);
      };
      const file = imageFile("#bb3344");

      if (file instanceof foreignWindow.Blob)
        throw new Error("The File must come from the importing document's realm");

      setInitialForeignFile(file);

      foreignApplication = mount(foreignDocument.body, ForeignFileImage, {});
      foreignFrame = frame;

      await foreignApplication.settled();

      return foreignSnapshot();
    },

    replace() {
      replaceForeignFile(imageFile("#3377bb"));
    },

    snapshot: foreignSnapshot,

    dispose() {
      foreignApplication?.dispose();

      foreignApplication = undefined;

      foreignFrame?.remove();

      foreignFrame = undefined;
      return foreignSnapshot();
    },
  },
});

document.documentElement.dataset.ready = "true";
