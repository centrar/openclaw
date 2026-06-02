#!/usr/bin/env node
import crypto from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectAgentInventory } from "./agent-os-agent-inventory.mjs";

const require = createRequire(import.meta.url);
const {
  assertAgentOsArtifactContract,
  assertAgentOsProofEvent,
  assertAgentOsTicket,
} = require("../lib/agent-os-contracts.cjs");

export const AGENT_OS_AGENT_MANAGER_SCHEMA_VERSION = "agent-os.agent-manager.v1";
export const AGENT_OS_AGENT_MANAGER_SMOKE_SCHEMA_VERSION = "agent-os.agent-manager-smoke.v1";

const DEFAULT_PLAN_OUTPUT_PATH = path.join(".artifacts", "agent-os-agent-manager-plan.json");
const DEFAULT_CATALOG_OUTPUT_PATH = path.join(".artifacts", "agent-os-managed-agents.json");
const DEFAULT_SMOKE_OUTPUT_PATH = path.join(".artifacts", "agent-os-agent-manager-smoke.json");

const DECISIONS_BY_MANAGEABILITY = Object.freeze({
  "adapter-manageable": {
    action: "manage-through-adapter",
    controlPlaneManaged: true,
    managerState: "managed",
    nextStep: "Route through the matching skill or tool adapter.",
  },
  "adapter-stale": {
    action: "manage-through-quarantine-supervisor",
    controlPlaneManaged: true,
    managerState: "managed-with-warnings",
    nextStep: "Route through the quarantine supervisor and repair the stale adapter path.",
  },
  "discoverable-not-registered": {
    action: "manage-through-supervisor",
    controlPlaneManaged: true,
    managerState: "managed",
    nextStep: "Route through the supervised import adapter before native registration.",
  },
  dormant: {
    action: "reactivate-through-supervisor",
    controlPlaneManaged: true,
    managerState: "managed",
    nextStep: "Route through the dormant-agent supervisor for activation proof.",
  },
  "dormant-stale": {
    action: "manage-through-quarantine-supervisor",
    controlPlaneManaged: true,
    managerState: "managed-with-warnings",
    nextStep: "Route through the quarantine supervisor and repair the stale dormant reference.",
  },
  referenced: {
    action: "manage-through-quarantine-supervisor",
    controlPlaneManaged: true,
    managerState: "managed-with-warnings",
    nextStep: "Route through the quarantine supervisor and add a concrete manifest.",
  },
  registered: {
    action: "keep-registered",
    controlPlaneManaged: true,
    managerState: "managed",
    nextStep: "Run live ticket proof through the dispatcher for delivery claims.",
  },
  "registered-with-warnings": {
    action: "repair-registered-paths",
    controlPlaneManaged: true,
    managerState: "managed-with-warnings",
    nextStep: "Repair missing paths before claiming clean live delivery.",
  },
  "referenced-only": {
    action: "manage-through-quarantine-supervisor",
    controlPlaneManaged: true,
    managerState: "managed-with-warnings",
    nextStep: "Route through the quarantine supervisor and add a concrete manifest.",
  },
});

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

function stableHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
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

function pathWarningCount(agent) {
  return agent.pathRefs.filter((ref) => !ref.exists).length;
}

function routeForAgent(agent) {
  const kinds = new Set(agent.kinds);
  if (agent.registered) {
    return "openclaw-config";
  }
  if (kinds.has("tool-adapter")) {
    return "tool-adapter";
  }
  if (kinds.has("skill-adapter")) {
    return "skill-adapter";
  }
  if (kinds.has("skill-owned-agent")) {
    return "skill-owned-agent-adapter";
  }
  if (kinds.has("host-native-agent")) {
    return "native-bridge-supervisor";
  }
  if (kinds.has("capability-profile")) {
    return "capability-profile-adapter";
  }
  if (kinds.has("business-agent")) {
    return "business-agent-supervisor";
  }
  if (kinds.has("workspace")) {
    return "workspace-agent-adapter";
  }
  if (kinds.has("filesystem-agent") || kinds.has("filesystem-subagent")) {
    return "filesystem-agent-adapter";
  }
  return "quarantine-supervisor";
}

