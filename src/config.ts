/**
 * Configuration loading for opencode-model-routers.
 * Reads from:
 *   .opencode/opencode-model-routers.jsonc / .json (project)
 *   ~/.config/opencode/opencode-model-routers.jsonc / .json (global)
 * Falls back to legacy opencode-model-fallback.json for backwards compat.
 */
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { RouterPluginConfig } from "./types";
import { DEFAULT_CONFIG } from "./types";

export function loadConfig(directory: string): RouterPluginConfig {
  const globalDir = join(homedir(), ".config", "opencode");
  const candidates: string[] = [
    join(directory, ".opencode", "opencode-model-routers.jsonc"),
    join(directory, ".opencode", "opencode-model-routers.json"),
    join(globalDir, "opencode-model-routers.jsonc"),
    join(globalDir, "opencode-model-routers.json"),
    // legacy
    join(directory, ".opencode", "opencode-model-fallback.jsonc"),
    join(directory, ".opencode", "opencode-model-fallback.json"),
    join(globalDir, "opencode-model-fallback.jsonc"),
    join(globalDir, "opencode-model-fallback.json")
  ];

  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const raw = readFileSync(p, "utf8");
      const parsed = parseJsonc(raw);
      if (parsed && typeof parsed === "object") {
        return normalizeConfig(parsed as RouterPluginConfig);
      }
    } catch (err) {
      console.error(`[opencode-model-routers] Failed to parse ${p}:`, err);
    }
  }
  return normalizeConfig({});
}

/** Minimal jsonc to json conversion: strips line comments, block comments and trailing commas. */
export function parseJsonc(raw: string): unknown {
  const stripped = raw
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/,\s*([}\]])/g, "$1");
  return JSON.parse(stripped);
}

function normalizeConfig(cfg: RouterPluginConfig): RouterPluginConfig {
  return {
    ...DEFAULT_CONFIG,
    ...cfg,
    retryable_error_patterns: cfg.retryable_error_patterns ?? DEFAULT_CONFIG.retryable_error_patterns,
    groups: cfg.groups ?? [],
    agent_groups: cfg.agent_groups ?? {}
  };
}
