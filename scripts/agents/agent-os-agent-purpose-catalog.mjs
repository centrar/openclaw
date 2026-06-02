#!/usr/bin/env node
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSON5 from "json5";
import YAML from "yaml";
import { buildAgentManagementPlan } from "./agent-os-agent-manager.mjs";
import { CAPABILITY_AGENT_PROFILES } from "./capability-agent-profile.mjs";

export const AGENT_OS_AGENT_PURPOSE_CATALOG_SCHEMA_VERSION = "agent-os.agent-purpose-catalog.v1";

const DEFAULT_OUTPUT_PATH = path.join(".artifacts", "agent-os-agent-purpose-catalog.json");
const SKILL_SOURCE_ROOTS = ["skills", path.join(".agents", "skills")];
const PURPOSE_METADATA_FILES = [
  "IDENTITY.md",
  "README.md",
  "SKILL.md",
  "AGENTS.md",
  "BOOTSTRAP.md",
  "SOUL.md",
];
const MAX_PURPOSE_METADATA_BYTES = 12_000;

function nowIso() {
  return new Date().toISOString();
}

function normalizePath(value) {
  if (!value || typeof value !== "string") {
    return null;
  }
  return path.resolve(value);
}

function normalizeString(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const normalized = String(value).trim();
  return normalized || null;
}

function normalizeId(value) {
  const text = normalizeString(value);
  if (!text) {
    return null;
  }
  return text
    .replace(/[^A-Za-z0-9_.:-]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .toLowerCase();
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

function pathExists(filePath) {
  try {
    return Boolean(filePath) && existsSync(filePath);
  } catch {
    return false;
  }
}

function ensureParentDir(filePath) {
  const parent = path.dirname(filePath);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
}

function writeJson(filePath, value) {
  const resolved = path.resolve(filePath);
  ensureParentDir(resolved);
  writeFileSync(resolved, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  return resolved;
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

function readTextPrefix(filePath, maxBytes) {
  if (!pathExists(filePath)) {
    return "";
  }
  if (!Number.isFinite(maxBytes)) {
    return readFileSync(filePath, "utf8").replace(/^\uFEFF/u, "");
  }
  const fd = openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const bytesRead = readSync(fd, buffer, 0, maxBytes, 0);
    return buffer
      .subarray(0, bytesRead)
      .toString("utf8")
      .replace(/^\uFEFF/u, "");
  } finally {
    closeSync(fd);
  }
}

function parseMarkdown(filePath, options = {}) {
  const text = readTextPrefix(filePath, options.maxBytes || Number.POSITIVE_INFINITY);
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/u.exec(text);
  if (!match) {
    return { body: text, frontmatter: {} };
  }
  let frontmatter = {};
  try {
    frontmatter = YAML.parse(match[1]) || {};
  } catch {
    frontmatter = {};
  }
  return { body: text.slice(match[0].length), frontmatter };
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
      walkFiles(entryPath, predicate, output);
      continue;
    }
    if (entry.isFile() && predicate(entryPath, entry.name)) {
      output.push(entryPath);
    }
  }
  return output;
}

function firstLine(value) {
  const text = normalizeString(value);
  if (!text) {
    return null;
  }
  return (
    text
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line.length > 0) || null
  );
}

function extractMarkdownPurpose(body) {
  const lines = body.split(/\r?\n/u);
  const bullets = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^[-*]\s+\S/u.test(trimmed)) {
      bullets.push(trimmed.replace(/^[-*]\s+/u, ""));
    }
    if (bullets.length >= 3) {
      break;
    }
  }
  if (bullets.length > 0) {
    return bullets.join(" ");
  }
  return firstLine(
    lines.find((line) => {
      const trimmed = line.trim();
      return trimmed.length > 0 && !trimmed.startsWith("#");
    }),
  );
}

function extractMarkdownTitle(body) {
  const match = /^#\s+(.+)$/mu.exec(body);
  return normalizeString(match?.[1]);
}

function addSource(map, id, source) {
  const normalized = normalizeId(id);
  if (!normalized) {
    return;
  }
  const list = map.get(normalized) || [];
  list.push(source);
  map.set(normalized, list);
}

function sourceRecord(fields) {
  return {
    defaultPrompt: normalizeString(fields.defaultPrompt),
    displayName: normalizeString(fields.displayName),
    explicit: fields.explicit !== false,
    sourcePath: fields.sourcePath ? path.resolve(fields.sourcePath) : null,
    sourceType: fields.sourceType,
    summary: normalizeString(fields.summary),
    taskHints: normalizeStringList(fields.taskHints),
  };
}

