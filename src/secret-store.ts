/**
 * The bridge's secret store: names and values, entered out of band.
 *
 * Why not the environment: `start-bridge.sh` loads `.env.durable` with `set -a`,
 * so anything there is in `process.env` — and pi-durable builds each command's
 * environment from it, which means `bash` can read every value. A secret store
 * whose only protection is "pretend the model won't run `echo $NAME`" is not a
 * store. Two properties matter instead:
 *
 *   1. **Out of band entry.** The value is typed into a Chat *card*, so it is
 *      never a message in the space and never submitted as conversation input.
 *      `runDurableCommand()` runs before `router.deliver()`, so a `/secret`
 *      interaction cannot reach the transcript at all.
 *   2. **Redaction is the only reader.** The registry in `extensions/redact.ts`
 *      needs the literal value; nothing else does. Once captured, the value is
 *      used to build that registry and handed to the child process only when a
 *      command names it — the model never receives it in a tool result.
 *
 * What this deliberately is NOT: a security boundary. The bridge and its shell
 * share a UID, so the file below is readable by anything the agent can run. It
 * buys "not in the transcript, not in the chat scrollback, not in a session
 * export", which is the risk that actually bites. Making it a boundary needs a
 * separate process or keychain, and is a different piece of work.
 *
 * On-disk format: JSON, mode 0600, outside PI_CWD by default, with a `version`
 * so a future keychain-backed store can be introduced without guessing at the
 * old shape. Writes are atomic (temp file + rename) because a truncated store
 * would silently weaken redaction — the one failure mode worth spending code on.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { logger } from "./logger.js";
import type { RegisteredSecret } from "./durable/extensions/redact.js";
import { MIN_SECRET_LENGTH } from "./durable/extensions/redact.js";

/** One stored secret: the literal value plus where it came from. */
export interface StoredSecret {
  /** Environment-variable-style name, also the redaction marker's payload. */
  readonly value: string;
  /** Epoch ms, for `/secret list` and the store's own bookkeeping. */
  readonly addedAt: number;
  /** Who entered it (Chat display name), for the audit line a human reads. */
  readonly addedBy: string;
  /**
   * Optional restriction: only these Chat keys may use it. Empty/absent = every
   * conversation on this bridge. Not enforced yet beyond listing — recorded now
   * so the information is not lost when it is.
   */
  readonly scopes?: readonly string[];
}

interface StoreFile {
  readonly version: 1;
  readonly secrets: Record<string, StoredSecret>;
}

const EMPTY: StoreFile = { version: 1, secrets: {} };

/** Names that must not be captured: they would break the shell or pi itself. */
const RESERVED = new Set([
  "PATH",
  "HOME",
  "PWD",
  "SHELL",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "IFS",
  "BASH_ENV",
  "ENV",
]);

/** A name usable as both an env var and a marker payload. */
export function isValidSecretName(name: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) return false;
  if (RESERVED.has(name)) return false;
  // `PI_*` is pi's own namespace (session id, model, reasoning level).
  if (name.startsWith("PI_")) return false;
  return true;
}

/** Why a value cannot be stored, or undefined when it is acceptable. */
export function valueProblem(value: string): string | undefined {
  if (value.length < MIN_SECRET_LENGTH) {
    return `too short — at least ${MIN_SECRET_LENGTH} characters, or redaction would corrupt normal text`;
  }
  if (/[\r\n]/.test(value)) {
    // Multi-line secrets (PEM, service-account JSON) cannot go through a
    // single-line card input, and the redaction variants do not model them.
    return "single-line only — for a PEM or JSON key, store the path instead";
  }
  return undefined;
}

/** The last few characters, for `/secret list`. Never enough to be the value. */
export function tail(value: string): string {
  // Always leave at least one character unshown: the tail is shown in a Chat
  // message that the model can read, so a 4-character PIN must not be fully
  // recoverable from `/secret list`. Capped at four so a long key still reads.
  const shown = Math.min(4, value.length - 1);
  if (shown <= 0) return "••••";
  return `••••${value.slice(-shown)}`;
}

