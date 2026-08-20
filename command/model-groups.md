---
description: 查看和管理模型分组(查看所有组、选中组后编辑/使用)
agent: build
---

You are managing the opencode model router groups. The configuration lives at
`~/.config/opencode/opencode-model-routers.json` and the helper CLI is at
`~/.config/opencode/scripts/model-groups.mjs`.

## Commands

1. **查看所有模型组**: Run `node ~/.config/opencode/scripts/model-groups.mjs ls`
2. **选中一个组查看详情**: Run `node ~/.config/opencode/scripts/model-groups.mjs show <组名>`
3. **编辑组**(选择具体操作):
   - 添加成员: `node ~/.config/opencode/scripts/model-groups.mjs add <组名> <model-id> [--priority N] [--weight N]`
   - 删除成员: `node ~/.config/opencode/scripts/model-groups.mjs remove <组名> <model-id>`
   - 编辑成员: 用 `remove` + `add` 组合实现(先删后加,可带新的 priority/weight)
   - 编辑组名: `node ~/.config/opencode/scripts/model-groups.mjs rename <旧名> <新名>`
   - 编辑策略/重试/超时: `node ~/.config/opencode/scripts/model-groups.mjs edit <组名> --strategy <round-robin|random|failover> [--max-retries N] [--timeout N] [--cooldown N]`
   - 绑定 agent 到组链: `node ~/.config/opencode/scripts/model-groups.mjs set-agent <agent> <group1,group2,...>`

## Rules

- Always run `ls` first to show the current groups, then ask which group and which operation the user wants.
- After any edit, run `ls` again to show the updated state and confirm the change.
- Model IDs must be in `provider/model-id` format (e.g. `opencode-go2/glm-5.2`).
- Groups support priority (higher = preferred tier) and weight (traffic share within tier).

User request: $ARGUMENTS