function sourceFromMarkdown(filePath, sourceType, options = {}) {
  const { body, frontmatter } = parseMarkdown(filePath, {
    maxBytes: options.maxBytes || Number.POSITIVE_INFINITY,
  });
  const record = sourceRecord({
    defaultPrompt: frontmatter.default_prompt || frontmatter.prompt,
    displayName:
      frontmatter.name ||
      frontmatter.displayName ||
      frontmatter.display_name ||
      (options.preferDisplayName ? options.displayName : extractMarkdownTitle(body)) ||
      options.displayName,
    sourcePath: filePath,
    sourceType,
    summary:
      frontmatter.description ||
      frontmatter.summary ||
      frontmatter.short_description ||
      extractMarkdownPurpose(body),
    taskHints: [
      ...(options.taskHints || []),
      frontmatter.name,
      frontmatter.description,
      frontmatter.summary,
      frontmatter.short_description,
    ],
  });
  if (
    !record.defaultPrompt &&
    !record.displayName &&
    !record.summary &&
    record.taskHints.length === 0
  ) {
    return null;
  }
  return record;
}

function collectSkillSources(repoRoot, openclawHome) {
  const bySkill = new Map();
  const roots = [
    ...SKILL_SOURCE_ROOTS.map((relative) => path.join(repoRoot, relative)),
    path.join(openclawHome, "skills"),
    path.join(openclawHome, "plugin-skills"),
  ];
  for (const root of roots) {
    for (const skill of listDirectories(root)) {
      const skillDir = path.join(root, skill);
      const sourceFiles = [
        { fileName: "SKILL.md", sourceType: "skill-frontmatter" },
        { fileName: "README.md", sourceType: "skill-readme" },
      ];
      for (const sourceFile of sourceFiles) {
        const skillPath = path.join(skillDir, sourceFile.fileName);
        if (!pathExists(skillPath)) {
          continue;
        }
        const record = sourceFromMarkdown(skillPath, sourceFile.sourceType, {
          displayName: skill,
          taskHints: [skill],
        });
        if (record) {
          addSource(bySkill, skill, record);
        }
      }
    }
  }
  return bySkill;
}

function agentDefinitionId(entry, skill, filePath) {
  if (entry && typeof entry === "object") {
    return (
      entry.id ||
      entry.name ||
      entry.interface?.id ||
      `${skill}:${path.basename(filePath, path.extname(filePath))}`
    );
  }
  return `${skill}:${path.basename(filePath, path.extname(filePath))}`;
}

function sourceFromAgentDefinition(entry, body, filePath, skill) {
  const iface = entry?.interface && typeof entry.interface === "object" ? entry.interface : {};
  return sourceRecord({
    defaultPrompt: iface.default_prompt || entry?.default_prompt || entry?.prompt,
    displayName: iface.display_name || entry?.displayName || entry?.display_name || entry?.name,
    sourcePath: filePath,
    sourceType: "skill-agent-definition",
    summary:
      iface.short_description ||
      entry?.description ||
      entry?.short_description ||
      entry?.summary ||
      extractMarkdownPurpose(body),
    taskHints: [
      skill,
      iface.default_prompt,
      iface.short_description,
      entry?.description,
      entry?.name,
    ],
  });
}

function collectSkillAgentSources(repoRoot) {
  const byAgentId = new Map();
  const roots = SKILL_SOURCE_ROOTS.map((relative) => path.join(repoRoot, relative));
  for (const root of roots) {
    const files = walkFiles(root, (filePath, fileName) => {
      if (!/\.(json|md|ya?ml)$/iu.test(fileName)) {
        return false;
      }
      return filePath.split(path.sep).includes("agents");
    });
    for (const filePath of files) {
      const parts = path.relative(root, filePath).split(path.sep);
      const skill = parts[0] || null;
      let parsed = null;
      let body = "";
      try {
        if (/\.json$/iu.test(filePath)) {
          parsed = readJsonLike(filePath);
        } else if (/\.md$/iu.test(filePath)) {
          const markdown = parseMarkdown(filePath);
          parsed = markdown.frontmatter;
          body = markdown.body;
        } else {
          parsed = readYamlLike(filePath);
        }
      } catch {
        parsed = null;
      }
      const entries = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [{}];
      for (const entry of entries) {
        const id = agentDefinitionId(entry, skill, filePath);
        addSource(byAgentId, id, sourceFromAgentDefinition(entry, body, filePath, skill));
      }
    }
  }
  return byAgentId;
}

