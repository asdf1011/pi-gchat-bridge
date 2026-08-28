/**
 * Minimal structured logger: routes all bridge logging through one place so
 * levels can be filtered and the format stays consistent. The message text
 * (including any embedded `[tag]` prefix) is passed through unchanged.
 *
 * Level filtering is controlled by LOG_LEVEL (default "info"). Enabled levels
 * log via console.log; warn/error via console.error so they land on stderr.
 */
type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const threshold = LEVEL_ORDER[(process.env.LOG_LEVEL as Level) ?? "info"] ?? LEVEL_ORDER.info;

function emit(level: Level, message: string, ...args: unknown[]): void {
  if (LEVEL_ORDER[level] < threshold) return;
  const line = `[${new Date().toISOString()}] [${level}] ${message}`;
  const sink = level === "warn" || level === "error" ? console.error : console.log;
  if (args.length === 0) sink(line);
  else sink(line, ...args);
}

export const logger = {
  debug: (message: string, ...args: unknown[]) => emit("debug", message, ...args),
  info: (message: string, ...args: unknown[]) => emit("info", message, ...args),
  warn: (message: string, ...args: unknown[]) => emit("warn", message, ...args),
  error: (message: string, ...args: unknown[]) => emit("error", message, ...args),
};
