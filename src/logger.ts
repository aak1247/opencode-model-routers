/**
 * Logging for opencode-model-routers with size-based rotation.
 *
 * Log file: ~/.config/opencode/opencode-model-routers.log
 * Rotation: when the log exceeds MAX_LOG_BYTES (default 100 MiB), the current
 * file is renamed to opencode-model-routers.log.1 (previous .1 is discarded)
 * and a fresh file is started.
 */
import { appendFileSync, mkdirSync, statSync, renameSync, existsSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const LOG_DIR = join(homedir(), ".config", "opencode");
const LOG_FILE = join(LOG_DIR, "opencode-model-routers.log");

/** Default max log size: 100 MiB. Overridable via env var. */
const DEFAULT_MAX_LOG_BYTES = 100 * 1024 * 1024;
const envMax = process.env.OPENCODE_MODEL_ROUTERS_LOG_MAX_BYTES;
const MAX_LOG_BYTES = envMax === undefined ? DEFAULT_MAX_LOG_BYTES : Math.max(0, Number.parseInt(envMax, 10) || 0);

try {
  mkdirSync(LOG_DIR, { recursive: true });
} catch {
  // best effort
}

function rotateIfNeeded(): void {
  if (MAX_LOG_BYTES <= 0) return; // 0 disables rotation cap (unlimited)
  try {
    if (!existsSync(LOG_FILE)) return;
    const stats = statSync(LOG_FILE);
    if (stats.size < MAX_LOG_BYTES) return;
    const rotated = `${LOG_FILE}.1`;
    try {
      if (existsSync(rotated)) unlinkSync(rotated);
    } catch {}
    renameSync(LOG_FILE, rotated);
  } catch {
    // best effort — if rotation fails, keep appending
  }
}

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

function writeToFile(level: LogLevel, message: string, context?: unknown): void {
  try {
    rotateIfNeeded();
    const ts = new Date().toISOString();
    const ctx = context === undefined ? "" : ` ${JSON.stringify(context)}`;
    appendFileSync(LOG_FILE, `[${ts}] [${level}] [opencode-model-routers] ${message}${ctx}\n`);
  } catch {
    // logging must never break the plugin
  }
}

export const logger = {
  debug: (message: string, context?: unknown) => writeToFile("DEBUG", message, context),
  info: (message: string, context?: unknown) => writeToFile("INFO", message, context),
  warn: (message: string, context?: unknown) => writeToFile("WARN", message, context),
  error: (message: string, context?: unknown) => writeToFile("ERROR", message, context),
  /** Path of the active log file (for user-facing messages). */
  logFile: LOG_FILE
};
