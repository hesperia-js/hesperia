import * as client from "hesperia/client";

type SourceSet = readonly (readonly [Blob | string, `${number}w` | `${number}x`])[];

export interface BlobAttributesControl {
  replaceSources(): void;

  useGenericString(): void;
}

let control: BlobAttributesControl | undefined;

export function getBlobAttributesControl(): BlobAttributesControl {
  if (!control) throw new Error("The Blob attribute route has not mounted");

  return control;
}

function imageBlob(color: string): Blob {
  return new Blob(
    [
      `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" fill="${color}" /></svg>`,
    ],
    { type: "image/svg+xml" },
  );
}

function audioBlob(): Blob {
  const buffer = new ArrayBuffer(44 + 16_000);
  const view = new DataView(buffer);

  const write = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++)
      view.setUint8(offset + index, value.charCodeAt(index));
  };

  write(0, "RIFF");

  view.setUint32(4, buffer.byteLength - 8, true);

  write(8, "WAVE");

  write(12, "fmt ");

  view.setUint32(16, 16, true);

  view.setUint16(20, 1, true);

  view.setUint16(22, 1, true);

  view.setUint32(24, 8000, true);

  view.setUint32(28, 16000, true);

  view.setUint16(32, 2, true);

  view.setUint16(34, 16, true);

  write(36, "data");

  view.setUint32(40, 16_000, true);

  for (let index = 0; index < 8000; index++) {
    view.setInt16(
      44 + index * 2,
      Math.round(Math.sin((2 * Math.PI * 440 * index) / 8000) * 4096),
      true,
    );
  }

  return new Blob([buffer], { type: "audio/wav" });
}

const authorImage = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" fill="#3266cc" /></svg>')}`;

export function BlobAttributes() {
  const initial = imageBlob("#cc3344");
  const generic = client.state<Blob | string>(initial);
  const image = client.state<Blob | string>(initial);
  const sources = client.state<SourceSet>([
    [initial, "1x"],
    [authorImage, "2x"],
  ]);
  const poster = client.state<Blob | string>(imageBlob("#33aa66"));
  const audio = client.state<Blob | string>(audioBlob());

  control = {
    replaceSources() {
      const next = imageBlob("#aa33cc");

      generic.set(next);

      image.set(next);

      sources.set([
        [next, "1x"],
        [authorImage, "2x"],
      ]);

      poster.set(imageBlob("#e4a323"));

      audio.set(audioBlob());
    },

    useGenericString() {
      generic.set("https://author.example.test/generic.svg");
    },
  };

  return (
    <main id="blob-page">
      <div id="generic-src" src={generic()} />
      <img id="blob-image" src={image()} />
      <img id="responsive-image" srcset={sources()} />
      <video id="blob-video" poster={poster()} />
      <audio id="blob-audio" preload="metadata" src={audio()} />
    </main>
  );
}

export function AwayPage() {
  return <main id="away-page">Away</main>;
}
