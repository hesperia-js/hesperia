import { afterEach, expect, test } from "bun:test";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PluginPipeline } from "../../packages/tooling/src/plugin-pipeline.ts";
import { bundleCssRoots, CssBundleError } from "../../packages/tooling/src/css-bundling.ts";
import { stylex } from "../../packages/stylex/src/index.ts";
import { checkSources, prepareBuild } from "../../packages/tooling/src/project.ts";
import { devProject } from "../../packages/tooling/src/server.ts";
import { linkFrameworkPackages, unlinkFrameworkPackages } from "./fixture-dependencies.ts";

const roots: string[] = [];

const fixtureRoot = join(import.meta.dir, "fixtures/applications/stylex-integration");

interface StyleRevisionMessage {
  readonly type: "style-revision";
  readonly plan: {
    readonly assets: readonly {
      readonly id: string;
      readonly revision: string;
      readonly path: string;
    }[];
  };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("StyleX rebases aliased static URLs before hashing and bundles both contributors", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-stylex-integration-"));

  roots.push(root);

  const alpha = join(root, "src", "alpha");

  const beta = join(root, "src", "beta");

  await mkdir(join(alpha, "images"), { recursive: true });

  await mkdir(join(beta, "images"), { recursive: true });

  const alphaFile = join(alpha, "Card.tsx");

  const betaFile = join(beta, "Card.tsx");

  const alphaImage = join(alpha, "images", "icon.svg");

  const alphaEscapedImage = join(alpha, "images", "icon-alt.svg");

  const betaImage = join(beta, "images", "icon.svg");

  const alphaEscapedImageContents = "<svg><text>alpha escaped asset</text></svg>";

  await writeFile(alphaImage, `<svg><metadata>${"a".repeat(32 * 1024)}</metadata></svg>`);

  await writeFile(alphaEscapedImage, alphaEscapedImageContents);

  await writeFile(betaImage, `<svg><metadata>${"b".repeat(32 * 1024)}</metadata></svg>`);

  const alphaSource = await readFile(join(fixtureRoot, "rebase/src/alpha/Card.tsx"), "utf8");

  const betaSource = await readFile(join(fixtureRoot, "rebase/src/beta/Card.tsx"), "utf8");

  const plugin = stylex();

  const pipeline = new PluginPipeline([plugin]);

  const authoredSources = new Map([
    [alphaFile, { filename: alphaFile, authored: alphaSource, current: alphaSource }],
    [betaFile, { filename: betaFile, authored: betaSource, current: betaSource }],
  ]);

  const transformed = await pipeline.transformSources(authoredSources, root);

  const compilation = {
    modules: new Map(
      [alphaFile, betaFile].map((filename) => [
        filename,
        { semantics: { components: new Set<string>() } },
      ]),
    ),
  } as unknown as Parameters<typeof pipeline.generateStyles>[1];

  const styles = await pipeline.generateStyles(transformed, compilation);

  const style = styles[0]!;

  const css = style.css;

  const transformedAlpha = transformed.get(alphaFile)!.current;

  const transformedAlphaMap = transformed.get(alphaFile)!.map!;

  const rebasedUrls = style.assetReferences ?? [];

  expect(styles).toHaveLength(1);

  expect(style.owner).toStrictEqual({ kind: "application" });

  expect(style.inputFilename).toBe(join(root, ".hesperia", "stylex.css"));

  expect(transformedAlphaMap.sources.map((item) => item.replaceAll("\\", "/"))).toContain(
    alphaFile.replaceAll("\\", "/"),
  );

  expect(transformedAlphaMap.sourcesContent).toContain(alphaSource);

  expect(rebasedUrls.map((item) => item.filename).sort()).toStrictEqual(
    [alphaEscapedImage, alphaImage, betaImage].sort(),
  );

  expect(
    rebasedUrls.every(
      (item) => item.origin.filename === alphaFile || item.origin.filename === betaFile,
    ),
  ).toBe(true);

  const alphaReference = rebasedUrls.find((item) => item.origin.filename === alphaFile)!;

  expect(alphaSource.slice(alphaReference.origin.start, alphaReference.origin.end)).toContain(
    "url(",
  );

  expect(css).toContain('url("data:image/svg+xml,%3Csvg%3E")');

  expect(css).toContain('url("/public/icons/icon.svg")');

  expect(css).toContain('url("https://example.test/icon.svg")');

  expect(transformedAlpha).toContain("const unrelated = 'url(\"./images/icon.svg\")'");

  expect(css).toContain("../src/alpha/images/icon.svg?mode=small#symbol");

  expect(css).toContain("../src/alpha/images/icon-alt.svg?mode=small#symbol");

  expect(css).toContain("../src/beta/images/icon.svg?mode=small#symbol");

  const ruleSelector = (url: string): string => {
    const open = css.lastIndexOf("{", css.indexOf(url));

    return css
      .slice(Math.max(css.lastIndexOf("}", open), css.lastIndexOf("\n", open)) + 1, open)
      .trim();
  };

  const alphaSelector = ruleSelector("../src/alpha/images/icon.svg");

  const betaSelector = ruleSelector("../src/beta/images/icon.svg");

  expect(alphaSelector).not.toBe(betaSelector);

  expect(pipeline.watch).toContainEqual({ kind: "file", file: alphaImage });

  expect(pipeline.watch).toContainEqual({ kind: "file", file: alphaEscapedImage });

  expect(pipeline.watch).toContainEqual({ kind: "file", file: betaImage });

  expect(pipeline.capturedFiles).toHaveLength(0);

  const padding = css.indexOf(".x1i3ajwb");

  const background = css.indexOf(".x1t391ir");

  const color = css.indexOf(".x1e2nbdu");

  expect(padding).toBeGreaterThanOrEqual(0);

  expect(background).toBeGreaterThan(padding);

  expect(color).toBeGreaterThan(background);

  const firstBundle = await bundleCssRoots(root, [], styles, pipeline);

  const firstCss = await firstBundle.files.get(firstBundle.roots[0]!.path)!.text();

  expect(firstBundle.roots[0]?.source).toBe(join(root, ".hesperia", "stylex.css"));

  expect(
    pipeline.capturedFiles
      .filter(
        (item) =>
          item.filename === alphaImage ||
          item.filename === alphaEscapedImage ||
          item.filename === betaImage,
      )
      .map((item) => item.filename)
      .sort(),
  ).toStrictEqual([alphaEscapedImage, alphaImage, betaImage].sort());

  const escapedCapture = pipeline.capturedFiles.find(
    (item) => item.filename === alphaEscapedImage,
  )!;

  expect(pipeline.capturedFiles.filter((item) => item.filename === alphaEscapedImage)).toHaveLength(
    1,
  );

  expect(await escapedCapture.blob.text()).toBe(alphaEscapedImageContents);

  expect(firstCss).toContain("data:image/svg+xml;base64,");

  expect(firstCss.includes("#symbol")).toBe(true);

  expect(firstCss).toContain("/public/icons/icon.svg");

  expect(pipeline.capturedFiles.filter((item) => item.filename === alphaImage)).toHaveLength(1);

  expect(pipeline.capturedFiles.filter((item) => item.filename === betaImage)).toHaveLength(1);

  expect(pipeline.capturedFiles.find((item) => item.filename === alphaImage)?.digest).not.toBe(
    pipeline.capturedFiles.find((item) => item.filename === betaImage)?.digest,
  );

  await writeFile(alphaImage, "<svg><text>alpha next revision</text></svg>");

  const nextRevision = await bundleCssRoots(root, [], styles, new PluginPipeline());

  expect(nextRevision.roots[0]?.revision).not.toBe(firstBundle.roots[0]?.revision);
});

