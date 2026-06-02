#!/usr/bin/env node
import crypto from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildAgentManagementPlan } from "./agent-os-agent-manager.mjs";

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
    .replace(/[^a-z0-9_.:-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return normalized || fallback;
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

function blockingReasonsForAgent(agent) {
  const reasons = [];
  if (agent.managerState === "blocked") {
    reasons.push("manager state is blocked");
  }
  if (agent.managerState === "candidate") {
    reasons.push("agent is an import candidate, not a managed runtime");
  }
  if (agent.managerState === "dormant") {
    reasons.push("agent is dormant");
  }
  if (agent.missingPaths > 0) {
    reasons.push(`${agent.missingPaths} path reference(s) missing`);
  }
  if (!agent.controlPlaneManaged) {
    reasons.push("no control-plane managed route");
  }
  return reasons;
}

function contractDeliveryStatus(agent) {
  const blockingReasons = blockingReasonsForAgent(agent);
  const contractDeliveryProven = blockingReasons.length === 0 && agent.managerState === "managed";
  if (contractDeliveryProven) {
    return {
      blockingReasons,
      contractDeliveryProven: true,
      deliveryStatus: "CONTRACT_DELIVERY_PROVEN",
      proofStatus: "PASS",
    };
  }
  if (agent.controlPlaneManaged) {
    return {
      blockingReasons,
      contractDeliveryProven: false,
      deliveryStatus: "CONTRACT_DELIVERY_WARN",
      proofStatus: "WARN",
    };
  }
  return {
    blockingReasons,
    contractDeliveryProven: false,
    deliveryStatus: "NOT_DELIVERY_PROVEN",
    proofStatus: "FAIL",
  };
}

function deliveryArtifactPayload(agent, evaluation, options) {
  return {
    agent: {
      capabilityFamilies: agent.capabilityFamilies,
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
    generatedAt: options.generatedAt,
    kind: "agent-delivery-proof-card",
    liveDeliveryProven: false,
    note: "This artifact is produced by the Agent OS proof harness. It is not evidence that arbitrary agent code executed.",
    runId: options.runId,
    schemaVersion: AGENT_OS_AGENT_DELIVERY_PROOF_SCHEMA_VERSION,
  };
}

function resultForAgent(agent, options) {
  const evaluation = contractDeliveryStatus(agent);
  const ticketId = `agent-delivery-${stableHash(agent.id).slice(0, 12)}`;
  const ticket = assertAgentOsTicket({
    id: ticketId,
    input: {
      agentId: agent.id,
      managerState: agent.managerState,
      proofMode: "contract",
      route: agent.route,
    },
    status: evaluation.contractDeliveryProven ? "DONE" : "BLOCKED",
    targetAgent: agent.id,
    title: `Agent delivery proof for ${agent.id}`,
    type: "agent_delivery_proof",
  });
  const agentArtifactPath = path.join(options.agentArtifactDir, `${slug(agent.id)}.json`);
  const artifactPayload = deliveryArtifactPayload(agent, evaluation, {
    generatedAt: options.generatedAt,
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
      liveDeliveryProven: false,
      managerState: agent.managerState,
      route: agent.route,
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
    id: agent.id,
    liveDeliveryProven: false,
    managerState: agent.managerState,
    proofEvent,
    route: agent.route,
    ticket,
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
    contractDeliveryProven: results.filter((result) => result.contractDeliveryProven).length,
    liveDeliveryProven: results.filter((result) => result.liveDeliveryProven).length,
    notDeliveryProven: results.filter((result) => !result.contractDeliveryProven).length,
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
    resultForAgent(agent, { agentArtifactDir, generatedAt, runId }),
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
      liveExecution: false,
      note: "This proof does not execute arbitrary agent code. It proves contract-delivery readiness and names every remaining blocker for live delivery.",
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
