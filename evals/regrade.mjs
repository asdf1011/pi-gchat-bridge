#!/usr/bin/env node
/**
 * regrade.mjs — re-score an existing run with the CURRENT grader.
 *
 * Grading is deterministic and run files keep the model's raw output, so fixing a
 * grader (or adding a check) should never mean paying for another local-model
 * run — the photo case alone is ~11 minutes on CPU. This also makes grader
 * changes auditable: re-score old runs and see exactly what moved.
 *
 * Usage:
 *   node evals/regrade.mjs runs/<timestamp>_<model>            # rewrite files
 *   node evals/regrade.mjs runs/<timestamp>_<model> --dry-run  # print only
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { grade } from "./lib/grade.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const dirArg = argv.find((a) => !a.startsWith("--"));
const DRY = argv.includes("--dry-run");
if (!dirArg) {
  console.error("usage: node evals/regrade.mjs runs/<run-dir> [--dry-run]");
  process.exit(2);
}
const RUN_DIR = path.isAbsolute(dirArg) ? dirArg : path.join(HERE, dirArg);
const results = JSON.parse(fs.readFileSync(path.join(RUN_DIR, "results.json"), "utf8"));

let changed = 0;
for (const r of results) {
  const caseFile = path.join(HERE, "cases", r.suite, r.id, "case.json");
  if (!fs.existsSync(caseFile)) {
    console.warn(`  ! ${r.suite}/${r.id}: case.json missing, kept as-is`);
    continue;
  }
  const meta = JSON.parse(fs.readFileSync(caseFile, "utf8"));
  const before = r.grade?.score ?? 0;
  r.grade = r.output
    ? grade(meta, r.output)
    : { checks: [], score: 0, passed: false, failures: [r.error ?? "no-output"] };
  if (Math.abs(before - r.grade.score) > 0.0005) {
    changed++;
    console.log(`  ${r.id}: ${(before * 100).toFixed(1)}% -> ${(r.grade.score * 100).toFixed(1)}%  (${r.grade.failures.join(", ") || "all pass"})`);
  }
}

// Same aggregation as run.mjs, kept in step with it by hand (both are short).
const bySuite = {};
for (const r of results) {
  bySuite[r.suite] ??= { scores: [], checks: {}, runs: 0, outputs: 0 };
  bySuite[r.suite].scores.push(r.grade?.score ?? 0);
  bySuite[r.suite].runs++;
  if (r.output) bySuite[r.suite].outputs++;
  for (const c of r.grade?.checks ?? []) {
    bySuite[r.suite].checks[c.name] ??= { pass: 0, total: 0 };
    bySuite[r.suite].checks[c.name].total++;
    if (c.pass) bySuite[r.suite].checks[c.name].pass++;
  }
}
const summary = { model: results[0]?.model ?? "?", runs: 1, at: new Date().toISOString(), suites: {} };
for (const [s, v] of Object.entries(bySuite)) {
  const mean = v.scores.reduce((a, b) => a + b, 0) / v.scores.length;
  const sd = Math.sqrt(v.scores.reduce((a, b) => a + (b - mean) ** 2, 0) / v.scores.length);
  summary.suites[s] = {
    meanScore: Number(mean.toFixed(3)),
    stdev: Number(sd.toFixed(3)),
    fullPassRate: Number((v.scores.filter((x) => x === 1).length / v.scores.length).toFixed(3)),
    producedOutput: `${v.outputs}/${v.runs}`,
    checks: v.checks,
  };
}
summary.cases = results.map((r) => ({
  suite: r.suite,
  id: r.id,
  run: r.run,
  error: r.error ?? null,
  score: r.grade?.score ?? 0,
  failures: r.grade?.failures ?? [],
  outputChars: r.outputChars,
  elapsedMs: r.elapsedMs,
  judge: r.judge?.score ?? null,
}));

const L = [`# Eval report — ${summary.model}`, "", "_(re-graded from recorded outputs)_", ""];
for (const [suite, s] of Object.entries(summary.suites)) {
  L.push(`## ${suite}`);
  L.push(`- mean score: **${(s.meanScore * 100).toFixed(1)}%** (sd ${(s.stdev * 100).toFixed(1)})`);
  L.push(`- fully passing runs: **${(s.fullPassRate * 100).toFixed(0)}%**`);
  L.push(`- produced output: ${s.producedOutput}`);
  const failing = Object.entries(s.checks)
    .filter(([, v]) => v.pass < v.total)
    .sort((a, b) => a[1].pass / a[1].total - b[1].pass / b[1].total);
  if (failing.length) {
    L.push("- weakest checks:");
    for (const [name, v] of failing) L.push(`  - \`${name}\`: ${v.pass}/${v.total}`);
  }
  L.push("");
}
const report = L.join("\n");

console.log(`\n${changed} case(s) changed\n`);
console.log(report);
if (!DRY) {
  fs.writeFileSync(path.join(RUN_DIR, "results.json"), JSON.stringify(results, null, 2) + "\n");
  fs.writeFileSync(path.join(RUN_DIR, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  fs.writeFileSync(path.join(RUN_DIR, "report.md"), report);
  console.log(`wrote ${path.relative(process.cwd(), RUN_DIR)}/{results,summary,report}`);
}
