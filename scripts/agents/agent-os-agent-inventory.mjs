#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSON5 from "json5";
import YAML from "yaml";

const require = createRequire(import.meta.url);
const { redactSensitiveValue } = require("../lib/secret-redaction.cjs");

export const AGENT_OS_AGENT_INVENTORY_SCHEMA_VERSION = "agent-os.agent-inventory.v1";

const DEFAULT_OUTPUT_PATH = path.join(".artifacts", "agent-os-agent-inventory.json");
const SKIPPED_SCAN_DIRS = new Set([
  ".git",
  ".tmp",
  "browser_profiles",
  "dist",
  "dist-runtime",
  "logs",
  "memory",
  "node_modules",
  "output",
  "sessions",
]);

function normalizePath(value) {
  if (!value || typeof value !== "string") {
    return null;
  }
  return path.resolve(value);
}

function normalizeId(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const normalized = String(value)
    .trim()
    .replace(/[^A-Za-z0-9_.:-]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .toLowerCase();
  return normalized || null;
}

function normalizeString(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const normalized = String(value).trim();
  return normalized || null;
}

function normalizeStringList(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeString(entry)).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(/[,\n]+/u)
      .map((entry) => normalizeString(entry))
      .filter(Boolean);
  }
  return [];
}

function pathExists(value) {
  if (!value) {
    return false;
  }
  try {
    return existsSync(value);
  } catch {
    return false;
  }
}

function readJsonLike(filePath) {
  if (!pathExists(filePath)) {
    return null;
  }
  return JSON5.parse(readFileSync(filePath, "utf8").replace(/^\uFEFF/u, ""));
}

function readYamlLike(filePath) {
  if (!pathExists(filePath)) {
    return null;
  }
  return YAML.parse(readFileSync(filePath, "utf8").replace(/^\uFEFF/u, ""));
}

function readMarkdownAgentLike(filePath) {
  if (!pathExists(filePath)) {
    return null;
  }
  const text = readFileSync(filePath, "utf8").replace(/^\uFEFF/u, "");
  if (!text.startsWith("---")) {
    return null;
  }
  const endIndex = text.indexOf("\n---", 3);
  if (endIndex < 0) {
    return null;
  }
  return YAML.parse(text.slice(3, endIndex));
}

function listDirectories(dirPath) {
  try {
    return readdirSync(dirPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function walkFiles(dirPath, predicate, output = []) {
  let entries = [];
  try {
    entries = readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return output;
  }
  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_SCAN_DIRS.has(entry.name)) {
        walkFiles(entryPath, predicate, output);
      }
      continue;
    }
    if (entry.isFile() && predicate(entryPath, entry.name)) {
      output.push(entryPath);
    }
  }
  return output;
}

function relativePath(filePath, rootPath) {
  return path.relative(rootPath, filePath).replace(/\\/gu, "/");
}

function createInventoryRow(id) {
  return {
    id,
    displayName: null,
    kinds: new Set(),
    pathRefs: new Map(),
    registered: false,
    sources: new Set(),
    status: null,
    capabilityFamilies: new Set(),
    ticketTypes: new Set(),
    skills: new Set(),
    warnings: new Set(),
  };
}

function addPathRef(row, kind, filePath) {
  if (!filePath) {
    return;
  }
  const resolved = normalizePath(filePath);
  if (!resolved) {
    return;
  }
  const key = `${kind}:${resolved}`;
  if (!row.pathRefs.has(key)) {
    row.pathRefs.set(key, { exists: pathExists(resolved), kind, path: resolved });
  }
}

function addAgent(rows, idValue, source, updates = {}) {
  const id = normalizeId(idValue);
  if (!id) {
    return null;
  }
  const row = rows.get(id) ?? createInventoryRow(id);
  rows.set(id, row);
  row.sources.add(source);
  if (updates.displayName && !row.displayName) {
    row.displayName = normalizeString(updates.displayName);
  }
  if (updates.kind) {
    row.kinds.add(updates.kind);
  }
  if (updates.status && !row.status) {
    row.status = normalizeString(updates.status);
  }
  if (updates.registered) {
    row.registered = true;
  }
  for (const skill of normalizeStringList(updates.skills)) {
    row.skills.add(skill);
  }
  for (const family of normalizeStringList(updates.capabilityFamilies)) {
    row.capabilityFamilies.add(family);
  }
  for (const ticketType of normalizeStringList(updates.ticketTypes)) {
    row.ticketTypes.add(ticketType);
  }
  for (const warning of normalizeStringList(updates.warnings)) {
    row.warnings.add(warning);
  }
  if (updates.path) {
    addPathRef(row, updates.pathKind || "source", updates.path);
  }
  if (updates.agentDir) {
    addPathRef(row, "agent-dir", updates.agentDir);
  }
  if (updates.workspace) {
    addPathRef(row, "workspace", updates.workspace);
  }
  if (updates.file) {
    addPathRef(row, "definition-file", updates.file);
  }
  return row;
}

