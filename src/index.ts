/**
 * opencode-model-routers — OpenCode plugin entry point.
 *
 * Hooks into opencode's session lifecycle events to detect model failures and
 * re-dispatch requests through a group-based routing engine (load balancing
 * within a group, fallback across groups).
 */
import type { Plugin } from "@opencode-ai/plugin";
import { loadConfig } from "./config";
import {
  createSessionState,
  planNext,
  markModelFailure,
  markModelSuccess,
  resetSessionFailures
} from "./router";
import type { RouterPluginConfig, SessionRouterState, RouterPlan } from "./types";
import { DEFAULT_CONFIG } from "./types";
import { logger } from "./logger";

type SessionMap = Map<string, SessionRouterState>;

/** Error classification helpers (mirror the upstream plugin's behavior). */
function extractStatusCode(error: unknown, retryOnErrors: number[]): number | undefined {
  const status =
    (error as any)?.status ??
    (error as any)?.statusCode ??
    (error as any)?.response?.status ??
    (error as any)?.error?.statusCode;
  if (typeof status === "number" && retryOnErrors.includes(status)) return status;
  return undefined;
}

function isRetryableError(error: unknown, cfg: RouterPluginConfig): boolean {
  const retryOn = cfg.retry_on_errors ?? DEFAULT_CONFIG.retry_on_errors;
  const status = extractStatusCode(error, retryOn);
  if (status !== undefined) return true;
  const msg = String((error as any)?.message ?? error ?? "");
  const patterns = [
    /rate.?limit/i,
    /too.?many.?requests/i,
    /quota.?exceeded/i,
    /quota.?protection/i,
    /key.?limit.?exceeded/i,
    /usage\s+limit\s+has\s+been\s+reached/i,
    /service.?unavailable/i,
    /overloaded/i,
    /temporarily.?unavailable/i,
    /try.?again/i,
    /credit.*balance.*too.*low/i,
    /insufficient.?(?:credits?|funds?|balance)/i,
    /model not found/i,
    /model not supported/i,
    /model is not available/i
  ];
  for (const p of patterns) {
    if (p.test(msg)) return true;
  }
  for (const custom of cfg.retryable_error_patterns ?? []) {
    try {
      if (new RegExp(custom, "i").test(msg)) return true;
    } catch {
      // ignore invalid patterns
    }
  }
  return false;
}

function parseModelId(model: string): { providerID: string; modelID: string } {
  const parts = model.split("/");
  return { providerID: parts[0], modelID: parts.slice(1).join("/") };
}

