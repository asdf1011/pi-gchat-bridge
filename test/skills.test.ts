/**
 * Skills reach a bridge conversation.
 *
 * The gap this closes: `pi-coding-agent` builds a `DefaultResourceLoader` and advertises
 * `~/.pi/agent/skills` in the system prompt; `pi-durable` builds none, so a conversation run
 * by the bridge saw no skills at all. The fix reuses the TUI's own loader rather than
 * reimplementing discovery, so these tests are about the *wiring* — that the section is
 * installed, renders the loader's output, and omits itself when there is nothing to say.
 *
 * They run against a temporary skills directory rather than the container's, because what is
 * installed here is a deployment fact and not something a test should assert on.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadSkillSources, skillGuidance } from "../src/durable/extensions/skills.js";

/** A config directory with the given skills, each `[name, description]`. */
function skillsDir(skills: [name: string, description: string | null][]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skills-test-"));
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(path.join(agentDir, "skills"), { recursive: true });
  for (const [name, description] of skills) {
    const dir = path.join(agentDir, "skills", name);
    fs.mkdirSync(dir, { recursive: true });
    const frontmatter = description === null ? `name: ${name}` : `name: ${name}\ndescription: ${description}`;
    fs.writeFileSync(path.join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n\n# ${name}\n\nDo the thing.\n`);
  }
  return agentDir;
}

test("skill bodies are not in the prompt, only their names, descriptions and paths", () => {
  // The whole point of the format: advertising costs a line, reading costs a tool call.
  const agentDir = skillsDir([["deploy", "Ship the service. Use when deploying."]]);
  const { prompt } = loadSkillSources({ cwd: os.tmpdir(), agentDir });

  assert.match(prompt, /deploy/);
  assert.match(prompt, /Ship the service/);
  assert.match(prompt, /SKILL\.md$|\/deploy\/SKILL\.md/);
  assert.doesNotMatch(prompt, /Do the thing/, "the body stays on disk until the model reads it");
});

test("the prompt names the read tool, because that is how a body is loaded", () => {
  // `formatSkillsForPrompt(skills, "read")` emits the line telling the model to use `read`.
  // Without it the paths are advertised but nothing says what to do with them.
  const agentDir = skillsDir([["deploy", "Ship it."]]);
  const { prompt } = loadSkillSources({ cwd: os.tmpdir(), agentDir });
  assert.match(prompt, /read tool/i);
});

test("a skill with no description is not advertised", () => {
  // The loader drops it, and a nameless entry in the prompt is worse than nothing: the model
  // would have no way to know when it applies.
  const agentDir = skillsDir([
    ["described", "Has a description."],
    ["undescribed", null],
  ]);
  const { prompt, diagnostics } = loadSkillSources({ cwd: os.tmpdir(), agentDir });
  assert.match(prompt, /described/);
  assert.doesNotMatch(prompt, /id="undescribed"|<name>undescribed<\/name>/, "no description, no entry");
  assert.ok(diagnostics.length > 0, "and the loader says why, so it is not a silent disappearance");
});

test("no skills at all means no section, rather than an empty tag", () => {
  // An empty <available_skills></available_skills> would cost tokens and say nothing.
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "skills-empty-"));
  const { prompt, skills } = loadSkillSources({ cwd: os.tmpdir(), agentDir: empty });
  assert.equal(skills.length, 0);
  assert.equal(prompt, "");

  const { extension } = skillGuidance({ cwd: os.tmpdir(), agentDir: empty });
  const rendered = extension.sections?.[0]?.render({} as never, {} as never);
  assert.equal(rendered, undefined, "the section renders nothing, so it is omitted");
});

test("the extension carries the loaded skills in its section", () => {
  const agentDir = skillsDir([["deploy", "Ship the service."]]);
  const { extension, skills } = skillGuidance({ cwd: os.tmpdir(), agentDir });
  assert.equal(extension.name, "skills");
  assert.equal(extension.sections?.length, 1);
  assert.equal(extension.sections?.[0]?.key, "available_skills");
  assert.deepEqual(skills.map((skill) => skill.name), ["deploy"]);

  const rendered = extension.sections?.[0]?.render({} as never, {} as never);
  assert.equal(typeof rendered, "string");
  assert.match(rendered as string, /deploy/);
});

test("the section renders the same text every time, so the prompt cache stays warm", () => {
  // A section that varies per request defeats pi-durable's prompt diffing. Loading at install
  // time, not render time, is what makes this true.
  const agentDir = skillsDir([["deploy", "Ship it."]]);
  const { extension } = skillGuidance({ cwd: os.tmpdir(), agentDir });
  const render = () => extension.sections?.[0]?.render({} as never, {} as never);
  assert.equal(render(), render());
});

test("a project skills directory is read too, from the conversation's cwd", () => {
  const agentDir = skillsDir([["global", "Available everywhere."]]);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "skills-project-"));
  const projectSkill = path.join(cwd, ".pi", "skills", "local");
  fs.mkdirSync(projectSkill, { recursive: true });
  fs.writeFileSync(
    path.join(projectSkill, "SKILL.md"),
    "---\nname: local\ndescription: Only in this project.\n---\n\nBody.\n",
  );

  const { prompt } = loadSkillSources({ cwd, agentDir });
  assert.match(prompt, /global/);
  assert.match(prompt, /local/);
});
