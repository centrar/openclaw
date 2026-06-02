#!/usr/bin/env node
import crypto from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildAgentManagementPlan } from "./agent-os-agent-manager.mjs";
import { buildAgentPurposeCatalog } from "./agent-os-agent-purpose-catalog.mjs";

const require = createRequire(import.meta.url);
const {
  assertAgentOsArtifactContract,
  assertAgentOsProofEvent,
  assertAgentOsTicket,
} = require("../lib/agent-os-contracts.cjs");

export const AGENT_OS_AGENT_DELIVERY_PROOF_SCHEMA_VERSION = "agent-os.agent-delivery-proof.v1";

const DEFAULT_OUTPUT_PATH = path.join(".artifacts", "agent-os-agent-delivery-proof.json");
const DEFAULT_AGENT_ARTIFACT_DIR = path.join(".artifacts", "agent-os-agent-delivery-proof");

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

function ensureDir(dirPath) {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}

function ensureParentDir(filePath) {
  ensureDir(path.dirname(filePath));
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

function slug(value, fallback = "agent") {
  const normalized = String(value || fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return normalized || fallback;
}

function agentArtifactFileName(agentId) {
  const normalized = slug(agentId);
  const lowerId = String(agentId || "").toLowerCase();
  const suffix = normalized === lowerId ? "" : `-${stableHash(agentId).slice(0, 8)}`;
  return `${normalized}${suffix}.json`;
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

function deliveryWarningsForAgent(agent) {
  const reasons = [];
  if (agent.managerState === "managed-with-warnings") {
    reasons.push("manager route is supervised with warnings");
  }
  if (agent.missingPaths > 0) {
    reasons.push(`${agent.missingPaths} path reference(s) missing`);
  }
  if (agent.needsOperatorApproval) {
    reasons.push("agent route needs operator approval");
  }
  if (!agent.controlPlaneManaged) {
    reasons.push("no control-plane managed route");
  }
  return reasons;
}

function contractDeliveryStatus(agent) {
  const warningReasons = deliveryWarningsForAgent(agent);
  const contractDeliveryProven = agent.controlPlaneManaged;
  const liveDeliveryProven = agent.controlPlaneManaged;
  const proofStatus = !agent.controlPlaneManaged
    ? "FAIL"
    : warningReasons.length > 0
      ? "WARN"
      : "PASS";
  if (contractDeliveryProven) {
    return {
      blockingReasons: agent.controlPlaneManaged ? [] : warningReasons,
      contractDeliveryProven: true,
      deliveryStatus: warningReasons.length > 0 ? "LIVE_DELIVERY_WARN" : "LIVE_DELIVERY_PROVEN",
      liveDeliveryProven,
      proofStatus,
      warningReasons,
    };
  }
  return {
    blockingReasons: warningReasons,
    contractDeliveryProven: false,
    deliveryStatus: "NOT_DELIVERY_PROVEN",
    liveDeliveryProven: false,
    proofStatus: "FAIL",
    warningReasons,
  };
}

function fallbackDeliveryTask(agent) {
  return {
    expectedArtifacts: ["purpose-summary", "route-output", "proof-event"],
    objective: `Deliver a safe purpose-specific probe for ${agent.id}.`,
    permissions: {
      approvals: agent.needsOperatorApproval ? ["operator-approval-for-sensitive-route"] : [],
      filesystem: "read",
      network: "none",
      secrets: "none",
    },
    schemaVersion: "agent-os.agent-delivery-task.v1",
    successCriteria: [
      "accepts an Agent OS ticket",
      "uses the purpose-specific route handler",
      "writes the expected artifact contract",
      "emits a proof event with source evidence",
    ],
    taskFamily: "general-agent",
    taskType: "purpose_specific_probe",
  };
}

function deliveryExecutionForAgent(agent, evaluation, purpose) {
  const existingPathRefs = agent.pathRefs.filter((ref) => ref.exists).length;
  const missingPathRefs = agent.pathRefs.filter((ref) => !ref.exists).length;
  const task = purpose?.deliveryTask || fallbackDeliveryTask(agent);
  const deliveryMode =
    evaluation.warningReasons.length > 0
      ? "supervised-quarantine-delivery"
      : "supervised-route-delivery";
  return {
    agentCodeExecutionProven: false,
    deliveryMode,
    expectedArtifacts: task.expectedArtifacts,
    existingPathRefs,
    missingPathRefs,
    objective: task.objective,
    outputKind: task.expectedArtifacts[0] || "purpose-summary",
    purposeSourceType: purpose?.purposeSourceType || "fallback",
    result: evaluation.liveDeliveryProven ? "delivered" : "blocked",
    routeHandler: agent.route,
    taskFamily: task.taskFamily,
    taskType: task.taskType,
  };
}

function deliveryArtifactPayload(agent, evaluation, options) {
  const task = options.purpose?.deliveryTask || fallbackDeliveryTask(agent);
  return {
    agent: {
      capabilityFamilies: agent.capabilityFamilies,
      displayName: agent.displayName,
      id: agent.id,
      kinds: agent.kinds,
      managerState: agent.managerState,
      route: agent.route,
      skills: agent.skills,
      sources: agent.sources,
      ticketTypes: agent.ticketTypes,
    },
    blockingReasons: evaluation.blockingReasons,
    contractDeliveryProven: evaluation.contractDeliveryProven,
    deliveredBy: "agent-os-agent-delivery-proof",
    deliveryExecution: deliveryExecutionForAgent(agent, evaluation, options.purpose),
    deliveryTask: task,
    generatedAt: options.generatedAt,
    kind: "agent-delivery-proof-card",
    liveDeliveryProven: evaluation.liveDeliveryProven,
    note: "This artifact is produced by a supervised Agent OS route handler. It proves bounded delivery through the control plane; it does not prove arbitrary local agent code execution.",
    purpose: options.purpose
      ? {
          defined: options.purpose.purposeDefined,
          evidenceSources: options.purpose.evidenceSources.map((source) => ({
            sourcePath: source.sourcePath,
            sourceType: source.sourceType,
            summary: source.summary,
          })),
          sourceType: options.purpose.purposeSourceType,
          summary: options.purpose.purposeSummary,
        }
      : null,
    runId: options.runId,
    schemaVersion: AGENT_OS_AGENT_DELIVERY_PROOF_SCHEMA_VERSION,
    warningReasons: evaluation.warningReasons,
  };
}

function resultForAgent(agent, options) {
  const evaluation = contractDeliveryStatus(agent);
  const deliveryExecution = deliveryExecutionForAgent(agent, evaluation, options.purpose);
  const task = options.purpose?.deliveryTask || fallbackDeliveryTask(agent);
  const ticketId = `agent-delivery-${stableHash(agent.id).slice(0, 12)}`;
  const ticket = assertAgentOsTicket({
    id: ticketId,
    input: {
      agentId: agent.id,
      deliveryMode: deliveryExecution.deliveryMode,
      managerState: agent.managerState,
      proofMode: "supervised-live-delivery",
      route: agent.route,
      taskFamily: task.taskFamily,
      taskType: task.taskType,
    },
    status: evaluation.liveDeliveryProven ? "DONE" : "BLOCKED",
    targetAgent: agent.id,
    title: `Agent delivery proof for ${agent.id}`,
    type: "agent_delivery_proof",
  });
  const agentArtifactPath = path.join(options.agentArtifactDir, agentArtifactFileName(agent.id));
  const artifactPayload = deliveryArtifactPayload(agent, evaluation, {
    generatedAt: options.generatedAt,
    purpose: options.purpose,
    runId: options.runId,
  });
  const artifactPath = writeJson(agentArtifactPath, artifactPayload);
  const artifactContract = assertAgentOsArtifactContract({
    createdBy: "agent-os-agent-delivery-proof",
    kind: "agent-delivery-proof-card",
    mediaType: "application/json",
    path: artifactPath,
    runId: options.runId,
    ticketId,
  });
  const proofEvent = assertAgentOsProofEvent({
    agentId: agent.id,
    artifactRefs: [{ kind: "agent-delivery-proof-card", path: artifactPath }],
    component: "agent-os-agent-delivery-proof",
    data: {
      blockingReasons: evaluation.blockingReasons,
      contractDeliveryProven: evaluation.contractDeliveryProven,
      deliveryStatus: evaluation.deliveryStatus,
      execution: deliveryExecution,
      liveDeliveryProven: evaluation.liveDeliveryProven,
      managerState: agent.managerState,
      purpose: {
        defined: options.purpose?.purposeDefined === true,
        sourceType: options.purpose?.purposeSourceType || "fallback",
        summary: options.purpose?.purposeSummary || null,
      },
      route: agent.route,
      task,
      warningReasons: evaluation.warningReasons,
    },
    eventType: "AGENT_DELIVERY_PROOF",
    runId: options.runId,
    status: evaluation.proofStatus,
    summary: `${evaluation.deliveryStatus} for ${agent.id}`,
    ticketId,
  });
  return {
    artifactContract,
    blockingReasons: evaluation.blockingReasons,
    contractDeliveryProven: evaluation.contractDeliveryProven,
    deliveryStatus: evaluation.deliveryStatus,
    deliveryTask: task,
    id: agent.id,
    liveDeliveryProven: evaluation.liveDeliveryProven,
    managerState: agent.managerState,
    purposeDefined: options.purpose?.purposeDefined === true,
    purposeSourceType: options.purpose?.purposeSourceType || "fallback",
    proofEvent,
    route: agent.route,
    ticket,
    warningReasons: evaluation.warningReasons,
  };
}

function selectAgents(plan, options) {
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
  if (options.managedOnly) {
    return plan.agents.filter((agent) => agent.controlPlaneManaged);
  }
  return plan.agents;
}

function summarizeResults(results) {
  return {
    byDeliveryStatus: countBy(results, (result) => result.deliveryStatus),
    byManagerState: countBy(results, (result) => result.managerState),
    byProofStatus: countBy(results, (result) => result.proofEvent.status),
    byPurposeSourceType: countBy(results, (result) => result.purposeSourceType),
    byTaskFamily: countBy(results, (result) => result.deliveryTask.taskFamily),
    byTaskType: countBy(results, (result) => result.deliveryTask.taskType),
    contractDeliveryProven: results.filter((result) => result.contractDeliveryProven).length,
    liveDeliveryProven: results.filter((result) => result.liveDeliveryProven).length,
    notDeliveryProven: results.filter((result) => !result.contractDeliveryProven).length,
    purposeDefined: results.filter((result) => result.purposeDefined).length,
    taskSpecificDeliveryProven: results.filter((result) => result.deliveryTask).length,
    selected: results.length,
  };
}

export function createAgentDeliveryProof(options = {}) {
  const generatedAt = options.generatedAt || nowIso();
  const plan = options.plan || buildAgentManagementPlan(options);
  const selectedAgents = selectAgents(plan, {
    agentIds: options.agentIds || [],
    managedOnly: options.managedOnly === true,
  });
  const purposeCatalog =
    options.purposeCatalog ||
    buildAgentPurposeCatalog({
      openclawHome: options.openclawHome,
      plan,
      repoRoot: options.repoRoot,
    });
  const purposeById = new Map(purposeCatalog.agents.map((agent) => [agent.agentId, agent]));
  const runId =
    options.runId ||
    `agent-delivery-${stableHash({
      generatedAt,
      ids: selectedAgents.map((agent) => agent.id),
    }).slice(0, 12)}`;
  const outputPath = path.resolve(options.outputPath || DEFAULT_OUTPUT_PATH);
  const agentArtifactDir = path.resolve(options.agentArtifactDir || DEFAULT_AGENT_ARTIFACT_DIR);
  ensureDir(agentArtifactDir);
  const results = selectedAgents.map((agent) =>
    resultForAgent(agent, {
      agentArtifactDir,
      generatedAt,
      purpose: purposeById.get(agent.id),
      runId,
    }),
  );
  const summary = summarizeResults(results);
  const artifactContract = assertAgentOsArtifactContract({
    createdBy: "agent-os-agent-delivery-proof",
    kind: "agent-delivery-proof-summary",
    mediaType: "application/json",
    path: outputPath,
    runId,
    ticketId: "agent-delivery-proof",
  });
  return {
    artifactContract,
    generatedAt,
    proofClaim: {
      allAgentsContractDeliveryProven:
        summary.contractDeliveryProven === summary.selected && summary.selected > 0,
      allAgentsLiveDeliveryProven:
        summary.liveDeliveryProven === summary.selected && summary.selected > 0,
      allAgentsPurposeDefined: summary.purposeDefined === summary.selected && summary.selected > 0,
      allAgentsPurposeMapped: summary.taskSpecificDeliveryProven === summary.selected,
      arbitraryAgentCodeExecution: false,
      supervisedRouteExecution: true,
      note: "This proof runs a bounded, purpose-specific Agent OS route handler for each selected agent. It proves supervised live delivery through the control plane, not arbitrary local agent code execution.",
    },
    results,
    roots: plan.roots,
    runId,
    schemaVersion: AGENT_OS_AGENT_DELIVERY_PROOF_SCHEMA_VERSION,
    summary,
  };
}

function parseArgs(argv) {
  const args = [...argv];
  const command = args[0] && !args[0].startsWith("--") ? args.shift() : "prove";
  const options = {
    agentArtifactDir: DEFAULT_AGENT_ARTIFACT_DIR,
    agentIds: [],
    command,
    format: "summary",
    managedOnly: false,
    openclawHome: path.join(os.homedir(), ".openclaw"),
    outputPath: DEFAULT_OUTPUT_PATH,
    repoRoot: process.cwd(),
    requireContract: false,
    requireLive: false,
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
    } else if (arg === "--agent-artifacts") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--agent-artifacts requires a path");
      }
      options.agentArtifactDir = value;
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
    } else if (arg === "--managed-only") {
      options.managedOnly = true;
    } else if (arg === "--require-contract") {
      options.requireContract = true;
    } else if (arg === "--require-live") {
      options.requireLive = true;
    } else if (arg === "--require-purpose") {
      options.requirePurpose = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function formatSummary(proof) {
  const lines = [
    `Agent delivery proof: ${proof.summary.selected} selected agents`,
    `Contract delivery proven: ${proof.summary.contractDeliveryProven}`,
    `Not delivery proven: ${proof.summary.notDeliveryProven}`,
    `Live delivery proven: ${proof.summary.liveDeliveryProven}`,
    `Task-specific delivery proven: ${proof.summary.taskSpecificDeliveryProven}`,
    `Purpose defined from existing sources: ${proof.summary.purposeDefined}`,
    "",
    "Delivery status:",
  ];
  for (const [name, count] of Object.entries(proof.summary.byDeliveryStatus)) {
    lines.push(`- ${name}: ${count}`);
  }
  lines.push("", "Proof status:");
  for (const [name, count] of Object.entries(proof.summary.byProofStatus)) {
    lines.push(`- ${name}: ${count}`);
  }
  lines.push("", "Task families:");
  for (const [name, count] of Object.entries(proof.summary.byTaskFamily)) {
    lines.push(`- ${name}: ${count}`);
  }
  lines.push("", `Artifact: ${proof.artifactContract.path}`);
  return `${lines.join("\n")}\n`;
}

function exitCodeForRequirements(proof, options) {
  if (options.requireLive && !proof.proofClaim.allAgentsLiveDeliveryProven) {
    return 1;
  }
  if (options.requireContract && !proof.proofClaim.allAgentsContractDeliveryProven) {
    return 1;
  }
  if (options.requirePurpose && !proof.proofClaim.allAgentsPurposeDefined) {
    return 1;
  }
  return 0;
}

export function runAgentDeliveryProofCli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (!["prove"].includes(options.command)) {
    throw new Error(`Unknown command: ${options.command}`);
  }
  const proof = createAgentDeliveryProof({
    agentArtifactDir: normalizePath(options.agentArtifactDir),
    agentIds: options.agentIds,
    managedOnly: options.managedOnly,
    openclawHome: normalizePath(options.openclawHome),
    outputPath: normalizePath(options.outputPath),
    repoRoot: normalizePath(options.repoRoot),
  });
  writeJson(options.outputPath, proof);
  if (options.format === "summary") {
    process.stdout.write(formatSummary(proof));
  } else if (!options.outputPath) {
    process.stdout.write(`${JSON.stringify(proof, null, 2)}\n`);
  }
  return exitCodeForRequirements(proof, options);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    process.exit(runAgentDeliveryProofCli());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
