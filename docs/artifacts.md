# Artifacts: the files a conversation touched

Status: implemented; the origin is not exposed yet — the Cloudflare steps below
are what remains.

## What it is

One conversation's edited and created files, derived from its own transcript, and
a GET-only HTTP origin that serves them.

- `npx tsx src/scripts/artifacts.ts <conversationId>` lists them (add `--json`).
- `GET /c/:id/` is the index; `GET /c/:id/<key>` is a file; `?render` renders
  Markdown as a sandboxed document.

Deliberately **not** a file browser: the derived list *is* the allow-list, so a
request for anything the conversation did not write — however it is spelled — is
a 404 rather than a path to sanitise.

## Two ledgers, joined

**Tool calls (exact).** Every `write` and `edit` tool call already names its file,
and tool calls are durable entries. So there is no per-call bookkeeping, no second
list to drift, conversations older than this feature already have lists (measured:
19 for the largest conversation, ~120 ms to derive), and the list survives a file
being deleted.

**The filesystem (complete).** A tool call only names a file when the tool does.
`sed -i`, a `>` redirect, a formatter, a build writing into `dist/` — those leave
no path in the transcript, so nothing can be derived from it. What cannot be
bypassed is the filesystem itself, so around each turn:

1. read the wall clock, then submit;
2. when the submission settles, walk the roots and keep every regular file whose
   mtime is at or after that reading (`src/durable/observed-files.ts`);
3. store the paths on the conversation's binding, newest first, capped at 200.

No command parsing, no per-tool special cases: a new way of writing a file is
covered the day it is used. The walk is 8.6k files here (~0.4 s, directories in
parallel, stats in batches) and runs off the reply path, after the answer has
settled.

What the walk cannot do is tell a write from an edit — mtime says only "changed".
So observed files carry no counts, and any path a tool call already named keeps
the counts the transcript gave it (`mergeArtifacts`). Directories named
`node_modules`, `.git` and `.jj` are skipped, as are the handful of files this
bridge writes itself (`bridge.sqlite*`, our logs, the pid file) — otherwise every
conversation would list them as artifacts of its own bookkeeping.

Attribution is by time window: a file changed during a turn belongs to that turn.
Two conversations running at once both see a file they both touched, which is
true; a file changed by something else on the machine during a long turn will
appear as well, which is the price of asking the filesystem instead of the
transcript.

## Configuration

```bash
# .env.durable (and .env for the SDK host)
BRIDGE_ARTIFACTS_PORT=8082          # 0/unset disables the listener entirely
BRIDGE_ARTIFACT_ROOTS=              # optional, colon-separated; default below
BRIDGE_WEB_DEV=1                    # optional: re-read page.html per request
```

Roots default to `PI_CWD` plus the agent config dir (`getAgentDir()`), because
this deployment edits files in both — `AGENTS.md` lives outside `PI_CWD` and a
root list of just `PI_CWD` would silently hide it.

## Exposing it (the remaining work)

Keep it off `pi.hl.id.au`: a separate hostname means a separate origin, so the
artifact route table cannot be reached through the app.

1. **DNS.** `cloudflared tunnel route dns pi-bridge artifacts.hl.id.au`, or a
   proxied CNAME in the dashboard. One level below the zone, so Universal SSL
   covers it — no certificate to buy.
2. **Ingress** in `cloudflared.yml`, above the catch-all:

   ```yaml
     - hostname: artifacts.hl.id.au
       service: http://127.0.0.1:8082
       originRequest:
         # No event stream here, so none of the /web SSE tuning applies.
         connectTimeout: 30s
   ```

3. **Access.** Self-hosted application for `artifacts.hl.id.au`, session duration
   the same as the chat app (a shorter one buys nothing: the chat session is the
   stronger credential), policy = your email, or an IdP group if this grows.
4. **Restart** the bridge with the env var set. `start-bridge.sh` restarts node,
   and cloudflared reads its ingress at startup, so both need it.

Check before pointing DNS at it:

```bash
curl -s http://127.0.0.1:8082/healthz                      # ok
curl -s http://127.0.0.1:8082/c/8508/ | head -20           # the index
```

## Security posture

Artifact content is untrusted by construction: the agent is steerable by what it
reads, so a rendered document must be assumed hostile.

- **Every response carries `sandbox`.** Documents become opaque origins: no
  cookies, no `localStorage`, no access to the parent page — including when the
  URL is opened in its own tab, because the header applies to top-level
  navigation too.
- **`default-src 'none'`, `form-action 'none'`.** A rendered document cannot
  fetch, frame or post anything, so it has no exfiltration channel.
- **`nosniff`, `no-store`, `no-referrer`, `frame-ancestors 'self'`.**
- **Markdown is escaped before it is parsed.** The renderer turns source into
  tags only after HTML-escaping it, so there is no path from source text to
  markup. Links keep `http`/`https`/`mailto`/relative and drop everything else.
- **Redaction runs on the way out**, resolved per request, because this viewer
  reads files the harness never sees. The artifact reader is the one place in the
  deployment where a secret could otherwise walk straight out of a file.
- **The listener is GET-only and bound to `127.0.0.1`.** The tunnel is the only
  way in, and the mutating API is not reachable on this port at all.

## Known limits

- `bash`-made changes are not listed (above).
- Raw artifacts are always `text/plain`, never sniffed: serving the wrong thing
  as HTML is the one mistake this viewer cannot afford.
- `.html` artifacts are **not** served as HTML yet. The sandboxed document path
  exists and is tested; enabling generated apps is a deliberate follow-up, with
  `sandbox allow-scripts` and `connect-src 'none'` for the app case.
- No per-conversation origin isolation: all conversations share
  `artifacts.hl.id.au`. That is the cost of picking paths over subdomains, and it
  only matters if one conversation's artifact must not be readable from another.
- The index re-derives on every request. Fine at 19-100 artifacts (milliseconds);
  a conversation with thousands would want a cache.