function capabilityFields(agentEntry) {
  const params =
    agentEntry?.params && typeof agentEntry.params === "object" ? agentEntry.params : {};
  const capability = params.agentOsCapability || {};
  return {
    capabilityFamilies:
      capability.capabilityFamilies || params.capabilityFamilies || params.capabilityFamily,
    ticketTypes: capability.ticketTypes || params.ticketTypes,
  };
}

function collectConfigAgents(rows, openclawHome) {
  const configPath = path.join(openclawHome, "openclaw.json");
  const config = readJsonLike(configPath);
  const list = Array.isArray(config?.agents?.list) ? config.agents.list : [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const capability = capabilityFields(entry);
    const row = addAgent(rows, entry.id, "user-openclaw-json", {
      agentDir: entry.agentDir,
      capabilityFamilies: capability.capabilityFamilies,
      displayName: entry.name,
      kind:
        entry.params?.agentOsCapability || entry.params?.capabilityAgent
          ? "capability-agent"
          : "openclaw-agent",
      registered: true,
      skills: entry.skills,
      ticketTypes: capability.ticketTypes,
      workspace: entry.workspace,
    });
    if (row && entry.default === true) {
      row.kinds.add("default-agent");
    }
  }
}

function collectRegistryAgents(rows, openclawHome) {
  const registryPath = path.join(openclawHome, "agents_registry.json");
  const registry = readJsonLike(registryPath);
  const agents = Array.isArray(registry?.agents)
    ? registry.agents
    : Array.isArray(registry)
      ? registry
      : [];
  for (const entry of agents) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const id = entry.id || entry.name;
    const type = normalizeId(entry.type || "registry-entry");
    const kind =
      type === "python_tool"
        ? "tool-adapter"
        : type === "skill"
          ? "skill-adapter"
          : type === "business_agent"
            ? "business-agent"
            : "registry-agent";
    const row = addAgent(rows, id, "user-agents-registry", {
      displayName: entry.name,
      kind,
      path: entry.path,
      pathKind: kind,
      skills: entry.skills,
      status: entry.status,
    });
    if (row && entry.path && !pathExists(entry.path)) {
      row.warnings.add("registry path missing");
    }
  }
}

function collectHomeAgentDirs(rows, openclawHome) {
  const agentRoot = path.join(openclawHome, "agents");
  for (const dirName of listDirectories(agentRoot)) {
    addAgent(rows, dirName, "user-agent-dir", {
      agentDir: path.join(agentRoot, dirName),
      kind: "filesystem-agent",
    });
  }

  const subagentRoot = path.join(openclawHome, "subagents");
  for (const dirName of listDirectories(subagentRoot)) {
    addAgent(rows, dirName, "user-subagent-dir", {
      agentDir: path.join(subagentRoot, dirName),
      kind: "filesystem-subagent",
    });
  }
}

function collectSkillDirs(rows, repoRoot, openclawHome) {
  const roots = [
    { path: path.join(repoRoot, ".agents", "skills"), source: "repo-agent-skill-dir" },
    { path: path.join(repoRoot, "skills"), source: "repo-skill-dir" },
    { path: path.join(openclawHome, "skills"), source: "user-skill-dir" },
    { path: path.join(openclawHome, "plugin-skills"), source: "user-plugin-skill-dir" },
  ];
  for (const root of roots) {
    for (const dirName of listDirectories(root.path)) {
      if (!pathExists(path.join(root.path, dirName, "SKILL.md"))) {
        continue;
      }
      addAgent(rows, dirName, root.source, {
        kind: "skill-adapter",
        path: path.join(root.path, dirName),
        pathKind: "skill-adapter",
      });
    }
  }
}

function collectWorkspaceDirs(rows, openclawHome) {
  for (const dirName of listDirectories(openclawHome)) {
    if (!dirName.startsWith("workspace_")) {
      continue;
    }
    addAgent(rows, dirName.replace(/^workspace_/u, ""), "user-workspace-dir", {
      kind: "workspace",
      workspace: path.join(openclawHome, dirName),
    });
  }
}

