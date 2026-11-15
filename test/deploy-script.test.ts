/**
 * `scripts/deploy.sh`: the contract that matters is "a failed build never restarts".
 *
 * Not a shell-script test for its own sake — the whole reason this script exists is that the
 * build and the restart were two steps nobody did together, so the one behaviour worth pinning
 * is that the second step cannot happen after the first one failed.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const SCRIPT = path.resolve(import.meta.dirname, "../scripts/deploy.sh");

function run(args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile("bash", [SCRIPT, ...args], { env: { ...process.env, ...env } }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : ((error.code as number | undefined) ?? 1), out: `${stdout}${stderr}` });
    });
  });
}

test("--help prints the usage and exits 0", async () => {
  const { code, out } = await run(["--help"]);
  assert.equal(code, 0);
  assert.match(out, /npm run deploy/);
  assert.match(out, /--now/);
  // The script body must not leak into its own help.
  assert.doesNotMatch(out, /^set -u$/m);
});

test("an unknown option is refused rather than ignored", async () => {
  const { code, out } = await run(["--nope"]);
  assert.equal(code, 2);
  assert.match(out, /unknown option/);
});

test("--quiet and --wait need numbers", async () => {
  assert.equal((await run(["--quiet", "soon"])).code, 2);
  assert.equal((await run(["--wait"])).code, 2);
});

test("a failed build stops before any restart, and says the bridge is untouched", async () => {
  // Copied into the repo beside the real one, because the script resolves its project from its
  // own location — a copy in /tmp would look for `.restart-when-idle.sh` somewhere that has none
  // and fail for the wrong reason.
  const copy = path.join(path.dirname(SCRIPT), ".deploy-failing.sh");
  fs.writeFileSync(copy, fs.readFileSync(SCRIPT, "utf8").replace(
    /if ! BUILD_LOG=\$\(npm run build 2>&1\); then/,
    'if ! BUILD_LOG=$(echo "src/x.ts(1,1): error TS1005: boom" && false); then',
  ));
  try {
    const { code, out } = await new Promise<{ code: number; out: string }>((resolve) => {
      execFile("bash", [copy], { env: process.env }, (error, stdout, stderr) => {
        resolve({ code: error === null ? 0 : ((error.code as number | undefined) ?? 1), out: `${stdout}${stderr}` });
      });
    });
    assert.equal(code, 1, "non-zero, so a caller cannot ignore it");
    assert.match(out, /build FAILED/);
    assert.match(out, /untouched/);
    // The compiler's own words reach the person, not just "it failed".
    assert.match(out, /TS1005/);
  } finally {
    fs.rmSync(copy, { force: true });
  }
});
