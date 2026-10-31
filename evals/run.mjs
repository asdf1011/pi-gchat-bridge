#!/usr/bin/env node
/**
 * run.mjs — evals for the bridge's local-model jobs.
 *
 * One suite today: `topic-title`, the /model card titler (src/topic-summary.ts).
 * It is not an agent job — in production it is a single completion against the
 * local model — so cases are POSTed straight to an OpenAI-compatible endpoint
 * and the returned title is graded. There is no pi session and no replay
 * fixture, because the titler's only inputs are text plus, for photo threads,
 * the image itself.
 *
 * Usage:
 *   node evals/run.mjs                        # whole suite, local model
 *   node evals/run.mjs --case disk-space      # one case
 *   node evals/run.mjs --runs 2 --judge       # variance + LLM judge
 *   node evals/run.mjs --model <id> --base-url <url>   # e.g. a hosted model
 *   node evals/run.mjs --min-score 0.9        # CI-style gate (exit 1 below it)
 *
 * Grading is deterministic first (lib/grade.mjs); `--judge` adds an LLM judge
 * for the judgement calls (lib/judge.mjs, needs DEEPSEEK_API_KEY).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { grade } from "./lib/grade.mjs";
import { judge } from "./lib/judge.mjs";
import { postJson } from "./lib/model-call.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[a.slice(2)] = true;
    else {
      out[a.slice(2)] = next;
      i++;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const BASE_URL = args["base-url"] ?? process.env.BRIDGE_TOPIC_SUMMARY_BASE_URL ?? "http://127.0.0.1:8090/v1";
const MODEL = args.model ?? process.env.BRIDGE_TOPIC_SUMMARY_MODEL ?? "lfm3-vl-2b-q8";
const RUNS = Number(args.runs ?? 1);
const SUITE = args.suite;
const ONLY = args.case;
const USE_JUDGE = !!args.judge;
const MAX_CASES = args["max-cases"] ? Number(args["max-cases"]) : Infinity;
const MIN_SCORE = args["min-score"] ? Number(args["min-score"]) : null;
const TIMEOUT_MS = Number(args.timeout ?? process.env.EVAL_TIMEOUT_MS ?? 20 * 60 * 1000);
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const RUN_DIR = args.out ?? path.join(HERE, "runs", `${STAMP}_${MODEL.replace(/[^a-zA-Z0-9._-]/g, "_")}`);

function loadCases() {
  const cases = [];
  for (const suite of fs.readdirSync(path.join(HERE, "cases"))) {
    if (SUITE && suite !== SUITE) continue;
    const dir = path.join(HERE, "cases", suite);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const id of fs.readdirSync(dir)) {
      if (id === "prompts" || (ONLY && id !== ONLY)) continue;
      const cdir = path.join(dir, id);
      const metaFile = path.join(cdir, "case.json");
      if (!fs.existsSync(metaFile)) continue;
      cases.push({ dir: cdir, meta: JSON.parse(fs.readFileSync(metaFile, "utf8")) });
    }
  }
  cases.sort((a, b) => (a.meta.suite + a.meta.id).localeCompare(b.meta.suite + b.meta.id));
  return cases.slice(0, MAX_CASES);
}

/** One case = one completion. The transcript is the input production builds. */
async function runOne({ dir, meta }) {
  const prompt = fs.readFileSync(path.join(dir, "prompt.txt"), "utf8").trim();
  const transcript = fs.readFileSync(path.join(dir, "transcript.txt"), "utf8").trim();

  const content = [{ type: "text", text: transcript }];
  const imagePath = path.join(dir, "image.jpg");
  if (fs.existsSync(imagePath)) {
    content.push({
      type: "image_url",
      image_url: { url: `data:image/jpeg;base64,${fs.readFileSync(imagePath).toString("base64")}` },
    });
  }

  const started = Date.now();
  let error = null;
  let output = "";
  try {
    const data = await postJson(
      `${BASE_URL.replace(/\/+$/, "")}/chat/completions`,
      {
        model: MODEL,
        messages: [
          { role: "system", content: prompt },
          // A lone text block goes as a plain string: some llama.cpp chat
          // templates mishandle a one-element content array.
          { role: "user", content: content.length > 1 ? content : transcript },
        ],
        max_tokens: 64,
        temperature: 0,
        chat_template_kwargs: { enable_thinking: false },
      },
      TIMEOUT_MS,
    );
    output = String(data.choices?.[0]?.message?.content ?? "").trim();
  } catch (err) {
    error = err?.message ?? String(err);
  }

  const result = {
    suite: meta.suite,
    id: meta.id,
    contract: meta.contract,
    model: MODEL,
    hasImage: !!meta.hasImage,
    error,
    elapsedMs: Date.now() - started,
    output,
  };
  result.grade = output
    ? grade(meta, output)
    : { checks: [], score: 0, passed: false, failures: [error ?? "no-output"] };
  if (USE_JUDGE && output) result.judge = await judge(meta, output, dir);
  return result;
}

function report(summary) {
  const L = [`# Eval report — ${summary.model}`, ""];
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
  const errs = summary.cases.filter((c) => c.error);
  if (errs.length) {
    L.push("## Harness errors");
    for (const e of errs) L.push(`- ${e.suite}/${e.id}: ${e.error}`);
    L.push("");
  }
  return L.join("\n");
}

async function main() {
  const cases = loadCases();
  if (!cases.length) throw new Error("no cases matched");
  fs.mkdirSync(RUN_DIR, { recursive: true });

  console.log(`model=${MODEL} base=${BASE_URL} cases=${cases.length} runs=${RUNS} out=${RUN_DIR}\n`);

  const results = [];
  for (const c of cases) {
    for (let r = 0; r < RUNS; r++) {
      process.stdout.write(`  ${c.meta.suite}/${c.meta.id} run ${r + 1}/${RUNS} … `);
      let res;
      try {
        res = await runOne(c);
      } catch (err) {
        res = {
          suite: c.meta.suite,
          id: c.meta.id,
          run: r,
          error: err?.message ?? String(err),
          grade: { score: 0, checks: [], failures: ["harness-error"] },
        };
      }
      res.run = r;
      results.push(res);
      console.log(
        res.error
          ? `ERROR ${res.error.slice(0, 70)}`
          : `score ${(res.grade.score * 100).toFixed(0)}%  ${(res.grade.failures ?? []).slice(0, 3).join(",")}`,
      );
    }
  }

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

  const summary = { model: MODEL, baseUrl: BASE_URL, runs: RUNS, at: new Date().toISOString(), suites: {} };
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
    contract: r.contract,
    run: r.run,
    error: r.error ?? null,
    score: r.grade?.score ?? 0,
    failures: r.grade?.failures ?? [],
    output: r.output ?? "",
    elapsedMs: r.elapsedMs,
    judge: r.judge?.mean ?? null,
  }));

  fs.writeFileSync(path.join(RUN_DIR, "results.json"), JSON.stringify(results, null, 2) + "\n");
  fs.writeFileSync(path.join(RUN_DIR, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  fs.writeFileSync(path.join(RUN_DIR, "report.md"), report(summary));

  console.log("\n" + report(summary));
  if (MIN_SCORE !== null) {
    const worst = Math.min(...Object.values(summary.suites).map((s) => s.meanScore));
    process.exitCode = worst >= MIN_SCORE ? 0 : 1;
  }
}

main().catch((err) => {
  console.error("fatal:", err.message);
  process.exit(1);
});