export const serverPlugin: Plugin = async ({ client, directory }) => {
  const fileConfig = loadConfig(directory);
  const sessions: SessionMap = new Map();

  logger.info("Plugin initialized", {
    directory,
    enabled: fileConfig.enabled,
    groups: (fileConfig.groups ?? []).map((g) => ({
      name: g.name,
      models: g.models.map((m) => (typeof m === "string" ? m : m.id)),
      strategy: g.strategy ?? "round-robin",
      max_retries: g.max_retries ?? 3,
      timeout_seconds: g.timeout_seconds ?? 180
    })),
    agent_groups: fileConfig.agent_groups,
    max_group_fallbacks: fileConfig.max_group_fallbacks ?? 3
  });

  const getSessionState = (sessionID: string): SessionRouterState => {
    let s = sessions.get(sessionID);
    if (!s) {
      s = createSessionState();
      sessions.set(sessionID, s);
    }
    return s;
  };

  const showToast = async (title: string, message: string, variant: "warning" | "info" | "success" | "error" = "warning") => {
    try {
      await client.tui?.showToast({
        body: { title, message, variant, duration: 5000 }
      });
    } catch {
      // toast is best-effort
    }
  };

  /**
   * Re-dispatch the last user message on `newModel`. Mirrors the upstream
   * plugin's replay approach: fetch session messages, find the last user
   * message, promptAsync it on the new model.
   */
  const redispatch = async (
    sessionID: string,
    newModel: string,
    agent: string | undefined,
    plan: RouterPlan
  ): Promise<boolean> => {
    if (!newModel) return false;
    const { providerID, modelID } = parseModelId(newModel);
    try {
      const messagesResp = await client.session.messages({
        path: { id: sessionID },
        query: { directory }
      });
      const msgs = messagesResp.data ?? [];
      // Find last user message
      let lastUser: (typeof msgs)[number] | undefined;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i]?.info?.role === "user") {
          lastUser = msgs[i];
          break;
        }
      }
      if (!lastUser) {
        logger.warn("No user message to replay", { sessionID, model: newModel, agent });
        return false;
      }
      const parts = lastUser.parts ?? [];
      await client.session.promptAsync({
        path: { id: sessionID },
        body: {
          agent,
          model: { providerID, modelID },
          parts: parts as any
        },
        query: { directory }
      });
      logger.info("Re-dispatch accepted by host", {
        sessionID,
        model: newModel,
        agent,
        sameModelRetry: plan.sameModelRetry,
        withinGroupSwitch: plan.withinGroupSwitch,
        groupFallback: plan.groupFallback
      });
      return true;
    } catch (err) {
      logger.error("Re-dispatch failed", { sessionID, model: newModel, agent, error: String(err) });
      return false;
    }
  };

  const notifySwitch = async (plan: RouterPlan, agent: string | undefined, attempt: number) => {
    const kind = plan.groupFallback ? "group-fallback" : plan.withinGroupSwitch ? "model-switch" : "same-model-retry";
    logger.info("Routing decision", {
      sessionID: plan.failedModel ? "?" : "(initial)",
      from: plan.failedModel || "(start)",
      to: plan.newModel,
      group: plan.group,
      kind,
      agent,
      attempt
    });
    if (!fileConfig.notify_on_fallback) return;
    const displayKind = plan.groupFallback ? "Group Fallback" : plan.withinGroupSwitch ? "Model Switch" : "Retry";
    const from = plan.failedModel ? plan.failedModel.split("/").pop() : "start";
    const to = plan.newModel.split("/").pop() ?? plan.newModel;
    await showToast(displayKind, `${from} → ${to} (${agent ?? "?"} · attempt ${attempt})`);
  };

  const handleFailure = async (
    sessionID: string,
    agent: string | undefined,
    error: unknown
  ) => {
    if (!fileConfig.enabled) {
      logger.debug("Plugin disabled, ignoring failure", { sessionID, agent });
      return;
    }
    if (!isRetryableError(error, fileConfig)) {
      logger.debug("Non-retryable error, ignoring", {
        sessionID,
        agent,
        error: String((error as any)?.message ?? error).slice(0, 300)
      });
      return;
    }

    const state = getSessionState(sessionID);
    const failedModel = state.currentModel;
    if (!failedModel) return;

    const failedGroup = (fileConfig.groups ?? []).find((g) => g.models.includes(failedModel));
    const cooldown = failedGroup?.cooldown_seconds ?? 60;
    markModelFailure(state, failedModel, cooldown);

    const plan = planNext(state, fileConfig, failedModel, agent);
    if (plan.exhausted || !plan.newModel) {
      logger.error("All models exhausted", {
        sessionID,
        agent,
        failedModel,
        groupFallbacks: state.groupFallbacks
      });
      await showToast("All Models Exhausted", `No model available for session ${sessionID}`, "error");
      return;
    }
    await notifySwitch(plan, agent, state.groupFallbacks + 1);
    const ok = await redispatch(sessionID, plan.newModel, agent, plan);
    if (!ok) {
      // re-dispatch failed — treat as another failure to continue chain
      logger.warn("Re-dispatch failed, continuing chain", { sessionID, failedModel: plan.newModel, agent });
      await handleFailure(sessionID, agent, new Error("re-dispatch failed"));
    }
  };

  const handleSuccess = async (sessionID: string, modelId?: string) => {
    const state = sessions.get(sessionID);
    if (!state) return;
    if (modelId) {
      markModelSuccess(state, modelId);
      // A success on any model resets failure counters for the session walk
      resetSessionFailures(state);
      // clear currentModel failure tracking — done via markModelSuccess
      state.currentModel = modelId;
      logger.debug("Model success recorded", { sessionID, model: modelId });
    }
  };

  return {
    event: async ({ event }) => {
      try {
        const e = event as any;
        switch (e?.type) {
          case "session.error": {
            const props = e?.properties ?? {};
            await handleFailure(props.sessionID, props.agent, props.error ?? props);
            break;
          }
          case "message.updated": {
            // Detect completion of a message with an error
            const props = e?.properties ?? {};
            const msg = props.message ?? props;
            if (msg?.info?.error) {
              const error = msg.info.error;
              await handleFailure(props.sessionID, props.agent ?? msg.info?.agent, error);
            }
            break;
          }
          case "session.compacted":
          case "session.idle": {
            const props = e?.properties ?? {};
            const sessionID = props.sessionID;
            if (sessionID) {
              sessions.delete(sessionID);
              logger.debug("Session state cleared", { sessionID, reason: e.type });
            }
            break;
          }
          default:
            break;
        }
      } catch (err) {
        logger.error("Event handler error", { error: String(err) });
      }
    }
  };
};

const pluginManifest = {
  id: "opencode-model-routers",
  server: serverPlugin
};

export default pluginManifest;