test("a missing StyleX URL asset keeps its contributor span through the Bun load race", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-stylex-missing-"));

  roots.push(root);

  const sourceDirectory = join(root, "src", "cards");

  await mkdir(sourceDirectory, { recursive: true });

  const image = join(sourceDirectory, "gone.svg");

  await writeFile(image, "<svg><text>present during the source transform</text></svg>");

  const filename = join(sourceDirectory, "Missing.tsx");

  const source = `import * as stylex from "@stylexjs/stylex";
export const styles = stylex.create({ root: { backgroundImage: 'url("./gone.svg")' } });
`;

  const pipeline = new PluginPipeline([stylex()]);

  const transformed = await pipeline.transformSources(
    new Map([[filename, { filename, authored: source, current: source }]]),
    root,
  );

  const compilation = {
    modules: new Map([[filename, { semantics: { components: new Set<string>() } }]]),
  } as unknown as Parameters<typeof pipeline.generateStyles>[1];

  const styles = await pipeline.generateStyles(transformed, compilation);

  const expectedReference = styles[0]!.assetReferences![0]!;

  expect(expectedReference.filename).toBe(image);

  await rm(image);

  await expect(bundleCssRoots(root, [], styles, pipeline)).rejects.toMatchObject({
    name: "TypeError",
    source: expectedReference.filename,
    origin: expectedReference.origin,
  } satisfies Partial<CssBundleError>);

  expect(expectedReference.origin.filename).toBe(filename);

  expect(source.slice(expectedReference.origin.start, expectedReference.origin.end)).toContain(
    "gone.svg",
  );
});

