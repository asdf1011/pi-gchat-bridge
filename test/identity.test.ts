/**
 * Identity from an identity-aware proxy, and the trust rule that makes it safe.
 *
 * The failure this guards against is subtle and total: a header that says "I am
 * you" is worth nothing if anything that can open a socket to the bridge can
 * send it. So the tests care less about header parsing than about the peer
 * check — the header is believed only from the configured proxy address, and
 * an unexpected header is reported rather than silently accepted.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { IncomingMessage } from "node:http";

import { identify, peerAddress } from "../src/durable/identity.js";

function req(headers: Record<string, string>, remoteAddress = "127.0.0.1"): IncomingMessage {
  return { headers, socket: { remoteAddress } } as unknown as IncomingMessage;
}

test("the header is honoured from the trusted proxy", () => {
  const who = identify(req({ "cf-access-authenticated-user-email": "me@example.com" }), "127.0.0.1");
  assert.equal(who.email, "me@example.com");
  assert.equal(who.untrustedHeader, false);
});

test("the same header from any other peer is ignored and flagged", () => {
  const who = identify(req({ "cf-access-authenticated-user-email": "me@example.com" }, "10.0.0.9"), "127.0.0.1");
  assert.equal(who.email, undefined);
  // Flagged, not silently dropped: the header means something reached the
  // bridge that should not have, or the proxy address is wrong.
  assert.equal(who.untrustedHeader, true);
});

test("nothing is trusted when no proxy is configured", () => {
  const who = identify(req({ "cf-access-authenticated-user-email": "me@example.com" }), "");
  assert.equal(who.email, undefined);
  // Even on loopback: the default must fail closed, or a stray local process
  // could impersonate a user just by sending a header.
  assert.equal(who.untrustedHeader, true);
});

test("no header at all is anonymous and unflagged", () => {
  const who = identify(req({}), "127.0.0.1");
  assert.equal(who.email, undefined);
  assert.equal(who.untrustedHeader, false);
});

test("other proxy dialects are not an identity", () => {
  // Cloudflare Tunnel only. These headers are exactly the ones other software
  // sets, and some are user-controllable -- accepting them would widen the
  // surface for no deployment that exists.
  assert.equal(identify(req({ "x-auth-request-email": "a@b.c" }), "127.0.0.1").email, undefined);
  assert.equal(identify(req({ "x-forwarded-email": "a@b.c" }), "127.0.0.1").email, undefined);
  assert.equal(identify(req({ "x-authentik-username": "bob" }), "127.0.0.1").email, undefined);
  // ... and they are not flagged as a spoofing attempt either, because the
  // bridge never asked for them.
  assert.equal(identify(req({ "x-forwarded-email": "a@b.c" }), "127.0.0.1").untrustedHeader, false);
});

test("an empty header value is not an identity", () => {
  const who = identify(req({ "x-auth-request-email": "   " }), "127.0.0.1");
  assert.equal(who.email, undefined);
});

test("a Cloudflare header alongside other dialects still wins", () => {
  const who = identify(
    req({ "cf-access-authenticated-user-email": "cf@example.com", "x-forwarded-email": "spoof@example.com" }),
    "127.0.0.1",
  );
  assert.equal(who.email, "cf@example.com");
});

test("a spoofable header alone does not become an identity", () => {
  const who = identify(req({ "x-forwarded-email": "spoof@example.com" }), "127.0.0.1");
  assert.equal(who.email, undefined);
});

test("IPv4-mapped IPv6 peers compare equal to the plain IPv4 proxy address", () => {
  // Node reports loopback peers as ::ffff:127.0.0.1 on a dual-stack listener.
  assert.equal(peerAddress(req({}, "::ffff:127.0.0.1")), "127.0.0.1");
  const who = identify(req({ "cf-access-authenticated-user-email": "me@example.com" }, "::ffff:127.0.0.1"), "127.0.0.1");
  assert.equal(who.email, "me@example.com");
});