function collectCapabilityProfileSources() {
  const byAgentId = new Map();
  for (const profile of CAPABILITY_AGENT_PROFILES) {
    addSource(
      byAgentId,
      profile.id,
      sourceRecord({
        defaultPrompt: profile.description,
        displayName: profile.name,
        sourcePath: path.join(
          path.dirname(fileURLToPath(import.meta.url)),
          "capability-agent-profile.mjs",
        ),
        sourceType: "capability-profile",
        summary: profile.description,
        taskHints: [
          profile.params?.capabilityFamily,
          ...(profile.params?.ticketTypes || []),
          ...(profile.skills || []),
        ],
      }),
    );
  }
  return byAgentId;
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

function collectConfigSources(openclawHome) {
  const byAgentId = new Map();
  const configPath = path.join(openclawHome, "openclaw.json");
  const config = readJsonLike(configPath);
  const list = Array.isArray(config?.agents?.list) ? config.agents.list : [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const capability = capabilityFields(entry);
    addSource(
      byAgentId,
      entry.id,
      sourceRecord({
        displayName: entry.name || entry.id,
        sourcePath: configPath,
        sourceType: "openclaw-config",
        summary:
          entry.description ||
          entry.params?.description ||
          `Configured OpenClaw agent${entry.name ? ` named ${entry.name}` : ""}.`,
        taskHints: [
          ...normalizeStringList(capability.capabilityFamilies),
          ...normalizeStringList(capability.ticketTypes),
        ],
      }),
    );
  }
  return byAgentId;
}

function collectRegistrySources(openclawHome) {
  const byAgentId = new Map();
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
    addSource(
      byAgentId,
      entry.id || entry.name,
      sourceRecord({
        displayName: entry.name || entry.id,
        sourcePath: registryPath,
        sourceType: "agents-registry",
        summary: entry.description || `Registry ${entry.type || "agent"} entry.`,
        taskHints: [entry.type, entry.status],
      }),
    );
  }
  return byAgentId;
}

function collectPathMetadataSources(plan) {
  const byAgentId = new Map();
  for (const agent of plan.agents) {
    for (const ref of agent.pathRefs || []) {
      if (!ref.exists || !ref.path) {
        continue;
      }
      for (const fileName of PURPOSE_METADATA_FILES) {
        const metadataPath = path.join(ref.path, fileName);
        if (!pathExists(metadataPath)) {
          continue;
        }
        const record = sourceFromMarkdown(metadataPath, "path-metadata", {
          displayName: agent.displayName || agent.id,
          maxBytes: MAX_PURPOSE_METADATA_BYTES,
          preferDisplayName: true,
          taskHints: [agent.id, agent.route, ref.kind, fileName],
        });
        if (record) {
          addSource(byAgentId, agent.id, record);
        }
      }
    }
  }
  return byAgentId;
}

function mergeMaps(...maps) {
  const output = new Map();
  for (const map of maps) {
    for (const [key, value] of map.entries()) {
      output.set(key, [...(output.get(key) || []), ...value]);
    }
  }
  return output;
}

const TASK_FAMILY_RULES = [
  {
    artifacts: ["security-triage-summary", "redacted-evidence", "proof-event"],
    family: "security",
    keywords: ["security", "secret", "ghsa", "advisory", "sentinel", "bouncer", "guardian"],
    taskType: "security_triage_probe",
  },
  {
    artifacts: ["github-state-summary", "source-refs", "proof-event"],
    family: "github",
    keywords: ["github", "issue", "pull request", "pr ", "release", "changelog"],
    taskType: "github_repo_audit_probe",
  },
  {
    artifacts: ["test-plan", "command-proof", "proof-event"],
    family: "testing",
    keywords: ["test", "qa", "ci", "e2e", "docker", "crabbox", "testbox", "parallels"],
    taskType: "test_validation_probe",
  },
  {
    artifacts: ["archive-query-summary", "freshness-proof", "proof-event"],
    family: "archive-search",
    keywords: ["crawl", "archive", "discord", "slack", "notion", "granola", "search"],
    taskType: "archive_search_probe",
  },
  {
    artifacts: ["browser-workflow-summary", "visual-proof-ref", "proof-event"],
    family: "browser-ops",
    keywords: ["browser", "web", "ui", "visual", "canvas"],
    taskType: "browser_workflow_probe",
  },
  {
    artifacts: ["documentation-coverage-map", "missing-path-list", "proof-event"],
    family: "documentation",
    keywords: ["docs", "documentation", "synthesis", "inventory", "governance"],
    taskType: "documentation_audit_probe",
  },
  {
    artifacts: ["channel-flow-summary", "message-proof", "proof-event"],
    family: "channel-ops",
    keywords: ["telegram", "discord", "slack", "imessage", "message", "channel"],
    taskType: "channel_flow_probe",
  },
  {
    artifacts: ["coding-task-summary", "diff-or-plan", "proof-event"],
    family: "coding",
    keywords: ["code", "coding", "developer", "debug", "refactor", "bugfix"],
    taskType: "coding_workflow_probe",
  },
  {
    artifacts: ["business-workflow-summary", "bounded-output", "proof-event"],
    family: "business-workflow",
    keywords: ["business", "workday", "order", "trello", "calendar", "todo"],
    taskType: "business_workflow_probe",
  },
];

