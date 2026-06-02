#!/usr/bin/env node
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

export const AGENT_OS_NATIVE_EXEC_PROOF_SCHEMA_VERSION = "agent-os.native-exec-proof.v1";

const DEFAULT_OUTPUT_PATH = path.join(".artifacts", "agent-os-native-exec-proof.json");
const DEFAULT_AGENT_ARTIFACT_DIR = path.join(".artifacts", "agent-os-native-exec-proof");
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_CAPTURE_BYTES = 64_000;
const NATIVE_EXECUTION_ROUTES = new Set([
  "tool-adapter",
  "filesystem-agent-adapter",
  "workspace-agent-adapter",
  "business-agent-supervisor",
]);
const LOW_RISK_AUTO_AGENT_IDS = new Set(["test_fileio", "test_fileio2", "test_hosts"]);
const RISK_PATTERNS = [
  { pattern: /\b(?:EAA|sk-)[A-Za-z0-9_-]{24,}\b/u, reason: "hardcoded credential-like token" },
  {
    pattern: /\b(access_token|api[_-]?key|secret|password|client_secret)\b\s*=/iu,
    reason: "credential assignment",
  },
  { pattern: /\byt_token\.pickle\b/iu, reason: "YouTube credential state access" },
  {
    pattern: /\brequests\.(?:get|post|put)\b|https?:\/\//iu,
    reason: "external network side effect",
  },
  { pattern: /\bngrok\b|public_url/iu, reason: "public tunnel side effect" },
  { pattern: /\btest_reel\.mp4\b/iu, reason: "local media file access" },
  {
    pattern: /\bmedia_publish\b|videos\(\)\.insert|published["']?\s*:/iu,
    reason: "publishing side effect",
  },
  {
    pattern: /\bwebbrowser\.open\b|selenium|playwright/iu,
    reason: "interactive browser/account side effect",
  },
  { pattern: /\btaskkill\b|subprocess\.Popen/iu, reason: "host process mutation" },
  { pattern: /\bC:\\ffmpeg\b|ffmpeg_download\.zip/iu, reason: "host install or media mutation" },
];
const RISKY_TOOL_NAME_PATTERN =
  /(?:account|auth|container|convert|debug|diag|ffmpeg|fb|ig|media|ngrok|page|patch|perms|publish|slicer|token|upload|wrapper|youtube)/iu;

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

function redactText(value) {
  return String(value || "")
    .replace(/(access_token|api[_-]?key|secret|token|password)=([^&\s"']+)/giu, "$1=[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{16,}/gu, "Bearer [REDACTED]")
    .replace(/\b(?:EAA|sk-)[A-Za-z0-9_-]{24,}\b/gu, "[REDACTED]")
    .replace(/\b[A-Za-z0-9_=-]{80,}\b/gu, "[REDACTED_LONG_VALUE]");
}

function trimCapture(value) {
  const text = String(value || "");
  if (Buffer.byteLength(text, "utf8") <= MAX_CAPTURE_BYTES) {
    return text;
  }
  return `${text.slice(0, MAX_CAPTURE_BYTES)}\n[TRUNCATED]`;
}

function safeEnv(options = {}) {
  if (options.inheritEnv) {
    return { ...process.env };
  }
  const keys = [
    "ComSpec",
    "LOCALAPPDATA",
    "PATH",
    "Path",
    "PATHEXT",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "SystemDrive",
    "SystemRoot",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "WINDIR",
  ];
  const env = {};
  for (const key of keys) {
    if (process.env[key]) {
      env[key] = process.env[key];
    }
  }
  env.PYTHONIOENCODING = "utf-8";
  return env;
}

function quoteCmdArg(value) {
  return `"${String(value).replace(/"/gu, '\\"')}"`;
}

function commandForPath(filePath, args) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".py") {
    return { args: [filePath, ...args], command: "python" };
  }
  if ([".js", ".cjs", ".mjs"].includes(extension)) {
    return { args: [filePath, ...args], command: "node" };
  }
  if ([".cmd", ".bat"].includes(extension)) {
    const commandLine = [filePath, ...args].map((arg) => quoteCmdArg(arg)).join(" ");
    return { args: ["/d", "/s", "/c", commandLine], command: "cmd.exe" };
  }
  return { args, command: filePath };
}

function executablePathForAgent(agent) {
  const candidates = (agent.pathRefs || []).filter((ref) => ref.exists && ref.path);
  const fileRef = candidates.find((ref) => /\.[A-Za-z0-9]+$/u.test(path.basename(ref.path)));
  return fileRef?.path || null;
}

function nativeExecutionCandidate(agent) {
  return NATIVE_EXECUTION_ROUTES.has(agent.route);
}

function safetyAssessment(agent, executablePath, options) {
  if (!nativeExecutionCandidate(agent)) {
    return { ok: false, reasons: ["agent route is not a native execution candidate"] };
  }
  if (!executablePath) {
    return { ok: false, reasons: ["no direct executable path reference"] };
  }
  if (options.allowRisky || LOW_RISK_AUTO_AGENT_IDS.has(agent.id)) {
    return { ok: true, reasons: [] };
  }
  const riskyToolName = RISKY_TOOL_NAME_PATTERN.test(path.basename(executablePath));
  let text = "";
  try {
    text = readFileSync(executablePath, "utf8");
  } catch {
    return { ok: false, reasons: ["cannot read executable for safety scan"] };
  }
  const reasons = [];
  if (riskyToolName) {
    reasons.push("risky tool name requires explicit approval or dry-run wrapper");
  }
  for (const rule of RISK_PATTERNS) {
    if (rule.pattern.test(text)) {
      reasons.push(rule.reason);
    }
  }
  return reasons.length > 0 ? { ok: false, reasons } : { ok: true, reasons: [] };
}

function runProcess(commandSpec, options) {
  return new Promise((resolve) => {
    const startedAt = nowIso();
    const child = spawn(commandSpec.command, commandSpec.args, {
      cwd: options.cwd,
      env: safeEnv({ inheritEnv: options.inheritEnv }),
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout = trimCapture(stdout + chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk) => {
      stderr = trimCapture(stderr + chunk.toString("utf8"));
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({
        durationMs: Date.now() - Date.parse(startedAt),
        error: error.message,
        exitCode: null,
        signal: null,
        startedAt,
        stderr: redactText(stderr),
        stdout: redactText(stdout),
        timedOut,
      });
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timeout);
      resolve({
        durationMs: Date.now() - Date.parse(startedAt),
        error: null,
        exitCode,
        signal,
        startedAt,
        stderr: redactText(stderr),
        stdout: redactText(stdout),
        timedOut,
      });
    });
  });
}

function selectAgent(plan, agentId) {
  const agent = plan.agents.find((entry) => entry.id === agentId);
  if (!agent) {
    throw new Error(`Agent not found in inventory: ${agentId}`);
  }
  return agent;
}

function selectAllCandidates(plan) {
  return plan.agents.filter(
    (agent) => nativeExecutionCandidate(agent) && (agent.pathRefs || []).some((ref) => ref.exists),
  );
}

async function resultForAgent(agent, options) {
  const executablePath = executablePathForAgent(agent);
  const safety = safetyAssessment(agent, executablePath, options);
  const runnable = safety.ok && executablePath !== null;
  const commandSpec = runnable ? commandForPath(executablePath, options.args) : null;
  const execution = runnable
    ? await runProcess(commandSpec, {
        cwd: path.dirname(executablePath),
        inheritEnv: options.inheritEnv,
        timeoutMs: options.timeoutMs,
      })
    : {
        durationMs: 0,
        error: executablePath
          ? "agent route is not a direct local executable"
          : "no executable path reference",
        exitCode: null,
        signal: null,
        startedAt: options.generatedAt,
        stderr: "",
        stdout: "",
        timedOut: false,
      };
  const agentCodeExecutionProven = runnable && execution.exitCode === 0 && !execution.timedOut;
  const blocked = !safety.ok || executablePath === null;
  const status = agentCodeExecutionProven ? "PASS" : blocked ? "WARN" : "FAIL";
  const ticketStatus = agentCodeExecutionProven ? "DONE" : blocked ? "BLOCKED" : "FAILED";
  const ticketId = `native-exec-${stableHash(agent.id).slice(0, 12)}`;
  const runId = options.runId;
  const artifactPath = path.join(options.agentArtifactDir, `${slug(agent.id)}.json`);
  const ticket = assertAgentOsTicket({
    id: ticketId,
    input: {
      agentId: agent.id,
      args: options.args,
      blockedReasons: safety.reasons,
      executablePath,
      route: agent.route,
      sanitizedEnvironment: !options.inheritEnv,
    },
    status: ticketStatus,
    targetAgent: agent.id,
    title: `Native execution proof for ${agent.id}`,
    type: "native_execution_proof",
  });
  const artifactPayload = {
    agent: {
      id: agent.id,
      kinds: agent.kinds,
      managerState: agent.managerState,
      route: agent.route,
      sources: agent.sources,
    },
    command: commandSpec
      ? {
          args: commandSpec.args.map((arg) => (arg === executablePath ? "[EXECUTABLE_PATH]" : arg)),
          command: commandSpec.command,
        }
      : null,
    executablePath,
    generatedAt: options.generatedAt,
    kind: "agent-native-execution-proof-card",
    nativeExecution: {
      agentCodeExecutionProven,
      blocked,
      blockedReasons: safety.reasons,
      durationMs: execution.durationMs,
      error: execution.error,
      exitCode: execution.exitCode,
      signal: execution.signal,
      startedAt: execution.startedAt,
      stderr: execution.stderr,
      stdout: execution.stdout,
      timedOut: execution.timedOut,
    },
    note: "This artifact proves the selected local implementation was executed as a host process with redacted output. It does not prove container isolation or safety for every task the agent can perform.",
    runId,
    schemaVersion: AGENT_OS_NATIVE_EXEC_PROOF_SCHEMA_VERSION,
    ticket,
  };
  const writtenArtifactPath = writeJson(artifactPath, artifactPayload);
  const artifactContract = assertAgentOsArtifactContract({
    createdBy: "agent-os-native-exec-proof",
    kind: "agent-native-execution-proof-card",
    mediaType: "application/json",
    path: writtenArtifactPath,
    redactionStatus: "redacted",
    runId,
    ticketId,
  });
  const proofEvent = assertAgentOsProofEvent({
    agentId: agent.id,
    artifactRefs: [{ kind: "agent-native-execution-proof-card", path: writtenArtifactPath }],
    component: "agent-os-native-exec-proof",
    data: {
      agentCodeExecutionProven,
      blocked,
      blockedReasons: safety.reasons,
      durationMs: execution.durationMs,
      executablePath,
      exitCode: execution.exitCode,
      route: agent.route,
      sanitizedEnvironment: !options.inheritEnv,
      timedOut: execution.timedOut,
    },
    eventType: "AGENT_NATIVE_EXECUTION_PROOF",
    runId,
    status,
    summary: `${status} native execution proof for ${agent.id}`,
    ticketId,
  });
  return {
    agentCodeExecutionProven,
    artifactContract,
    blocked,
    blockedReasons: safety.reasons,
    executablePath,
    exitCode: execution.exitCode,
    id: agent.id,
    proofEvent,
    route: agent.route,
    ticket,
    timedOut: execution.timedOut,
  };
}

export async function createNativeExecutionProof(options = {}) {
  const generatedAt = options.generatedAt || nowIso();
  const repoRoot = normalizePath(options.repoRoot || process.cwd());
  const openclawHome = normalizePath(options.openclawHome || path.join(os.homedir(), ".openclaw"));
  const plan = options.plan || buildAgentManagementPlan({ openclawHome, repoRoot });
  const agents = options.allCandidates
    ? selectAllCandidates(plan)
    : [selectAgent(plan, options.agentId)];
  const runId =
    options.runId ||
    `native-exec-${stableHash({
      agentIds: agents.map((agent) => agent.id),
      generatedAt,
    }).slice(0, 12)}`;
  const outputPath = path.resolve(options.outputPath || DEFAULT_OUTPUT_PATH);
  const agentArtifactDir = path.resolve(options.agentArtifactDir || DEFAULT_AGENT_ARTIFACT_DIR);
  ensureDir(agentArtifactDir);
  const results = [];
  for (const agent of agents) {
    results.push(
      await resultForAgent(agent, {
        agentArtifactDir,
        allowRisky: options.allowRisky === true,
        args: options.args || [],
        generatedAt,
        inheritEnv: options.inheritEnv === true,
        runId,
        timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
      }),
    );
  }
  const summary = {
    agentCodeExecutionProven: results.filter((result) => result.agentCodeExecutionProven).length,
    blocked: results.filter((result) => result.blocked).length,
    failed: results.filter((result) => !result.agentCodeExecutionProven && !result.blocked).length,
    selected: results.length,
  };
  const artifactContract = assertAgentOsArtifactContract({
    createdBy: "agent-os-native-exec-proof",
    kind: "agent-native-execution-proof-summary",
    mediaType: "application/json",
    path: outputPath,
    redactionStatus: "redacted",
    runId,
    ticketId: "native-execution-proof",
  });
  return {
    artifactContract,
    generatedAt,
    proofClaim: {
      allSelectedAgentCodeExecutionProven:
        summary.agentCodeExecutionProven === summary.selected && summary.selected > 0,
      arbitraryAgentCodeExecution: summary.agentCodeExecutionProven > 0,
      hostProcessExecution: true,
      note: "This proof executes selected local implementations when they pass the safety gate. BLOCKED results need explicit dry-run wrappers or operator-approved risky execution before they can count as native code execution proof.",
    },
    results,
    roots: plan.roots,
    runId,
    schemaVersion: AGENT_OS_NATIVE_EXEC_PROOF_SCHEMA_VERSION,
    summary,
  };
}

function parseArgs(argv) {
  const args = [...argv];
  const command = args[0] && !args[0].startsWith("--") ? args.shift() : "prove";
  const options = {
    agentArtifactDir: DEFAULT_AGENT_ARTIFACT_DIR,
    agentId: null,
    args: [],
    allCandidates: false,
    allowRisky: false,
    command,
    format: "summary",
    inheritEnv: false,
    openclawHome: path.join(os.homedir(), ".openclaw"),
    outputPath: DEFAULT_OUTPUT_PATH,
    repoRoot: process.cwd(),
    requireNative: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--agent") {
      const value = normalizeString(args[index + 1]);
      if (!value) {
        throw new Error("--agent requires an id");
      }
      options.agentId = value;
      index += 1;
    } else if (arg === "--all-candidates") {
      options.allCandidates = true;
    } else if (arg === "--repo") {
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
    } else if (arg === "--timeout-ms") {
      const value = Number.parseInt(args[index + 1] || "", 10);
      if (!Number.isFinite(value) || value < 1_000) {
        throw new Error("--timeout-ms requires an integer >= 1000");
      }
      options.timeoutMs = value;
      index += 1;
    } else if (arg === "--arg") {
      const value = args[index + 1];
      if (value === undefined) {
        throw new Error("--arg requires a value");
      }
      options.args.push(value);
      index += 1;
    } else if (arg === "--format") {
      const value = args[index + 1];
      if (!value || !["json", "summary"].includes(value)) {
        throw new Error("--format must be json or summary");
      }
      options.format = value;
      index += 1;
    } else if (arg === "--inherit-env") {
      options.inheritEnv = true;
    } else if (arg === "--allow-risky") {
      options.allowRisky = true;
    } else if (arg === "--require-native") {
      options.requireNative = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!options.allCandidates && !options.agentId) {
    throw new Error("--agent is required");
  }
  return options;
}

function formatSummary(proof) {
  const lines = [
    `Native execution proof: ${proof.summary.selected} selected agents`,
    `Agent code execution proven: ${proof.summary.agentCodeExecutionProven}`,
    `Blocked: ${proof.summary.blocked}`,
    `Failed: ${proof.summary.failed}`,
    "",
    "Results:",
  ];
  for (const result of proof.results) {
    lines.push(
      `- ${result.id}: ${
        result.agentCodeExecutionProven ? "PASS" : result.blocked ? "BLOCKED" : "FAIL"
      } (${result.route}, exit=${result.exitCode}, timedOut=${result.timedOut ? "yes" : "no"})`,
    );
  }
  lines.push("", `Artifact: ${proof.artifactContract.path}`, "");
  return lines.join("\n");
}

export async function runNativeExecutionProofCli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (!["prove"].includes(options.command)) {
    throw new Error(`Unknown command: ${options.command}`);
  }
  const proof = await createNativeExecutionProof({
    agentArtifactDir: normalizePath(options.agentArtifactDir),
    agentId: options.agentId,
    allCandidates: options.allCandidates,
    allowRisky: options.allowRisky,
    args: options.args,
    inheritEnv: options.inheritEnv,
    openclawHome: normalizePath(options.openclawHome),
    outputPath: normalizePath(options.outputPath),
    repoRoot: normalizePath(options.repoRoot),
    timeoutMs: options.timeoutMs,
  });
  writeJson(options.outputPath, proof);
  if (options.format === "summary") {
    process.stdout.write(formatSummary(proof));
  } else if (!options.outputPath) {
    process.stdout.write(`${JSON.stringify(proof, null, 2)}\n`);
  }
  return options.requireNative && !proof.proofClaim.allSelectedAgentCodeExecutionProven ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    process.exit(await runNativeExecutionProofCli());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
