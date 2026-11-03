# Exposing the web UI with Cloudflare Tunnel

Goal: open the pi bridge web UI from a device that cannot run Tailscale, with
SSO in front, without opening any port.

```
browser → Cloudflare edge → Access policy → tunnel → 127.0.0.1:8081
```

Authentication happens **at the edge**. Access evaluates the policy before the
request enters the tunnel, so unauthenticated traffic never reaches this
machine. The bridge implements no auth of its own and binds loopback.

## One-time setup

```bash
cloudflared tunnel login                       # opens a browser, authorises the domain
cloudflared tunnel create pi-bridge            # writes ~/.cloudflared/<tunnel-id>.json
cloudflared tunnel route dns pi-bridge pi.hl.id.au
```

### Token instead of a credentials file

The dashboard offers `cloudflared tunnel run --token <token>`. That command alone
pulls **ingress from the dashboard**, which has no `disableChunkedEncoding` — and
without it the edge buffers the `/web` event stream, so the page sits blank while
the model replies. This bridge therefore always passes `--config`:

```
cloudflared tunnel --config /etc/cloudflared/cloudflared.yml run --token "$TUNNEL_TOKEN"
```

The token can live in either place, checked in this order:

1. **`/secret set TUNNEL_TOKEN`** — preferred. The value never sits in a file the
   shell sources, and `start_bridge.sh` reads it through the bridge's own store
   (`dist/scripts/secret-get.js`, which uses `SecretStore` — not a second bash
   parser of `secrets.json`). A file-backed secret works too:
   `/secret set TUNNEL_TOKEN --file /etc/cloudflared/token`.
2. **`TUNNEL_TOKEN=` in `.env.durable`** — for a fresh deployment, where the
   bridge has not run yet and there is no store to read.

Three details worth knowing:

- Either way the token is **removed from the environment** before the bridge
  starts, because `.env.durable` is sourced with `set -a` and would otherwise be
  inherited by every `bash` tool call the agent runs. It is a supervisor
  credential; `/secret` is for values the agent uses, this is not one of them.
- The token and a `credentials-file` are alternatives; the token wins if both
  are present. `cloudflared.yml` keeps the file line commented for reference.
- The supervisor restarts cloudflared when it dies, but it reads the token only
  at startup — so after changing it, restart the supervisor (`start-bridge.sh`),
  not just `cloudflared`.

Then put the credentials where the config expects them and fill in the id:

```bash
sudo mkdir -p /etc/cloudflared
sudo cp ~/.cloudflared/<tunnel-id>.json /etc/cloudflared/
sudo sed -i 's|<tunnel-id>|<your-tunnel-id>|' /etc/cloudflared/cloudflared.yml
```

Copy `cloudflared.yml` from this repo to `/etc/cloudflared/` (the supervisor
reads it from the project directory, so either location works — adjust the
`credentials-file` path to match).

## The Access policy — do not skip this

Zero Trust dashboard → **Access → Applications → Add an application → Self-hosted**:

- Application domain: `pi.hl.id.au`
- Policy: **Allow**, include → **Emails** → your address
- Session duration: short (8h or less). This bridge can run `bash` as you, so a
  stolen session cookie is total compromise.
- If you have a hardware key, require it (WebAuthn).

Until this exists the tunnel is a public door with no lock: anyone who finds the
hostname can read every conversation and submit prompts as your bot.

## Running it

`start-bridge.sh` starts the tunnel alongside the bridge, for the durable engine
only, and:

- refuses to start it if `cloudflared.yml` or its credentials are missing
  (without credentials cloudflared exits in ~1s, and a 5s respawn loop would
  flood the log)
- **warns if `BRIDGE_BIND` is not `127.0.0.1`** — the tunnel is only a security
  boundary if it is the only way in
- leaves the tunnel up across bridge restarts (the edge returns 502 for a few
  seconds, which beats a DNS change), but restarts it if cloudflared itself dies
- takes the tunnel down on shutdown, so the public hostname stops answering

Logs: `cloudflared.log` in the project directory.

## Verify

```bash
# 1. SSE must stream, not arrive in one lump at the end
curl -N https://pi.hl.id.au/web/api/c/1/events

# 2. The identity path, end to end
#    send a message in the browser, then:
tail -f bridge-durable.log | grep '\[web\]'
# [web] you@example.com: submitted to conversation 12 (submission 345)

# 3. From a device with no Tailscale, load https://pi.hl.id.au/web/
```

If step 1 hangs and then delivers everything at once, the `disableChunkedEncoding`
setting is not taking effect — that is the one failure mode that looks like
"the page is just blank while the model streams".

## Costs

$0 for a single user: Cloudflare Tunnel is free, Zero Trust Free includes 50
seats, and a seat is consumed per *user who authenticates*, not per login.

The trade: Cloudflare terminates TLS and can see every prompt and every command
output. For a bridge with shell access that is a real decision, not a formality.

## What the tunnel must never expose

The tunnel is a boundary only for the things it fronts. Two rules follow from
that and are worth writing down, because both are easy to undo by accident:

- **Only the bridge is in `ingress`.** The config ends in
  `http_status: 404`, so anything not matched dies at the edge. Any secrets or
  egress proxy this machine runs must stay off the ingress list: the agent can
  drive such a proxy, so a public one is a credential oracle with an SSO door.
- **`BRIDGE_BIND` stays `127.0.0.1`.** `start-bridge.sh` warns when it is not.
  A second listener means the Access policy protects nothing, because the origin
  is reachable without passing it.
- **Cloudflare terminates TLS and can see prompts and command output.** That is
  the documented trade for using the tunnel at all. It is another reason the
  agent should hold placeholder credentials rather than real ones: what the edge
  can see should be worth nothing.
