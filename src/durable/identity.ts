/**
 * Who is making this request?
 *
 * Behind Cloudflare Access (or oauth2-proxy, or any identity-aware proxy) the
 * browser never authenticates to the bridge — the edge does it, and forwards
 * the answer as a header. That is a good split: the policy lives where it can
 * be changed without a deploy, and the bridge does not implement auth.
 *
 * The header is only trustworthy if the request provably came from the proxy.
 * Anything that can open a socket to the bridge can send the same header, so
 * identity is honoured only when the socket peer is the configured proxy
 * address. That is why the server also binds loopback by default: the strongest
 * version of this rule is "nothing but the tunnel can reach me at all".
 */
import type { IncomingMessage } from "node:http";

/**
 * Headers identity-aware proxies use, most specific first.
 *
 * Cloudflare Access sends the email and a signed JWT; oauth2-proxy and
 * Authentik send X-Auth-Request-Email / X-Forwarded-Email. All are read, in
 * this order, and the first non-empty one wins.
 */
const IDENTITY_HEADERS = [
  "cf-access-authenticated-user-email",
  "x-auth-request-email",
  "x-forwarded-email",
  "x-authentik-username",
] as const;

export interface RequestIdentity {
  /** The verified identity, when the request came from a trusted proxy. */
  readonly email?: string;
  /** True when identity headers were present but the peer was not trusted. */
  readonly untrustedHeader: boolean;
}

/** The socket peer address, normalised out of IPv4-mapped IPv6 form. */
export function peerAddress(req: IncomingMessage): string | undefined {
  const remote = req.socket.remoteAddress;
  if (!remote) return undefined;
  // Node reports IPv4 peers on a dual-stack listener as ::ffff:127.0.0.1.
  return remote.startsWith("::ffff:") ? remote.slice("::ffff:".length) : remote;
}

/**
 * Resolve the caller's identity from a request.
 *
 * `trustedProxy` empty means "trust nobody": identity is then always undefined,
 * even on loopback. That is the default because the safe failure is to treat
 * every request as anonymous rather than to believe a spoofable header.
 */
export function identify(req: IncomingMessage, trustedProxy: string): RequestIdentity {
  const header = IDENTITY_HEADERS.map((name) => req.headers[name]).find(
    (value) => typeof value === "string" && value.trim().length > 0,
  );
  if (typeof header !== "string") return { untrustedHeader: false };

  const peer = peerAddress(req);
  if (!trustedProxy || peer !== trustedProxy) {
    // Present but not from the proxy: worth knowing about, because it means
    // something is reaching the bridge that should not be (or a proxy address
    // is misconfigured).
    return { untrustedHeader: true };
  }
  return { email: header.trim(), untrustedHeader: false };
}
