/**
 * Who is making this request?
 *
 * Behind Cloudflare Access the browser never authenticates to the bridge — the
 * edge does it, and forwards the answer as a header. That is a good split: the policy lives where it can
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
 * The one header Cloudflare Access sets.
 *
 * Deliberately the only one. Accepting several proxy dialects meant accepting
 * headers that are also widely user-controllable (`X-Forwarded-Email` in
 * particular), which is a far larger surface than the deployment needs. This is
 * a Cloudflare Tunnel and nothing else.
 *
 * Access also sends `Cf-Access-Jwt-Assertion`; it is not used, because the JWT
 * only adds value when the origin can be reached some other way, and the bridge
 * binds loopback so it cannot.
 */
const IDENTITY_HEADER = "cf-access-authenticated-user-email";

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
  const header = req.headers[IDENTITY_HEADER];
  if (typeof header !== "string" || header.trim().length === 0) return { untrustedHeader: false };

  const peer = peerAddress(req);
  if (!trustedProxy || peer !== trustedProxy) {
    // Present but not from the proxy: worth knowing about, because it means
    // something is reaching the bridge that should not be (or a proxy address
    // is misconfigured).
    return { untrustedHeader: true };
  }
  return { email: header.trim(), untrustedHeader: false };
}
