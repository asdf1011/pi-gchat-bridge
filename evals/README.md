# Evals

Evals for the bridge's **local-model** jobs — the parts that aren't deterministic
code and so can regress silently when a prompt or model changes.

One suite today:

- **`topic-title`** — the `/model` card titler (`src/topic-summary.ts`). After a
  conversation's first exchange, the local model is asked for a one-line topic,
  which is patched into the Chat card header (`src/cards.ts`).

The cron jobs' evals live with the cron code (`/workspace/cron/evals`); these
belong here because they exercise this repo's code and its session files.

## Why this suite looks different from the cron evals

The titler is **not an agent job**: in production it is a single completion
against the local model. Running it through pi would measure the harness, not the
job, so a case is one POST to an OpenAI-compatible endpoint and the returned
string is graded. There is no replay fixture because the only inputs are the
transcript (plus, for photo threads, the image itself).

```bash
node evals/run.mjs                        # whole suite against the local model
node evals/run.mjs --case disk-space      # one case
node evals/run.mjs --runs 2 --judge       # variance + LLM judge
node evals/run.mjs --min-score 0.9        # CI-style gate (exit 1 below it)
node evals/run.mjs --model <id> --base-url <url>   # e.g. a hosted model
```

`lib/model-call.mjs` mirrors the transport in `src/topic-summary.ts` on purpose:
the eval must talk to the model the way production does. That transport is *not*
`fetch` — llama.cpp buffers the whole completion and only sends response headers
at the end, and undici aborts after a 300s header timeout, which a CPU model
exceeds on every image prompt. Using `fetch` here scored timeouts as model
failures. It also disables keep-alive (`agent: false`): llama.cpp closes the
socket after a buffered response and a pooled agent then reuses the dead one,
failing every second request with `socket hang up`.

## Cases

`cases/topic-title/<id>/`:

| file | meaning |
|---|---|
| `case.json` | metadata + hand labels (`mustMention`, `mustNotMention`) |
| `transcript.txt` | the `USER: … / ASSISTANT: … / TITLE:` fragment, verbatim from a session |
| `prompt.txt` | the system prompt this case was recorded against |
| `image.jpg` | the first attached image, when the thread had one |

Cases are **mined, not invented**: `extract-topic-cases.mjs` reads
`../sessions/*.jsonl`, takes the first visible user text, the first visible
assistant text and the first image (skipping thinking blocks and tool output,
which the user never saw), and writes the case. Re-running it refreshes
transcripts but **never overwrites the human labels** — those say what the
conversation is actually about, and for photo cases were read from the image.

Adding a case = add an entry to `LORE` in the extractor and re-run it.

## Grading

Deterministic first (`lib/grade.mjs`):

- `names-the-topic` (weight 4) — the hand labels must appear
- `no-hallucinated-subject` (weight 2) — whole-word match, so a forbidden `sign`
  doesn't fire on "de**sign**"
- `no-third-person-narration`, `one-line`, `non-empty`
- `raw-*` checks (weight 1) — prompt hygiene only. Production runs
  `cleanTitle()` before patching the card, which strips a `Title:` echo, quotes
  and trailing punctuation, so those artefacts are never user-visible.

`--judge` adds the LLM judge (`lib/judge.mjs`, needs `DEEPSEEK_API_KEY`) on
TOPIC / NOT-THE-ANSWER / USEFULNESS / SPECIFICITY. This is where prompt variants
actually separate: the weighted score frequently ties while the judge does not.

`regrade.mjs` re-scores a recorded run with the current grader, so fixing a check
never means paying for another run (the photo case is ~11 minutes on CPU).

## Comparing prompt variants

`prompt.txt` per case is what makes a variant comparison honest — same inputs,
different instruction:

```bash
node evals/extract-topic-cases.mjs --contract title-v3   # re-point all cases
node evals/run.mjs                                       # measure v3
node evals/extract-topic-cases.mjs --contract title-v1   # back to shipped
```

Prompt texts live in `cases/topic-title/prompts/`. A unit test in
`test/topic-summary.test.ts` asserts the contract that ships (`title-v1`) still
matches `TOPIC_SYSTEM_PROMPT`, so the eval can't drift from the code.

## Results

Runs are in `runs/` (`results.json` with raw outputs, `summary.json`,
`report.md`).

### `title-v1` (shipped)

6 cases, 99.1% mean, sd 2.1, 5/6 fully passing, 6/6 produced output. Titles:

- photo sign → *"Sign requesting employees to monitor noise in a workspace"*
- disk space → *"Free Disk Space Summary"*
- greeting-only → *"Workflow Design for AI Chat Interfaces"* ← fabricated
- `/model` default → *"How '/model' sets or changes the default model for new conversations"*
- audio → *"Chat with an audio-capable model is blocked by two layers: …"* ← restates the answer
- local-model timing → *"Timing breakdown for image analysis task in local model thread"*

That run was recorded while the greeting case still carried an older, wrong
label (`hello-workflow-design`, which expected a "workflow design" title and so
*rewarded* the fabrication). After the relabel, a targeted re-run fails it
outright: 66.7%, failing `names-the-topic` and `no-hallucinated-subject`. The
99.1% figure above should be read with that in mind.

The two defects are exactly what the suite was built to catch:

- **`greeting-only`**: the thread's first exchange is `Hello` → "I'm in
  `/workspace`, looks like `pi-gchat-bridge`". There is no topic yet, so v1
  invents one; the judge scored it 1.5/5. An earlier informal A/B had "won" on
  this very case, i.e. it mistook a fabrication for a good title.
- **`audio-capable-model`**: v1 restates the verdict (judge: NOT-THE-ANSWER 1/5).

### `title-v3` (one added clause)

Adding *"If they don't contain a topic yet, say what the conversation started
with."* fixes both and changes nothing else:

- greeting → *"Welcome to the Pi Chat Bridge Project — Let's Plan Your First Task"*
- audio → *"Chat about gchat audio support and current limitations"*
- disk → *"Free Disk Space Report"*, photo → *"Sign requesting employees to
  monitor noise in a workspace"*

99.1% mean as well — the score ties; only the judge separates them. Not yet
adopted: `title-v1` is what ships.
