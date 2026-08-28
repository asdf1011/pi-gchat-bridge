import type { SessionStats } from "@earendil-works/pi-coding-agent";
import type {
  ModelInfo,
  SessionContext,
  SessionInfo,
  SessionUsage,
  SwitchModelResult,
} from "./agent-sessions.js";
import { MODEL_ACTION, RESUME_ACTION, SET_DEFAULT_MODEL_ACTION } from "./constants.js";

/** Escape text for use inside Chat card/message HTML (e.g. user-supplied names). */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Dropdown + submit button card listing sessions; the button's click carries
 *  the dropdown value in formInputs (dropdown onChangeAction events carry none)
 *  and the session key it was created for (card events omit thread info). */
export function pickerCard(sessions: SessionInfo[], sessionKey: string): unknown[] {
  return [
    {
      cardId: "session-picker",
      card: {
        header: { title: "Resume a session" },
        sections: [
          {
            widgets: [
              {
                selectionInput: {
                  name: "session_picker",
                  label: "Session",
                  type: "DROPDOWN",
                  items: sessions.map((s) => ({ text: s.label, value: s.file })),
                },
              },
              {
                buttonList: {
                  buttons: [
                    {
                      text: "Resume session",
                      onClick: {
                        action: {
                          function: RESUME_ACTION,
                          parameters: [{ key: "session", value: sessionKey }],
                        },
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    },
  ];
}

/** Confirmation card after resuming a session. */
export function confirmCard(label: string): unknown[] {
  const safe = escapeHtml(label);
  return [
    {
      cardId: "resume-confirm",
      card: {
        header: { title: "Session switched" },
        sections: [
          {
            widgets: [
              { textParagraph: { text: `Now on <b>${safe}</b>. Send a message to continue there.` } },
            ],
          },
        ],
      },
    },
  ];
}

/** Card shown when a card action fails (e.g. resume with no session selected). */
export function errorCard(message: string): unknown[] {
  const safe = escapeHtml(message);
  return [
    {
      cardId: "resume-error",
      card: {
        header: { title: "Couldn't switch session" },
        sections: [{ widgets: [{ textParagraph: { text: safe } }] }],
      },
    },
  ];
}

/** Card showing a conversation's session stats (tokens, cost). */
export function sessionStatsCard(stats: SessionStats, name?: string): unknown[] {
  const t = stats.tokens;
  const lines = [
    name ? `<b>${escapeHtml(name)}</b>` : "",
    `File: <b>${escapeHtml(stats.sessionFile?.split("/").pop() ?? "(in-memory)")}</b>`,
    `Messages: ${stats.totalMessages} (${stats.userMessages} user · ${stats.assistantMessages} assistant · ${stats.toolResults} tool results · ${stats.toolCalls} tool calls)`,
    `Tokens: ${t.total.toLocaleString()} total (${t.input.toLocaleString()} in · ${t.output.toLocaleString()} out · ${t.cacheRead.toLocaleString()} cache read)`,
    `Cost: <b>$${stats.cost.toFixed(4)}</b>`,
    stats.contextUsage ? `Context now: ${stats.contextUsage.tokens?.toLocaleString() ?? "unknown"} tokens (${stats.contextUsage.percent?.toFixed(0) ?? "?"}% of ${stats.contextUsage.contextWindow.toLocaleString()})` : "",
  ].filter(Boolean);
  return [
    {
      cardId: "session-stats",
      card: {
        header: { title: "Session" },
        sections: [
          {
            widgets: [{ textParagraph: { text: lines.join("<br>") } }],
          },
        ],
      },
    },
  ];
}

/** Quick status card: current model + conversation token usage. */
export function statusCard(info: {
  model?: string;
  defaultModel?: string;
  context?: SessionContext;
  usage?: SessionUsage;
}): unknown[] {
  const lines: string[] = [];
  if (info.model) {
    lines.push(`Model: <b>${escapeHtml(info.model)}</b>`);
  } else if (info.defaultModel) {
    lines.push(`Model: <b>${escapeHtml(info.defaultModel)}</b> <i>(default — no conversation here yet)</i>`);
    lines.push("Send a message to start a conversation with this model.");
  } else {
    lines.push("No model configured.");
  }
  if (info.context) {
    if (info.context.tokens != null) {
      const left = info.context.window - info.context.tokens;
      lines.push(
        `Context: <b>${info.context.tokens.toLocaleString()}</b> of <b>${info.context.window.toLocaleString()}</b> tokens` +
          ` (${info.context.percent?.toFixed(1) ?? "?"}% full — ${left.toLocaleString()} left)`,
      );
    } else {
      lines.push("Context: unknown until the next response (recently compacted).");
    }
  }
  if (info.usage) {
    const u = info.usage;
    const total = u.input + u.output + u.cacheRead + u.cacheWrite;
    lines.push(`Tokens billed: <b>${total.toLocaleString()}</b> total (${u.input.toLocaleString()} in · ${u.output.toLocaleString()} out · ${u.cacheRead.toLocaleString()} cache read)`);
    lines.push(`Cost: <b>$${u.cost.toFixed(4)}</b>`);
  } else if (info.model) {
    lines.push("No token usage recorded yet.");
  }
  return [
    {
      cardId: "status",
      card: {
        header: { title: "Status" },
        sections: [{ widgets: [{ textParagraph: { text: lines.join("<br>") } }] }],
      },
    },
  ];
}

/** Dropdown + submit card listing models to switch THIS conversation to. */
export function modelPickerCard(models: ModelInfo[], sessionKey: string, current?: string): unknown[] {
  const currentNote = current ? ` (currently <b>${escapeHtml(current)}</b>)` : "";
  const intro = "Switches the model for <b>this conversation only</b>.";
  return [
    {
      cardId: "model-picker",
      card: {
        header: { title: "Switch backend model" },
        sections: [
          {
            widgets: [
              {
                textParagraph: {
                  text: `${intro}${currentNote}`,
                },
              },
              {
                selectionInput: {
                  name: "model_picker",
                  label: "Model",
                  type: "DROPDOWN",
                  items: models.map((m) => ({
                    text: m.label,
                    value: `${m.provider}|${m.id}`,
                  })),
                },
              },
              {
                buttonList: {
                  buttons: [
                    {
                      text: "Switch model",
                      onClick: {
                        action: {
                          function: MODEL_ACTION,
                          parameters: [{ key: "session", value: sessionKey }],
                        },
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    },
  ];
}

/** Confirmation card after a model switch. */
export function modelConfirmCard(result: SwitchModelResult): unknown[] {
  const safe = escapeHtml;
  return [
    {
      cardId: "model-confirm",
      card: {
        header: { title: result.ok ? "Model switched" : "Couldn't switch model" },
        sections: [
          {
            widgets: [
              {
                textParagraph: {
                  text: result.ok
                    ? result.created
                      ? `New conversation on <b>${safe(result.label)}</b>.`
                      : `Now on <b>${safe(result.label)}</b>.`
                    : `${safe(result.error ?? "Unknown error")}`,
                },
              },
            ],
          },
        ],
      },
    },
  ];
}

/** Card to change the GLOBAL default model (for NEW conversations only). */
export function defaultModelCard(models: ModelInfo[], current?: string): unknown[] {
  const currentNote = current ? ` (currently <b>${escapeHtml(current)}</b>)` : "";
  return [
    {
      cardId: "default-model-picker",
      card: {
        header: { title: "Change default model" },
        sections: [
          {
            widgets: [
              {
                textParagraph: {
                  text: `Sets the model for <b>new</b> conversations${currentNote}. Existing conversations are <b>not</b> affected — switch those individually with <b>/model</b> in each conversation.`,
                },
              },
              {
                selectionInput: {
                  name: "default_model_picker",
                  label: "Default model",
                  type: "DROPDOWN",
                  items: models.map((m) => ({
                    text: m.label,
                    value: `${m.provider}|${m.id}`,
                  })),
                },
              },
              {
                buttonList: {
                  buttons: [
                    {
                      text: "Set default",
                      onClick: { action: { function: SET_DEFAULT_MODEL_ACTION } },
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    },
  ];
}

/** Confirmation card after changing the default model. */
export function defaultModelConfirmCard(result: { ok: boolean; label: string; error?: string }): unknown[] {
  const safe = escapeHtml;
  return [
    {
      cardId: "default-model-confirm",
      card: {
        header: { title: result.ok ? "Default model set" : "Couldn't set default model" },
        sections: [
          {
            widgets: [
              {
                textParagraph: {
                  text: result.ok
                    ? `New conversations will use <b>${safe(result.label)}</b>. Existing conversations are unchanged — switch them with <b>/model</b> in each conversation.`
                    : `${safe(result.error ?? "Unknown error")}`,
                },
              },
            ],
          },
        ],
      },
    },
  ];
}

/** Card listing the bridge's slash commands. */
export function helpCard(): unknown[] {
  const items = [
    ["<b>/model</b>", "Switch this conversation's model (or set the default when there's no conversation here)"],
    ["<b>/status</b>", "Show this conversation's model, context usage, and tokens"],
    ["<b>/resume</b>", "Resume a session (dropdown picker)"],
    ["<b>/sessions</b>", "Same as /resume"],
    ["<b>/list</b>", "Same as /resume"],
    ["<b>/name</b>", "Show or set this conversation's session name"],
    ["<b>/session</b>", "Show this conversation's session stats (tokens, cost)"],
    ["<b>/help</b>", "This card"],
    ["<b>anything else</b>", "Chats with pi (tools, skills, images)"],
  ];
  return [
    {
      cardId: "help",
      card: {
        header: { title: "Commands" },
        sections: [
          {
            widgets: [
              {
                textParagraph: {
                  text: items.map(([cmd, desc]) => `${cmd} — ${desc}`).join("<br>"),
                },
              },
            ],
          },
        ],
      },
    },
  ];
}
