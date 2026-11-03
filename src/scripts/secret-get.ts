#!/usr/bin/env node
/**
 * Print one secret's value, for a supervisor that cannot import TypeScript.
 *
 * `start-bridge.sh` needs `TUNNEL_TOKEN` before the bridge process exists, so it
 * cannot ask the running bridge. It could parse `secrets.json` in bash — but that
 * duplicates the store's on-disk format in a second language, and the whole point
 * of `source`/migration logic is that the format is the store's business.
 *
 * So the reading goes through `SecretStore` itself. Same class the bridge uses,
 * same migration, same `O_NOFOLLOW` handling for file-backed secrets — no second
 * implementation to drift.
 *
 *   node dist/scripts/secret-get.js TUNNEL_TOKEN
 *     → the value on stdout, exit 0
 *     → nothing on stdout, exit 1, reason on stderr
 *
 * Deliberate choices:
 *  - The value goes to stdout and nothing else does, so `$(...)` captures it
 *    cleanly and no log line can accidentally contain it.
 *  - Errors name the secret, never a value.
 *  - A file-backed secret is read through the same resolution path, so a
 *    `/secret set NAME --file /path` works here too (e.g. a PEM for a tunnel).
 */
import { SecretStore } from "../secret-store.js";

const name = process.argv[2];
if (!name) {
  process.stderr.write("usage: secret-get.js NAME\n");
  process.exit(2);
}

// Same resolution the bridge uses, so a BRIDGE_SECRETS_FILE override applies.
// The bridge derives it from the db path; here the default is reproduced from
// BRIDGE_DB, falling back to this project's own database.
const dbPath = process.env.BRIDGE_DB ?? new URL("../../bridge.sqlite", import.meta.url).pathname;
const store = new SecretStore(SecretStore.defaultPath(dbPath));

if (!store.has(name)) {
  process.stderr.write(`no stored secret called ${name}\n`);
  process.exit(1);
}

// registrySecrets() is the only method that returns plaintext, and it resolves
// file-backed secrets at call time. Reading it whole and filtering keeps this
// script to the store's public surface — no extra accessors just for the
// supervisor.
const found = store.registrySecrets().find((secret) => secret.name === name);
if (!found) {
  // Present in the index but unreadable: a file-backed secret whose file is
  // gone, or one shorter than the redaction minimum.
  process.stderr.write(`secret ${name} could not be read\n`);
  process.exit(1);
}

process.stdout.write(found.value);
