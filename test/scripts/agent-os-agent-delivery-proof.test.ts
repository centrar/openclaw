import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENT_OS_AGENT_DELIVERY_PROOF_SCHEMA_VERSION,
  createAgentDeliveryProof,
  runAgentDeliveryProofCli,
} from "../../scripts/agents/agent-os-agent-delivery-proof.mjs";

function writeJson(filePath: string, value: unknown) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(filePath: string, value: string) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, value);
}

function createFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-agent-delivery-proof-"));
  const repoRoot = path.join(root, "repo");
  const openclawHome = path.join(root, ".openclaw");
  mkdirSync(path.join(openclawHome, "agents", "main"), { recursive: true });
  mkdirSync(path.join(openclawHome, "agents", "orphan_agent"), { recursive: true });
  mkdirSync(path.join(openclawHome, "workspace_main"), { recursive: true });
  mkdirSync(path.join(openclawHome, "workspace_workspace_only"), { recursive: true });
  mkdirSync(path.join(root, "tools"), { recursive: true });
  writeText(path.join(root, "tools", "upload.py"), "print('ok')\n");
  writeJson(path.join(openclawHome, "openclaw.json"), {
    agents: {
      list: [
        {
          id: "main",
          name: "Main Agent",
          workspace: path.join(openclawHome, "workspace_main"),
        },
        {
          id: "research_agent",
          params: {
            agentOsCapability: {
              capabilityFamilies: ["research"],
              ticketTypes: ["research"],
            },
          },
        },
      ],
    },
  });
  writeJson(path.join(openclawHome, "agents_registry.json"), {
    agents: [
      {
        id: "main",
        path: path.join(openclawHome, "agents", "main"),
        status: "listed",
        type: "orchestrator",
      },
      {
        id: "upload_tool",
        path: path.join(root, "tools", "upload.py"),
        status: "unlisted",
        type: "python_tool",
      },
      {
        id: "missing_tool",
        path: path.join(root, "missing.py"),
        status: "unlisted",
        type: "python_tool",
      },
      {
        id: "dormant_partner",
        path: path.join(root, "missing-partner"),
        status: "dormant",
        type: "business_agent",
      },
    ],
  });
  writeText(path.join(repoRoot, "skills", "weather", "SKILL.md"), "# weather\n");
  writeText(
    path.join(repoRoot, ".agents", "skills", "weather", "agents", "openai.yaml"),
    "id: weather:openai\n",
  );
  writeText(
    path.join(repoRoot, ".agents", "skills", "swarm-signal", "scripts", "signal_hub.cjs"),
    "const NATIVE_AGENTS = new Set(['native_agent']);\n",
  );
  writeText(
    path.join(repoRoot, "scripts", "agents", "capability-agent-profile.mjs"),
    "export const x = [{ id: 'research_agent' }, { id: 'security_bouncer_agent' }];\n",
  );
  return { openclawHome, repoRoot, root };
}

