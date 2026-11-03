/**
 * The browser page is a template string, so TypeScript never checks it.
 *
 * That is how it shipped broken: the script assigned `source`, `current`, `log`
 * and `tool` without declaring any of them, so the first conversation click threw
 * `ReferenceError: source is not defined` and the message pane stayed blank. The
 * server was fine the whole time — the page's own JS was not.
 *
 * These checks are deliberately shallow but targeted: they run the page's script
 * through `node --check` for syntax, and assert that each identifier the script
 * assigns is also declared. Not a linter — just a guard on the failure that
 * actually happened and is invisible to every other test here.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { WEB_PAGE } from "../src/adapter/web.js";

/** The contents of the page's single <script> block. */
function scriptOf(page: string): string {
  const match = /<script>([\s\S]*?)<\/script>/.exec(page);
  assert.ok(match, "the page must contain a script block");
  return match[1]!;
}

test("the page script parses as JavaScript", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-")), "page.mjs");
  fs.writeFileSync(file, scriptOf(WEB_PAGE));
  // Throws on a syntax error, with the message on stderr.
  execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
});

test("identifiers the script assigns are declared", () => {
  const script = scriptOf(WEB_PAGE);
  // Bare assignments at statement position: `name = ...` not preceded by `.` or
  // a declaration keyword. This is the shape that caused the ReferenceError.
  const declared = new Set<string>();
  for (const m of script.matchAll(/\b(?:let|const|var)\s+([A-Za-z_$][\w$]*)/g)) {
    declared.add(m[1]!);
  }
  // Function parameters and function declarations are in scope too.
  for (const m of script.matchAll(/function\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]!);
  for (const m of script.matchAll(/\(([^)]*)\)\s*=>/g)) {
    for (const part of m[1]!.split(",")) {
      const name = part.trim().split(/[:\s=]/)[0];
      if (name) declared.add(name);
    }
  }

  const assigned = new Set<string>();
  for (const m of script.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*=[^=]/g)) {
    assigned.add(m[1]!);
  }

  const globals = new Set([
    "location", "document", "window", "fetch", "JSON", "EventSource", "console",
    "setInterval", "setTimeout", "Promise", "Math", "Date", "Object", "Array",
  ]);
  const undeclared = [...assigned].filter((name) => !declared.has(name) && !globals.has(name));
  assert.deepEqual(undeclared, [], `undeclared identifiers assigned in the page script: ${undeclared.join(", ")}`);
});

test("the page declares the state its handlers use", () => {
  // Named explicitly: these four were all missing, and each is load-bearing.
  const script = scriptOf(WEB_PAGE);
  for (const name of ["current", "source", "log", "tool"]) {
    assert.match(script, new RegExp(`(?:let|const|var)\\s+${name}\\b`), `${name} must be declared`);
  }
});
