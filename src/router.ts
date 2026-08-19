/**
 * Core routing engine: group-based load balancing, retry and fallback.
 * Pure functions — no opencode dependencies, fully unit-testable.
 */
import type {
  RouterGroup,
  RouterPluginConfig,
  SessionRouterState,
  ModelRuntimeState,
  RouterPlan,
  GroupStrategy
} from "./types";
import { DEFAULT_CONFIG } from "./types";

export function createSessionState(): SessionRouterState {
  return {
    currentModel: "",
    groupIndex: 0,
    cursor: 0,
    groupFallbacks: 0,
    models: new Map()
  };
}

export function getModelState(state: SessionRouterState, model: string): ModelRuntimeState {
  let s = state.models.get(model);
  if (!s) {
    s = { failures: 0, cooldownUntil: 0, successes: 0, totalFailures: 0 };
    state.models.set(model, s);
  }
  return s;
}

export function isModelInCooldown(state: SessionRouterState, model: string, cooldownSeconds: number): boolean {
  const s = getModelState(state, model);
  if (s.cooldownUntil === 0) return false;
  return Date.now() < s.cooldownUntil;
}

export function markModelSuccess(state: SessionRouterState, model: string): void {
  const s = getModelState(state, model);
  s.successes++;
  s.failures = 0;
  s.cooldownUntil = 0;
}

export function markModelFailure(state: SessionRouterState, model: string, cooldownSeconds: number): void {
  const s = getModelState(state, model);
  s.failures++;
  s.totalFailures++;
  s.cooldownUntil = Date.now() + cooldownSeconds * 1000;
}

export function resetSessionFailures(state: SessionRouterState): void {
  for (const s of state.models.values()) {
    s.failures = 0;
  }
}

function getGroupChain(config: RouterPluginConfig, agent: string | undefined): string[] {
  const bindings = config.agent_groups ?? {};
  if (agent && bindings[agent] && bindings[agent].length > 0) {
    return bindings[agent];
  }
  if (bindings["*"] && bindings["*"].length > 0) {
    return bindings["*"];
  }
  // Default: all groups in declaration order
  return (config.groups ?? []).map((g) => g.name);
}

function pickByStrategy(
  group: RouterGroup,
  state: SessionRouterState,
  strategy: GroupStrategy
): string | undefined {
  const healthy = group.models.filter((m) => {
    const cooldown = (group.cooldown_seconds ?? 60) * 1000;
    const s = state.models.get(m);
    return !s || s.cooldownUntil === 0 || Date.now() >= s.cooldownUntil;
  });
  if (healthy.length === 0) return undefined;

  if (strategy === "random") {
    const idx = Math.floor(Math.random() * healthy.length);
    return healthy[idx];
  }
  if (strategy === "failover") {
    return healthy[0];
  }
  // round-robin: rotate within the healthy set
  const idx = state.cursor % healthy.length;
  state.cursor = idx + 1;
  return healthy[idx];
}

function findModelGroup(config: RouterPluginConfig, model: string): RouterGroup | undefined {
  return (config.groups ?? []).find((g) => g.models.includes(model));
}

/**
 * Compute the next dispatch plan given the current state and the model that
 * just failed (or "" for initial dispatch).
 *
 * Rules:
 *  1. Initial dispatch: pick first model of first group.
 *  2. Same model failure: if retries remain within its group's max_retries,
 *     retry the SAME model (sameModelRetry).
 *  3. Otherwise try the next model in the same group (withinGroupSwitch).
 *  4. If the group is exhausted, move to the next group (groupFallback), up to
 *     max_group_fallbacks hops.
 */
