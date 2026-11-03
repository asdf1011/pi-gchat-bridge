import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  isValidSecretName,
  SecretStore,
  tail,
  valueProblem,
} from "../src/secret-store.js";

function tempStore(): { store: SecretStore; file: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bridge-secrets-"));
  const file = path.join(dir, "secrets.json");
  return { store: new SecretStore(file), file, dir };
}

// --- Name validation ---------------------------------------------------------

test("accepts an env-var style name", () => {
  assert.equal(isValidSecretName("STRIPE_KEY"), true);
  assert.equal(isValidSecretName("A"), true);
  assert.equal(isValidSecretName("KEY2"), true);
});

test("rejects a name starting with a digit or containing a dash", () => {
  assert.equal(isValidSecretName("2KEY"), false);
  assert.equal(isValidSecretName("STRIPE-KEY"), false);
  assert.equal(isValidSecretName("STRIPE KEY"), false);
  assert.equal(isValidSecretName(""), false);
});

test("refuses names that would break the shell or pi", () => {
  for (const name of ["PATH", "HOME", "PWD", "SHELL", "IFS", "PI_SESSION_ID", "PI_MODEL"]) {
    assert.equal(isValidSecretName(name), false, name);
  }
});

// --- Value validation --------------------------------------------------------

test("rejects a value shorter than the redaction minimum", () => {
  assert.match(valueProblem("abc") ?? "", /too short/);
});

test("accepts a value at the minimum length", () => {
  assert.equal(valueProblem("abcd"), undefined);
});

test("rejects a multi-line value and points at the file workaround", () => {
  assert.match(valueProblem("-----BEGIN KEY-----\nabc\n-----END KEY-----") ?? "", /single-line/);
});

test("tail shows at most four characters and never the whole value", () => {
  assert.equal(tail("sk-live-abcdefgh"), "••••efgh");
  // A short value must not be recoverable from `/secret list` either: at least
  // one character always stays hidden, because the list is a Chat message the
  // model can read.
  assert.equal(tail("abcd"), "••••bcd");
  assert.notEqual(tail("abcd"), "••••abcd");
});

// --- Store round-trip --------------------------------------------------------

test("stores and lists a secret without exposing the value", () => {
  const { store } = tempStore();
  store.set("STRIPE_KEY", "sk-live-abcdefgh", "alice@example.com");
  const list = store.list();
  assert.equal(list.length, 1);
  assert.equal(list[0]?.name, "STRIPE_KEY");
  assert.equal(list[0]?.addedBy, "alice@example.com");
  assert.equal(list[0]?.tail, "••••efgh");
  assert.equal(JSON.stringify(list).includes("sk-live-abcdefgh"), false);
});

test("registrySecrets returns the values for redaction", () => {
  const { store } = tempStore();
  store.set("STRIPE_KEY", "sk-live-abcdefgh", "alice");
  assert.deepEqual(store.registrySecrets(), [{ name: "STRIPE_KEY", value: "sk-live-abcdefgh" }]);
});

test("writes the file with mode 0600", () => {
  const { store, file } = tempStore();
  store.set("KEY", "abcdefgh", "alice");
  const mode = fs.statSync(file).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, got 0${mode.toString(8)}`);
});

test("replacing a value keeps one entry", () => {
  const { store } = tempStore();
  store.set("KEY", "abcdefgh", "alice");
  store.set("KEY", "ijklmnop", "bob");
  assert.equal(store.list().length, 1);
  assert.deepEqual(store.registrySecrets(), [{ name: "KEY", value: "ijklmnop" }]);
});

test("remove reports whether anything was removed", () => {
  const { store } = tempStore();
  store.set("KEY", "abcdefgh", "alice");
  assert.equal(store.remove("KEY"), true);
  assert.equal(store.remove("KEY"), false);
  assert.equal(store.list().length, 0);
});

test("an unreadable file is treated as empty, not fatal", () => {
  const { store, file } = tempStore();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "not json at all");
  assert.deepEqual(store.list(), []);
  // And a later write repairs it rather than failing.
  store.set("KEY", "abcdefgh", "alice");
  assert.equal(store.list().length, 1);
});

test("a non-version-1 file is ignored rather than misread", () => {
  const { store, file } = tempStore();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 99, secrets: { KEY: { value: "abcdefgh" } } }));
  assert.deepEqual(store.list(), []);
});

test("an invalid name or value is refused before anything is written", () => {
  const { store, file } = tempStore();
  assert.throws(() => store.set("bad-name", "abcdefgh", "alice"), /not a usable secret name/);
  assert.throws(() => store.set("KEY", "abc", "alice"), /too short/);
  assert.equal(fs.existsSync(file), false);
});

test("has() distinguishes present from absent", () => {
  const { store } = tempStore();
  store.set("KEY", "abcdefgh", "alice");
  assert.equal(store.has("KEY"), true);
  assert.equal(store.has("OTHER"), false);
});

test("the default path is outside the bridge directory", () => {
  const resolved = SecretStore.defaultPath("/workspace/pi-gchat-bridge/bridge.sqlite");
  assert.equal(resolved.includes("pi-gchat-bridge/secrets.json"), false);
  assert.match(resolved, /\.pi-bridge/);
});
