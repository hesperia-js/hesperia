import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createClient, type State } from "../../packages/hesperia/src/client.ts";
import { Owner } from "../../packages/hesperia/src/runtime/owner.ts";
import {
  defineComponent,
  dynamic,
  element,
  mount,
} from "../../packages/hesperia/src/runtime/index.ts";

const windows: Window[] = [];

afterEach(() => {
  for (const window of windows.splice(0)) window.close();
});

function container(): Element {
  const window = new Window();

  windows.push(window);

  return window.document.body as unknown as Element;
}

function trackObjectURLs(window: Window) {
  let next = 0;
  const created: { readonly blob: unknown; readonly url: string }[] = [];
  const revoked: string[] = [];

  Object.defineProperty(window.URL, "createObjectURL", {
    configurable: true,

    value(blob: Blob) {
      const url = `blob:happy-dom/${++next}`;

      created.push({ blob, url });

      return url;
    },
  });

  Object.defineProperty(window.URL, "revokeObjectURL", {
    configurable: true,

    value(url: string) {
      revoked.push(url);
    },
  });

  return { created, revoked };
}

test("Blob src, video poster, and structured srcset URLs follow attribute and owner lifetimes", () => {
  const target = container();
  const window = windows.at(-1)!;
  const urls = trackObjectURLs(window);
  const first = new window.Blob(["first"], { type: "image/svg+xml" }) as unknown as Blob;
  const second = new window.Blob(["second"], { type: "image/svg+xml" }) as unknown as Blob;
  const srcsetFirst = new window.Blob(["srcset first"]) as unknown as Blob;
  const srcsetSecond = new window.Blob(["srcset second"]) as unknown as Blob;
  const srcsetReplacement = new window.Blob(["srcset replacement"]) as unknown as Blob;
  const external = "https://assets.example.test/author-owned.svg";

  type SourceSet = readonly (readonly [Blob | string, string])[];

  let generic!: State<Blob | string>;
  let peer!: State<Blob | string>;
  let imageSource!: State<Blob | string>;
  let candidates!: State<SourceSet>;
  let poster!: State<Blob | string | undefined>;
  let pageOwner!: Owner;
  let genericNode!: HTMLDivElement;
  let peerNode!: HTMLDivElement;
  let image!: HTMLImageElement;
  let srcsetImage!: HTMLImageElement;
  let video!: HTMLVideoElement;
  let staticImage!: HTMLImageElement;

  const App = defineComponent((owner) => {
    pageOwner = owner;
    const client = createClient(owner);
    generic = client.state<Blob | string>(first);
    peer = client.state<Blob | string>(first);
    imageSource = client.state<Blob | string>(first);
    candidates = client.state<SourceSet>([
      [srcsetFirst, "1x"],
      [external, "2x"],
    ]);
    poster = client.state<Blob | string | undefined>(second);

    genericNode = element(owner, "div", { id: "generic", src: dynamic(generic) });
    peerNode = element(owner, "div", { id: "peer", src: dynamic(peer) });
    image = element(owner, "img", { id: "image", src: dynamic(imageSource) });
    srcsetImage = element(owner, "img", { id: "srcset", srcset: dynamic(candidates) });
    video = element(owner, "video", { id: "video", poster: dynamic(poster) });
    staticImage = element(owner, "img", { id: "static", src: first });
    return [genericNode, peerNode, image, srcsetImage, video, staticImage];
  });

  const application = mount(target, App, {});
  const nativeTarget = target as unknown as typeof window.document.body;
  const firstURLs = urls.created.filter(({ blob }) => blob === first).map(({ url }) => url);
  const secondURLs = urls.created.filter(({ blob }) => blob === second).map(({ url }) => url);
  const srcsetFirstURL = urls.created.find(({ blob }) => blob === srcsetFirst)!.url;

  expect(firstURLs).toHaveLength(4);

  expect(new Set(firstURLs).size).toBe(4);

  expect(secondURLs).toHaveLength(1);

  expect(genericNode.getAttribute("src")).not.toBe(peerNode.getAttribute("src"));

  expect(image.getAttribute("src")).toBe(firstURLs[2]!);

  expect(srcsetImage.getAttribute("srcset")).toBe(`${srcsetFirstURL} 1x, ${external} 2x`);

  expect(video.getAttribute("poster")).toBe(secondURLs[0]!);

  expect(staticImage.getAttribute("src")).toBe(firstURLs[3]!);

  const cached = window.document.createDocumentFragment();

  while (nativeTarget.firstChild) cached.appendChild(nativeTarget.firstChild);

  pageOwner.suspend();

  const createdBeforeSuspension = urls.created.length;
  const revokedBeforeSuspension = urls.revoked.slice();

  imageSource.set(second);

  expect(urls.created).toHaveLength(createdBeforeSuspension);

  expect(urls.revoked).toStrictEqual(revokedBeforeSuspension);

  expect(image.getAttribute("src")).toBe(firstURLs[2]!);

  nativeTarget.appendChild(cached);

  pageOwner.resume();

  const imageSecondURL = urls.created.at(-1)!.url;

  expect(image.getAttribute("src")).toBe(imageSecondURL);

  expect(urls.revoked).toContain(firstURLs[2]!);

  expect(target.querySelector("#image")).toBe(image);

  candidates.set([
    [srcsetSecond, "1x"],
    [external, "2x"],
  ]);

  const srcsetSecondURL = urls.created.find(({ blob }) => blob === srcsetSecond)!.url;

  expect(srcsetImage.getAttribute("srcset")).toBe(`${srcsetSecondURL} 1x, ${external} 2x`);

  expect(urls.revoked).toContain(srcsetFirstURL);

  candidates.set([
    [srcsetFirst, "1x"],
    [srcsetSecond, "2x"],
  ]);

  const srcsetFirstPairURL = urls.created.filter(({ blob }) => blob === srcsetFirst).at(-1)!.url;

  expect(srcsetImage.getAttribute("srcset")).toBe(
    `${srcsetFirstPairURL} 1x, ${srcsetSecondURL} 2x`,
  );

  expect(urls.revoked).not.toContain(srcsetSecondURL);

  candidates.set([
    [srcsetReplacement, "1x"],
    [srcsetSecond, "2x"],
  ]);

  const srcsetReplacementURL = urls.created.find(({ blob }) => blob === srcsetReplacement)!.url;

  expect(srcsetImage.getAttribute("srcset")).toBe(
    `${srcsetReplacementURL} 1x, ${srcsetSecondURL} 2x`,
  );

  expect(urls.revoked).toContain(srcsetFirstPairURL);

  expect(urls.revoked).not.toContain(srcsetSecondURL);

  const genericFirstURL = firstURLs[0]!;

  generic.set(external);

  expect(genericNode.getAttribute("src")).toBe(external);

  expect(urls.revoked).toContain(genericFirstURL);

  expect(urls.revoked).not.toContain(firstURLs[1]);

  poster.set(undefined);

  expect(video.hasAttribute("poster")).toBe(false);

  expect(urls.revoked).toContain(secondURLs[0]!);

  application.dispose();

  expect(urls.revoked).toContain(imageSecondURL);

  expect(urls.revoked).toContain(srcsetSecondURL);

  expect(urls.revoked).toContain(srcsetReplacementURL);

  expect(urls.revoked).toContain(firstURLs[1]!);

  expect(urls.revoked).toContain(firstURLs[3]!);

  expect(new Set(urls.revoked).size).toBe(urls.created.length);
});