function decisionForAgent(agent) {
  const base =
    DECISIONS_BY_MANAGEABILITY[agent.manageability] ||
    DECISIONS_BY_MANAGEABILITY["referenced-only"];
  const missingPaths = pathWarningCount(agent);
  const route = routeForAgent(agent);
  const needsOperatorApproval =
    agent.kinds.includes("host-native-agent") ||
    route === "native-bridge-supervisor" ||
    base.managerState === "managed-with-warnings";
  return {
    ...base,
    liveDeliveryProven: false,
    missingPaths,
    needsOperatorApproval,
    route,
  };
}

function planEntryForAgent(agent) {
  const decision = decisionForAgent(agent);
  return {
    action: decision.action,
    capabilityFamilies: agent.capabilityFamilies,
    controlPlaneManaged: decision.controlPlaneManaged,
    id: agent.id,
    kinds: agent.kinds,
    liveDeliveryProven: decision.liveDeliveryProven,
    manageability: agent.manageability,
    managerState: decision.managerState,
    missingPaths: decision.missingPaths,
    needsOperatorApproval: decision.needsOperatorApproval,
    nextStep: decision.nextStep,
    pathRefs: agent.pathRefs,
    registered: agent.registered,
    route: decision.route,
    skills: agent.skills,
    sources: agent.sources,
    status: agent.status,
    ticketTypes: agent.ticketTypes,
    warnings: agent.warnings || [],
  };
}

function summarizePlan(agents) {
  return {
    blocked: agents.filter((agent) => agent.managerState === "blocked").length,
    byAction: countBy(agents, (agent) => agent.action),
    byManagerState: countBy(agents, (agent) => agent.managerState),
    byRoute: countBy(agents, (agent) => agent.route),
    candidates: agents.filter((agent) => agent.managerState === "candidate").length,
    controlPlaneManaged: agents.filter((agent) => agent.controlPlaneManaged).length,
    dormant: agents.filter((agent) => agent.managerState === "dormant").length,
    liveDeliveryProven: agents.filter((agent) => agent.liveDeliveryProven).length,
    pathWarnings: agents.filter((agent) => agent.missingPaths > 0).length,
    totalUnique: agents.length,
  };
}

export function buildAgentManagementPlan(options = {}) {
  const inventory =
    options.inventory ||
    collectAgentInventory({
      openclawHome: options.openclawHome,
      repoRoot: options.repoRoot,
    });
  const agents = inventory.agents.map(planEntryForAgent);
  return {
    agents,
    generatedAt: options.generatedAt || nowIso(),
    inventorySchemaVersion: inventory.schemaVersion,
    roots: inventory.roots,
    schemaVersion: AGENT_OS_AGENT_MANAGER_SCHEMA_VERSION,
    summary: summarizePlan(agents),
  };
}

export function buildManagedAgentCatalog(options = {}) {
  const plan = options.plan || buildAgentManagementPlan(options);
  return {
    blockedAgents: plan.agents.filter((agent) => agent.managerState === "blocked"),
    generatedAt: options.generatedAt || plan.generatedAt,
    importCandidates: plan.agents.filter((agent) => agent.managerState === "candidate"),
    managedAgents: plan.agents.filter((agent) => agent.controlPlaneManaged),
    proofClaim: {
      liveDelivery: false,
      managementCatalog: true,
      note: "This catalog proves control-plane management. Per-agent live task delivery still needs dispatcher or adapter smoke proof.",
    },
    roots: plan.roots,
    schemaVersion: AGENT_OS_AGENT_MANAGER_SCHEMA_VERSION,
    summary: plan.summary,
  };
}

function managementCheckForAgent(agent) {
  const checks = [
    { name: "inventory-row", status: "PASS" },
    {
      name: "control-plane-route",
      status: agent.controlPlaneManaged ? "PASS" : "WARN",
      value: agent.route,
    },
    {
      name: "path-references",
      status: agent.missingPaths > 0 ? "WARN" : "PASS",
      value: agent.missingPaths,
    },
    {
      name: "live-delivery",
      status: "INFO",
      value: "not executed by manager contract smoke",
    },
  ];
  const terminalStatus = checks.some((check) => check.status === "FAIL")
    ? "FAIL"
    : checks.some((check) => check.status === "WARN")
      ? "WARN"
      : "PASS";
  return { checks, terminalStatus };
}