function keywordMatches(text, tokens, keyword) {
  const normalized = keyword.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (normalized.includes(" ")) {
    return text.includes(normalized);
  }
  if (normalized.length <= 3) {
    return tokens.includes(normalized);
  }
  return text.includes(normalized);
}

function classifyTask(agent, evidence) {
  const text = [
    agent.id,
    agent.displayName,
    agent.route,
    ...(agent.skills || []),
    ...(agent.capabilityFamilies || []),
    ...(agent.ticketTypes || []),
    ...evidence.flatMap((source) => [
      source.displayName,
      source.summary,
      source.defaultPrompt,
      ...(source.taskHints || []),
    ]),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const tokens = text.split(/[^a-z0-9]+/u).filter(Boolean);
  for (const rule of TASK_FAMILY_RULES) {
    if (rule.keywords.some((keyword) => keywordMatches(text, tokens, keyword))) {
      return rule;
    }
  }
  const taskSlug = (
    normalizeId(
      agent.skills?.[0] || agent.capabilityFamilies?.[0] || agent.ticketTypes?.[0] || agent.id,
    ) || "agent"
  ).replace(/[:.]+/gu, "_");
  return {
    artifacts: [`${taskSlug}-purpose-summary`, "route-output", "proof-event"],
    family: agent.route || "general-agent",
    taskType: `${taskSlug}_purpose_probe`,
  };
}

function permissionsForTask(agent, taskFamily) {
  const network =
    taskFamily === "archive-search" ||
    taskFamily === "browser-ops" ||
    taskFamily === "channel-ops" ||
    taskFamily === "github" ||
    taskFamily === "testing"
      ? "allowlist"
      : "none";
  const secrets =
    taskFamily === "channel-ops" || taskFamily === "testing" || taskFamily === "security"
      ? "named-refs-only"
      : "none";
  return {
    approvals: agent.needsOperatorApproval ? ["operator-approval-for-sensitive-route"] : [],
    filesystem: "read",
    network,
    secrets,
  };
}

function inferSummaryFromId(agent) {
  const label = (agent.displayName || agent.id).replace(/[_:-]+/gu, " ");
  return `Operate the ${label} agent through its ${agent.route} route.`;
}

function purposeForAgent(agent, stores) {
  const directEvidence = stores.byAgentId.get(agent.id) || [];
  const pathMetadataEvidence = directEvidence.filter(
    (source) => source.sourceType === "path-metadata",
  );
  const explicitDirectEvidence = directEvidence.filter(
    (source) => source.sourceType !== "path-metadata",
  );
  const evidence = [
    ...explicitDirectEvidence,
    ...(stores.bySkill.get(agent.id) || []),
    ...agent.skills.flatMap((skill) => stores.bySkill.get(skill) || []),
    ...pathMetadataEvidence,
  ];
  const primary =
    evidence.find((source) => source.summary) ||
    evidence.find((source) => source.displayName) ||
    sourceRecord({
      displayName: agent.displayName || agent.id,
      explicit: false,
      sourcePath: null,
      sourceType: "id-and-route-inference",
      summary: inferSummaryFromId(agent),
      taskHints: [agent.route, agent.id],
    });
  const task = classifyTask(agent, evidence);
  const displayName = primary.displayName || agent.displayName || agent.id;
  const objective =
    primary.defaultPrompt ||
    `Deliver a safe ${task.family} probe for ${displayName}: ${primary.summary}`;
  return {
    agentId: agent.id,
    deliveryTask: {
      expectedArtifacts: task.artifacts,
      objective,
      permissions: permissionsForTask(agent, task.family),
      schemaVersion: "agent-os.agent-delivery-task.v1",
      successCriteria: [
        "accepts an Agent OS ticket",
        "uses the purpose-specific route handler",
        "writes the expected artifact contract",
        "emits a proof event with source evidence",
      ],
      taskFamily: task.family,
      taskType: task.taskType,
    },
    displayName,
    evidenceSources: evidence,
    purposeDefined: evidence.some((source) => source.explicit),
    purposeSummary: primary.summary || inferSummaryFromId(agent),
    purposeSourceType: primary.sourceType,
    route: agent.route,
  };
}

function countBy(items, selector) {
  const counts = {};
  for (const item of items) {
    const key = selector(item) || "unknown";
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function buildAgentPurposeCatalog(options = {}) {
  const repoRoot = normalizePath(options.repoRoot || process.cwd());
  const openclawHome = normalizePath(options.openclawHome || path.join(os.homedir(), ".openclaw"));
  const plan = options.plan || buildAgentManagementPlan({ openclawHome, repoRoot });
  const stores = {
    byAgentId: mergeMaps(
      collectCapabilityProfileSources(),
      collectSkillAgentSources(repoRoot),
      collectConfigSources(openclawHome),
      collectRegistrySources(openclawHome),
      collectPathMetadataSources(plan),
    ),
    bySkill: collectSkillSources(repoRoot, openclawHome),
  };
  const agents = plan.agents.map((agent) => purposeForAgent(agent, stores));
  return {
    agents,
    generatedAt: options.generatedAt || nowIso(),
    managerSchemaVersion: plan.schemaVersion,
    roots: plan.roots,
    schemaVersion: AGENT_OS_AGENT_PURPOSE_CATALOG_SCHEMA_VERSION,
    summary: {
      byPurposeSourceType: countBy(agents, (agent) => agent.purposeSourceType),
      byTaskFamily: countBy(agents, (agent) => agent.deliveryTask.taskFamily),
      byTaskType: countBy(agents, (agent) => agent.deliveryTask.taskType),
      inferredPurpose: agents.filter((agent) => !agent.purposeDefined).length,
      purposeDefined: agents.filter((agent) => agent.purposeDefined).length,
      totalUnique: agents.length,
    },
  };
}

function parseArgs(argv) {
  const args = [...argv];
  const command = args[0] && !args[0].startsWith("--") ? args.shift() : "audit";
  const options = {
    command,
    format: "summary",
    openclawHome: path.join(os.homedir(), ".openclaw"),
    outputPath: DEFAULT_OUTPUT_PATH,
    repoRoot: process.cwd(),
    requirePurpose: false,
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
    } else if (arg === "--require-purpose") {
      options.requirePurpose = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function formatSummary(catalog) {
  const lines = [
    `Agent purpose catalog: ${catalog.summary.totalUnique} unique agents`,
    `Purpose defined from existing sources: ${catalog.summary.purposeDefined}`,
    `Purpose inferred from id/route: ${catalog.summary.inferredPurpose}`,
    "",
    "Task families:",
  ];
  for (const [name, count] of Object.entries(catalog.summary.byTaskFamily)) {
    lines.push(`- ${name}: ${count}`);
  }
  lines.push("", "Purpose sources:");
  for (const [name, count] of Object.entries(catalog.summary.byPurposeSourceType)) {
    lines.push(`- ${name}: ${count}`);
  }
  return `${lines.join("\n")}\n`;
}

export function runAgentPurposeCatalogCli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (!["audit"].includes(options.command)) {
    throw new Error(`Unknown command: ${options.command}`);
  }
  const catalog = buildAgentPurposeCatalog({
    openclawHome: normalizePath(options.openclawHome),
    repoRoot: normalizePath(options.repoRoot),
  });
  if (options.outputPath) {
    writeJson(options.outputPath, catalog);
  }
  if (options.format === "summary") {
    process.stdout.write(formatSummary(catalog));
  } else if (!options.outputPath) {
    process.stdout.write(`${JSON.stringify(catalog, null, 2)}\n`);
  }
  return options.requirePurpose && catalog.summary.inferredPurpose > 0 ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    process.exit(runAgentPurposeCatalogCli());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