test("a failed Blob attribute write revokes only its new URL and keeps the prior lease", () => {
  const target = container();
  const window = windows.at(-1)!;
  const urls = trackObjectURLs(window);
  const first = new window.Blob(["first"], { type: "image/svg+xml" }) as unknown as Blob;
  const second = new window.Blob(["second"], { type: "image/svg+xml" }) as unknown as Blob;
  let source!: State<Blob | string>;
  let image!: HTMLImageElement;
  const errors: unknown[] = [];
  const App = defineComponent((owner) => {
    source = createClient(owner).state<Blob | string>(first);
    image = element(owner, "img", { src: dynamic(source) });
    return image;
  });

  const application = mount(target, App, {}, { onError: (error) => errors.push(error) });
  const firstURL = image.getAttribute("src")!;
  const originalSetAttribute = image.setAttribute.bind(image);
  const failure = new Error("attribute write failed");
  image.setAttribute = (name, value) => {
    if (name === "src" && value !== firstURL) throw failure;

    originalSetAttribute(name, value);
  };

  source.set(second);

  const secondURL = urls.created.at(-1)!.url;

  expect(urls.created).toHaveLength(2);

  expect(image.getAttribute("src")).toBe(firstURL);

  expect(urls.revoked).toStrictEqual([secondURL]);

  expect(errors).toContain(failure);

  image.setAttribute = originalSetAttribute;

  application.dispose();

  expect(urls.revoked).toStrictEqual([secondURL, firstURL]);
});

test("direct embedded-document elements fault before document creation", () => {
  const target = container();
  const window = windows.at(-1)!;
  const errors: unknown[] = [];
  let pageOwner!: Owner;
  const App = defineComponent((owner) => {
    pageOwner = owner;
    return element(owner, "main");
  });
  const application = mount(target, App, {}, { onError: (error) => errors.push(error) });
  const createdTags: string[] = [];
  const createElement = window.document.createElement.bind(window.document);
  window.document.createElement = ((tag: string) => {
    if (["iframe", "embed", "object"].includes(tag)) createdTags.push(tag);

    return createElement(tag);
  }) as typeof window.document.createElement;
  const sourceValues: unknown[] = ["/frame.html", new window.Blob(["frame"])];

  for (const tag of ["iframe", "embed", "object"]) {
    for (const src of sourceValues) {
      expect(() => element(pageOwner, tag, { src })).toThrow(
        /official Embed component from hesperia\/embed/u,
      );
    }
  }

  expect(target.querySelector("iframe, embed, object")).toBeNull();

  expect(createdTags).toStrictEqual([]);

  expect(errors).toStrictEqual([]);

  application.dispose();
});
