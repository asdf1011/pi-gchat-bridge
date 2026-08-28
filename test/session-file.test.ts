import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { truncateIncompleteTail } from "../src/session-file.js";

const HEADER = '{"type":"session","version":3,"id":"h","timestamp":"t","cwd":"/workspace"}';

function writeSession(lines: string[]): string {
  const file = `/tmp/pi-gchat-session-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`;
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

test("truncateIncompleteTail drops the trailing unanswered toolCall turn, keeping the last completed reply", () => {
  const file = writeSession([
    HEADER,
    '{"type":"session_info","id":"s1","parentId":null,"timestamp":"t","name":"foo"}',
    '{"type":"message","id":"m1","parentId":null,"timestamp":"t","message":{"role":"user","content":"hello"}}',
    '{"type":"message","id":"m2","parentId":"m1","timestamp":"t","message":{"role":"assistant","content":[{"type":"text","text":"world"}]}}',
    '{"type":"message","id":"m3","parentId":"m2","timestamp":"t","message":{"role":"assistant","content":[{"type":"toolCall","name":"bash","arguments":{}}]}}',
    '{"type":"message","id":"m4","parentId":"m3","timestamp":"t","message":{"role":"toolResult","content":[{"type":"text","text":"output"}]}}',
  ]);
  try {
    const dropped = truncateIncompleteTail(file);
    const after = fs.readFileSync(file, "utf8").trim().split("\n");
    // Drops m3 (assistant toolCall) and m4 (toolResult); keeps header + m1 + m2.
    assert.equal(dropped, 2);
    assert.equal(after.length, 4);
    assert.match(after[0], /"type":"session"/);
    assert.match(after[3], /"text":"world"/);
    assert.ok(!after.some((line) => line.includes("toolCall")));
  } finally {
    fs.rmSync(file);
  }
});

test("truncateIncompleteTail leaves a clean file untouched", () => {
  const file = writeSession([
    HEADER,
    '{"type":"message","id":"m1","parentId":null,"timestamp":"t","message":{"role":"user","content":"hello"}}',
    '{"type":"message","id":"m2","parentId":"m1","timestamp":"t","message":{"role":"assistant","content":[{"type":"text","text":"world"}]}}',
  ]);
  try {
    const dropped = truncateIncompleteTail(file);
    const after = fs.readFileSync(file, "utf8").trim().split("\n");
    assert.equal(dropped, 0);
    assert.equal(after.length, 3);
  } finally {
    fs.rmSync(file);
  }
});

test("truncateIncompleteTail refuses to touch a file with an unparsable line", () => {
  const file = writeSession([
    HEADER,
    "not valid json",
    '{"type":"message","id":"m1","parentId":null,"timestamp":"t","message":{"role":"assistant","content":[{"type":"text","text":"world"}]}}',
    '{"type":"message","id":"m2","parentId":"m1","timestamp":"t","message":{"role":"assistant","content":[{"type":"toolCall","name":"bash","arguments":{}}]}}',
  ]);
  try {
    const dropped = truncateIncompleteTail(file);
    // An unparsable line must not risk corruption: bail out, leave the file as-is.
    assert.equal(dropped, 0);
    assert.equal(fs.readFileSync(file, "utf8").trim().split("\n").length, 4);
  } finally {
    fs.rmSync(file);
  }
});