test("a StyleX image-only development edit publishes a CSS revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-stylex-development-"));

  const asset = join(root, "src", "cards", "images", "icon.svg");

  let server: Awaited<ReturnType<typeof devProject>> | undefined;

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  try {
    await linkFrameworkPackages(root);

    await linkStylexPackages(root);

    await mkdir(join(root, "src", "cards", "images"), { recursive: true });

    await mkdir(join(root, "src", "routes"), { recursive: true });

    await writeFile(asset, "<svg><text>revision one</text></svg>");

    await copyDevelopmentFixtures(root, "image-only");

    const initial = await prepareBuild(root, true).catch((error: unknown) => {
      if (typeof error === "object" && error !== null && "diagnostics" in error)
        throw new Error(JSON.stringify(error.diagnostics));

      throw error;
    });

    const initialAsset = initial.styleRevision?.plan.assets[0];

    if (!initialAsset)
      throw new Error(
        JSON.stringify({
          diagnostics: initial.diagnostics,
          styles: initial.styles?.map(({ id, inputFilename, owner }) => ({
            id,
            inputFilename,
            owner,
          })),
          files: [...initial.files.keys()],
        }),
      );

    expect(initialAsset).toBeDefined();

    const initialCss = await initial.files.get(`/assets/${basename(initialAsset!.path)}`)?.text();

    expect(initialCss).toBeDefined();

    server = await devProject(root, { port: 0 }).catch((error: unknown) => {
      if (typeof error === "object" && error !== null && "diagnostics" in error)
        throw new Error(JSON.stringify(error.diagnostics));

      throw error;
    });

    const events = await fetch(new URL("/_hesperia/events", server.url));

    reader = events.body!.getReader();

    await reader.read();

    await writeFile(asset, "<svg><text>revision two</text></svg>");

    let payload = "";

    let revision: StyleRevisionMessage | undefined;

    while (!revision) {
      const chunk = await reader.read();

      if (chunk.done)
        throw new Error("Development event stream closed before the StyleX asset revision");

      payload += new TextDecoder().decode(chunk.value);

      for (const line of payload.split(/\r?\n/u)) {
        if (!line.startsWith("data: ")) continue;

        const message: unknown = JSON.parse(line.slice("data: ".length));

        if (isStyleRevisionMessage(message)) revision = message;
        else if (message === "reload")
          throw new Error("A StyleX image-only edit triggered a full page reload");
      }

      payload = payload.slice(payload.lastIndexOf("\n") + 1);
    }

    const nextAsset = revision.plan.assets.find((item) => item.id === initialAsset!.id);

    expect(nextAsset).toBeDefined();

    expect(nextAsset!.revision).not.toBe(initialAsset!.revision);

    const response = await fetch(
      new URL(`/_hesperia/assets/${basename(nextAsset!.path)}`, server.url),
    );

    expect(response.status).toBe(200);

    const nextCss = await response.text();

    expect(nextCss).not.toBe(initialCss);
  } finally {
    await reader?.cancel().catch(() => undefined);

    await server?.close();

    await unlinkStylexPackages(root);

    await unlinkFrameworkPackages(root);

    await rm(root, { recursive: true, force: true });
  }
}, 90_000);

