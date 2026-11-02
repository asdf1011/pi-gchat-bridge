#!/usr/bin/env python3
"""
Wait for a nameserver change to propagate.

Registrar NS edits are not instant: the parent zone (.au) republishes with its
own TTL, then resolvers cache the old answer until it expires. This polls several
independent public resolvers because they do not agree at the same moment -- one
resolver switching over does not mean the world has, and a single-resolver check
is how people conclude "it propagated" and then watch it revert.

    python3 tools/wait-ns.py                 # one check
    python3 tools/wait-ns.py --expect cloudflare

Exit 0 when every resolver agrees on the expected nameservers, 1 otherwise, so
it can be looped or used in a shell `until`.
"""
import argparse
import json
import sys
import time
import urllib.request

# Independent resolvers, so "all agree" means something.
RESOLVERS = {
    "cloudflare": "https://cloudflare-dns.com/dns-query",
    "google": "https://dns.google/resolve",
}


def query(url: str, name: str, rrtype: str) -> list[str]:
    """Nameserver answers from one DoH resolver, or [] if it has none yet."""
    sep = "&" if "?" in url else "?"
    full = f"{url}{sep}name={name}&type={rrtype}"
    req = urllib.request.Request(full, headers={"accept": "application/dns-json"})
    with urllib.request.urlopen(req, timeout=20) as res:
        body = json.load(res)
    return [a["data"].rstrip(".") for a in body.get("Answer", []) if "data" in a]


def classify(nameservers: list[str]) -> str:
    if not nameservers:
        return "none"
    lowered = " ".join(nameservers).lower()
    if "cloudflare.com" in lowered:
        return "cloudflare"
    if "awsdns" in lowered:
        return "aws"
    return "other"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--domain", default="hl.id.au")
    ap.add_argument("--expect", default="cloudflare", help="cloudflare | aws | other")
    ap.add_argument("--watch", action="store_true", help="poll until it settles")
    ap.add_argument("--interval", type=int, default=120)
    args = ap.parse_args()

    while True:
        stamp = time.strftime("%H:%M:%S")
        seen = {}
        ok = True
        for label, url in RESOLVERS.items():
            try:
                ns = query(url, args.domain, "NS")
            except Exception as exc:  # a resolver being unhappy is not a verdict
                seen[label] = f"error ({exc})"
                ok = False
                continue
            kind = classify(ns)
            seen[label] = f"{kind}: {', '.join(ns) if ns else '(no answer)'}"
            if kind != args.expect:
                ok = False

        print(f"[{stamp}] {args.domain} expecting {args.expect}")
        for label, value in seen.items():
            print(f"  {label:<10} {value}")

        if ok:
            print(f"\nPropagated: every resolver now reports {args.expect}.")
            return 0
        if not args.watch:
            return 1
        print(f"\nNot yet. Rechecking in {args.interval}s (Ctrl-C to stop).\n", flush=True)
        time.sleep(args.interval)


if __name__ == "__main__":
    sys.exit(main())
