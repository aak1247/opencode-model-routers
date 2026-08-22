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
  GroupStrategy,
  ModelEntry,
  ResolvedModel
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

/** Normalize a ModelEntry into a ResolvedModel. */
export function resolveModelEntry(entry: ModelEntry): ResolvedModel {
  if (typeof entry === "string") {
    return { id: entry, weight: 1, priority: 0 };
  }
  return {
    id: entry.id,
    weight: typeof entry.weight === "number" && entry.weight > 0 ? entry.weight : 1,
    priority: typeof entry.priority === "number" ? entry.priority : 0
  };
}

/** Return the group's models resolved and grouped by priority (highest first). */
function groupModelsByPriority(group: RouterGroup): { id: string; weight: number; priority: number }[][] {
  const resolved = group.models.map(resolveModelEntry);
  const byPriority = new Map<number, ResolvedModel[]>();
  for (const m of resolved) {
    if (!byPriority.has(m.priority)) byPriority.set(m.priority, []);
    byPriority.get(m.priority)!.push(m);
  }
  const sortedPriorities = [...byPriority.keys()].sort((a, b) => b - a);
  return sortedPriorities.map((p) => byPriority.get(p)!);
}

/** Weighted round-robin: returns next model index by weight among candidates. */
function weightedPick(candidates: ResolvedModel[], state: SessionRouterState, random: boolean): ResolvedModel | undefined {
  if (candidates.length === 0) return undefined;
  if (random) {
    const totalWeight = candidates.reduce((s, m) => s + m.weight, 0);
    let r = Math.random() * totalWeight;
    for (const m of candidates) {
      r -= m.weight;
      if (r < 0) return m;
    }
    return candidates[candidates.length - 1];
  }
  // weighted round-robin: advance cursor across a virtual weight wheel
  const totalWeight = candidates.reduce((s, m) => s + m.weight, 0);
  const step = state.cursor % totalWeight;
  let acc = 0;
  for (const m of candidates) {
    acc += m.weight;
    if (step < acc) {
      state.cursor = (state.cursor + 1) % totalWeight;
      return m;
    }
  }
  state.cursor = (state.cursor + 1) % totalWeight;
  return candidates[candidates.length - 1];
}

function pickByStrategy(
  group: RouterGroup,
  state: SessionRouterState,
  strategy: GroupStrategy
): string | undefined {
  const cooldownMs = (group.cooldown_seconds ?? 60) * 1000;
  const tiers = groupModelsByPriority(group);

  // Walk priority tiers from highest to lowest; use the first tier that has
  // at least one healthy model.
  for (const tier of tiers) {
    const healthy = tier.filter((m) => {
      const s = state.models.get(m.id);
      return !s || s.cooldownUntil === 0 || Date.now() >= s.cooldownUntil;
    });
    if (healthy.length === 0) continue;

    if (strategy === "failover") {
      // strict failover: use the first healthy model in declaration order
      // within the highest available priority tier
      return healthy[0].id;
    }
    if (strategy === "random") {
      return weightedPick(healthy, state, true)!.id;
    }
    // round-robin (weighted)
    return weightedPick(healthy, state, false)!.id;
  }
  return undefined;
}

function findModelGroup(config: RouterPluginConfig, model: string): RouterGroup | undefined {
  return (config.groups ?? []).find((g) => g.models.some((m) => resolveModelEntry(m).id === model));
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
  now: number = Date.now(),
  opts: { skipSameModelRetry?: boolean } = {}
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
  // Permanent errors (quota/usage-limit/model-not-found) skip same-model retry
  // via opts.skipSameModelRetry — retrying a permanently failing model is wasted work.
  if (!opts.skipSameModelRetry && failedState.failures <= maxRetries) {
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

  // Rule 3: next model in same group — pick the next healthy candidate by
  // priority tier (same tier first, then drop to lower tiers). A candidate
  // must have retry budget (failures <= maxRetries) and not be in cooldown.
  const cooldownSeconds = failedGroup.cooldown_seconds ?? 60;
  const candidateRetries = failedGroup.max_retries ?? 3;
  const tiers = groupModelsByPriority(failedGroup);

  for (const tier of tiers) {
    for (const candidate of tier) {
      if (candidate.id === failedModel) continue;
      const cState = getModelState(state, candidate.id);
      if (isModelInCooldown(state, candidate.id, cooldownSeconds)) continue;
      if (cState.failures > candidateRetries) continue; // budget exhausted
      state.currentModel = candidate.id;
      return {
        newModel: candidate.id,
        group: failedGroup.name,
        sameModelRetry: false,
        withinGroupSwitch: true,
        groupFallback: false,
        failedModel
      };
    }
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