describe("agent os agent delivery proof", () => {
  it("proves supervised live delivery for every discovered entry", () => {
    const fixture = createFixture();
    try {
      const outputPath = path.join(fixture.root, "delivery-proof.json");
      const agentArtifactDir = path.join(fixture.root, "agent-artifacts");
      const proof = createAgentDeliveryProof({
        agentArtifactDir,
        generatedAt: "2026-06-01T00:00:00.000Z",
        openclawHome: fixture.openclawHome,
        outputPath,
        repoRoot: fixture.repoRoot,
        runId: "delivery-run",
      });
      expect(proof.schemaVersion).toBe(AGENT_OS_AGENT_DELIVERY_PROOF_SCHEMA_VERSION);
      expect(proof.summary).toMatchObject({
        approvalRequired: 3,
        callableDeliveryProven: 11,
        contractDeliveryProven: 11,
        liveDeliveryProven: 11,
        notCallable: 0,
        notDeliveryProven: 0,
        purposeDefined: 8,
        selected: 11,
        taskSpecificDeliveryProven: 11,
      });
      expect(proof.summary.byCallabilityStatus).toMatchObject({
        CALLABLE_APPROVAL_REQUIRED: 3,
        CALLABLE_READY: 8,
      });
      expect(proof.proofClaim).toMatchObject({
        allAgentsCallableDeliveryProven: true,
        allAgentsContractDeliveryProven: true,
        allAgentsLiveDeliveryProven: true,
        allAgentsPurposeDefined: false,
        allAgentsPurposeMapped: true,
        allAgentsUnattendedDeliveryReady: false,
        arbitraryAgentCodeExecution: false,
        supervisedRouteExecution: true,
      });

      const byId = new Map(proof.results.map((result) => [result.id, result]));
      expect(byId.get("main")).toMatchObject({
        contractDeliveryProven: true,
        deliveryTask: {
          taskFamily: "openclaw-config",
          taskType: "main_purpose_probe",
        },
        deliveryStatus: "LIVE_DELIVERY_PROVEN",
        liveDeliveryProven: true,
        proofEvent: { status: "PASS" },
        ticket: { schemaVersion: "agent-os.ticket.v1", status: "DONE" },
      });
      expect(byId.get("native_agent")).toMatchObject({
        callableDeliveryProven: true,
        callabilityStatus: "CALLABLE_APPROVAL_REQUIRED",
        contractDeliveryProven: true,
        deliveryStatus: "LIVE_DELIVERY_WARN",
        liveDeliveryProven: true,
        proofEvent: { status: "WARN" },
        route: "native-bridge-supervisor",
        ticket: { status: "DONE" },
      });
      expect(byId.get("native_agent")?.warningReasons).toContain(
        "agent route needs operator approval",
      );
      expect(byId.get("missing_tool")).toMatchObject({
        callableDeliveryProven: true,
        callabilityStatus: "CALLABLE_APPROVAL_REQUIRED",
        contractDeliveryProven: true,
        deliveryStatus: "LIVE_DELIVERY_WARN",
        liveDeliveryProven: true,
        proofEvent: { status: "WARN" },
      });
      expect(byId.get("missing_tool")?.warningReasons).toContain(
        "manager route is supervised with warnings",
      );
      expect(existsSync(path.join(agentArtifactDir, "main.json"))).toBe(true);
      expect(
        readdirSync(agentArtifactDir).some((name) =>
          /^weather-openai-[a-f0-9]+\.json$/u.test(name),
        ),
      ).toBe(true);
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it("passes contract/live gates and fails the purpose gate when metadata is missing", () => {
    const fixture = createFixture();
    try {
      expect(
        runAgentDeliveryProofCli([
          "prove",
          "--repo",
          fixture.repoRoot,
          "--openclaw-home",
          fixture.openclawHome,
          "--output",
          path.join(fixture.root, "all-delivery-proof.json"),
          "--agent-artifacts",
          path.join(fixture.root, "all-agent-artifacts"),
          "--require-contract",
          "--require-callable",
          "--format",
          "summary",
        ]),
      ).toBe(0);
      expect(
        runAgentDeliveryProofCli([
          "prove",
          "--repo",
          fixture.repoRoot,
          "--openclaw-home",
          fixture.openclawHome,
          "--managed-only",
          "--output",
          path.join(fixture.root, "managed-delivery-proof.json"),
          "--agent-artifacts",
          path.join(fixture.root, "managed-agent-artifacts"),
          "--require-contract",
        ]),
      ).toBe(0);
      expect(
        runAgentDeliveryProofCli([
          "prove",
          "--repo",
          fixture.repoRoot,
          "--openclaw-home",
          fixture.openclawHome,
          "--managed-only",
          "--output",
          path.join(fixture.root, "managed-live-proof.json"),
          "--agent-artifacts",
          path.join(fixture.root, "managed-live-agent-artifacts"),
          "--require-live",
        ]),
      ).toBe(0);
      expect(
        runAgentDeliveryProofCli([
          "prove",
          "--repo",
          fixture.repoRoot,
          "--openclaw-home",
          fixture.openclawHome,
          "--managed-only",
          "--output",
          path.join(fixture.root, "managed-purpose-proof.json"),
          "--agent-artifacts",
          path.join(fixture.root, "managed-purpose-agent-artifacts"),
          "--require-purpose",
        ]),
      ).toBe(1);

      const managedProof = JSON.parse(
        readFileSync(path.join(fixture.root, "managed-delivery-proof.json"), "utf8"),
      );
      expect(managedProof.summary).toMatchObject({
        callableDeliveryProven: 11,
        contractDeliveryProven: 11,
        liveDeliveryProven: 11,
        notCallable: 0,
        notDeliveryProven: 0,
        selected: 11,
      });
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });
});
