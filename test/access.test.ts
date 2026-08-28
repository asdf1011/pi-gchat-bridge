import test from "node:test";
import assert from "node:assert/strict";
import { isAllowed } from "../src/access.js";

test("empty allow-list allows everything", () => {
  assert.equal(isAllowed("spaces/abc", []), true);
});

test("matches a full resource name", () => {
  assert.equal(isAllowed("spaces/abc", ["spaces/abc"]), true);
});

test("matches a trailing ID against a full resource value", () => {
  assert.equal(isAllowed("spaces/abc", ["abc"]), true);
});

test("matches a full resource against a bare ID value", () => {
  assert.equal(isAllowed("spaces/abc", ["spaces/abc"]), true);
});

test("rejects a non-matching space", () => {
  assert.equal(isAllowed("spaces/abc", ["spaces/xyz"]), false);
});

test("blocks when the value is missing", () => {
  assert.equal(isAllowed(undefined, ["spaces/abc"]), false);
});

test("works for user resource names", () => {
  assert.equal(isAllowed("users/123", ["123"]), true);
  assert.equal(isAllowed("users/123", ["users/456"]), false);
});
