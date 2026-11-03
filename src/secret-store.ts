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
import os from "node:os";
import path from "node:path";

import { logger } from "./logger.js";
import type { RegisteredSecret } from "./durable/extensions/redact.js";
import { MIN_SECRET_LENGTH } from "./durable/extensions/redact.js";

/**
 * Where a secret's bytes come from.
 *
 * Two kinds, because they answer different problems and one of them cannot be a
 * card input at all:
 *
 *  - `value`: the literal, typed on a card. Single-line only — a card has no
 *    multi-line input, and the redaction variants do not model newlines.
 *  - `file`: a path to read at use time. This is what a PEM or a
 *    service-account JSON needs, and it is also the *better* option for any
 *    long-lived credential: the bytes never pass through Chat, never sit in the
 *    store, and stay where the operator already controls permissions.
 *
 * A path is not itself secret, so storing one is safe in a way storing a value
 * is not — `/secret set cert --file /etc/cloudflared/tunnel.json` is a
 * reasonable thing to record.
 */
export type SecretSource =
  | { readonly kind: "value"; readonly value: string }
  | { readonly kind: "file"; readonly path: string };

/** One stored secret: where it comes from, plus provenance. */
export interface StoredSecret {
  /** Environment-variable-style name, also the redaction marker's payload. */
  readonly source: SecretSource;
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

/**
 * Bring an older entry up to the `source` shape.
 *
 * Before file-backed secrets, an entry was `{ value, addedAt, addedBy, scopes }`.
 * Rather than bump the version and force a re-entry, the old shape is read as
 * what it always meant — a literal value — so a store written by a previous
 * build keeps working. Anything unrecognisable is dropped, because guessing at a
 * credential's shape is worse than forgetting it.
 */
function migrate(raw: Record<string, unknown>): Record<string, StoredSecret> {
  const out: Record<string, StoredSecret> = {};
  for (const [name, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const addedAt = typeof e.addedAt === "number" ? e.addedAt : 0;
    const addedBy = typeof e.addedBy === "string" ? e.addedBy : "unknown";
    const scopes = Array.isArray(e.scopes) ? (e.scopes.filter((x) => typeof x === "string") as string[]) : undefined;
    const withScopes = scopes?.length ? { scopes } : {};

    const source = e.source as SecretSource | undefined;
    if (source?.kind === "value" && typeof source.value === "string") {
      out[name] = { source, addedAt, addedBy, ...withScopes };
    } else if (source?.kind === "file" && typeof source.path === "string") {
      out[name] = { source, addedAt, addedBy, ...withScopes };
    } else if (typeof e.value === "string") {
      // Pre-file-backed entry.
      out[name] = { source: { kind: "value", value: e.value }, addedAt, addedBy, ...withScopes };
    }
  }
  return out;
}

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

/**
 * Why a file path is unusable, or undefined when it is acceptable.
 *
 * Absolute only: a relative path would be resolved against `PI_CWD`, which is
 * the agent's own working directory — so the agent could pick the target.
 * Symlinks are rejected (see `assertReadable`) rather than followed here, since
 * only the resolved check can tell.
 */
export function pathProblem(filePath: string): string | undefined {
  if (!filePath.trim()) return "empty path";
  if (!path.isAbsolute(filePath)) {
    return "must be absolute — a relative path would resolve inside the agent's working directory";
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

/**
 * Force a mode on an existing path, best-effort.
 *
 * A failure here is logged rather than thrown: refusing to store a secret
 * because a chmod was denied would be worse than storing it at the wrong mode,
 * and the operator can see the warning. Skipped on platforms without POSIX modes.
 */
function tighten(target: string, mode: number): void {
  try {
    const current = fs.statSync(target).mode & 0o777;
    if (current !== mode) fs.chmodSync(target, mode);
  } catch (error) {
    // Only complain when we can see a wider mode; ENOENT and EPERM are noise.
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "EPERM") {
      logger.error(`[secrets] cannot set ${mode.toString(8)} on ${target}: ${(error as Error).message}`);
    }
  }
}

export class SecretStore {
  constructor(private readonly file: string) {}

  /**
   * Where the store lives: the operator's home, not the project directory.
   *
   * This used to be `dirname(dbPath)/.pi-bridge/`, with a comment claiming that
   * was "not inside PI_CWD". It was: `BRIDGE_DB` defaults to `./bridge.sqlite`,
   * so the store landed in the bridge directory — which is exactly `PI_CWD`, the
   * directory the agent's `read` and `bash` sit in. A secrets file there is one
   * `cat` away from a tool result.
   *
   * `~/.pi-bridge/` is outside the project, so the agent only reaches it by
   * naming an absolute path in `$HOME` — which is a deliberate act, not an
   * accident of the default working directory. `BRIDGE_SECRETS_FILE` overrides.
   */
  static defaultPath(_dbPath?: string): string {
    const configured = process.env.BRIDGE_SECRETS_FILE;
    if (configured) return configured;
    return path.join(os.homedir(), ".pi-bridge", "secrets.json");
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
      return { version: 1, secrets: migrate(candidate.secrets as Record<string, unknown>) };
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
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // `mode` on mkdir only applies at creation, so an existing directory keeps
    // whatever permissions it had. A store found at 0755 (which happened: an
    // earlier build created it, and the mode is a claim the file has to keep) is
    // tightened here rather than left readable.
    tighten(dir, 0o700);

    const temp = `${this.file}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    // 0600 at creation: writing then chmod'ing leaves a window where the file is
    // world-readable, which on a shared host is the whole ballgame.
    fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    tighten(temp, 0o600);
    fs.renameSync(temp, this.file);
    tighten(this.file, 0o600);
  }

  /**
   * Names and metadata only — never a value.
   *
   * For a file-backed secret there IS no tail to show, so `tail` is undefined
   * and `from` carries the path instead. Showing a path is safe: a path is not
   * the secret, and knowing it is what lets an operator confirm the right file
   * was recorded.
   */
  list(): {
    name: string;
    addedAt: number;
    addedBy: string;
    tail?: string;
    from?: string;
  }[] {
    const store = this.read();
    return Object.entries(store.secrets)
      .map(([name, secret]) => ({
        name,
        addedAt: secret.addedAt,
        addedBy: secret.addedBy,
        ...(secret.source.kind === "value"
          ? { tail: tail(secret.source.value) }
          : { from: secret.source.path }),
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
    const out: RegisteredSecret[] = [];
    for (const [name, secret] of Object.entries(this.read().secrets)) {
      const value = this.resolve(secret);
      // A file-backed secret whose file is unreadable is skipped rather than
      // mis-redacted: an empty pattern would match every character.
      if (value === undefined) {
        logger.error(`[secrets] ${name}: file unreadable, not redacting it`);
        continue;
      }
      out.push({ name, value, ...(secret.scopes?.length ? { scopes: secret.scopes } : {}) });
    }
    return out;
  }

  /**
   * The bytes a secret stands for, or undefined if they cannot be read.
   *
   * Read on every call rather than cached. For a file-backed secret that means a
   * rotated certificate is picked up without a restart — which is the whole
   * reason to point at a file instead of storing a value.
   *
   * `O_NOFOLLOW` refuses a symlink: the store is operator-owned, but a path that
   * can be swapped for a link into `/proc` or an attacker-chosen file turns
   * "read the key" into "read anything". Rejecting rather than resolving keeps
   * the failure visible.
   */
  private resolve(secret: StoredSecret): string | undefined {
    if (secret.source.kind === "value") return secret.source.value;
    try {
      const fd = fs.openSync(secret.source.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const value = fs.readFileSync(fd, "utf8");
        return value.length >= MIN_SECRET_LENGTH ? value : undefined;
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return undefined;
    }
  }

  /** Store a literal value, typed on a card. Single-line only. */
  set(name: string, value: string, addedBy: string, scopes?: readonly string[]): void {
    if (!isValidSecretName(name)) throw new Error(`"${name}" is not a usable secret name`);
    const problem = valueProblem(value);
    if (problem) throw new Error(problem);

    this.put(name, { kind: "value", value }, addedBy, scopes);
    // Count and name only. A log line is a transcript with a different owner.
    logger.info(`[secrets] stored ${name} (${value.length} chars, by ${addedBy})`);
  }

  /**
   * Store a path to read at use time.
   *
   * The file is checked at set time so a typo is caught while a human is
   * looking, and read again at every use so a rotation is picked up. Its
   * contents are never copied into the store.
   */
  setFile(name: string, filePath: string, addedBy: string, scopes?: readonly string[]): void {
    if (!isValidSecretName(name)) throw new Error(`"${name}" is not a usable secret name`);
    const problem = pathProblem(filePath);
    if (problem) throw new Error(problem);

    const trimmed = filePath.trim();
    // Read once now: catches a missing file, a symlink, and a permissions
    // problem at the moment the operator can still fix it.
    const probe = this.resolve({ source: { kind: "file", path: trimmed } } as StoredSecret);
    if (probe === undefined) {
      throw new Error(`cannot read ${trimmed} (missing, unreadable, a symlink, or under ${MIN_SECRET_LENGTH} bytes)`);
    }

    this.put(name, { kind: "file", path: trimmed }, addedBy, scopes);
    logger.info(`[secrets] stored ${name} as a path (${trimmed}, by ${addedBy})`);
  }

  private put(name: string, source: SecretSource, addedBy: string, scopes?: readonly string[]): void {
    const store = this.read();
    this.write({
      version: 1,
      secrets: {
        ...store.secrets,
        [name]: { source, addedAt: Date.now(), addedBy, ...(scopes?.length ? { scopes } : {}) },
      },
    });
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
