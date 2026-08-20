# opencode-model-routers

[![npm version](https://img.shields.io/npm/v/opencode-model-routers.svg)](https://www.npmjs.com/package/opencode-model-routers)
[![npm downloads](https://img.shields.io/npm/dm/opencode-model-routers.svg)](https://www.npmjs.com/package/opencode-model-routers)
[![GitHub release](https://img.shields.io/github/v/release/aak1247/opencode-model-routers.svg)](https://github.com/aak1247/opencode-model-routers/releases)
[![GitHub license](https://img.shields.io/github/license/aak1247/opencode-model-routers.svg)](https://github.com/aak1247/opencode-model-routers/blob/main/LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/aak1247/opencode-model-routers.svg)](https://github.com/aak1247/opencode-model-routers)
[![GitHub issues](https://img.shields.io/github/issues/aak1247/opencode-model-routers.svg)](https://github.com/aak1247/opencode-model-routers/issues)
[![Bundle size](https://img.shields.io/bundlephobia/min/opencode-model-routers.svg)](https://bundlephobia.com/package/opencode-model-routers)
[![Test status](https://img.shields.io/badge/tests-13%20passed-brightgreen.svg)](#development)

Group-based model routing, load balancing, retry and fallback plugin for [OpenCode](https://github.com/sst/opencode).

Put multiple models in the same **group** for load balancing and same-model retry; chain groups together for **group-level fallback**. Each agent can have its own group chain.

## Features

- **Load balancing within a group** — `round-robin` / `random` / `failover` strategies
- **Weighted distribution** — each model can carry a `weight` for traffic share within its tier
- **Priority tiers** — models with higher `priority` are preferred while healthy; routing only drops to lower-priority models when the preferred tier is exhausted
- **Same-model retry** — a model is retried `max_retries` times before switching (no instant fallback on one-off errors)
- **Model switch within a group** — when a model exhausts its retries, the next healthy model in the group is tried
- **Group-level fallback** — when an entire group is exhausted, the next group in the chain is used
- **Per-agent group chains** — bind different group chains to different agents (`*` for default)
- **Cooldown & auto-recovery** — failed models cool down, then rejoin rotation
- **TTFT timeout** — aborts models that produce no first token within `timeout_seconds`; streaming models are never interrupted
- **Toast notifications** — on model/group switches
- **File logging with rotation** — every routing decision, retry, switch, fallback and error is written to `~/.config/opencode/opencode-model-routers.log`, auto-rotated at 100 MiB (old data discarded; override with `OPENCODE_MODEL_ROUTERS_LOG_MAX_BYTES`)

## Installation

```bash
npm install opencode-model-routers
```

Add to `opencode.json` (or `~/.config/opencode/opencode.json`):

```json
{
  "plugin": ["opencode-model-routers"]
}
```

## Configuration

Create `opencode-model-routers.json` in your project (`.opencode/`) or globally (`~/.config/opencode/`). `.jsonc` with comments is supported.

```jsonc
{
  "enabled": true,

  // HTTP status codes that trigger routing. Default: [401,402,429,500,502,503,504]
  "retry_on_errors": [429, 500, 502, 503, 504],

  // Extra regex patterns matched against error messages (adds to built-ins)
  "retryable_error_patterns": [],

  // Max group-to-group fallback hops before giving up. Default: 3
  "max_group_fallbacks": 3,

  // Toast notifications on switches. Default: true
  "notify_on_fallback": true,

  // ─── Routing groups ───
  // Models can be plain strings ("provider/model-id") or objects with
  // priority and weight:
  //   { "id": "...", "priority": 1, "weight": 2 }
  //   priority: higher = preferred tier, tried first while healthy
  //   weight:   relative traffic share within the same priority tier
  "groups": [
    {
      "name": "primary",
      "models": [
        { "id": "newapi/gpt-5.6-luna", "priority": 2, "weight": 1 },  // preferred: fast/cheap
        { "id": "kimi/k3",             "priority": 2, "weight": 1 },
        { "id": "newapi/gpt-5.6-terra","priority": 1, "weight": 2 }   // fallback tier: heavy-duty
      ],
      "strategy": "round-robin",   // round-robin | random | failover
      "max_retries": 3,            // same-model retries before switching
      "cooldown_seconds": 60,
      "timeout_seconds": 180       // TTFT timeout, 0 disables
    },
    {
      "name": "backup",
      "models": [
        "nvidia-nim/z-ai/glm-5.2",
        "glm/GLM-5.2"
      ],
      "strategy": "failover"
    }
  ],

  // ─── Per-agent group chains ───
  // Ordered list of group names per agent. "*" is the default for unbound agents.
  "agent_groups": {
    "*": ["primary", "backup"],
    "explorer": ["primary"]
  }
}
```

### How routing works

```
Request → primary group → pick highest available priority tier
                            └─ within tier: weighted round-robin / random / failover
          ├─ success → done
          └─ failure → retry SAME model up to max_retries
                       └─ still failing → next model in tier (weighted)
                                          └─ tier exhausted → next lower tier
                                                             └─ group exhausted → next group in chain
                                                                                └─ chain exhausted → error surfaced
```

Priority tiers make routing cost-aware: keep cheap/fast models at `priority: 2`
and only fall through to expensive/heavy models at `priority: 1` when the
preferred tier is down.

### Legacy config compatibility

If you previously used `@razroo/opencode-model-fallback`, the plugin also reads
`opencode-model-fallback.json` as a fallback (its `fallback_models` list is treated
as a single `default` group).

## Model Group Management Command

Manage routing groups from inside opencode with `/model-groups` (or via the bundled CLI script).

```bash
# Install the command (global)
mkdir -p ~/.config/opencode/command ~/.config/opencode/scripts
cp scripts/model-groups.mjs ~/.config/opencode/scripts/
cp command/model-groups.md ~/.config/opencode/command/
```

Then in the TUI run `/model-groups`, or use the CLI directly:

```bash
node ~/.config/opencode/scripts/model-groups.mjs ls                                   # list all groups
node ~/.config/opencode/scripts/model-groups.mjs show <group>                         # show one group
node ~/.config/opencode/scripts/model-groups.mjs add <group> <model> [--priority N] [--weight N]
node ~/.config/opencode/scripts/model-groups.mjs remove <group> <model>
node ~/.config/opencode/scripts/model-groups.mjs rename <old> <new>
node ~/.config/opencode/scripts/model-groups.mjs edit <group> --strategy <s> [--max-retries N] [--timeout N] [--cooldown N]
node ~/.config/opencode/scripts/model-groups.mjs set-agent <agent> <group1,group2,...>
node ~/.config/opencode/scripts/model-groups.mjs use <group> [--append]              # set default group chain
```

Editing a member = `remove` + `add` (re-add with new `--priority` / `--weight`).
After any edit, restart opencode (or start a new session) for the router to pick it up.

## Logs

All routing activity is logged to `~/.config/opencode/opencode-model-routers.log`:

- Plugin initialization (groups, strategies, per-agent bindings)
- Each routing decision: same-model retry, model switch, group fallback
- Re-dispatch acceptance/failure
- Chain exhaustion and errors

The log auto-rotates at **100 MiB** by default: once the cap is reached the old log is **deleted** and a fresh file starts. Override the cap with the `OPENCODE_MODEL_ROUTERS_LOG_MAX_BYTES` environment variable (bytes; `0` disables rotation).

## Development

```bash
bun install
bun test        # run unit tests
bun run build   # bundle to dist/
bun run typecheck
```

## License

MIT
