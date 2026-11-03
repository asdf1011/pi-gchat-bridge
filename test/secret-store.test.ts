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

// --- File-backed secrets -----------------------------------------------------

test("a file-backed secret resolves its contents at use time", () => {
  const { store, dir } = tempStore();
  const file = path.join(dir, "key.pem");
  fs.writeFileSync(file, "-----BEGIN KEY-----\nabcdef\n-----END KEY-----\n");
  store.setFile("PEM_KEY", file, "alice");
  const [secret] = store.registrySecrets();
  assert.equal(secret?.name, "PEM_KEY");
  assert.equal(secret?.value.includes("BEGIN KEY"), true);
});

test("multi-line content is accepted through a file, though a card would refuse it", () => {
  // This is the gap the file form exists to fill: valueProblem() rejects a
  // newline, so a PEM or a service-account JSON has to arrive as a path.
  const { store, dir } = tempStore();
  const file = path.join(dir, "sa.json");
  fs.writeFileSync(file, JSON.stringify({ type: "service_account", private_key: "x".repeat(40) }, null, 2));
  assert.throws(() => store.set("SA", JSON.stringify({ a: 1 }, null, 2), "alice"), /single-line/);
  store.setFile("SA", file, "alice");
  assert.match(store.registrySecrets()[0]?.value ?? "", /service_account/);
});

test("a rotation is picked up without re-storing", () => {
  const { store, dir } = tempStore();
  const file = path.join(dir, "cert");
  fs.writeFileSync(file, "first-value-here");
  store.setFile("CERT", file, "alice");
  fs.writeFileSync(file, "second-value-here");
  assert.equal(store.registrySecrets()[0]?.value, "second-value-here");
});

test("a relative path is refused", () => {
  // Relative would resolve against PI_CWD — the agent's own directory.
  const { store } = tempStore();
  assert.throws(() => store.setFile("K", "secrets/key", "alice"), /absolute/);
  assert.throws(() => store.setFile("K", "./key", "alice"), /absolute/);
});

test("a missing file is refused at set time", () => {
  const { store, dir } = tempStore();
  assert.throws(() => store.setFile("K", path.join(dir, "nope"), "alice"), /cannot read/);
});

test("a symlink is refused, even when it points at a readable file", () => {
  // O_NOFOLLOW: otherwise a path could be swapped for a link into /proc or an
  // attacker-chosen file, turning "read the key" into "read anything".
  const { store, dir } = tempStore();
  const real = path.join(dir, "real");
  fs.writeFileSync(real, "a-real-secret-value");
  const link = path.join(dir, "link");
  fs.symlinkSync(real, link);
  assert.throws(() => store.setFile("K", link, "alice"), /cannot read/);
});

test("a file too short to redact safely is refused", () => {
  const { store, dir } = tempStore();
  const file = path.join(dir, "tiny");
  fs.writeFileSync(file, "ab");
  assert.throws(() => store.setFile("K", file, "alice"), /cannot read/);
});

test("a file that becomes unreadable is skipped, not mis-redacted", () => {
  // An empty pattern would match every character; skipping is the safe failure.
  const { store, dir } = tempStore();
  const file = path.join(dir, "gone");
  fs.writeFileSync(file, "value-then-deleted");
  store.setFile("K", file, "alice");
  fs.rmSync(file);
  assert.deepEqual(store.registrySecrets(), []);
});

test("the listing shows the path, never the contents", () => {
  const { store, dir } = tempStore();
  const file = path.join(dir, "sa.json");
  fs.writeFileSync(file, '{"private_key":"supersecretvalue"}');
  store.setFile("SA", file, "alice");
  const [row] = store.list();
  assert.equal(row?.from, file);
  assert.equal(row?.tail, undefined);
  assert.equal(JSON.stringify(row).includes("supersecretvalue"), false);
});

// --- Format migration --------------------------------------------------------

test("a store written before file-backed secrets is still read", () => {
  // The on-disk shape changed from `{value}` to `{source}`. Rather than force a
  // re-entry, the old shape is read as what it always meant.
  const { store, file } = tempStore();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      secrets: { OLD_KEY: { value: "old-value-here", addedAt: 1, addedBy: "alice" } },
    }),
  );
  assert.deepEqual(store.registrySecrets(), [{ name: "OLD_KEY", value: "old-value-here" }]);
});

test("an unrecognisable entry is dropped rather than guessed at", () => {
  const { store, file } = tempStore();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, secrets: { BAD: { nonsense: true } } }));
  assert.deepEqual(store.registrySecrets(), []);
});