test("a StyleX asset also imported as text keeps an executable reload", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-stylex-dual-use-"));

  const asset = join(root, "src", "cards", "images", "icon.svg");

  let server: Awaited<ReturnType<typeof devProject>> | undefined;

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  try {
    await linkFrameworkPackages(root);

    await linkStylexPackages(root);

    await mkdir(join(root, "src", "cards", "images"), { recursive: true });

    await mkdir(join(root, "src", "routes"), { recursive: true });

    await writeFile(asset, "<svg><text>revision one</text></svg>");

    await copyDevelopmentFixtures(root, "dual-use");

    server = await devProject(root, { port: 0 });

    const events = await fetch(new URL("/_hesperia/events", server.url));

    reader = events.body!.getReader();

    await reader.read();

    await writeFile(asset, "<svg><text>revision two</text></svg>");

    let payload = "";

    let reloaded = false;

    while (!reloaded) {
      const chunk = await reader.read();

      if (chunk.done) throw new Error("Development event stream closed before executable reload");

      payload += new TextDecoder().decode(chunk.value);

      for (const line of payload.split(/\r?\n/u)) {
        if (!line.startsWith("data: ")) continue;

        const message: unknown = JSON.parse(line.slice("data: ".length));

        if (message === "reload") reloaded = true;
        else if (isStyleRevisionMessage(message))
          throw new Error("A dual-use StyleX asset edit was incorrectly published as CSS-only");
      }

      payload = payload.slice(payload.lastIndexOf("\n") + 1);
    }

    expect(reloaded).toBe(true);
  } finally {
    await reader?.cancel().catch(() => undefined);

    await server?.close();

    await unlinkStylexPackages(root);

    await unlinkFrameworkPackages(root);

    await rm(root, { recursive: true, force: true });
  }
}, 90_000);

test("relative prior source-map names keep StyleX asset provenance on an absolute authored file", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-stylex-map-origin-"));

  roots.push(root);

  const filename = join(root, "src", "Mapped.tsx");

  const source = `import * as stylex from "@stylexjs/stylex";
const styles = stylex.create({
  root: { backgroundImage: 'url("./images/icon.svg")' },
});
`;

  const map = {
    version: 3 as const,
    sources: ["Mapped.tsx"],
    names: [],
    mappings: identityMappings(source),
    sourcesContent: [source],
    sourceRoot: ".",
  };

  const pipeline = new PluginPipeline([
    {
      name: "relative-source-map",

      transformSource(input) {
        return { code: input.current, map };
      },
    },
    stylex(),
  ]);

  const transformed = await pipeline.transformSources(
    new Map([[filename, { filename, authored: source, current: source }]]),
    root,
  );

  const compilation = {
    modules: new Map([[filename, { semantics: { components: new Set<string>() } }]]),
  } as unknown as Parameters<typeof pipeline.generateStyles>[1];

  const styles = await pipeline.generateStyles(transformed, compilation);

  const reference = styles[0]!.assetReferences![0]!;

  expect(reference.filename).toBe(join(root, "src", "images", "icon.svg"));

  expect(reference.origin.filename).toBe(filename);

  expect(source.slice(reference.origin.start, reference.origin.end)).toContain("url(");
});