export class SecretStore {
  constructor(private readonly file: string) {}

  /** The default location: alongside the store, but not inside PI_CWD. */
  static defaultPath(bridgeDir: string): string {
    const configured = process.env.BRIDGE_SECRETS_FILE;
    if (configured) return configured;
    // `~/.pi-bridge/secrets.json`, not `./secrets.json`: the BridgeHost's cwd is
    // PI_CWD, which is where the agent's tools run, and a file in the working
    // directory is one `cat` away from being in a tool result.
    return path.join(path.dirname(bridgeDir), ".pi-bridge", "secrets.json");
  }

  private read(): StoreFile {
    try {
      const raw = fs.readFileSync(this.file, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return EMPTY;
      const candidate = parsed as Partial<StoreFile>;
      if (candidate.version !== 1 || !candidate.secrets || typeof candidate.secrets !== "object") {
        logger.error(`[secrets] ${this.file} is not a version 1 store — ignoring it`);
        return EMPTY;
      }
      return { version: 1, secrets: candidate.secrets as Record<string, StoredSecret> };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY;
      // A corrupt store must not silently disable redaction: say so loudly and
      // behave as empty, which means "no stored secrets" — the environment
      // registry still applies.
      logger.error(`[secrets] cannot read ${this.file}: ${(error as Error).message}`);
      return EMPTY;
    }
  }

  private write(next: StoreFile): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    // 0600 at creation: writing then chmod'ing leaves a window where the file is
    // world-readable, which on a shared host is the whole ballgame.
    fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }

  /** Names and metadata only — never a value. */
  list(): { name: string; addedAt: number; addedBy: string; tail: string }[] {
    const store = this.read();
    return Object.entries(store.secrets)
      .map(([name, secret]) => ({
        name,
        addedAt: secret.addedAt,
        addedBy: secret.addedBy,
        tail: tail(secret.value),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  has(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.read().secrets, name);
  }

  /**
   * Plaintext for the redaction registry, and for delivery.
   *
   * A redaction word list and a credential store are different things, so this
   * returns both: the redactor needs every value (to scrub output), while
   * delivery needs the value *and* the scope (to decide whether a command in
   * this conversation may have it). One read, two consumers, and the caller
   * decides which. Nothing else returns plaintext.
   *
   * Read per call by `host.ts`, not cached: a secret captured a minute ago must
   * be usable without a restart, and re-reading a small JSON is cheaper than
   * the bug where `/secret set` appeared to do nothing.
   */
  registrySecrets(): RegisteredSecret[] {
    return Object.entries(this.read().secrets).map(([name, secret]) => ({
      name,
      value: secret.value,
      ...(secret.scopes?.length ? { scopes: secret.scopes } : {}),
    }));
  }

  set(name: string, value: string, addedBy: string, scopes?: readonly string[]): void {
    if (!isValidSecretName(name)) throw new Error(`"${name}" is not a usable secret name`);
    const problem = valueProblem(value);
    if (problem) throw new Error(problem);

    const store = this.read();
    this.write({
      version: 1,
      secrets: {
        ...store.secrets,
        [name]: { value, addedAt: Date.now(), addedBy, ...(scopes?.length ? { scopes } : {}) },
      },
    });
    // Count and name only. A log line is a transcript with a different owner.
    logger.info(`[secrets] stored ${name} (${value.length} chars, by ${addedBy})`);
  }

  remove(name: string): boolean {
    const store = this.read();
    if (!Object.prototype.hasOwnProperty.call(store.secrets, name)) return false;
    const { [name]: _removed, ...rest } = store.secrets;
    this.write({ version: 1, secrets: rest });
    logger.info(`[secrets] removed ${name}`);
    return true;
  }
}
