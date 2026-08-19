# opencode-model-routers

Group-based model routing, load balancing, retry and fallback plugin for [OpenCode](https://github.com/sst/opencode).

Put multiple models in the same **group** for load balancing and same-model retry; chain groups together for **group-level fallback**. Each agent can have its own group chain.

## Features

- **Load balancing within a group** — `round-robin` / `random` / `failover` strategies
- **Same-model retry** — a model is retried `max_retries` times before switching (no instant fallback on one-off errors)
- **Model switch within a group** — when a model exhausts its retries, the next healthy model in the group is tried
- **Group-level fallback** — when an entire group is exhausted, the next group in the chain is used
- **Per-agent group chains** — bind different group chains to different agents (`*` for default)
- **Cooldown & auto-recovery** — failed models cool down, then rejoin rotation
- **TTFT timeout** — aborts models that produce no first token within `timeout_seconds`; streaming models are never interrupted
- **Toast notifications** — on model/group switches

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
  "groups": [
    {
      "name": "primary",
      "models": [
        "newapi/gpt-5.6-terra",
        "newapi/gpt-5.6-luna"
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
Request → primary group → pick model (round-robin/random/failover)
          ├─ success → done
          └─ failure → retry SAME model up to max_retries
                       └─ still failing → next model in group
                                          └─ group exhausted → next group in chain
                                                               └─ chain exhausted → error surfaced
```

### Legacy config compatibility

If you previously used `@razroo/opencode-model-fallback`, the plugin also reads
`opencode-model-fallback.json` as a fallback (its `fallback_models` list is treated
as a single `default` group).

## Development

```bash
bun install
bun test        # run unit tests
bun run build   # bundle to dist/
bun run typecheck
```

## License

MIT
