/**
 * The command surface: what a slash command *means*, independent of the surface asking.
 *
 * A command is answered with a **shape**, not with a card and not with a sentence: `text` for a
 * result, `list` for a set of things with something to click, `choice` for one question with a few
 * answers, `form` for several answers at once. A surface renders those four and needs to know
 * nothing about `/model` or `/quota` — which is the whole point, because there are three surfaces
 * (Chat cards, the web pane, the CLI) and eleven commands, and eleven times three is how a command
 * set rots the moment one of them is skipped.
 *
 * This module deliberately has no HTTP, no cards and no wording shared with any transport. It takes
 * the seam and plain input, and returns plain data. `commands.ts` still holds the Chat card
 * construction; the two will converge on this module as the bridge is extracted, one command at a
 * time. What it must never do is believe its caller: a value that arrived from a form is validated
 * here, not trusted because a surface offered it in a dropdown.
 */
import type { ModelInfo, SessionHost } from "../session-host/api.js";

/** A row in a list. `command` makes the row clickable: it is the command the click sends. */
export interface CommandRow {
  label: string;
  detail?: string;
  command?: string;
  /** Marks the row that is already true — the current conversation, the current model. */
  current?: boolean;
}

export interface CommandOption {
  /** Identifies the option within its question. */
  id: string;
  label: string;
  detail?: string;
  selected?: boolean;
  /**
   * What choosing it sends, as field values.
   *
   * Explicit rather than derived from the command name: only the command knows which field an answer
   * belongs to, and a renderer guessing ("the command is /model, so the field is model") is the kind
   * of coupling that survives exactly until the second choice command exists.
   */
  values?: Record<string, string>;
}

/** One field of a form. A form is several answers asked once, not a sequence of questions. */
export interface FormField {
  id: string;
  label: string;
  kind: "select" | "text";
  value?: string;
  options?: CommandOption[];
  /** Shown under the field: units, a range, a reason. */
  hint?: string;
}

export type CommandResponse =
  | { kind: "text"; text: string; /** Navigate to this conversation id, when the command made one. */ goto?: number }
  | { kind: "list"; title?: string; rows: CommandRow[]; empty?: string }
  | { kind: "choice"; prompt: string; command: string; options: CommandOption[] }
  | { kind: "form"; prompt: string; command: string; submit?: string; fields: FormField[] };

export interface CommandInput {
  /** The whole line as typed, leading slash included. */
  text: string;
  /**
   * Values from a form or a choice, keyed by field id.
   *
   * A surface that rendered a `form` sends the field ids back with the values; the command's own
   * text stays `/model`. That is why this is separate from `text`: what was asked and what was
   * answered are different things, and the second one is untrusted.
   */
  values?: Record<string, string>;
}

/** What a command needs to know about the conversation it was typed in. */
export interface CommandSubject {
  conversationId: number;
  /** The adapter's name for the conversation: what `setModel`, `bind` and `create` take. */
  name: string;
}

const text = (body: string, goto?: number): CommandResponse => ({ kind: "text", text: body, ...(goto === undefined ? {} : { goto }) });

/** Every command, for `/help`. One line each: what it does, not how it is spelled. */
const HELP: readonly { command: string; about: string }[] = [
  { command: "/status", about: "the model, thinking level, usage and size of this conversation" },
  { command: "/model", about: "choose the model and thinking level" },
  { command: "/quota", about: "provider balances, and which ones bill per token" },
  { command: "/sessions", about: "recent conversations in this store" },
  { command: "/resume <id>", about: "carry on in one of them" },
  { command: "/new", about: "start a fresh conversation here" },
  { command: "/name <label>", about: "rename this conversation" },
  { command: "/compact [instructions]", about: "summarise the history now" },
  { command: "/abort", about: "stop whatever is running" },
  { command: "/help", about: "this list" },
];

