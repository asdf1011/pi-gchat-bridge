/**
 * `secret-get.js`: the one place the supervisor reads the store.
 *
 * `start-bridge.sh` needs TUNNEL_TOKEN before the bridge exists, so it shells out
 * to this script instead of parsing `secrets.json` itself. That choice is what
 * these tests protect: if the store's format ever changes, the script follows it
 * for free, and the supervisor keeps working — whereas a bash `jq` would have
 * silently read the wrong field.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { SecretStore } from "../src/secret-store.js";

const script = path.join(import.meta.dirname, "../dist/scripts/secret-get.js");

/** Run the built script against a store, returning {out, code}. */
function run(storeFile: string, name: string): { out: string; code: number } {
  try {
    const out = execFileSync(process.execPath, [script, name], {
      env: { ...process.env, BRIDGE_SECRETS_FILE: storeFile },
      encoding: "utf8",
    });
    return { out, code: 0 };
  } catch (error) {
    const e = error as { stdout?: string; status?: number };
    return { out: e.stdout ?? "", code: e.status ?? 1 };
  }
}

function tempStore(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bridge-get-"));
  return path.join(dir, "secrets.json");
}

test("prints a stored value on stdout and nothing else", () => {
  const file = tempStore();
  new SecretStore(file).set("TUNNEL_TOKEN", "eyJhIjoix", "alice");
  const { out, code } = run(file, "TUNNEL_TOKEN");
  assert.equal(code, 0);
  // Exact: a trailing newline would end up inside a shell variable.
  assert.equal(out, "eyJhIjoix");
});

test("a file-backed secret resolves to its contents", () => {
  // This is the /secret set NAME --file case reaching the supervisor.
  const file = tempStore();
  const target = path.join(path.dirname(file), "tok");
  fs.writeFileSync(target, "from-a-file-value");
  new SecretStore(file).setFile("CF_TOKEN", target, "alice");
  const { out, code } = run(file, "CF_TOKEN");
  assert.equal(code, 0);
  assert.equal(out, "from-a-file-value");
});

test("a missing secret exits 1 with a message naming it, not a value", () => {
  const file = tempStore();
  new SecretStore(file).set("OTHER", "some-other-value", "alice");
  const { out, code } = run(file, "TUNNEL_TOKEN");
  assert.equal(code, 1);
  assert.equal(out, "");
});

test("an unreadable file-backed secret exits 1", () => {
  const file = tempStore();
  const target = path.join(path.dirname(file), "gone");
  fs.writeFileSync(target, "value-then-deleted");
  new SecretStore(file).setFile("CF_TOKEN", target, "alice");
  fs.rmSync(target);
  assert.equal(run(file, "CF_TOKEN").code, 1);
});

test("no name argument exits 2", () => {
  const file = tempStore();
  try {
    execFileSync(process.execPath, [script], {
      env: { ...process.env, BRIDGE_SECRETS_FILE: file },
      stdio: "pipe",
    });
    assert.fail("expected a nonzero exit");
  } catch (error) {
    assert.equal((error as { status?: number }).status, 2);
  }
});

test("a store written by an older build still resolves", () => {
  // Provenance for the migration: the script reads through SecretStore, so an
  // old `{value}` entry works without the supervisor knowing.
  const file = tempStore();
  fs.writeFileSync(
    file,
    JSON.stringify({ version: 1, secrets: { TUNNEL_TOKEN: { value: "legacy-value", addedAt: 1, addedBy: "a" } } }),
  );
  assert.equal(run(file, "TUNNEL_TOKEN").out, "legacy-value");
});
