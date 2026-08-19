/**
 * Core type definitions for opencode-model-routers.
 */

/** Load-balancing strategy within a group. */
export type GroupStrategy = "round-robin" | "random" | "failover";

/**
 * A single model in a group. Supports priority tiers and load-balancing weight.
 * - `priority` (higher = preferred): selection first restricts to the highest
 *   priority tier that still has a healthy model. Only when that tier is fully
 *   exhausted does routing drop to the next tier.
 * - `weight`: relative traffic share within the same priority tier
 *   (used by round-robin and random strategies). Default 1.
 */
export interface ModelSpec {
  /** Model id as "provider/model-id". */
  id: string;
  /** Relative weight for load balancing within its priority tier. Default: 1. */
  weight?: number;
  /** Preference tier; higher values are tried first. Default: 0. */
  priority?: number;
}

/** A model entry: plain "provider/model-id" string or a full spec. */
export type ModelEntry = string | ModelSpec;

/** Normalized model spec (all fields resolved). */
export interface ResolvedModel {
  id: string;
  weight: number;
  priority: number;
}

/**
 * A routing group. Models inside a group are load-balanced / retried;
 * groups themselves form a fallback chain (primary → backup → ...).
 */
export interface RouterGroup {
  /** Unique group name. */
  name: string;
  /** Models in this group. Strings are shorthand for `{ id }`. */
  models: (string | ModelSpec)[];
  /**
   * Within-group strategy:
   *  - "round-robin": pick next model in weighted rotation per request
   *  - "random": pick a random healthy model weighted by `weight`
   *  - "failover": always try the highest-priority healthy model, switch only on failure
   * Default: "round-robin"
   */
  strategy?: GroupStrategy;
  /**
   * How many times a single model in this group is retried (same model)
   * before the next model in the group is tried.
   * Default: 3
   */
  max_retries?: number;
  /** Cooldown in seconds after a model fails before it can be picked again. Default: 60. */
  cooldown_seconds?: number;
  /** Time-to-first-token timeout in seconds per model. Default: 180. 0 disables. */
  timeout_seconds?: number;
  /** If true, a model that fails moves to the back of the rotation. Default: true. */
  penalize_on_failure?: boolean;
}

/**
 * Per-agent routing binding. Keys are agent names ("*" = default for all).
 * Value is an ordered list of group names forming the fallback chain.
 */
export type AgentGroupBinding = Record<string, string[]>;

export interface RouterPluginConfig {
  /** Master switch. Default: true. */
  enabled?: boolean;
  /** HTTP status codes that mark an error as retryable. Default: [401,402,429,500,502,503,504]. */
  retry_on_errors?: number[];
  /** Extra regex patterns matched against error messages. */
  retryable_error_patterns?: string[];
  /**
   * Maximum number of group-to-group transitions (fallback hops) before giving up.
   * Same-model retries and within-group model switches do not count against this.
   * Default: 3.
   */
  max_group_fallbacks?: number;
  /** Show toast notifications on model switches. Default: true. */
  notify_on_fallback?: boolean;
  /** Routing groups. */
  groups?: RouterGroup[];
  /** Per-agent group chain bindings. "*" applies to all unbound agents. */
  agent_groups?: AgentGroupBinding;
  /** Whether a new session starts with the same group chain state or fresh. Default: true (fresh). */
  fresh_state_per_session?: boolean;
}

export const DEFAULT_RETRY_ON_ERRORS = [401, 402, 429, 500, 502, 503, 504];

export const DEFAULT_CONFIG: Required<Pick<
  RouterPluginConfig,
  "enabled" | "retry_on_errors" | "retryable_error_patterns" | "max_group_fallbacks" | "notify_on_fallback" | "groups" | "agent_groups" | "fresh_state_per_session"
>> = {
  enabled: true,
  retry_on_errors: DEFAULT_RETRY_ON_ERRORS,
  retryable_error_patterns: [],
  max_group_fallbacks: 3,
  notify_on_fallback: true,
  groups: [],
  agent_groups: {},
  fresh_state_per_session: true
};

/** Mutable per-model runtime state. */
export interface ModelRuntimeState {
  /** Consecutive failures of this model (within the current fallback walk). */
  failures: number;
  /** When this model entered cooldown (ms epoch), or 0. */
  cooldownUntil: number;
  /** Total successes ever recorded for this model. */
  successes: number;
  /** Total failures ever recorded for this model. */
  totalFailures: number;
}

/** Per-session router state. */
export interface SessionRouterState {
  /** Model currently being used ("" = none yet). */
  currentModel: string;
  /** Current group index in the agent's group chain. */
  groupIndex: number;
  /** Within-group rotation cursor (for round-robin). */
  cursor: number;
  /** Group-to-group fallback hops so far. */
  groupFallbacks: number;
  /** Per-model runtime state (keyed by model id). */
  models: Map<string, ModelRuntimeState>;
}

export interface RouterPlan {
  /** Model to dispatch next. */
  newModel: string;
  /** Group name this model belongs to. */
  group: string;
  /** True if this is a same-model retry. */
  sameModelRetry: boolean;
  /** True if this moves to the next model within the same group. */
  withinGroupSwitch: boolean;
  /** True if this moves to the next group. */
  groupFallback: boolean;
  /** Failed model that triggered this plan ("" for initial dispatch). */
  failedModel: string;
  /** Whether the chain is exhausted (no more models/groups). */
  exhausted?: boolean;
}