function smokeResultForAgent(agent, options) {
  const ticketId = `agent-manager-smoke-${stableHash(agent.id).slice(0, 12)}`;
  const ticket = assertAgentOsTicket({
    id: ticketId,
    input: {
      controlPlaneManaged: agent.controlPlaneManaged,
      liveExecution: false,
      managerState: agent.managerState,
      route: agent.route,
    },
    status: "DONE",
    targetAgent: agent.id,
    title: `Agent manager smoke for ${agent.id}`,
    type: "agent_manager_smoke",
  });
  const { checks, terminalStatus } = managementCheckForAgent(agent);
  const proofEvent = assertAgentOsProofEvent({
    agentId: agent.id,
    component: "agent-os-agent-manager",
    data: {
      checks,
      controlPlaneManaged: agent.controlPlaneManaged,
      liveDeliveryProven: false,
      managerState: agent.managerState,
      route: agent.route,
    },
    eventType: "MANAGEMENT_SMOKE",
    runId: options.runId,
    status: terminalStatus,
    summary: `Agent manager ${terminalStatus.toLowerCase()} for ${agent.id}`,
    ticketId,
  });
  return {
    checks,
    controlPlaneManaged: agent.controlPlaneManaged,
    id: agent.id,
    liveDeliveryProven: false,
    proofEvent,
    route: agent.route,
    status: terminalStatus,
    ticket,
  };
}

function selectSmokeAgents(plan, options) {
  if (options.agentIds.length > 0) {
    const byId = new Map(plan.agents.map((agent) => [agent.id, agent]));
    return options.agentIds.map((id) => {
      const agent = byId.get(id);
      if (!agent) {
        throw new Error(`Agent not found in inventory: ${id}`);
      }
      return agent;
    });
  }
  if (options.allManaged) {
    return plan.agents.filter((agent) => agent.controlPlaneManaged);
  }
  throw new Error("smoke requires --agent <id> or --all-managed");
}

export function createAgentManagerSmoke(options = {}) {
  const plan = options.plan || buildAgentManagementPlan(options);
  const generatedAt = options.generatedAt || nowIso();
  const selectedAgents = selectSmokeAgents(plan, {
    agentIds: options.agentIds || [],
    allManaged: options.allManaged === true,
  });
  const runId =
    options.runId ||
    `agent-manager-${stableHash({
      generatedAt,
      ids: selectedAgents.map((agent) => agent.id),
    }).slice(0, 12)}`;
  const outputPath = path.resolve(options.outputPath || DEFAULT_SMOKE_OUTPUT_PATH);
  const results = selectedAgents.map((agent) => smokeResultForAgent(agent, { runId }));
  const summary = {
    byStatus: countBy(results, (result) => result.status),
    controlPlaneManaged: results.filter((result) => result.controlPlaneManaged).length,
    liveDeliveryProven: results.filter((result) => result.liveDeliveryProven).length,
    smoked: results.length,
  };
  const artifactContract = assertAgentOsArtifactContract({
    createdBy: "agent-os-agent-manager",
    kind: "agent-manager-smoke",
    mediaType: "application/json",
    path: outputPath,
    runId,
    ticketId: "agent-manager-smoke",
  });
  return {
    artifactContract,
    generatedAt,
    proofClaim: {
      liveDelivery: false,
      managementSmoke: true,
      note: "This smoke validates routing and contracts for manager-selected agents. It does not execute arbitrary agent code.",
    },
    results,
    runId,
    schemaVersion: AGENT_OS_AGENT_MANAGER_SMOKE_SCHEMA_VERSION,
    summary,
  };
}

