import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { EditorProject } from "../../packages/language-server/src/project.ts";

test("page completion and diagnostics follow the route file when it is renamed", async () => {
  const source = `import type { Page } from "hesperia";
export default function UserPage(props: Page.Props<{ queryParams: { tab?: string } }>) {
  const id = props.params.uid;
  return <span>{id}:{props.queryParams().get("tab")}</span>;
}`;
  const filename = resolve("src/routes/users/[uid]/+page.tsx");
  const renamed = resolve("src/routes/users/[userId]/+page.tsx");
  const position = source.indexOf("props.params.uid") + "props.params.".length;
  const first = await EditorProject.create([{ filename, source }], { root: process.cwd() });

  try {
    expect(first.diagnostics.diagnostics).toStrictEqual([]);

    expect((await first.hover(filename, position))?.type).toBe("string");

    const firstCompletions = await first.completions(filename, position);

    expect(firstCompletions.map((item) => item.label)).toContain("uid");

    expect(firstCompletions.map((item) => item.label)).not.toContain("userId");
  } finally {
    await first.dispose();
  }

  const second = await EditorProject.create([{ filename: renamed, source }], {
    root: process.cwd(),
  });

  try {
    const errors = second.diagnostics.diagnostics.filter((item) => item.severity === "error");

    expect(errors).toHaveLength(1);

    expect(errors[0]?.code).toBe("TS2339");

    expect(errors[0]?.span?.start).toBe(position);

    expect(errors[0]?.span?.end).toBe(position + "uid".length);

    const names = (await second.completions(renamed, position)).map((item) => item.label);

    expect(names).toContain("userId");

    expect(names).not.toContain("uid");
  } finally {
    await second.dispose();
  }
});

test("unknown page parameters in JSX have an authored diagnostic range", async () => {
  const filename = resolve("src/routes/users/[id]/+page.tsx");
  const source = `import type { Page } from "hesperia";
export default function User(props: Page.Props) { return <span>{props.params.unknown}</span>; }`;
  const project = await EditorProject.create([{ filename, source }], { root: process.cwd() });

  try {
    const error = project.diagnostics.diagnostics.find((item) => item.code === "TS2339");

    expect(error?.span).toStrictEqual({
      start: source.indexOf("unknown"),
      end: source.indexOf("unknown") + "unknown".length,
    });
  } finally {
    await project.dispose();
  }
});

test("editor route completion keeps params for a page declaration named Page", async () => {
  const filename = resolve("src/routes/users/[id]/+page.tsx");
  const source = `import type { Page } from "hesperia";
export default function Page(props: Page.Props) { return <span>{props.params.id}</span>; }`;
  const project = await EditorProject.create([{ filename, source }], { root: process.cwd() });

  try {
    expect(project.diagnostics.diagnostics).toStrictEqual([]);

    const position = source.indexOf("props.params.id") + "props.params.".length;

    expect((await project.completions(filename, position)).map((item) => item.label)).toContain(
      "id",
    );
  } finally {
    await project.dispose();
  }
});

test("unsaved page query declarations reject non-string values and preserve native reads", async () => {
  const filename = resolve("src/routes/search/+page.tsx");
  const source = `import type { Page as SearchPage } from "hesperia";
export default function Search(props: SearchPage.Props<{ queryParams: { page?: string } }>) {
  const value: string | null = props.queryParams().get("page");
  return <span>{value}</span>;
}`;
  const valid = await EditorProject.create([{ filename, source }], { root: process.cwd() });

  try {
    expect(valid.diagnostics.diagnostics).toStrictEqual([]);
  } finally {
    await valid.dispose();
  }

  const invalidSource = source.replace("page?: string", "page?: number");
  const invalid = await EditorProject.create([{ filename, source: invalidSource }], {
    root: process.cwd(),
  });

  try {
    expect(invalid.diagnostics.diagnostics.some((item) => item.severity === "error")).toBe(true);
  } finally {
    await invalid.dispose();
  }

  const missing = await EditorProject.create(
    [{ filename, source: source.replace('get("page")', 'get("unknown")') }],
    { root: process.cwd() },
  );

  try {
    const errors = missing.diagnostics.diagnostics.filter((item) => item.severity === "error");

    expect(errors).toHaveLength(1);

    expect(errors[0]?.message).toContain("unknown");
  } finally {
    await missing.dispose();
  }
});
