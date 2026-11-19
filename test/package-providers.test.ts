/**
 * Package-provided providers, and the promise that a broken package is not a
 * broken bridge.
 *
 * The interesting case — a real OAuth extension registering a real provider — is
 * verified by hand against an installed `pi-antigravity` (log line `[models]
 * provider antigravity from …`, then the models appear in `/model`). What can be
 * decided here is the part that must never regress: an agent directory with no
 * packages has to be silent and cheap, and a package that cannot be loaded has to
 * cost itself and nothing else, because this runs inside `BridgeHost.open()`.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { registerPackageProviders } from "../src/durable/package-providers.js";

/** A ModelRuntime stand-in that records what it was handed. */
function fakeRuntime() {
  const registered: { provider: string; config: unknown }[] = [];
  return {
    registered,
    registerProvider(provider: string, config: unknown) {
      registered.push({ provider, config });
    },
  };
}

async function temporaryAgentDir(settings?: unknown): Promise<{ dir: string; cwd: string; done: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "pkg-providers-"));
  const cwd = join(dir, "cwd");
  await mkdir(cwd, { recursive: true });
  if (settings !== undefined) {
    await writeFile(join(dir, "settings.json"), JSON.stringify(settings));
  }
  return { dir, cwd, done: () => rm(dir, { recursive: true, force: true }) };
}

test("an agent directory with no packages registers nothing", async () => {
  const agent = await temporaryAgentDir();
  try {
    const runtime = fakeRuntime();
    const report = await registerPackageProviders(runtime as never, { cwd: agent.cwd, agentDir: agent.dir });
    assert.deepEqual(report.registered, []);
    assert.deepEqual(report.failures, []);
    assert.deepEqual(runtime.registered, []);
  } finally {
    await agent.done();
  }
});

test("a package that cannot be installed is reported, not thrown", async () => {
  const agent = await temporaryAgentDir({ packages: ["npm:pi-a-package-that-does-not-exist"] });
  try {
    const runtime = fakeRuntime();
    // The point is that this resolves at all: BridgeHost.open() has no handler
    // for a failure here, so a throw would mean a bridge that never starts.
    const report = await registerPackageProviders(runtime as never, { cwd: agent.cwd, agentDir: agent.dir });
    assert.deepEqual(runtime.registered, []);
    assert.equal(report.registered.length, 0);
  } finally {
    await agent.done();
  }
});