function parseArgs(argv) {
  const args = [...argv];
  const command = args[0] && !args[0].startsWith("--") ? args.shift() : "check";
  const options = {
    agentIds: [],
    allManaged: false,
    command,
    format: "json",
    openclawHome: path.join(os.homedir(), ".openclaw"),
    outputPath: null,
    repoRoot: process.cwd(),
    strict: false,
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
    } else if (arg === "--agent") {
      const value = normalizeString(args[index + 1]);
      if (!value) {
        throw new Error("--agent requires an id");
      }
      options.agentIds.push(value);
      index += 1;
    } else if (arg === "--all-managed") {
      options.allManaged = true;
    } else if (arg === "--strict") {
      options.strict = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function formatPlanSummary(plan) {
  const lines = [
    `Agent manager plan: ${plan.summary.totalUnique} unique IDs`,
    `Control-plane managed: ${plan.summary.controlPlaneManaged}`,
    `Import candidates: ${plan.summary.candidates}`,
    `Blocked: ${plan.summary.blocked}`,
    `Dormant: ${plan.summary.dormant}`,
    `Path warnings: ${plan.summary.pathWarnings}`,
    `Live delivery proven: ${plan.summary.liveDeliveryProven}`,
    "",
    "Manager states:",
  ];
  for (const [name, count] of Object.entries(plan.summary.byManagerState)) {
    lines.push(`- ${name}: ${count}`);
  }
  lines.push("", "Routes:");
  for (const [name, count] of Object.entries(plan.summary.byRoute)) {
    lines.push(`- ${name}: ${count}`);
  }
  return `${lines.join("\n")}\n`;
}

function formatSmokeSummary(smoke) {
  const lines = [
    `Agent manager smoke: ${smoke.summary.smoked} selected agents`,
    `Control-plane managed: ${smoke.summary.controlPlaneManaged}`,
    `Live delivery proven: ${smoke.summary.liveDeliveryProven}`,
    "",
    "Statuses:",
  ];
  for (const [name, count] of Object.entries(smoke.summary.byStatus)) {
    lines.push(`- ${name}: ${count}`);
  }
  lines.push("", `Artifact: ${smoke.artifactContract.path}`);
  return `${lines.join("\n")}\n`;
}

function outputPayload(payload, options, defaultPath = null) {
  const output = options.format === "summary" ? null : `${JSON.stringify(payload, null, 2)}\n`;
  const outputPath = options.outputPath || defaultPath;
  if (outputPath) {
    writeJson(outputPath, payload);
  } else if (output) {
    process.stdout.write(output);
  }
}

export function runAgentManagerCli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (!["apply", "check", "plan", "smoke"].includes(options.command)) {
    throw new Error(`Unknown command: ${options.command}`);
  }
  const plan = buildAgentManagementPlan({
    openclawHome: normalizePath(options.openclawHome),
    repoRoot: normalizePath(options.repoRoot),
  });
  if (options.command === "check") {
    process.stdout.write(formatPlanSummary(plan));
    return options.strict && (plan.summary.blocked > 0 || plan.summary.pathWarnings > 0) ? 1 : 0;
  }
  if (options.command === "plan") {
    if (options.format === "summary") {
      if (options.outputPath) {
        writeJson(options.outputPath, plan);
      }
      process.stdout.write(formatPlanSummary(plan));
    } else {
      outputPayload(plan, options, options.outputPath ? null : DEFAULT_PLAN_OUTPUT_PATH);
    }
    return 0;
  }
  if (options.command === "apply") {
    const catalog = buildManagedAgentCatalog({ plan });
    if (options.format === "summary") {
      writeJson(options.outputPath || DEFAULT_CATALOG_OUTPUT_PATH, catalog);
      process.stdout.write(formatPlanSummary(plan));
    } else {
      outputPayload(catalog, options, options.outputPath ? null : DEFAULT_CATALOG_OUTPUT_PATH);
    }
    return 0;
  }
  const smoke = createAgentManagerSmoke({
    agentIds: options.agentIds,
    allManaged: options.allManaged,
    outputPath: options.outputPath || DEFAULT_SMOKE_OUTPUT_PATH,
    plan,
  });
  writeJson(options.outputPath || DEFAULT_SMOKE_OUTPUT_PATH, smoke);
  if (options.format === "summary") {
    process.stdout.write(formatSmokeSummary(smoke));
  } else if (!options.outputPath) {
    process.stdout.write(`${JSON.stringify(smoke, null, 2)}\n`);
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    process.exit(runAgentManagerCli());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
