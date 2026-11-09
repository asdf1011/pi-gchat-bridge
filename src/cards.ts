import type { SessionStats } from "@earendil-works/pi-coding-agent";
import type { ProviderQuota } from "./quota.js";
import type {
  ConversationSettingsResult,
  DefaultSettings,
  DefaultSettingsResult,
  ModelInfo,
  SessionContext,
  SessionInfo,
  SessionUsage,
} from "./agent-sessions.js";
import { clampToSupported } from "./agent-sessions.js";
import {
  MODEL_ACTION,
  REMOVE_SECRET_ACTION,
  RESUME_ACTION,
  SECRET_ACTION,
  SETTINGS_ACTION,
  SET_SECRET_ACTION,
  THINKING_KEEP,
  THINKING_LEVELS,
  THINKING_LEVELS_ACTION,
} from "./constants.js";

/** Escape text for use inside Chat card/message HTML (e.g. user-supplied names). */
/**
 * Escape text for use inside Chat card/message HTML (e.g. user-supplied names).
 *
 * Total on purpose: callers pass optional values (`process.env.X`, a status
 * field) and an `undefined` must not throw inside a command handler, where the
 * failure would surface as a missing reply rather than an error.
 */
export function escapeHtml(text: string | undefined | null): string {
  return String(text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Items for a thinking-level dropdown.
 *
 * `supported` is the picked model's level list (pi's own rule). When it's known
 * the dropdown lists ONLY those levels, so nothing on the card can't happen, and
 * "keep current" is offered only if that level is one of them.
 *
 * When it's unknown (no session yet / old card) every level is listed and pi
 * clamps on apply.
 */
function thinkingItems(
  current: string | undefined,
  opts?: { keep?: boolean; supported?: string[] },
): { text: string; value: string; selected?: boolean }[] {
  const supported = opts?.supported && opts.supported.length > 0 ? opts.supported : [...THINKING_LEVELS];
  // What pi would actually do with `current` on this model (up-clamp first),
  // so the pre-selection matches reality instead of silently landing on the
  // dropdown's first item.
  const effective = current === undefined ? undefined : clampToSupported(supported, current);
  const items = supported.map((level) => ({
    text: level,
    value: level,
    ...(level === effective ? { selected: true } : {}),
  }));
  const offerKeep = opts?.keep === true && (current === undefined || effective === current);
  if (!offerKeep) return items;
  return [
    {
      text: current ? `— keep current (${current}) —` : "— keep current —",
      value: THINKING_KEEP,
      ...(current ? {} : { selected: true }),
    },
    ...items,
  ];
}

/** One line describing what the thinking dropdown is showing and why. */
function thinkingHint(current: string | undefined, supported: string[] | undefined): string {
  if (!supported || supported.length === 0) {
    return "<br>Thinking levels are clamped to what the chosen model supports.";
  }
  const list = supported.map((l) => `<b>${escapeHtml(l)}</b>`).join(", ");
  const note =
    current && !supported.includes(current)
      ? `<br>This model doesn't support <b>${escapeHtml(current)}</b> — the closest supported level will be used.`
      : "";
  return `<br>Thinking levels for this model: ${list}.${note}`;
}

/** onChangeAction for a model dropdown: asks Chat to submit the form so the
 *  bridge can re-render the card with that model's thinking levels. */
function levelsOnChange(mode: "model" | "settings", sessionKey?: string): unknown {
  return {
    function: THINKING_LEVELS_ACTION,
    parameters: [
      { key: "mode", value: mode },
      ...(sessionKey ? [{ key: "session", value: sessionKey }] : []),
    ],
  };
}

/** "thinking <b>high</b>", or a note when pi had to clamp what was picked. */
function thinkingSummary(result: ConversationSettingsResult): string {
  if (!result.thinkingLevel) return "";
  const level = `<b>${escapeHtml(result.thinkingLevel)}</b>`;
  return result.clampedFrom
    ? ` Thinking: ${level} <i>(${escapeHtml(result.clampedFrom)} isn't supported by this model)</i>.`
    : ` Thinking: ${level}.`;
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

/** Quick status card: current model + thinking level + conversation token usage. */
export function statusCard(info: {
  model?: string;
  thinkingLevel?: string;
  defaultModel?: string;
  defaultThinkingLevel?: string;
  context?: SessionContext;
  usage?: SessionUsage;
}): unknown[] {
  const lines: string[] = [];
  if (info.model) {
    lines.push(`Model: <b>${escapeHtml(info.model)}</b>`);
    if (info.thinkingLevel) lines.push(`Thinking: <b>${escapeHtml(info.thinkingLevel)}</b>`);
  } else if (info.defaultModel) {
    lines.push(`Model: <b>${escapeHtml(info.defaultModel)}</b> <i>(default — no conversation here yet)</i>`);
    if (info.defaultThinkingLevel) {
      lines.push(`Thinking: <b>${escapeHtml(info.defaultThinkingLevel)}</b> <i>(from /settings)</i>`);
    }
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

/** Per-provider quota report for /quota. One section per provider: status,
 *  balance (when the provider exposes a quota API), models queried through it,
 *  and a Top up button for anything that bills per token. */
export function quotaCard(quotas: readonly ProviderQuota[]): unknown[] {
  const statusLine = (q: ProviderQuota): string => {
    if (q.available === true) return "✅ available";
    if (q.available === false) return "❌ unavailable";
    return "❓ unknown";
  };
  const sections = quotas.map((q) => {
    const lines = [
      `<b>${escapeHtml(q.provider)}</b> — ${statusLine(q)}${q.queried ? "" : " <i>(not queried)</i>"}`,
    ];
    if (q.balance) lines.push(escapeHtml(q.balance));
    if (q.note) lines.push(`<i>${escapeHtml(q.note)}</i>`);
    lines.push(`Models: ${q.models.map((m) => escapeHtml(m)).join(", ") || "(none)"}`);
    const widgets: unknown[] = [{ textParagraph: { text: lines.join("<br>") } }];
    if (q.topUpUrl) {
      widgets.push({
        buttonList: {
          buttons: [{ text: "Top up", onClick: { openLink: { url: q.topUpUrl } } }],
        },
      });
    }
    return { widgets };
  });
  return [
    {
      cardId: "quota",
      card: {
        header: { title: "Provider quota" },
        sections: [{ widgets: [{ textParagraph: { text: "Quota per provider this bridge queries." } }] }, ...sections],
      },
    },
  ];
}

/** Dropdown + submit card listing models + thinking levels to switch THIS
 *  conversation to. With `newConversation` (no session yet) the same pick starts
 *  the conversation on that model instead — copy changes, action stays the same.
 *
 *  The thinking dropdown lists every level (plus "keep current") rather than
 *  only the picked model's: the levels depend on the model, which the card
 *  can't know without a round trip — pi clamps the pick and the confirmation
 *  reports the level actually in effect. */
export function modelPickerCard(
  models: ModelInfo[],
  sessionKey: string,
  current?: string,
  opts?: {
    newConversation?: boolean;
    thinkingLevel?: string;
    supportedLevels?: string[];
    /** `provider|id` of the model to pre-select (keeps a re-render on-pick). */
    currentValue?: string;
  },
): unknown[] {
  const starting = opts?.newConversation === true;
  const currentNote = current ? ` (currently <b>${escapeHtml(current)}</b>)` : "";
  const intro = starting
    ? "Starts <b>this conversation</b> on the model you pick. The defaults for new conversations are <b>not</b> changed — use <b>/settings</b> to change those."
    : "Switches the model and thinking level for <b>this conversation only</b>.";
  return [
    {
      cardId: "model-picker",
      card: {
        header: { title: starting ? "Start a new conversation" : "Switch model & thinking" },
        sections: [
          {
            widgets: [
              {
                textParagraph: {
                  text: `${intro}${currentNote}${thinkingHint(opts?.thinkingLevel, opts?.supportedLevels)}`,
                },
              },
              {
                selectionInput: {
                  name: "model_picker",
                  label: "Model",
                  type: "DROPDOWN",
                  // Changing the model re-renders this card with that model's
                  // thinking levels (Chat submits the form on a change).
                  onChangeAction: levelsOnChange("model", sessionKey),
                  items: models.map((m) => ({
                    text: m.label,
                    value: `${m.provider}|${m.id}`,
                    ...(opts?.currentValue === `${m.provider}|${m.id}` ? { selected: true } : {}),
                  })),
                },
              },
              {
                selectionInput: {
                  name: "thinking_picker",
                  label: "Thinking level",
                  type: "DROPDOWN",
                  items: thinkingItems(opts?.thinkingLevel, {
                    keep: true,
                    supported: opts?.supportedLevels,
                  }),
                },
              },
              {
                buttonList: {
                  buttons: [
                    {
                      text: starting ? "Start conversation" : "Apply",
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

/**
 * Confirmation card after a model / thinking-level switch.
 *
 * `opts.title` replaces the "Model switched" header with a conversation topic,
 * once one is known (see topic-summary.ts). Only the header changes: the body
 * keeps announcing the model exactly as before, so the card still answers
 * "which model am I on?" while the thread list gives a hint of the subject.
 */
export function modelConfirmCard(result: ConversationSettingsResult, opts?: { title?: string }): unknown[] {
  const safe = escapeHtml;
  const title = opts?.title?.trim();
  return [
    {
      cardId: "model-confirm",
      card: {
        header: { title: result.ok ? (title || "Model switched") : "Couldn't switch model" },
        sections: [
          {
            widgets: [
              {
                textParagraph: {
                  text: result.ok
                    ? result.created
                      ? `New conversation on <b>${safe(result.modelLabel)}</b>.${thinkingSummary(result)}`
                      : `Now on <b>${safe(result.modelLabel)}</b>.${thinkingSummary(result)}`
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

/** Card to change the GLOBAL defaults (model + thinking level) for NEW conversations. */
export function settingsCard(
  models: ModelInfo[],
  defaults: DefaultSettings,
  opts?: { currentValue?: string; supportedLevels?: string[] },
): unknown[] {
  const selectedValue =
    opts?.currentValue ??
    (defaults.provider && defaults.modelId ? `${defaults.provider}|${defaults.modelId}` : undefined);
  const currentNote = defaults.modelLabel ? ` (currently <b>${escapeHtml(defaults.modelLabel)}</b>)` : "";
  const levelNote = defaults.thinkingLevel
    ? `Thinking currently <b>${escapeHtml(defaults.thinkingLevel)}</b>.`
    : "Thinking level is unset — pi's default (<b>medium</b>) is used and clamped per model.";
  return [
    {
      cardId: "settings",
      card: {
        header: { title: "Settings for new conversations" },
        sections: [
          {
            widgets: [
              {
                textParagraph: {
                  text:
                    `Sets the defaults for <b>new</b> conversations${currentNote}. Existing conversations are <b>not</b> affected — switch those with <b>/model</b> inside each conversation.<br>${levelNote}${thinkingHint(defaults.thinkingLevel, opts?.supportedLevels)}`,
                },
              },
              {
                selectionInput: {
                  name: "default_model_picker",
                  label: "Default model",
                  type: "DROPDOWN",
                  // Same dynamic re-render as /model: the defaults card also
                  // shows only the picked model's levels.
                  onChangeAction: levelsOnChange("settings"),
                  items: models.map((m) => ({
                    text: m.label,
                    value: `${m.provider}|${m.id}`,
                    ...(selectedValue === `${m.provider}|${m.id}` ? { selected: true } : {}),
                  })),
                },
              },
              {
                selectionInput: {
                  name: "default_thinking_picker",
                  label: "Default thinking level",
                  type: "DROPDOWN",
                  items: thinkingItems(defaults.thinkingLevel, {
                    keep: true,
                    supported: opts?.supportedLevels,
                  }),
                },
              },
              {
                buttonList: {
                  buttons: [
                    {
                      text: "Save defaults",
                      onClick: { action: { function: SETTINGS_ACTION } },
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

/** Confirmation card after changing the global defaults. */
export function settingsConfirmCard(result: DefaultSettingsResult): unknown[] {
  const safe = escapeHtml;
  const level = result.thinkingLevel ? ` Thinking: <b>${safe(result.thinkingLevel)}</b>.` : "";
  return [
    {
      cardId: "settings-confirm",
      card: {
        header: { title: result.ok ? "Defaults saved" : "Couldn't save defaults" },
        sections: [
          {
            widgets: [
              {
                textParagraph: {
                  text: result.ok
                    ? `New conversations will use <b>${safe(result.modelLabel)}</b>.${level} Existing conversations are unchanged — switch them with <b>/model</b> in each conversation.`
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
    ["<b>/model</b>", "Switch this conversation's model and thinking level — or start this conversation on a model if it has none yet"],
    ["<b>/settings</b>", "Change the default model and thinking level for new conversations (existing ones keep theirs)"],
    ["<b>/status</b>", "Show this conversation's model, thinking level, context usage, and tokens"],
    ["<b>/quota</b>", "Show quota/balance for every provider the bridge can query (top-up links for paid ones)"],
    ["<b>/resume</b>", "Resume a session (dropdown picker)"],
    ["<b>/sessions</b>", "Same as /resume"],
    ["<b>/list</b>", "Same as /resume"],
    ["<b>/name</b>", "Show or set this conversation's session name"],
    ["<b>/session</b>", "Show this conversation's session stats (tokens, cost)"],
    ["<b>/secret</b>", "List stored secrets; <b>/secret set NAME</b> to add one (value entered on a card, never in chat)"],
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

/**
 * The `/secret set` card: name (already decided) plus a masked-looking value.
 *
 * Chat has no password widget, so the value is visible while it is typed. That
 * is a real limitation, and it is why the card's text says so: the point of the
 * card is that the value never becomes a *message* — not that it is unseeable
 * on a screen the operator is already looking at.
 *
 * `onlyVisibleTo` is not available on widget-level inputs in the Chat API, so
 * the card is posted into the same thread and the value travels back through
 * the Pub/Sub event as form input rather than as message text. That is the
 * boundary this design can actually deliver.
 */
export function secretValueCard(name: string, opts?: { replacing?: boolean; hint?: string }): unknown[] {
  const title = opts?.replacing ? "Replace secret" : "Store secret";
  return [
    {
      cardId: "secret-value",
      card: {
        header: { title, subtitle: name },
        sections: [
          {
            widgets: [
              {
                textParagraph: {
                  text:
                    `Value for <b>${escapeHtml(name)}</b>${opts?.hint ? ` — ${escapeHtml(opts.hint)}` : ""}.<br>` +
                    "It is stored on the bridge and never enters the conversation. " +
                    "Visible while you type: Google Chat has no password field.",
                },
              },
              {
                textInput: {
                  name: "secret_value",
                  label: "Value",
                  type: "SINGLE_LINE",
                },
              },
              {
                buttonList: {
                  buttons: [
                    {
                      text: opts?.replacing ? "Replace" : "Store",
                      onClick: {
                        action: {
                          function: SET_SECRET_ACTION,
                          parameters: [{ key: "name", value: name }],
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

/** Confirmation after storing, replacing, or removing a secret. */
export function secretConfirmCard(opts: {
  ok: boolean;
  name: string;
  action: "stored" | "removed" | "failed";
  detail?: string;
}): unknown[] {
  const title = opts.ok ? "Secret saved" : "Secret not saved";
  const body = opts.ok
    ? `${opts.action === "removed" ? "Removed" : "Stored"} <b>${escapeHtml(opts.name)}</b>.`
    : `Could not ${opts.action === "removed" ? "remove" : "store"} <b>${escapeHtml(opts.name)}</b>: ${escapeHtml(opts.detail ?? "unknown error")}`;
  return [
    {
      cardId: "secret-confirm",
      card: {
        header: { title },
        sections: [
          {
            widgets: [
              { textParagraph: { text: body } },
              ...(opts.ok
                ? [
                    {
                      textParagraph: {
                        text: "<i>New values take effect after the bridge restarts, or on /reload where supported.</i>",
                      },
                    },
                  ]
                : []),
            ],
          },
        ],
      },
    },
  ];
}

/**
 * The `/secret` panel: what is stored, and the one control that adds more.
 *
 * Deliberately a card rather than a text reply. A text listing looks like every
 * other answer the bot posts, which is misleading in a specific way: it gives no
 * signal that `/secret` is handled by the bridge rather than by pi, and no
 * signal that a value typed here takes a different route from a value typed into
 * the chat box. The card is evidence that this is a widget, not a prompt.
 *
 * The name input is the same `SECRET_ACTION` button the value card ends with, so
 * `/secret` and `/secret set NAME` converge on one path.
 */
export function secretPanelCard(
  secrets: { name: string; tail?: string; from?: string; addedAt: number; addedBy: string }[],
): unknown[] {
  const rows = secrets.map((secret) => ({
    textParagraph: {
      text:
        `<b>${escapeHtml(secret.name)}</b> — ` +
        // A file-backed secret shows its path: a path is not the secret, and
        // seeing it is how an operator confirms the right file was recorded.
        (secret.from !== undefined
          ? `file <code>${escapeHtml(secret.from)}</code>`
          : `<code>${escapeHtml(secret.tail ?? "")}</code>`) +
        ` · added ${new Date(secret.addedAt).toISOString().slice(0, 10)} by ${escapeHtml(secret.addedBy)}`,
    },
  }));

  const widgets: unknown[] = [
    {
      textParagraph: {
        text:
          "Values are captured on a card and **never** pass through the model — this panel, `request_secret` " +
          "and the redaction layer are bridge features, not prompt instructions.",
      },
    },
  ];

  if (secrets.length === 0) {
    widgets.push({ textParagraph: { text: "No secrets stored yet." } });
  } else {
    widgets.push(...rows);
    widgets.push({
      textParagraph: {
        text: "<i>Values are never shown — only the last few characters, and only to you.</i>",
      },
    });
  }

  widgets.push({
    textInput: {
      name: "secret_name",
      label: "Add a secret — name",
      type: "SINGLE_LINE",
      hintText: "e.g. BRAVE_API_KEY",
    },
  });

  widgets.push({
    buttonList: {
      buttons: [
        {
          text: "Enter value on a card",
          onClick: { action: { function: SECRET_ACTION } },
        },
        ...(secrets.length > 0
          ? [
              {
                text: "Remove…",
                onClick: { action: { function: REMOVE_SECRET_ACTION } },
              },
            ]
          : []),
      ],
    },
  });

  return [
    {
      cardId: "secret-panel",
      card: {
        header: { title: "Secrets", subtitle: `${secrets.length} stored` },
        sections: [{ widgets }],
      },
    },
  ];
}

/** Picker for removing a secret, so deletion needs no typed command. */
export function secretRemoveCard(secrets: { name: string; tail?: string; from?: string }[]): unknown[] {
  return [
    {
      cardId: "secret-remove",
      card: {
        header: { title: "Remove a secret" },
        sections: [
          {
            widgets: [
              {
                textParagraph: {
                  text: "Pick the secret to delete. This removes it from the bridge; it cannot be undone.",
                },
              },
              {
                selectionInput: {
                  name: "secret_remove_picker",
                  label: "Secret",
                  type: "DROPDOWN",
                  items: secrets.map((s) => ({
                    text: `${s.name} (${s.from !== undefined ? "file" : (s.tail ?? "")})`,
                    value: s.name,
                  })),
                },
              },
              {
                buttonList: {
                  buttons: [
                    {
                      text: "Remove",
                      onClick: { action: { function: REMOVE_SECRET_ACTION } },
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
