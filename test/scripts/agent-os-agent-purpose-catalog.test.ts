import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENT_OS_AGENT_PURPOSE_CATALOG_SCHEMA_VERSION,
  buildAgentPurposeCatalog,
  runAgentPurposeCatalogCli,
} from "../../scripts/agents/agent-os-agent-purpose-catalog.mjs";

function writeJson(filePath: string, value: unknown) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(filePath: string, value: string) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, value);
}

function createFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-agent-purpose-"));
  const repoRoot = path.join(root, "repo");
  const openclawHome = path.join(root, ".openclaw");
  mkdirSync(path.join(openclawHome, "agents", "orphan_agent"), { recursive: true });
  mkdirSync(path.join(openclawHome, "workspace_workspace_only"), { recursive: true });
  mkdirSync(path.join(root, "tools"), { recursive: true });
  writeText(path.join(root, "tools", "upload.py"), "print('ok')\n");
  writeText(
    path.join(openclawHome, "agents", "orphan_agent", "IDENTITY.md"),
    "# Orphan Agent\n\n- Handles coding repair tickets from a filesystem-backed agent workspace.\n",
  );
  writeJson(path.join(openclawHome, "openclaw.json"), {
    agents: {
      list: [
        {
          id: "main",
          name: "Main Agent",
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
    ],
  });
  writeText(
    path.join(repoRoot, "skills", "weather", "SKILL.md"),
    "---\nname: weather\ndescription: Current weather and forecasts.\n---\n",
  );
  writeText(
    path.join(repoRoot, ".agents", "skills", "discrawl", "agents", "openai.yaml"),
    "interface:\n  display_name: Discrawl\n  short_description: Discord archive search worker.\n  default_prompt: Search the Discord archive and summarize the result.\n",
  );
  writeText(
    path.join(
      repoRoot,
      ".agents",
      "skills",
      "technical-documentation",
      "agents",
      "inventory-agent.md",
    ),
    "---\nname: inventory-agent\ndescription: Fast repo-surface discovery for technical documentation audits.\n---\n\nTasks:\n- map docs surfaces\n",
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

describe("agent os agent purpose catalog", () => {
  it("maps discovered agents to source-backed task-specific delivery contracts", () => {
    const fixture = createFixture();
    try {
      const catalog = buildAgentPurposeCatalog({
        generatedAt: "2026-06-01T00:00:00.000Z",
        openclawHome: fixture.openclawHome,
        repoRoot: fixture.repoRoot,
      });
      expect(catalog.schemaVersion).toBe(AGENT_OS_AGENT_PURPOSE_CATALOG_SCHEMA_VERSION);
      expect(catalog.summary).toMatchObject({
        inferredPurpose: 2,
        purposeDefined: 9,
        totalUnique: 11,
      });

      const byId = new Map(catalog.agents.map((agent) => [agent.agentId, agent]));
      expect(byId.get("research_agent")).toMatchObject({
        deliveryTask: {
          taskFamily: "archive-search",
          taskType: "archive_search_probe",
        },
        purposeDefined: true,
        purposeSourceType: "capability-profile",
      });
      expect(byId.get("discrawl:openai")).toMatchObject({
        deliveryTask: {
          taskFamily: "archive-search",
          taskType: "archive_search_probe",
        },
        purposeSourceType: "skill-agent-definition",
      });
      expect(byId.get("inventory-agent")).toMatchObject({
        deliveryTask: {
          taskFamily: "documentation",
          taskType: "documentation_audit_probe",
        },
        purposeDefined: true,
      });
      expect(byId.get("orphan_agent")).toMatchObject({
        deliveryTask: {
          taskFamily: "coding",
          taskType: "coding_workflow_probe",
        },
        purposeDefined: true,
        purposeSourceType: "path-metadata",
      });
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it("writes the catalog and fails strict purpose mode when inference remains", () => {
    const fixture = createFixture();
    const outputPath = path.join(fixture.root, "purpose.json");
    try {
      expect(
        runAgentPurposeCatalogCli([
          "audit",
          "--repo",
          fixture.repoRoot,
          "--openclaw-home",
          fixture.openclawHome,
          "--output",
          outputPath,
          "--format",
          "summary",
        ]),
      ).toBe(0);
      expect(
        runAgentPurposeCatalogCli([
          "audit",
          "--repo",
          fixture.repoRoot,
          "--openclaw-home",
          fixture.openclawHome,
          "--output",
          path.join(fixture.root, "strict-purpose.json"),
          "--require-purpose",
        ]),
      ).toBe(1);
      const written = JSON.parse(readFileSync(outputPath, "utf8"));
      expect(written.summary.totalUnique).toBe(11);
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });
});
