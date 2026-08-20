#!/usr/bin/env node
/**
 * model-groups - CLI for viewing and editing opencode-model-routers.json groups.
 *
 * Usage:
 *   model-groups ls                      # list all groups with members
 *   model-groups show <group>            # show one group in detail
 *   model-groups add <group> <model> [--priority N] [--weight N]
 *   model-groups remove <group> <model>
 *   model-groups rename <group> <new-name>
 *   model-groups edit <group> --strategy <s> [--max-retries N] [--timeout N] [--cooldown N]
 *   model-groups set-agent <agent> <group1,group2,...>   # bind agent to group chain
 *   model-groups rm-member <group> <model>
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const CONFIG_PATH = join(homedir(), ".config", "opencode", "opencode-model-routers.json");

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    console.error(`Config not found: ${CONFIG_PATH}`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
}

function saveConfig(cfg) {
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  console.log(`Saved to ${CONFIG_PATH}`);
}

function findGroup(cfg, name) {
  return (cfg.groups ?? []).find((g) => g.name === name);
}

function argValue(argv, key) {
  const i = argv.indexOf(key);
  return i >= 0 ? argv[i + 1] : undefined;
}

function printGroup(g, verbose = false) {
  console.log(`\n[${g.name}]  strategy=${g.strategy ?? "round-robin"}  max_retries=${g.max_retries ?? 3}  cooldown=${g.cooldown_seconds ?? 60}s  timeout=${g.timeout_seconds ?? 180}s`);
  for (const m of g.models ?? []) {
    const id = typeof m === "string" ? m : m.id;
    if (typeof m === "string") {
      console.log(`  - ${id}`);
    } else {
      const extras = [];
      if (m.priority !== undefined) extras.push(`priority=${m.priority}`);
      if (m.weight !== undefined) extras.push(`weight=${m.weight}`);
      console.log(`  - ${id}${extras.length ? "  (" + extras.join(", ") + ")" : ""}`);
    }
  }
}

const [,, cmd, ...args] = process.argv;

switch (cmd) {
  case "ls":
  case "list": {
    const cfg = loadConfig();
    if (!cfg.groups?.length) {
      console.log("No groups defined.");
      break;
    }
    for (const g of cfg.groups) printGroup(g);
    console.log("\nagent_groups:", JSON.stringify(cfg.agent_groups ?? {}, null, 2));
    break;
  }

  case "show": {
    const name = args[0];
    if (!name) { console.error("Usage: model-groups show <group>"); process.exit(1); }
    const cfg = loadConfig();
    const g = findGroup(cfg, name);
    if (!g) { console.error(`Group "${name}" not found.`); process.exit(1); }
    printGroup(g, true);
    break;
  }

  case "add": {
    const [gname, model, ...rest] = args;
    if (!gname || !model) { console.error("Usage: model-groups add <group> <model> [--priority N] [--weight N]"); process.exit(1); }
    const cfg = loadConfig();
    let g = findGroup(cfg, gname);
    if (!g) {
      g = { name: gname, models: [], strategy: "round-robin", max_retries: 3, cooldown_seconds: 60, timeout_seconds: 180 };
      cfg.groups = cfg.groups ?? [];
      cfg.groups.push(g);
      console.log(`Created new group "${gname}".`);
    }
    const prio = argValue(rest, "--priority");
    const weight = argValue(rest, "--weight");
    const entry = (prio || weight)
      ? { id: model, ...(prio ? { priority: Number(prio) } : {}), ...(weight ? { weight: Number(weight) } : {}) }
      : model;
    const dup = (g.models ?? []).some((m) => (typeof m === "string" ? m : m.id) === model);
    if (dup) { console.error(`Model "${model}" already in group "${gname}".`); process.exit(1); }
    g.models = g.models ?? [];
    g.models.push(entry);
    saveConfig(cfg);
    console.log(`Added ${model} to [${gname}].`);
    break;
  }

  case "remove":
  case "rm-member": {
    const [gname, model] = args;
    if (!gname || !model) { console.error("Usage: model-groups remove <group> <model>"); process.exit(1); }
    const cfg = loadConfig();
    const g = findGroup(cfg, gname);
    if (!g) { console.error(`Group "${gname}" not found.`); process.exit(1); }
    const before = (g.models ?? []).length;
    g.models = (g.models ?? []).filter((m) => (typeof m === "string" ? m : m.id) !== model);
    if (g.models.length === before) { console.error(`Model "${model}" not in group "${gname}".`); process.exit(1); }
    saveConfig(cfg);
    console.log(`Removed ${model} from [${gname}].`);
    break;
  }

  case "rename": {
    const [gname, newName] = args;
    if (!gname || !newName) { console.error("Usage: model-groups rename <group> <new-name>"); process.exit(1); }
    const cfg = loadConfig();
    const g = findGroup(cfg, gname);
    if (!g) { console.error(`Group "${gname}" not found.`); process.exit(1); }
    if (findGroup(cfg, newName)) { console.error(`Group "${newName}" already exists.`); process.exit(1); }
    g.name = newName;
    // update agent_groups bindings
    for (const [agent, chain] of Object.entries(cfg.agent_groups ?? {})) {
      cfg.agent_groups[agent] = chain.map((n) => (n === gname ? newName : n));
    }
    saveConfig(cfg);
    console.log(`Renamed [${gname}] -> [${newName}].`);
    break;
  }

  case "edit": {
    const gname = args[0];
    if (!gname) { console.error("Usage: model-groups edit <group> --strategy <s> [--max-retries N] [--timeout N] [--cooldown N]"); process.exit(1); }
    const cfg = loadConfig();
    const g = findGroup(cfg, gname);
    if (!g) { console.error(`Group "${gname}" not found.`); process.exit(1); }
    const strategy = argValue(args, "--strategy");
    const maxRetries = argValue(args, "--max-retries");
    const timeout = argValue(args, "--timeout");
    const cooldown = argValue(args, "--cooldown");
    if (strategy) {
      if (!["round-robin", "random", "failover"].includes(strategy)) {
        console.error(`Invalid strategy "${strategy}". Use round-robin|random|failover.`);
        process.exit(1);
      }
      g.strategy = strategy;
    }
    if (maxRetries !== undefined) g.max_retries = Number(maxRetries);
    if (timeout !== undefined) g.timeout_seconds = Number(timeout);
    if (cooldown !== undefined) g.cooldown_seconds = Number(cooldown);
    if (!strategy && maxRetries === undefined && timeout === undefined && cooldown === undefined) {
      console.error("Nothing to edit. Provide --strategy, --max-retries, --timeout, or --cooldown.");
      process.exit(1);
    }
    saveConfig(cfg);
    console.log(`Updated [${gname}]:`, JSON.stringify({ strategy: g.strategy, max_retries: g.max_retries, timeout_seconds: g.timeout_seconds, cooldown_seconds: g.cooldown_seconds }));
    break;
  }

  case "set-agent": {
    const [agent, chain] = args;
    if (!agent || !chain) { console.error("Usage: model-groups set-agent <agent> <group1,group2,...>"); process.exit(1); }
    const cfg = loadConfig();
    cfg.agent_groups = cfg.agent_groups ?? {};
    cfg.agent_groups[agent] = chain.split(",").map((s) => s.trim()).filter(Boolean);
    saveConfig(cfg);
    console.log(`Bound agent "${agent}" -> [${cfg.agent_groups[agent].join(", ")}].`);
    break;
  }

  case "use": {
    const gname = args[0];
    if (!gname) { console.error("Usage: model-groups use <group>   (bind default to a single group, or --append to add to chain)"); process.exit(1); }
    const cfg = loadConfig();
    if (!findGroup(cfg, gname)) { console.error(`Group "${gname}" not found.`); process.exit(1); }
    cfg.agent_groups = cfg.agent_groups ?? {};
    const append = args.includes("--append");
    const current = cfg.agent_groups["*"] ?? [];
    cfg.agent_groups["*"] = append && !current.includes(gname) ? [...current, gname] : [gname];
    saveConfig(cfg);
    console.log(`Default group chain set to: [${cfg.agent_groups["*"].join(", ")}].`);
    console.log("Restart opencode (or new session) for the router to pick it up.");
    break;
  }

  default:
    console.log(`Unknown command: ${cmd}\n`);
    console.log("Usage:");
    console.log("  model-groups ls");
    console.log("  model-groups show <group>");
    console.log("  model-groups add <group> <model> [--priority N] [--weight N]");
    console.log("  model-groups remove <group> <model>");
    console.log("  model-groups rename <group> <new-name>");
    console.log("  model-groups edit <group> --strategy <s> [--max-retries N] [--timeout N] [--cooldown N]");
    console.log("  model-groups set-agent <agent> <group1,group2,...>");
    process.exit(1);
}