function collectSkillAgentFiles(rows, repoRoot) {
  const skillRoot = path.join(repoRoot, ".agents", "skills");
  const files = walkFiles(skillRoot, (filePath, fileName) => {
    if (!/\.(json|md|ya?ml)$/iu.test(fileName)) {
      return false;
    }
    return filePath.split(path.sep).includes("agents");
  });
  for (const filePath of files) {
    const relative = relativePath(filePath, repoRoot);
    const skill = relative.split("/")[2] || null;
    let parsed = null;
    try {
      parsed = /\.json$/iu.test(filePath)
        ? readJsonLike(filePath)
        : /\.md$/iu.test(filePath)
          ? readMarkdownAgentLike(filePath)
          : readYamlLike(filePath);
    } catch {
      parsed = null;
    }
    const parsedList = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
    const entries =
      parsedList.length > 0
        ? parsedList
        : [{ id: `${skill}:${path.basename(filePath, path.extname(filePath))}` }];
    for (const entry of entries) {
      const id =
        entry && typeof entry === "object"
          ? entry.id || entry.name || `${skill}:${path.basename(filePath, path.extname(filePath))}`
          : `${skill}:${path.basename(filePath, path.extname(filePath))}`;
      addAgent(rows, id, "repo-skill-agent-file", {
        displayName:
          entry && typeof entry === "object"
            ? entry.displayName || entry.display_name || entry.name || entry.interface?.display_name
            : null,
        file: filePath,
        kind: "skill-owned-agent",
        skills: skill ? [skill] : [],
      });
    }
  }
}

