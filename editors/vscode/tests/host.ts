import * as vscode from "vscode";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Verify the built extension inside VS Code's extension host. */
export async function run(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert(folder, "The extension test requires its isolated workspace.");
  const report = join(folder.uri.fsPath, "editor-result.json");
  try {
    const extension = vscode.extensions.getExtension("hesperia.hesperia-vscode");
    assert(extension, "Hesperia development extension is loaded.");
    await extension.activate();
    const shellUri = vscode.Uri.joinPath(folder.uri, "app.tsx");
    const apiUri = vscode.Uri.joinPath(folder.uri, "api.ts");
    const uri = vscode.Uri.joinPath(folder.uri, "src", "App.tsx");
    const shellDocument = await vscode.workspace.openTextDocument(shellUri);
    await until(() => shellDocument.languageId === "hesperia-tsx");
    const shellSource = shellDocument.getText();
    const invalidShell = shellSource.replace(
      "<body><main>{message}</main></body>",
      "<body><html><main>{message}</main></html></body>",
    );
    const shellEdit = new vscode.WorkspaceEdit();
    shellEdit.replace(
      shellUri,
      new vscode.Range(shellDocument.positionAt(0), shellDocument.positionAt(shellSource.length)),
      invalidShell,
    );
    assert(await vscode.workspace.applyEdit(shellEdit));
    await until(() =>
      vscode.languages
        .getDiagnostics(shellUri)
        .some((item) => item.source === "hesperia" && item.code === "HES-DOCUMENT-SHELL"),
    );
    const restoreShell = new vscode.WorkspaceEdit();
    restoreShell.replace(
      shellUri,
      new vscode.Range(shellDocument.positionAt(0), shellDocument.positionAt(invalidShell.length)),
      shellSource,
    );
    assert(await vscode.workspace.applyEdit(restoreShell));
    await until(() => vscode.languages.getDiagnostics(shellUri).length === 0);
    const apiDocument = await vscode.workspace.openTextDocument(apiUri);
    await until(() => apiDocument.languageId === "typescript");
    await vscode.workspace.openTextDocument(uri);
    await until(
      () =>
        vscode.workspace.textDocuments.find(
          (document) => document.uri.toString() === uri.toString(),
        )?.languageId === "hesperia-tsx",
    );
    await until(() =>
      vscode.languages
        .getDiagnostics(uri)
        .some((item) => item.source === "hesperia" && item.code === "TS2339"),
    );
    const apiSource = apiDocument.getText();
    const brokenApi = new vscode.WorkspaceEdit();
    brokenApi.replace(
      apiUri,
      new vscode.Range(apiDocument.positionAt(0), apiDocument.positionAt(apiSource.length)),
      'export const label = "changed";',
    );
    assert(await vscode.workspace.applyEdit(brokenApi));
    await until(() => vscode.languages.getDiagnostics(uri).some((item) => item.code === "TS2305"));
    const restoreApi = new vscode.WorkspaceEdit();
    restoreApi.replace(
      apiUri,
      new vscode.Range(
        apiDocument.positionAt(0),
        apiDocument.positionAt('export const label = "changed";'.length),
      ),
      apiSource,
    );
    assert(await vscode.workspace.applyEdit(restoreApi));
    await until(() => !vscode.languages.getDiagnostics(uri).some((item) => item.code === "TS2305"));
    assert(
      !vscode.languages.getDiagnostics(uri).some((item) => item.source === "ts"),
      "Stock JSX diagnostics are absent from Hesperia TSX.",
    );
    const position = new vscode.Position(2, " return <div title={field.".length);
    const hover = await vscode.commands.executeCommand<vscode.Hover[]>(
      "vscode.executeHoverProvider",
      uri,
      position,
    );
    const hoverText = hover
      ?.flatMap((item) =>
        item.contents.map((content) => (typeof content === "string" ? content : content.value)),
      )
      .join("\n");
    assert(hoverText?.includes("string"), `Hover result: ${hoverText}`);
    const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
      "vscode.executeCompletionItemProvider",
      uri,
      position,
    );
    assert(completions?.items.some((item) => item.label === "focus"));
    const definition = await vscode.commands.executeCommand<
      (vscode.Location | vscode.LocationLink)[]
    >(
      "vscode.executeDefinitionProvider",
      uri,
      new vscode.Position(2, " return <div title={".length),
    );
    assert.equal(definition?.length, 1);
    const target = definition[0]!;
    const range =
      "targetRange" in target ? (target.targetSelectionRange ?? target.targetRange) : target.range;
    assert.equal(range.start.line, 1);
    assert.equal(range.start.character, ' const emoji = "🐈"; const '.length);
    const document = vscode.workspace.textDocuments.find(
      (item) => item.uri.toString() === uri.toString(),
    )!;
    const start = document.getText().indexOf("missing()");
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      uri,
      new vscode.Range(document.positionAt(start), document.positionAt(start + "missing()".length)),
      "value",
    );
    assert(await vscode.workspace.applyEdit(edit));
    await until(() => vscode.languages.getDiagnostics(uri).length === 0);
    const validSource = document.getText();
    const invalidTree =
      'const label: string = "🐈";\r\nexport function App() { return <table><tr><td>{label}</td></tr></table>; }';
    const replaceSource = async (source: string) => {
      const replacement = new vscode.WorkspaceEdit();
      replacement.replace(
        uri,
        new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
        source,
      );
      assert(await vscode.workspace.applyEdit(replacement));
    };
    let counter = `import * as client from "hesperia/client";

export default function Page() {
  const count = client.state(0);
  const update = () => count.update((value) => value + 1);
  return (
    <main>
      <h1>Hesperia</h1>
      <button on:click={update}>Count: {count()}</button>
    </main>
  );
}
`;
    await replaceSource(counter);
    counter = document.getText();
    const identifiers = await vscode.commands.executeCommand<vscode.CompletionList>(
      "vscode.executeCompletionItemProvider",
      uri,
      document.positionAt(counter.indexOf("{update}") + 4),
    );
    for (const name of ["update", "count", "client", "document"])
      assert(
        identifiers?.items.some((item) => item.label === name),
        `Identifier completion includes ${name}`,
      );
    assert(
      !identifiers?.items.some(
        (item) => typeof item.label === "string" && item.label.startsWith("__hesperia_"),
      ),
    );
    const definitionAt = async (offset: number) => {
      const results = await vscode.commands.executeCommand<
        (vscode.Location | vscode.LocationLink)[]
      >("vscode.executeDefinitionProvider", uri, document.positionAt(offset));
      assert(results?.length, `Missing definition at ${counter.slice(offset, offset + 20)}`);
      const result = results[0]!;
      const targetUri = "targetUri" in result ? result.targetUri : result.uri;
      const targetRange =
        "targetRange" in result
          ? (result.targetSelectionRange ?? result.targetRange)
          : result.range;
      const targetDocument = await vscode.workspace.openTextDocument(targetUri);
      return { uri: targetUri, text: targetDocument.getText(targetRange) };
    };
    assert.equal((await definitionAt(counter.indexOf("{update}") + 3)).text, "update");
    for (const token of ["client from", "client.state", '"hesperia/client"']) {
      const imported = await definitionAt(counter.indexOf(token) + 3);
      assert(imported.uri.path.endsWith("/dist/client.d.ts"), imported.uri.toString());
    }
    assert.equal((await definitionAt(counter.indexOf("on:click") + 4)).text, "onclick");
    for (const [tag, type] of [
      ["<main>", "HTMLElement"],
      ["</main>", "HTMLElement"],
      ["<button ", "HTMLButtonElement"],
      ["</button>", "HTMLButtonElement"],
    ] as const) {
      const offset = counter.indexOf(tag) + 3;
      const nativeHover = await vscode.commands.executeCommand<vscode.Hover[]>(
        "vscode.executeHoverProvider",
        uri,
        document.positionAt(offset),
      );
      const content = nativeHover?.[0]?.contents[0];
      const text = typeof content === "string" ? content : content?.value;
      assert(text?.includes(type), `Native ${tag} hover: ${text}`);
      assert.equal((await definitionAt(offset)).text, type);
    }
    const outline = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      "vscode.executeDocumentSymbolProvider",
      uri,
    );
    const pageSymbol = outline?.find((symbol) => symbol.name === "Page");
    assert(pageSymbol, "Outline includes the authored Page function.");
    assert.equal(document.getText(pageSymbol.selectionRange), "Page");
    assert(pageSymbol.children.some((symbol) => symbol.name === "count"));
    assert(pageSymbol.children.some((symbol) => symbol.name === "update"));
    assert(!outline?.some((symbol) => symbol.name.includes("__hesperia_")));
    const configurationUri = vscode.Uri.joinPath(folder.uri, "hesperia.config.json");
    assert(
      vscode.languages.getDiagnostics(configurationUri).some((item) => item.code === "HES-CONFIG"),
      "An empty config reports its own error without disabling code navigation.",
    );
    await vscode.workspace.fs.writeFile(configurationUri, new TextEncoder().encode("{}"));
    await until(() => vscode.languages.getDiagnostics(configurationUri).length === 0);
    for (const partial of ["", "dr"]) {
      await replaceSource(counter.replace("on:click", `on:${partial}`));
      const eventSource = document.getText();
      const offset = eventSource.indexOf("on:") + 3 + partial.length;
      const suggestions = await vscode.commands.executeCommand<vscode.CompletionList>(
        "vscode.executeCompletionItemProvider",
        uri,
        document.positionAt(offset),
        ...(partial ? [] : [":"]),
      );
      const item = suggestions?.items.find((entry) => entry.label === "dragstart");
      assert(item, `Event suggestions after on:${partial}`);
      assert(!suggestions?.items.some((entry) => entry.label === "dragStart"));
      if (!partial) assert(suggestions?.items.some((entry) => entry.label === "click"));
      const range = item.range && ("replacing" in item.range ? item.range.replacing : item.range);
      assert(range, "Event completion has an explicit replacement range.");
      assert.equal(document.getText(range), partial);
      assert.equal(item.insertText, "dragstart");
      const accept = new vscode.WorkspaceEdit();
      accept.replace(uri, range, item.insertText);
      assert(await vscode.workspace.applyEdit(accept));
      assert(document.getText().includes("on:dragstart={update}"));
      await until(() => vscode.languages.getDiagnostics(uri).length === 0);
    }
    await replaceSource(invalidTree);
    await until(() =>
      vscode.languages.getDiagnostics(uri).some((item) => item.code === "HES-HTML-CONTEXT"),
    );
    const compilerDiagnostic = vscode.languages
      .getDiagnostics(uri)
      .find((item) => item.code === "HES-HTML-CONTEXT" && item.message.startsWith("<td>"));
    assert(compilerDiagnostic, "Compiler diagnostics reach the editor after an unsaved edit.");
    assert.equal(document.getText(compilerDiagnostic.range), "<td>{label}</td>");
    await replaceSource(validSource);
    await until(() => vscode.languages.getDiagnostics(uri).length === 0);
    const firstRoute = vscode.Uri.joinPath(folder.uri, "src/routes/(first)/+page.tsx");
    const secondRoute = vscode.Uri.joinPath(folder.uri, "src/routes/(second)/+page.tsx");
    const routeSource = new TextEncoder().encode(
      "export default function Page() { return <main>page</main>; }",
    );
    for (const route of [firstRoute, secondRoute]) {
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(route, ".."));
      await vscode.workspace.fs.writeFile(route, routeSource);
    }
    await until(() =>
      [firstRoute, secondRoute].every((route) =>
        vscode.languages.getDiagnostics(route).some((item) => item.code === "HES-ROUTE-SCAN"),
      ),
    );
    await vscode.workspace.fs.rename(
      secondRoute,
      vscode.Uri.joinPath(folder.uri, "src/routes/(second)/+layout.tsx"),
    );
    await until(() =>
      [firstRoute, secondRoute].every(
        (route) => vscode.languages.getDiagnostics(route).length === 0,
      ),
    );
    const declarationUri = vscode.Uri.joinPath(folder.uri, "src/routes/+route.ts");
    await vscode.workspace.fs.writeFile(
      declarationUri,
      new TextEncoder().encode(
        'import { route } from "hesperia/routing";\nexport default route({ guard: () => true });',
      ),
    );
    const declaration = await vscode.workspace.openTextDocument(declarationUri);
    await until(() =>
      vscode.languages
        .getDiagnostics(declarationUri)
        .some((item) => item.code === "HES-ROUTE-GUARD"),
    );
    const guardDiagnostic = vscode.languages
      .getDiagnostics(declarationUri)
      .find((item) => item.code === "HES-ROUTE-GUARD")!;
    assert.equal(declaration.getText(guardDiagnostic.range), "() => true");
    const guardEdit = new vscode.WorkspaceEdit();
    guardEdit.replace(
      declarationUri,
      new vscode.Range(
        declaration.positionAt(0),
        declaration.positionAt(declaration.getText().length),
      ),
      'import { route } from "hesperia/routing";\nconst guard = () => true;\nexport default route({ guard });',
    );
    assert(await vscode.workspace.applyEdit(guardEdit));
    await until(() => vscode.languages.getDiagnostics(declarationUri).length === 0);
    await writeFile(
      report,
      JSON.stringify({
        passed: true,
        checks: [
          "root app shell recognition and diagnostics",
          "unsaved ordinary TypeScript dependency update",
          "language",
          "diagnostics",
          "no duplicate JSX diagnostics",
          "hover",
          "completion",
          "local and imported identifier completion without auto-import failure",
          "definition",
          "counter callback and import definitions",
          "native event attribute definition",
          "native opening and closing tag types and definitions",
          "native event completion and insertion after on: and a partial name",
          "authored Outline symbols after unsaved edit",
          "empty configuration diagnostics and recovery",
          "unsaved edit",
          "compiler diagnostics and authored ranges",
          "route collisions and file rename",
          "route guard authored ranges and unsaved correction",
        ],
      }),
    );
  } catch (error) {
    await writeFile(
      report,
      JSON.stringify({
        passed: false,
        error: error instanceof Error ? error.stack : String(error),
      }),
    );
    throw error;
  }
}

function until(predicate: () => boolean): Promise<void> {
  if (predicate()) return Promise.resolve();
  return new Promise((accept, reject) => {
    const subscriptions = [
      vscode.languages.onDidChangeDiagnostics(check),
      vscode.workspace.onDidOpenTextDocument(check),
      vscode.workspace.onDidChangeTextDocument(check),
    ];
    const timeout = setTimeout(() => {
      close();
      reject(new Error("VS Code did not reach the expected editor state."));
    }, 15000);
    function close(): void {
      clearTimeout(timeout);
      for (const subscription of subscriptions) subscription.dispose();
    }
    function check(): void {
      if (predicate()) {
        close();
        accept();
      }
    }
    check();
  });
}
