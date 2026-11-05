/**
 * The seam's teeth.
 *
 * `docs/session-host-api.md` calls this the success criterion: an adapter that
 * cannot name a library type cannot reach past the boundary, and a "seam" that
 * only exists by convention is not one. These assertions fail the moment someone
 * imports pi-durable into an adapter, or reaches through the host again — which
 * is the specific regression this refactor exists to prevent, because it happened
 * before: five adapter files imported the harness and nobody noticed.
 *
 * Deliberately a source scan rather than a lint rule: the repository has no
 * linter, and a test runs on every `npm test` on every machine, including CI-less
 * ones.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const projectRoot = new URL("..", import.meta.url).pathname;
const adapterDir = path.join(projectRoot, "src/adapter");

function sourcesIn(dir: string): { file: string; source: string }[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => {
      const file = path.join(dir, entry.name);
      return { file: path.relative(projectRoot, file), source: fs.readFileSync(file, "utf8") };
    });
}

/** The libraries an adapter must not be able to name (D8, D9). */
const FORBIDDEN = ["@earendil-works/pi-durable", "@earendil-works/chord"];

test("no adapter imports pi-durable or chord", () => {
  const offenders: string[] = [];
  for (const { file, source } of sourcesIn(adapterDir)) {
    for (const library of FORBIDDEN) {
      if (source.includes(library)) offenders.push(`${file} imports ${library}`);
    }
  }
  assert.deepEqual(offenders, [], `the seam is only a seam if adapters cannot name these:\n${offenders.join("\n")}`);
});

test("no adapter reaches through the host into the harness", () => {
  const offenders: string[] = [];
  for (const { file, source } of sourcesIn(adapterDir)) {
    for (const smell of ["host.harness", "host.modelRuntime", "host.bindingFor", "host.conversationFor", "host.context"]) {
      if (source.includes(smell)) offenders.push(`${file} uses ${smell}`);
    }
  }
  assert.deepEqual(offenders, [], `adapters talk to SessionHost, not to the host object:\n${offenders.join("\n")}`);
});

test("the contract itself imports no library types", () => {
  const contract = fs.readFileSync(path.join(projectRoot, "src/session-host/api.ts"), "utf8");
  for (const library of FORBIDDEN) {
    assert.ok(!contract.includes(library), `src/session-host/api.ts must not import ${library}`);
  }
});

test("the projection is library-free too, so frames stay plain data", () => {
  const projection = fs.readFileSync(path.join(projectRoot, "src/session-host/projection.ts"), "utf8");
  for (const library of FORBIDDEN) {
    assert.ok(!projection.includes(library), `projection.ts must not import ${library}`);
  }
});

test("every adapter file is one of the surfaces we know about", () => {
  // A new file here is fine — it just has to be a deliberate one, because this
  // directory is the whole reason the seam exists.
  const known = new Set([
    "artifacts-server.ts",
    "commands.ts",
    "markdown.ts",
    "queries.ts",
    "router.ts",
    "view-sink.ts",
    "web.ts",
    "web-routes.ts",
  ]);
  const unexpected = sourcesIn(adapterDir)
    .map(({ file }) => path.basename(file))
    .filter((name) => !known.has(name));
  assert.deepEqual(unexpected, [], "new adapter files must be added here, deliberately");
});
