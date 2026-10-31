#!/usr/bin/env node
/**
 * extract-topic-cases.mjs — mine this bridge's own conversations into
 * `topic-title` eval cases.
 *
 * The job under test is the /model card titler (src/topic-summary.ts): given the
 * first visible user message and the first visible assistant reply, produce a
 * one-line topic. So a case is exactly that pair, taken verbatim from a
 * production session file — no re-typing, so the eval can't drift from what the
 * titler actually sees.
 *
 * Written per case:
 *   transcript.txt   the USER/ASSISTANT fragment, in the titler's own format
 *                    (same shape as buildTopicPrompt output)
 *   image.jpg        the first attached image, when there was one (photo-only
 *                    messages are the reason the titler forwards images)
 *   case.json        metadata; expectations are PRESERVED if the file exists,
 *                    because `mustMention` is a human label about the source
 *                    (for photos: what is actually in the picture), not
 *                    something derivable from a model's output.
 *
 * Cases are selected by LORE below: each entry names a session and the human
 * label for it. New production conversations get added by adding an entry, then
 * re-running; existing labels are never overwritten.
 *
 * Usage: node evals/extract-topic-cases.mjs [--sessions <dir>] [--out <dir>]
 *                                        [--contract <tag>] [--force]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv;
const arg = (name, dflt) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : dflt);
const SESSIONS_DIR = arg("--sessions", path.join(HERE, "..", "sessions"));
const OUT_DIR = arg("--out", path.join(HERE, "cases/topic-title"));
const FORCE = argv.includes("--force");
/**
 * Override every case's prompt contract, so the SAME cases can be re-pointed at
 * a different prompt variant (`--contract title-v3`) and the two runs compared
 * on identical inputs. Human labels are preserved either way.
 */
const CONTRACT_OVERRIDE = arg("--contract", null);
/**
 * The title instruction prompt, versioned by `contract`. One canonical copy per
 * prompt version, copied into every case so a case stays self-contained (the
 * same convention as the other suites, whose prompt.txt is per case). This file
' * is the authoritative text for the eval side; a unit test in
 * test/topic-summary.test.ts asserts it still matches TOPIC_SYSTEM_PROMPT in
 * src/topic-summary.ts, so the two can't drift.
 */
const PROMPT_DIR = path.join(OUT_DIR, "prompts");

/**
 * The curated set. `mustMention` holds concept groups (any alternative matches);
 * `mustNotMention` holds subjects that would be invented. Labels come from
 * reading the conversation (and, for photo cases, looking at the image), never
 * from a model's title.
 */
const LORE = [
  {
    id: "photo-noise-sign",
    session: "spaces_sPA7FKAAAAE_threads_2x_jDOV8T_8-16f63de7.jsonl",
    note: "Photo of a sign asking employees to monitor noise levels. Image-only-ish prompt ('What's going on here'), so this is the case the titler's image forwarding exists for.",
    mustMention: [["sign", "notice", "poster"], ["noise", "monitor"]],
    mustNotMention: ["disk", "wedding", "invoice"],
  },
  {
    id: "disk-space",
    session: "spaces_sPA7FKAAAAE_threads_MSibe26NqS0-6271538e.jsonl",
    note: "Plain question about free disk space; answer is mostly numbers, so a title that copies the answer is useless.",
    mustMention: [["disk", "storage"], ["space", "free", "available", "capacity"]],
    mustNotMention: ["noise", "sign", "photo"],
  },
  {
    id: "greeting-only",
    session: "spaces_sPA7FKAAAAE_threads_K0eqRPp5FNo-b9c60c51.jsonl",
    note: "Opener is 'Hello' and the first reply only says which directory/project pi is in — there is NO topic yet. Both prompt variants tested so far invented one ('Workspace Introduction', 'Workflow Design for AI Chat Interfaces'), so this case punishes fabricated subjects: the honest title is about the greeting/project context.",
    mustMention: [["workspace", "project", "greeting", "hello", "intro", "opening"]],
    mustNotMention: ["workflow", "design", "noise", "sign", "disk"],
  },
  {
    id: "model-default-behaviour",
    session: "spaces_sPA7FKAAAAE_threads_ztgOxWDF6uM-a07504eb.jsonl",
    note: "Asks whether /model outside a conversation changes the default; answer explains the rule.",
    mustMention: [["model"], ["default", "change", "behaviour", "behavior"]],
    mustNotMention: ["noise", "disk"],
  },
  {
    id: "audio-capable-model",
    session: "spaces_sPA7FKAAAAE_threads_Fdg_EmHKlkI-a0b723fe.jsonl",
    note: "Asks about voice/audio chat with an audio-capable model. The reply concludes it's blocked by two layers, so this is the case that punishes answer-restating titles.",
    mustMention: [["audio", "voice", "speech"]],
    mustNotMention: ["noise", "disk", "invoice"],
  },
  {
    id: "local-model-timing",
    session: "spaces_sPA7FKAAAAE_threads_12MBXYcYReY-eadb9eda.jsonl",
    note: "Asks for a processing-time breakdown of a local-model run; the reply is a timing table.",
    mustMention: [["timing", "time", "performance", "breakdown"]],
    mustNotMention: ["noise", "disk"],
  },
];

