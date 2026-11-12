/**
 * Skills — the `SKILL.md` directories a session can be told about.
 *
 * The TUI gets these for free: `pi-coding-agent` builds a `DefaultResourceLoader`, which
 * scans `~/.pi/agent/skills`, `.pi/skills`, `~/.agents/skills` and any ancestor
 * `.agents/skills` up to the repository root, then puts each skill's name, description and
 * path into the system prompt. `pi-durable` builds no such loader, so a conversation run by
 * the bridge sees none of them — `AGENTS.md` was the only instruction source it had.
 *
 * This closes that gap **using the same tooling rather than a copy of it**. `loadSkills` and
 * `formatSkillsForPrompt` are exported by `pi-coding-agent`, so the discovery rules (the
 * `SKILL.md`-is-a-root rule, gitignore handling, symlink deduplication, frontmatter
 * validation) are the TUI's own, not a reimplementation that can drift from them.
 *
 * Two deliberate choices:
 *
 *   - **No `read_skill` tool.** The conversation already has `read`, and the prompt names
 *     each skill's absolute path, which is exactly what `formatSkillsForPrompt` emits for a
 *     reader that has one. A second tool that resolves a name to a path would be a duplicate
 *     of `read` with extra ways to fail.
 *   - **The section renders once.** It changes only when a skill file does, so the prompt
 *     cache stays warm; pi-durable sends only what changed between requests.
 */
import { defineExtension, section } from "@earendil-works/pi-durable";
import {
  formatSkillsForPrompt,
  getAgentDir,
  loadSkills,
  type Skill,
} from "@earendil-works/pi-coding-agent";

/** The skill locations the loader reads, for a conversation whose tools run in `cwd`. */
export interface SkillSources {
  cwd: string;
  /** Defaults to pi's own config directory (`~/.pi/agent`). */
  agentDir?: string;
}

export interface LoadedSkills {
  skills: readonly Skill[];
  /** The `<available_skills>` block, empty when there is nothing to advertise. */
  prompt: string;
  /** Problems the loader reported: a malformed `SKILL.md`, a name collision, a missing path. */
  diagnostics: readonly { type: string; message: string }[];
}

/**
 * Load skills exactly as the TUI would.
 *
 * `includeDefaults` is what brings in `~/.pi/agent/skills` and `<cwd>/.pi/skills`;
 * `skillPaths` stays empty because the agent-level and project-level locations are the whole
 * of what this deployment configures. Exported so a test can assert the list without
 * standing up a host.
 */
export function loadSkillSources(sources: SkillSources): LoadedSkills {
  const result = loadSkills({
    cwd: sources.cwd,
    agentDir: sources.agentDir ?? getAgentDir(),
    skillPaths: [],
    includeDefaults: true,
  });
  return {
    skills: result.skills,
    prompt: formatSkillsForPrompt(result.skills, "read").trim(),
    diagnostics: result.diagnostics,
  };
}

/**
 * Build the extension for one deployment's working directory.
 *
 * Loading happens once, at install time, rather than on every request: skills are files on
 * disk that change when someone edits them, and re-reading the tree per model request would
 * both cost work and risk a section that varies for no reason.
 */
export function skillGuidance(sources: SkillSources) {
  const { skills, prompt, diagnostics } = loadSkillSources(sources);

  return {
    extension: defineExtension({
      name: "skills",
      sections: [
        // A skill with no description is dropped by the loader, and an empty block is
        // omitted rather than rendered as an empty tag.
        section("available_skills", () => (prompt === "" ? undefined : prompt)),
      ],
    }),
    skills,
    diagnostics,
  };
}
