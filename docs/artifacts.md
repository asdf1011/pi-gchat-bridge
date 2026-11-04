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

## Why derived rather than recorded

Every `write` and `edit` tool call already names its file, and tool calls are
durable entries. So:

- no per-call bookkeeping, and no second list to drift from the transcript
- conversations written before this existed have artifact lists too (measured:
  19 for the largest conversation, ~120 ms to derive)
- the list survives a file being deleted, so history does not shrink

The cost, stated plainly: **a change made through `bash` is invisible.** `sed -i`,
`>`, a build writing into `dist/` — the tool call does not name the file, so there
is nothing to derive. Recording those needs a filesystem diff per turn (a
`git status --porcelain` snapshot per turn is the obvious version) and is not
implemented.

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