export function planNext(
  state: SessionRouterState,
  config: RouterPluginConfig,
  failedModel: string,
  agent: string | undefined,
  now: number = Date.now()
): RouterPlan {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const chain = getGroupChain(cfg, agent);

  // Initial dispatch
  if (!failedModel) {
    const group = (cfg.groups ?? []).find((g) => g.name === chain[0]);
    if (!group || group.models.length === 0) {
      return { newModel: "", group: chain[0] ?? "", sameModelRetry: false, withinGroupSwitch: false, groupFallback: false, failedModel: "", exhausted: true };
    }
    const model = pickByStrategy(group, state, group.strategy ?? "round-robin");
    if (!model) {
      return { newModel: "", group: group.name, sameModelRetry: false, withinGroupSwitch: false, groupFallback: false, failedModel: "", exhausted: true };
    }
    state.currentModel = model;
    return { newModel: model, group: group.name, sameModelRetry: false, withinGroupSwitch: false, groupFallback: false, failedModel: "" };
  }

  // A model failed — find its group
  const failedGroup = findModelGroup(cfg, failedModel);
  if (!failedGroup) {
    // Model not in any group: treat as exhausted
    return { newModel: "", group: "", sameModelRetry: false, withinGroupSwitch: false, groupFallback: false, failedModel, exhausted: true };
  }

  const maxRetries = failedGroup.max_retries ?? 3;
  const failedState = getModelState(state, failedModel);
  const groupIdx = chain.indexOf(failedGroup.name);

  // Rule 2: same-model retry — a model can be retried `max_retries` times
  // after its first failure (total attempts = 1 + max_retries).
  // `failures` counts completed failures; while it is <= max_retries we retry
  // the same model, and only after exceeding it do we move on.
  if (failedState.failures <= maxRetries) {
    // Keep same model (do not mark cooldown yet — will be applied on final failure)
    return {
      newModel: failedModel,
      group: failedGroup.name,
      sameModelRetry: true,
      withinGroupSwitch: false,
      groupFallback: false,
      failedModel
    };
  }

  // Rule 3: next model in same group — pick a model that still has retry
  // budget (failures <= maxRetries) and is not in cooldown.
  const groupModels = failedGroup.models;
  const failedIdx = groupModels.indexOf(failedModel);
  const cooldownSeconds = failedGroup.cooldown_seconds ?? 60;
  for (let i = 1; i < groupModels.length; i++) {
    const idx = (failedIdx + i) % groupModels.length;
    const candidate = groupModels[idx];
    if (candidate === failedModel) continue;
    const cState = getModelState(state, candidate);
    const candidateRetries = failedGroup.max_retries ?? 3;
    if (isModelInCooldown(state, candidate, cooldownSeconds)) continue;
    if (cState.failures > candidateRetries) continue; // budget exhausted
    state.currentModel = candidate;
    return {
      newModel: candidate,
      group: failedGroup.name,
      sameModelRetry: false,
      withinGroupSwitch: true,
      groupFallback: false,
      failedModel
    };
  }

  // Rule 4: move to next group
  if (groupIdx < chain.length - 1) {
    if (state.groupFallbacks >= (cfg.max_group_fallbacks ?? 3)) {
      return { newModel: "", group: failedGroup.name, sameModelRetry: false, withinGroupSwitch: false, groupFallback: false, failedModel, exhausted: true };
    }
    const nextGroupName = chain[groupIdx + 1];
    const nextGroup = (cfg.groups ?? []).find((g) => g.name === nextGroupName);
    if (!nextGroup || nextGroup.models.length === 0) {
      return { newModel: "", group: nextGroupName, sameModelRetry: false, withinGroupSwitch: false, groupFallback: false, failedModel, exhausted: true };
    }
    state.groupIndex = groupIdx + 1;
    state.groupFallbacks++;
    const model = pickByStrategy(nextGroup, state, nextGroup.strategy ?? "round-robin");
    if (!model) {
      return { newModel: "", group: nextGroupName, sameModelRetry: false, withinGroupSwitch: false, groupFallback: false, failedModel, exhausted: true };
    }
    state.currentModel = model;
    return {
      newModel: model,
      group: nextGroupName,
      sameModelRetry: false,
      withinGroupSwitch: false,
      groupFallback: true,
      failedModel
    };
  }

  return { newModel: "", group: failedGroup.name, sameModelRetry: false, withinGroupSwitch: false, groupFallback: false, failedModel, exhausted: true };
}
