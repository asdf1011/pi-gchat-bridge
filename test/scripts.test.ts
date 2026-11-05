/**
 * The shell scripts in this repository must stay executable, in git.
 *
 * Not a style rule — a production incident. The container's command is a path to
 * `start-bridge.sh`, and the image is `node:*-slim`, whose `docker-entrypoint.sh`
 * prepends `node` when its argument is not a command on `PATH`. A script whose
 * executable bit had been lost in the repository therefore became
 *
 *     node /workspace/pi-chat-bridge/start-bridge.sh
 *     ERR_UNKNOWN_FILE_EXTENSION: Unknown file extension ".sh"
 *
 * and `restart: unless-stopped` turned that into a death loop. The bit is stored
 * in git, so a checkout or export restores whatever was committed: this test is
 * the thing that notices when it is committed as `100644`.
 *
 * It checks the working tree, which is what the container bind-mounts, and it
 * names the fix rather than just failing.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const projectRoot = new URL("..", import.meta.url).pathname;

/** Every shell script a human or a supervisor is meant to run directly. */
const SCRIPTS = ["start-bridge.sh", "start-bridge-sdk.sh", ".restart-bridge.sh", ".upgrade-restart.sh"];

test("the shell scripts are executable, with a shebang", () => {
  for (const name of SCRIPTS) {
    const file = path.join(projectRoot, name);
    if (!fs.existsSync(file)) continue; // a script may legitimately be removed

    const mode = fs.statSync(file).mode;
    assert.ok(
      (mode & 0o111) !== 0,
      `${name} is not executable — the container would run it as "node ${name}". ` +
        `Fix: chmod +x ${name} && jj commit (or git update-index --chmod=+x ${name})`,
    );

    const firstLine = fs.readFileSync(file, "utf8").split("\n", 1)[0] ?? "";
    assert.match(firstLine, /^#!\//, `${name} must start with a shebang, or the entrypoint cannot exec it`);
  }
});