test("StyleX attrs work with static and reactive native class and style strings", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-stylex-native-attrs-"));

  roots.push(root);

  await linkStylexRuntime(root);

  const filename = join(root, "src", "Card.tsx");

  const appFilename = join(root, "app.tsx");

  const appSource = await readFile(join(fixtureRoot, "native-attrs/app.tsx"), "utf8");

  const source = await readFile(join(fixtureRoot, "native-attrs/src/Card.tsx"), "utf8");

  const transformed = await stylex().transformSource!({
    projectRoot: root,
    filename,
    authored: source,
    current: source,
  });

  const diagnostics = await checkSources(
    new Map([
      [filename, source],
      [appFilename, appSource],
    ]),
    root,
    {
      allowUnsafeHTML: false,
      mountURL: "/",
      allowUnsafeEmbed: false,
      resolutionOverrides: { browser: {} },
      plugins: [stylex()],
    },
  );

  expect(transformed?.code).toContain('as unknown as import("@stylexjs/stylex").CompiledStyles');

  expect(transformed?.code).toContain(
    'as [import("@stylexjs/stylex").CompiledStyles, import("@stylexjs/stylex").InlineStyles]',
  );

  expect(diagnostics.filter((item) => item.severity === "error")).toStrictEqual([]);
});

test("StyleX attrs style must be passed as a string-valued native attribute", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-stylex-native-style-error-"));

  roots.push(root);

  await linkStylexRuntime(root);

  const filename = join(root, "src", "Card.tsx");

  const source = `import * as stylex from "@stylexjs/stylex";
const styles = stylex.create({ root: { color: "red" } });
export function Card() {
  const attrs = () => stylex.attrs(styles.root);
  const invalidAttrs = stylex.attrs(styles.root, 42);
  void invalidAttrs;
  return <button class={attrs().class ?? ""} style={() => attrs().style ?? ""} />;
}
`;

  const diagnostics = await checkSources(new Map([[filename, source]]), root, {
    allowUnsafeHTML: false,
    mountURL: "/",
    allowUnsafeEmbed: false,
    resolutionOverrides: { browser: {} },
    plugins: [stylex()],
  });

  const styleError = diagnostics.find((item) => item.code === "TS2322");

  const attrsError = diagnostics.find((item) => item.code === "TS2345");

  expect(styleError?.message).toContain("not assignable to type 'string'");

  expect(attrsError?.message).toContain("not assignable to parameter of type");
});

test("StyleX attrs produce static classes and reactive inline style strings at runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-stylex-attrs-runtime-"));

  roots.push(root);

  await linkStylexRuntime(root);

  const filename = join(root, "src", "Attrs.tsx");

  const source = await readFile(join(fixtureRoot, "runtime-attrs/Attrs.tsx"), "utf8");

  const transformed = await stylex().transformSource!({
    projectRoot: root,
    filename,
    authored: source,
    current: source,
  });

  const output = join(root, "Attrs.tsx");

  await writeFile(output, transformed!.code);

  const attrs = await import(`${pathToFileURL(output).href}?revision=${Date.now()}`);

  expect(attrs.staticAttrs.class).toEqual(expect.any(String));

  expect(attrs.activeAttrs.class).toEqual(expect.any(String));

  expect(attrs.activeAttrs.style).toBe("--x-color:rebeccapurple");

  expect(attrs.inactiveAttrs.class).toEqual(expect.any(String));

  expect(attrs.inactiveAttrs.style).toBeUndefined();
});

