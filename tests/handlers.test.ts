import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// handlers.ts imports the Raycast API, so evaluate the pure function from source.
async function handlerFunction(name: string) {
  const text = await readFile("src/handlers.ts", "utf8");
  const source = ts.createSourceFile("handlers.ts", text, ts.ScriptTarget.Latest, true);
  const declaration = source.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  assert.ok(declaration, `Missing function ${name}`);
  const output = ts.transpileModule(`${declaration.getText(source).replace(/^export /, "")}; ${name};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return runInNewContext(output);
}

test("a closed window's yabai query error triggers the application launch fallback", async () => {
  const isWindowNotFoundError = await handlerFunction("isWindowNotFoundError");
  const message =
    "Command failed: /opt/homebrew/bin/yabai -m query --windows --window 148288\n" +
    "could not locate window with the specified id '148288'.";
  assert.equal(isWindowNotFoundError(message), true);
  assert.equal(isWindowNotFoundError("Selected window identity changed; refresh and try again"), false);
});
