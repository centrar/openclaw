import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENT_OS_AGENT_MANAGER_SCHEMA_VERSION,
  AGENT_OS_AGENT_MANAGER_SMOKE_SCHEMA_VERSION,
  buildAgentManagementPlan,
  buildManagedAgentCatalog,
  createAgentManagerSmoke,
  runAgentManagerCli,
} from "../../scripts/agents/agent-os-agent-manager.mjs";

function writeJson(filePath: string, value: unknown) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(filePath: string, value: string) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, value);
}

function createFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-agent-manager-"));
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
    path.join(repoRoot, ".agents", "skills", "swarm-signal", "scripts", "signal_hub.cjs"),
    "const NATIVE_AGENTS = new Set(['native_agent']);\n",
  );
  writeText(
    path.join(repoRoot, "scripts", "agents", "capability-agent-profile.mjs"),
    "export const x = [{ id: 'research_agent' }, { id: 'security_bouncer_agent' }];\n",
  );
  return { openclawHome, repoRoot, root };
}

describe("agent os agent manager", () => {
  it("plans registered agents, adapters, candidates, and blocked stale refs", () => {
    const fixture = createFixture();
    try {
      const plan = buildAgentManagementPlan({
        generatedAt: "2026-06-01T00:00:00.000Z",
        openclawHome: fixture.openclawHome,
        repoRoot: fixture.repoRoot,
      });
      expect(plan.schemaVersion).toBe(AGENT_OS_AGENT_MANAGER_SCHEMA_VERSION);
      expect(plan.summary).toMatchObject({
        blocked: 0,
        candidates: 0,
        controlPlaneManaged: 10,
        dormant: 0,
        liveDeliveryProven: 0,
        pathWarnings: 2,
        totalUnique: 10,
      });

      const byId = new Map(plan.agents.map((agent) => [agent.id, agent]));
      expect(byId.get("main")).toMatchObject({
        action: "keep-registered",
        controlPlaneManaged: true,
        managerState: "managed",
        route: "openclaw-config",
      });
      expect(byId.get("upload_tool")).toMatchObject({
        action: "manage-through-adapter",
        controlPlaneManaged: true,
        route: "tool-adapter",
      });
      expect(byId.get("weather")).toMatchObject({
        action: "manage-through-adapter",
        route: "skill-adapter",
      });
      expect(byId.get("native_agent")).toMatchObject({
        action: "manage-through-supervisor",
        managerState: "managed",
        needsOperatorApproval: true,
        route: "native-bridge-supervisor",
      });
      expect(byId.get("missing_tool")).toMatchObject({
        action: "manage-through-quarantine-supervisor",
        managerState: "managed-with-warnings",
        route: "tool-adapter",
      });

      const catalog = buildManagedAgentCatalog({
        generatedAt: "2026-06-01T00:00:00.000Z",
        plan,
      });
      expect(catalog.managedAgents.map((agent) => agent.id).sort()).toEqual([
        "dormant_partner",
        "main",
        "missing_tool",
        "native_agent",
        "orphan_agent",
        "research_agent",
        "security_bouncer_agent",
        "upload_tool",
        "weather",
        "workspace_only",
      ]);
      expect(catalog.importCandidates).toEqual([]);
      expect(catalog.blockedAgents).toEqual([]);
      expect(catalog.proofClaim).toMatchObject({
        liveDelivery: false,
        managementCatalog: true,
      });
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it("writes a management catalog and control-plane smoke artifact", () => {
    const fixture = createFixture();
    const catalogPath = path.join(fixture.root, "catalog.json");
    const smokePath = path.join(fixture.root, "smoke.json");
    try {
      expect(
        runAgentManagerCli([
          "apply",
          "--repo",
          fixture.repoRoot,
          "--openclaw-home",
          fixture.openclawHome,
          "--output",
          catalogPath,
        ]),
      ).toBe(0);
      const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
      expect(catalog.managedAgents).toHaveLength(10);
      expect(catalog.proofClaim.liveDelivery).toBe(false);

      expect(
        runAgentManagerCli([
          "smoke",
          "--repo",
          fixture.repoRoot,
          "--openclaw-home",
          fixture.openclawHome,
          "--all-managed",
          "--output",
          smokePath,
          "--format",
          "summary",
        ]),
      ).toBe(0);
      const smoke = JSON.parse(readFileSync(smokePath, "utf8"));
      expect(smoke.schemaVersion).toBe(AGENT_OS_AGENT_MANAGER_SMOKE_SCHEMA_VERSION);
      expect(smoke.summary).toMatchObject({
        controlPlaneManaged: 10,
        liveDeliveryProven: 0,
        smoked: 10,
      });
      expect(smoke.summary.byStatus).toEqual({ PASS: 8, WARN: 2 });
      expect(smoke.results[0]).toMatchObject({
        liveDeliveryProven: false,
        proofEvent: { schemaVersion: "agent-os.proof-event.v1" },
        ticket: { schemaVersion: "agent-os.ticket.v1" },
      });
      expect(smoke.artifactContract).toMatchObject({
        kind: "agent-manager-smoke",
        path: path.resolve(smokePath),
        schemaVersion: "agent-os.artifact.v1",
      });
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it("supervises a selected import surface without claiming live code execution", () => {
    const fixture = createFixture();
    try {
      const smoke = createAgentManagerSmoke({
        agentIds: ["native_agent"],
        generatedAt: "2026-06-01T00:00:00.000Z",
        openclawHome: fixture.openclawHome,
        outputPath: path.join(fixture.root, "candidate-smoke.json"),
        repoRoot: fixture.repoRoot,
        runId: "candidate-run",
      });
      expect(smoke.summary).toMatchObject({
        controlPlaneManaged: 1,
        liveDeliveryProven: 0,
        smoked: 1,
      });
      expect(smoke.summary.byStatus).toEqual({ PASS: 1 });
      expect(smoke.results[0]).toMatchObject({
        id: "native_agent",
        route: "native-bridge-supervisor",
        status: "PASS",
      });
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });
});