function collectCapabilityProfileAgents(rows, repoRoot) {
  const profilePath = path.join(repoRoot, "scripts", "agents", "capability-agent-profile.mjs");
  if (!pathExists(profilePath)) {
    return;
  }
  const text = readFileSync(profilePath, "utf8");
  for (const match of text.matchAll(/id:\s*["']([A-Za-z0-9_.:-]+)["']/gu)) {
    if (!match[1].endsWith("_agent")) {
      continue;
    }
    addAgent(rows, match[1], "capability-profile-script", {
      file: profilePath,
      kind: "capability-profile",
    });
  }
}

function collectNativeBridgeAgents(rows, repoRoot) {
  const candidates = [
    path.join(repoRoot, ".agents", "skills", "swarm-signal", "scripts", "signal_hub.cjs"),
    path.join(repoRoot, ".agents", "skills", "swarm-signal", "scripts", "windows_node.cjs"),
    path.join(repoRoot, "scripts", "docker", "sidecars", "signal-hub.cjs"),
    path.join(repoRoot, "scripts", "docker", "sidecars", "windows-node.cjs"),
  ];
  for (const filePath of candidates) {
    if (!pathExists(filePath)) {
      continue;
    }
    const text = readFileSync(filePath, "utf8");
    for (const setMatch of text.matchAll(/NATIVE_AGENTS\s*=\s*new Set\(\[([^\]]*)\]/gu)) {
      for (const idMatch of setMatch[1].matchAll(/["']([^"']+)["']/gu)) {
        addAgent(rows, idMatch[1], "native-bridge-hardcode", {
          file: filePath,
          kind: "host-native-agent",
        });
      }
    }
  }
}

function inferManageability(row) {
  const pathRefs = [...row.pathRefs.values()];
  const hasMissingPath = pathRefs.some((ref) => !ref.exists);
  const hasConcretePath = pathRefs.some((ref) => ref.exists);
  if (row.registered) {
    return hasMissingPath ? "registered-with-warnings" : "registered";
  }
  if (row.status === "dormant") {
    return hasMissingPath ? "dormant-stale" : "dormant";
  }
  if (row.kinds.has("tool-adapter") || row.kinds.has("skill-adapter")) {
    return hasMissingPath ? "adapter-stale" : "adapter-manageable";
  }
  if (hasConcretePath) {
    return "discoverable-not-registered";
  }
  return "referenced-only";
}

function finalizeRows(rows) {
  return [...rows.values()]
    .map((row) => {
      const pathRefs = [...row.pathRefs.values()].sort((left, right) =>
        `${left.kind}:${left.path}`.localeCompare(`${right.kind}:${right.path}`),
      );
      if (pathRefs.some((ref) => !ref.exists)) {
        row.warnings.add("path reference missing");
      }
      const finalized = {
        capabilityFamilies: [...row.capabilityFamilies].sort(),
        displayName: row.displayName,
        id: row.id,
        kinds: [...row.kinds].sort(),
        manageability: inferManageability(row),
        pathRefs,
        registered: row.registered,
        skills: [...row.skills].sort(),
        sources: [...row.sources].sort(),
        status: row.status,
        ticketTypes: [...row.ticketTypes].sort(),
        warnings: [...row.warnings].sort(),
      };
      if (finalized.warnings.length === 0) {
        delete finalized.warnings;
      }
      return finalized;
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

function summarizeRows(agents) {
  const countBy = (field) => {
    const counts = {};
    for (const agent of agents) {
      const values = Array.isArray(agent[field]) ? agent[field] : [agent[field]];
      for (const value of values.filter(Boolean)) {
        counts[value] = (counts[value] || 0) + 1;
      }
    }
    return Object.fromEntries(
      Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
    );
  };
  return {
    byKind: countBy("kinds"),
    byManageability: countBy("manageability"),
    bySource: countBy("sources"),
    pathWarnings: agents.filter((agent) => agent.pathRefs.some((ref) => !ref.exists)).length,
    registered: agents.filter((agent) => agent.registered).length,
    totalUnique: agents.length,
  };
}

export function collectAgentInventory(options = {}) {
  const repoRoot = normalizePath(options.repoRoot || process.cwd());
  const openclawHome = normalizePath(options.openclawHome || path.join(os.homedir(), ".openclaw"));
  const rows = new Map();
  collectConfigAgents(rows, openclawHome);
  collectRegistryAgents(rows, openclawHome);
  collectHomeAgentDirs(rows, openclawHome);
  collectSkillDirs(rows, repoRoot, openclawHome);
  collectWorkspaceDirs(rows, openclawHome);
  collectSkillAgentFiles(rows, repoRoot);
  collectCapabilityProfileAgents(rows, repoRoot);
  collectNativeBridgeAgents(rows, repoRoot);

  const agents = finalizeRows(rows);
  return {
    agents,
    generatedAt: new Date().toISOString(),
    roots: {
      openclawHome,
      repoRoot,
    },
    schemaVersion: AGENT_OS_AGENT_INVENTORY_SCHEMA_VERSION,
    summary: summarizeRows(agents),
  };
}

function parseArgs(argv) {
  const args = [...argv];
  const command = args[0] && !args[0].startsWith("--") ? args.shift() : "scan";
  const options = {
    command,
    format: "json",
    openclawHome: path.join(os.homedir(), ".openclaw"),
    outputPath: null,
    repoRoot: process.cwd(),
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--repo") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--repo requires a path");
      }
      options.repoRoot = value;
      index += 1;
    } else if (arg === "--openclaw-home") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--openclaw-home requires a path");
      }
      options.openclawHome = value;
      index += 1;
    } else if (arg === "--output") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--output requires a path");
      }
      options.outputPath = value;
      index += 1;
    } else if (arg === "--format") {
      const value = args[index + 1];
      if (!value || !["json", "summary"].includes(value)) {
        throw new Error("--format must be json or summary");
      }
      options.format = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function formatSummary(inventory) {
  const lines = [
    `Agent inventory: ${inventory.summary.totalUnique} unique IDs`,
    `Registered: ${inventory.summary.registered}`,
    `Path warnings: ${inventory.summary.pathWarnings}`,
    "",
    "Manageability:",
  ];
  for (const [name, count] of Object.entries(inventory.summary.byManageability)) {
    lines.push(`- ${name}: ${count}`);
  }
  lines.push("", "Kinds:");
  for (const [name, count] of Object.entries(inventory.summary.byKind)) {
    lines.push(`- ${name}: ${count}`);
  }
  return `${lines.join("\n")}\n`;
}

export function runAgentInventoryCli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (!["scan", "summary"].includes(options.command)) {
    throw new Error(`Unknown command: ${options.command}`);
  }
  const inventory = collectAgentInventory({
    openclawHome: options.openclawHome,
    repoRoot: options.repoRoot,
  });
  const output =
    options.command === "summary" || options.format === "summary"
      ? formatSummary(inventory)
      : `${JSON.stringify(redactSensitiveValue(inventory), null, 2)}\n`;
  if (options.outputPath) {
    const resolvedOutput = path.resolve(options.outputPath || DEFAULT_OUTPUT_PATH);
    const parent = path.dirname(resolvedOutput);
    if (!pathExists(parent)) {
      mkdirSync(parent, { recursive: true });
    }
    writeFileSync(resolvedOutput, output, { mode: 0o600 });
  } else {
    process.stdout.write(output);
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    process.exit(runAgentInventoryCli());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