async function linkStylexRuntime(root: string): Promise<void> {
  const scope = join(root, "node_modules", "@stylexjs");

  await mkdir(scope, { recursive: true });

  await symlink(
    join(import.meta.dir, "../../packages/stylex/node_modules/@stylexjs/stylex"),
    join(scope, "stylex"),
    process.platform === "win32" ? "junction" : "dir",
  );
}

async function copyDevelopmentFixtures(root: string, variant: "image-only" | "dual-use") {
  const files = [
    ["development/shared/hesperia.config.ts", "hesperia.config.ts"],
    ["development/shared/src/routes/+page.tsx", "src/routes/+page.tsx"],
    ["development/shared/app.tsx", "app.tsx"],
    [`development/${variant}/src/cards/Card.tsx`, "src/cards/Card.tsx"],
  ] as const;

  for (const [source, destination] of files) {
    const target = join(root, destination);

    await mkdir(dirname(target), { recursive: true });

    await copyFile(join(fixtureRoot, source), target);
  }
}

async function linkStylexPackages(root: string): Promise<void> {
  await symlink(
    resolve(import.meta.dir, "../../packages/stylex"),
    join(root, "node_modules", "@hesperia", "stylex"),
    "junction",
  );

  await linkStylexRuntime(root);
}

async function unlinkStylexPackages(root: string): Promise<void> {
  for (const name of [
    join(root, "node_modules", "@hesperia", "stylex"),
    join(root, "node_modules", "@stylexjs", "stylex"),
  ]) {
    try {
      await unlink(name);
    } catch (error) {
      if (
        !(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      )
        throw error;
    }
  }
}

function isStyleRevisionMessage(value: unknown): value is StyleRevisionMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "style-revision" &&
    "plan" in value &&
    typeof value.plan === "object" &&
    value.plan !== null &&
    "assets" in value.plan &&
    Array.isArray(value.plan.assets)
  );
}

function identityMappings(source: string): string {
  const base64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  let previousSource = 0;

  let previousOriginalLine = 0;

  let previousOriginalColumn = 0;

  return source
    .split("\n")
    .map((line, originalLine) => {
      let previousGeneratedColumn = 0;

      return Array.from({ length: line.length + 1 }, (_unused, column) => {
        const values = [
          column - previousGeneratedColumn,
          -previousSource,
          originalLine - previousOriginalLine,
          column - previousOriginalColumn,
        ];

        previousGeneratedColumn = column;

        previousSource = 0;

        previousOriginalLine = originalLine;

        previousOriginalColumn = column;

        return values
          .map((value) => {
            const sign = value < 0 ? 1 : 0;

            let encoded = (Math.abs(value) << 1) | sign;

            let segment = "";

            do {
              let digit = encoded & 31;

              encoded >>>= 5;

              if (encoded > 0) digit |= 32;

              segment += base64[digit];
            } while (encoded > 0);

            return segment;
          })
          .join("");
      }).join(",");
    })
    .join(";");
}

test("URL controls and ordinary string values remain intact outside recognized StyleX definitions", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-stylex-controls-"));

  roots.push(root);

  const filename = join(root, "src", "Control.tsx");

  const source = `import { create as makeStyles } from "@stylexjs/stylex";
const text = 'url("./images/icon.svg")';
export const styles = makeStyles({
  root: {
    backgroundImage: 'url("./images/icon.svg")',
    maskImage: 'url("data:image/svg+xml,%3Csvg%3E")',
    borderImageSource: 'url("https://example.test/image.svg")',
  },
});
export { text };
`;

  const result = await stylex().transformSource!({
    projectRoot: root,
    filename,
    authored: source,
    current: source,
  });

  expect(result?.code).toContain("const text = 'url(\"./images/icon.svg\")'");

  expect(JSON.stringify(result?.data?.rules)).toContain("data:image/svg+xml,%3Csvg%3E");

  expect(JSON.stringify(result?.data?.rules)).toContain("https://example.test/image.svg");

  expect(result?.data?.assetReferences).toHaveLength(1);
});
