# Apps

A directory of files in a conversation, served as a web page on the artifact origin.

```
pi.hl.id.au            the bridge        (conversation, comments, no app code)
artifacts.hl.id.au     artifacts         /c/<id>/<key>   files
                                         /apps/<id>/     apps
```

## What an app is

**A directory containing `app.json` is an app.** That is the entire rule, and it lives in
`src/durable/apps.ts`. Nothing in the bridge knows what any app is for.

A marker file rather than "any directory", because serving a directory as runnable code is
a different promise from serving a file as text. An artifact directory is mostly notes,
scripts and generated output, and none of that should become a page because it happens to
sit next to an `index.html`. `app.json` is the author saying "run this".

```json
{ "name": "PocketTTS benchmark", "description": "Times a model in the tab." }
```

Both fields are optional; the marker is the point. A manifest that does not parse is still
a marker, so a typo degrades to an app with no description rather than to an outage.

## URLs

| Path | Serves |
|---|---|
| `/apps/<conversation>/` | the apps that conversation published |
| `/apps/<conversation>/<app>/` | that app's `index.html` |
| `/apps/<conversation>/<app>/<file>` | one file of it |

The app lives in the conversation that produced it, so there is no registry to keep in step
and no id to allocate: **the address is where the code already is.** Deleting the directory
un-publishes the app. Aliases would be a lookup layer over this if they ever earn their
keep, and are deliberately not there yet.

The app root answers `index.html` directly rather than redirecting, so a relative
`<script src="app.js">` resolves the same way whether or not the visitor typed the
trailing slash.

## Headers, and why each one

App responses carry four headers that the rest of the origin does not:

- **`Cross-Origin-Embedder-Policy: require-corp`** — the load-bearing one. A page needs
  COOP *and* COEP to be cross-origin isolated, and only an isolated page may use
  `SharedArrayBuffer`. A pthread-built WASM bundle asks for it during startup; without
  isolation the ask never resolves and the page hangs with no error at all. (COOP is
  already in `BASE_HEADERS`.)
- **`Cross-Origin-Resource-Policy: cross-origin`** — lets the same files be fetched from
  another of our origins, which is what an in-drawer app frame would need.
- **`Cache-Control: no-cache`** — the shared default is `no-store`, which is wrong for a
  6 MB wasm bundle: it would re-download on every reload.
- **A CSP with no `sandbox`** — apps run author-written code, which is the point of an app.
  See below for what that costs.

Content types are a table in `apps.ts`. Three entries are load-bearing: `.js` must be a
JavaScript MIME type or a module script is refused; `.wasm` must be `application/wasm` or
`instantiateStreaming` falls back to a slow compile; `.json` is read by apps themselves.
Everything else falls back to `application/octet-stream`, which downloads rather than
renders — the safe default for a model file.

## What an app is trusted with

**An app runs with the authority of the artifact origin.** It can read every artifact of
every conversation on that hostname, because they are same-origin. That is a real widening:
the origin otherwise serves only inert content — text, sandboxed documents, images.

It is acceptable only because apps are self-authored (the marker has to be written
deliberately) and the hostname is behind Cloudflare Access. So: **do not publish an app you
did not write, and do not serve an app directory from a conversation you do not trust.**

The CSP narrows this somewhat and is worth knowing precisely. `script-src 'self'
'unsafe-inline' 'wasm-unsafe-eval'` stops remote script being loaded, which is what would
turn a page behind Access into an exfiltration channel. `'unsafe-inline'` is required
because a static file host has no nonce to give a single-file app — the first version of
this policy without it produced a page that loaded, did nothing, and said why only in the
console. `connect-src 'self' https:` lets an app fetch a model from a CDN while keeping it
off plaintext origins and the local network.

If that trade ever stops being acceptable, the fix is a hostname per app; the certificate
cost of wildcard subdomains is noted in `CLOUDFLARE.md`.

## Path containment

`appRelativePath` and `resolveAppFile` are the only thing between a URL and the
filesystem, so there are two independent checks: the segments are inspected before they
are joined (`..`, absolute paths, backslashes and NUL refused), and the joined result is
compared against the app directory **after `realpath`**, which is what catches a symlink
inside the app pointing outward. `.jj` and `.git` are refused by name — that is the
repository the conversation's artifacts are committed to.

Refusals are 404 rather than an explanation: "that file exists but is not yours" is a fact
an attacker would like to have.

## Backends

An app that needs a server is not supported yet, and that is deliberate. Caddy cannot do it
— `reverse_proxy` forwards to something already listening and has no process lifecycle, no
reaping and no way to learn the port a child chose. Doing it properly means the bridge
supervising a child per app, which it already does for `chat-host` and `web-host`.

Nothing here needs it yet: the bundled app is entirely client-side, and the WASM does the
inference in the tab.

## Testing an app

```bash
# through the bridge, with the artifact origin's own headers
curl -sI http://127.0.0.1:8082/apps/<conversation>/<app>/ | grep -i cross-origin
```

The WASM case needs a browser, and specifically a GPU: audio.cpp's WebGPU backend registers
no device unless the adapter offers `shader-f16`. Software rasterisers (SwiftShader) do not,
so a machine without a GPU fails with `registry 'WebGPU' has no device 0`.