function readFirstTurn(file) {
  const turn = { userText: "", assistantText: "", image: null };
  let sawUser = false;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type !== "message") continue;
    const m = e.message ?? {};
    const blocks = Array.isArray(m.content)
      ? m.content
      : typeof m.content === "string"
        ? [{ type: "text", text: m.content }]
        : [];
    if (m.role === "user" && !sawUser) {
      sawUser = true;
      for (const b of blocks) {
        if (b.type === "text" && b.text) turn.userText += b.text;
        else if (b.type === "image" && !turn.image && b.data) turn.image = { data: b.data, mimeType: b.mimeType ?? "image/jpeg" };
      }
    } else if (m.role === "assistant" && sawUser) {
      // Visible text only: thinking and tool blocks are not part of what the
      // user saw, so they must not reach the title prompt.
      for (const b of blocks) if (b.type === "text" && b.text) turn.assistantText += b.text;
      if (turn.assistantText.trim()) break;
    }
  }
  return turn;
}

/**
 * Same slicing as the titler (MAX_USER_CHARS / MAX_ASSISTANT_CHARS) and the same
 * USER/…/ASSISTANT/…/TITLE: layout as buildTopicPrompt, so the case is the exact
 * input production builds.
 */
function transcriptFor(turn) {
  const user = turn.userText.trim() || "(the user sent a photo with no text)";
  return [
    `USER: ${user.slice(0, 600)}`,
    `ASSISTANT: ${turn.assistantText.trim().slice(0, 900)}`,
    "TITLE:",
  ].join("\n\n");
}

const made = [];
for (const c of LORE) {
  const contract = CONTRACT_OVERRIDE ?? c.contract ?? "title-v1";
  const promptFile = path.join(PROMPT_DIR, `${contract}.txt`);
  if (!fs.existsSync(promptFile)) {
    console.warn(`skip ${c.id}: missing prompt for contract ${contract} (${promptFile})`);
    continue;
  }
  const prompt = fs.readFileSync(promptFile, "utf8").trim();
  const sessionFile = path.join(SESSIONS_DIR, c.session);
  if (!fs.existsSync(sessionFile)) {
    console.warn(`skip ${c.id}: session not found (${c.session})`);
    continue;
  }
  const turn = readFirstTurn(sessionFile);
  if (!turn.userText.trim() && !turn.image) {
    console.warn(`skip ${c.id}: no first user turn`);
    continue;
  }
  const dir = path.join(OUT_DIR, c.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "prompt.txt"), prompt + "\n");
  fs.writeFileSync(path.join(dir, "transcript.txt"), transcriptFor(turn) + "\n");
  if (turn.image) {
    fs.writeFileSync(path.join(dir, "image.jpg"), Buffer.from(turn.image.data, "base64"));
  }

  const metaFile = path.join(dir, "case.json");
  if (fs.existsSync(metaFile) && !FORCE) {
    // Re-mining refreshes the transcript but keeps the human label.
    const existing = JSON.parse(fs.readFileSync(metaFile, "utf8"));
    existing.transcriptChars = transcriptFor(turn).length;
    existing.hasImage = !!turn.image;
    existing.source = c.session;
    existing.contract = contract;
    fs.writeFileSync(metaFile, JSON.stringify(existing, null, 2) + "\n");
    console.log(`refreshed ${c.id} (labels kept)`);
    made.push(c.id);
    continue;
  }

  const meta = {
    suite: "topic-title",
    id: c.id,
    mode: "direct",
    contract,
    source: c.session,
    hasImage: !!turn.image,
    transcriptChars: transcriptFor(turn).length,
    note: c.note,
    expectations: {
      mustMention: c.mustMention,
      mustNotMention: c.mustNotMention,
      labelSource: "hand label read from the conversation (and the image, for photo cases)",
    },
  };
  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2) + "\n");
  console.log(`wrote ${c.id}`);
  made.push(c.id);
}

console.log(`\n${made.length} case(s) in ${OUT_DIR}`);