/** `provider/modelId`, which is how a model is named on the wire and in a form value. */
export function modelKey(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

/** Every thinking level any model offers, deduplicated and ordered as the model lists them. */
function allLevels(models: readonly ModelInfo[]): string[] {
  const seen: string[] = [];
  for (const model of models) {
    for (const level of model.thinkingLevels ?? []) if (!seen.includes(level)) seen.push(level);
  }
  return seen;
}

/**
 * The model-and-thinking form.
 *
 * One form rather than "pick a model, then pick its thinking level": the two are one decision, and a
 * second question that depends on the answer to the first is a state machine to write in every
 * surface. The levels are the union of what every model offers, and the choice is checked on submit
 * — a form cannot re-render itself when a dropdown changes, and inventing a round trip for that
 * would put the state machine back.
 */
function modelForm(models: readonly ModelInfo[], current: { model: string; thinking?: string }): CommandResponse {
  const levels = allLevels(models);
  return {
    kind: "form",
    prompt: "Model and thinking level",
    command: "/model",
    submit: "Apply",
    fields: [
      {
        id: "model",
        label: "Model",
        kind: "select",
        value: current.model,
        options: models.map((model) => ({
          id: modelKey(model),
          label: model.label,
          detail: modelKey(model),
          selected: modelKey(model) === current.model,
        })),
      },
      {
        id: "thinking",
        label: "Thinking",
        kind: "select",
        ...(current.thinking === undefined ? {} : { value: current.thinking }),
        options: levels.map((level) => ({ id: level, label: level, selected: level === current.thinking })),
        hint: "Levels a model does not support are refused with a list of the ones it has.",
      },
    ],
  };
}

function statusText(state: Awaited<ReturnType<SessionHost["state"]>>): CommandResponse {
  if (!state) return text("This conversation is not in the store any more.");
  const lines = [
    `Model: ${state.model}${state.thinkingLevel ? ` (thinking ${state.thinkingLevel})` : ""}`,
    `Messages: ${state.entries}`,
  ];
  if (state.usage) {
    const usage = state.usage;
    lines.push(
      `Tokens: ${usage.input.toLocaleString()} in, ${usage.output.toLocaleString()} out` +
        (usage.cacheRead ? `, ${usage.cacheRead.toLocaleString()} cached` : ""),
      `Cost: $${usage.cost.toFixed(2)}`,
    );
  }
  return text(lines.join("\n"));
}

/**
 * Run one command line.
 *
 * Order matters in exactly one place: a form's values are applied *instead of* parsing arguments, so
 * a surface that sends both cannot have the arguments win over what the person actually chose.
 */
export async function runCommand(
  seam: SessionHost,
  subject: CommandSubject,
  input: CommandInput,
): Promise<CommandResponse> {
  const line = input.text.trim();
  const [word = "", ...rest] = line.split(/\s+/);
  const argument = rest.join(" ").trim();
  const values = input.values ?? {};
  const command = word.toLowerCase();

  if (command === "/help" || command === "") {
    return {
      kind: "list",
      title: "Commands",
      rows: HELP.map((entry) => ({ label: entry.command, detail: entry.about, command: entry.command })),
    };
  }

  if (command === "/status") {
    return statusText(await seam.state(subject.conversationId));
  }

  if (command === "/model") {
    const models = await seam.models();
    // A form submitted, or a name typed: `values.model` is the dropdown, `/model flash` is the
    // argument. Both end here, and neither is trusted to name a model that exists.
    const wanted = values.model ?? rest[0];
    if (!wanted) {
      const state = await seam.state(subject.conversationId);
      return modelForm(models, {
        model: state?.model ?? "",
        ...(state?.thinkingLevel === undefined ? {} : { thinking: state.thinkingLevel }),
      });
    }
    const requested = models.filter((model) => modelKey(model) === wanted || model.id === wanted || model.label === wanted);
    if (requested.length === 0) {
      return {
        kind: "list",
        title: `No model called ${wanted}`,
        rows: models.map((model) => ({ label: model.label, detail: modelKey(model), command: `/model ${modelKey(model)}` })),
      };
    }
    if (requested.length > 1) {
      return {
        kind: "list",
        title: `${wanted} matches more than one model`,
        rows: requested.map((model) => ({ label: model.label, detail: modelKey(model), command: `/model ${modelKey(model)}` })),
      };
    }
    const chosen = requested[0]!;
    const thinking = values.thinking ?? (rest.length > 1 ? rest.slice(1).join(" ") : undefined);
    const levels = chosen.thinkingLevels ?? [];
    if (thinking !== undefined && levels.length > 0 && !levels.includes(thinking)) {
      return text(
        `${chosen.label} does not support thinking level "${thinking}". It supports: ${levels.join(", ")}.`,
      );
    }
    const applied = await seam.setModel(subject.name, {
      provider: chosen.provider,
      modelId: chosen.id,
      ...(thinking === undefined ? {} : { thinkingLevel: thinking }),
    });
    return text(`Model: ${applied.model}${applied.thinkingLevel ? ` (thinking ${applied.thinkingLevel})` : ""}`);
  }

  if (command === "/quota") {
    // Read-only and slow-ish (a provider API per provider, with a timeout), which is why the seam
    // runs it rather than an adapter: the keys and the connection details live where the host is.
    const quotas = await seam.quota();
    return {
      kind: "list",
      title: "Provider quota",
      empty: "No providers are configured, so there is nothing to check.",
      rows: quotas.map((quota) => ({
        label: quota.provider + (quota.paid ? " (paid)" : " (free)"),
        detail: [
          quota.balance ?? quota.note ?? (quota.queried ? "" : "no quota API"),
          quota.models.slice(0, 3).join(", ") + (quota.models.length > 3 ? "…" : ""),
          quota.paid && quota.topUpUrl ? quota.topUpUrl : "",
        ]
          .filter(Boolean)
          .join(" · "),
      })),
    };
  }

  if (command === "/sessions") {
    const rows = await seam.list({ limit: 10 });
    return {
      kind: "list",
      title: "Recent conversations",
      empty: "Nothing else in this store yet.",
      rows: rows.map((row) => ({
        label: row.label || row.preview || `conversation ${row.conversationId}`,
        detail: [
          row.model,
          row.thinking ? `thinking ${row.thinking}` : "",
          row.lastActivityAt ? new Date(row.lastActivityAt).toISOString().slice(0, 16).replace("T", " ") : "",
        ]
          .filter(Boolean)
          .join(" · "),
        command: `/resume ${row.conversationId}`,
        current: row.conversationId === subject.conversationId,
      })),
    };
  }

  if (command === "/resume") {
    const id = Number(values.conversationId ?? argument);
    if (!Number.isInteger(id) || id <= 0) return text("Which conversation? `/sessions` lists them with their ids.");
    const bound = await seam.bind(subject.name, id);
    if (!bound) return text(`There is no conversation ${id}.`);
    return text(`Now on conversation ${id}.`, id);
  }

  if (command === "/new") {
    const state = await seam.state(subject.conversationId);
    const current = state ? { provider: state.provider, modelId: state.modelId } : undefined;
    if (!current) return text("This conversation has no model to copy, so there is nothing to start from.");
    const created = await seam.create(subject.name, {
      model: current,
      ...(state?.thinkingLevel === undefined ? {} : { thinkingLevel: state.thinkingLevel }),
    });
    return text(`Started conversation ${created.conversationId}.`, created.conversationId);
  }

  if (command === "/name") {
    const label = argument || values.label || "";
    if (!label) return text("A name, then: `/name research notes`.");
    const ok = await seam.label(subject.name, label);
    return text(ok ? `Named this conversation "${label}".` : "This conversation is not in the store any more.");
  }

  if (command === "/compact") {
    // Awaited: the reply is the *result*, and a surface that answered before the work happened would
    // be telling the reader something it does not know.
    await seam.compact(subject.conversationId, argument || undefined);
    return text("Context compacted. The conversation carries on.");
  }

  if (command === "/abort") {
    // The view is the authority on "is something running" — `abort` is idempotent and reports only
    // whether the conversation exists, so asking it would have said "Stopped." to an idle thread.
    const running = (await seam.snapshot(subject.conversationId))?.busy === true;
    if (!running) return text("Nothing was running.");
    await seam.abort(subject.conversationId);
    return text("Stopped.");
  }

  return {
    kind: "list",
    title: `No command called ${command}`,
    rows: HELP.map((entry) => ({ label: entry.command, detail: entry.about, command: entry.command })),
  };
}
