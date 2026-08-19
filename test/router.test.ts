import { describe, expect, test } from "bun:test";
import {
  createSessionState,
  planNext,
  markModelFailure,
  markModelSuccess,
  isModelInCooldown
} from "../src/router";
import type { RouterPluginConfig } from "../src/types";

const config: RouterPluginConfig = {
  groups: [
    {
      name: "primary",
      models: ["newapi/gpt-5.6-terra", "newapi/gpt-5.6-luna"],
      strategy: "round-robin",
      max_retries: 2,
      cooldown_seconds: 0
    },
    {
      name: "backup",
      models: ["nvidia-nim/z-ai/glm-5.2", "glm/GLM-5.2"],
      strategy: "failover",
      max_retries: 1
    }
  ],
  agent_groups: {
    "*": ["primary", "backup"]
  },
  max_group_fallbacks: 3
};

describe("planNext - initial dispatch", () => {
  test("picks first model of first group", () => {
    const state = createSessionState();
    const plan = planNext(state, config, "", undefined);
    expect(plan.newModel).toBe("newapi/gpt-5.6-terra");
    expect(plan.group).toBe("primary");
    expect(plan.exhausted).toBeFalsy();
  });

  test("round-robin rotates", () => {
    const state = createSessionState();
    const p1 = planNext(state, config, "", undefined);
    const p2 = planNext(state, config, "", undefined);
    expect(p1.newModel).toBe("newapi/gpt-5.6-terra");
    expect(p2.newModel).toBe("newapi/gpt-5.6-luna");
  });
});

describe("planNext - same model retry", () => {
  test("retries same model up to max_retries", () => {
    const state = createSessionState();
    const initial = planNext(state, config, "", undefined);
    expect(initial.newModel).toBe("newapi/gpt-5.6-terra");

    markModelFailure(state, initial.newModel, 0);
    const r1 = planNext(state, config, initial.newModel, undefined);
    expect(r1.sameModelRetry).toBe(true);
    expect(r1.newModel).toBe("newapi/gpt-5.6-terra");

    markModelFailure(state, r1.newModel, 0);
    const r2 = planNext(state, config, r1.newModel, undefined);
    expect(r2.sameModelRetry).toBe(true);
    expect(r2.newModel).toBe("newapi/gpt-5.6-terra");

    markModelFailure(state, r2.newModel, 0);
    const switch_ = planNext(state, config, r2.newModel, undefined);
    expect(switch_.sameModelRetry).toBe(false);
    expect(switch_.withinGroupSwitch).toBe(true);
    expect(switch_.newModel).toBe("newapi/gpt-5.6-luna");
  });
});

describe("planNext - within group switch", () => {
  test("moves to next model in same group when retries exhausted", () => {
    const state = createSessionState();
    const initial = planNext(state, config, "", undefined);
    // fail the model max_retries+1 times to exhaust its retry budget
    // max_retries = 2 → 3 failures (1 initial + 2 retries)
    markModelFailure(state, initial.newModel, 0);
    let p = planNext(state, config, initial.newModel, undefined);
    expect(p.sameModelRetry).toBe(true);
    markModelFailure(state, p.newModel, 0);
    p = planNext(state, config, p.newModel, undefined);
    expect(p.sameModelRetry).toBe(true);
    markModelFailure(state, p.newModel, 0);
    p = planNext(state, config, p.newModel, undefined);
    expect(p.sameModelRetry).toBe(false);
    expect(p.withinGroupSwitch).toBe(true);
    expect(p.newModel).toBe("newapi/gpt-5.6-luna");
  });
});

describe("planNext - group fallback", () => {
  test("falls back to next group when all models in group fail", () => {
    const state = createSessionState();
    let current = planNext(state, config, "", undefined).newModel; // gpt-5.6-terra

    // Exhaust gpt-5.6-terra: max_retries=2 → 2 same-model retries then switch
    // failure 1 → retry, failure 2 → retry, failure 3 → switch to luna
    markModelFailure(state, current, 0);
    let p = planNext(state, config, current, undefined);
    expect(p.sameModelRetry).toBe(true);
    markModelFailure(state, current, 0);
    p = planNext(state, config, current, undefined);
    expect(p.sameModelRetry).toBe(true);
    markModelFailure(state, current, 0);
    p = planNext(state, config, current, undefined);
    expect(p.withinGroupSwitch).toBe(true);
    expect(p.newModel).toBe("newapi/gpt-5.6-luna");
    current = p.newModel;

    // Exhaust luna identically
    markModelFailure(state, current, 0);
    p = planNext(state, config, current, undefined);
    expect(p.sameModelRetry).toBe(true);
    markModelFailure(state, current, 0);
    p = planNext(state, config, current, undefined);
    expect(p.sameModelRetry).toBe(true);
    markModelFailure(state, current, 0);
    p = planNext(state, config, current, undefined);
    expect(p.groupFallback).toBe(true);
    expect(p.group).toBe("backup");
    expect(p.newModel).toBe("nvidia-nim/z-ai/glm-5.2");
  });
});

describe("planNext - exhaustion", () => {
  test("exhausts chain and returns exhausted", () => {
    const state = createSessionState();
    let current = planNext(state, config, "", undefined).newModel;
    // Brute-force: repeatedly fail current model until chain advances,
    // up to a generous safety bound (each model needs max_retries+1 failures).
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const plan = planNext(state, config, current, undefined);
      if (plan.exhausted) {
        expect(plan.newModel).toBe("");
        return;
      }
      markModelFailure(state, plan.newModel, 0);
      current = plan.newModel;
      seen.add(current);
      if (seen.size > 4) break; // sanity: only 4 models exist
    }
    throw new Error("chain never exhausted: " + JSON.stringify([...seen]));
  });
});

describe("cooldown", () => {
  test("model in cooldown is not picked", () => {
    const cfg: RouterPluginConfig = {
      groups: [{ name: "g", models: ["a/x", "b/y"], max_retries: 0, cooldown_seconds: 3600 }],
      agent_groups: { "*": ["g"] }
    };
    const state = createSessionState();
    const initial = planNext(state, cfg, "", undefined);
    expect(initial.newModel).toBe("a/x");
    markModelFailure(state, "a/x", 3600);
    expect(isModelInCooldown(state, "a/x", 3600)).toBe(true);
    // retries = 0 → switch to next model in group
    const p = planNext(state, cfg, "a/x", undefined);
    expect(p.withinGroupSwitch).toBe(true);
    expect(p.newModel).toBe("b/y");
  });

  test("success clears cooldown and failures", () => {
    const state = createSessionState();
    markModelFailure(state, "a/x", 3600);
    markModelSuccess(state, "a/x");
    expect(isModelInCooldown(state, "a/x", 3600)).toBe(false);
  });
});
